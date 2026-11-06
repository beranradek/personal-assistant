/**
 * TmuxAgentService: all lifecycle logic of the `agent_session_*` tools, transport-free.
 * Every tmux call goes through the injected `TmuxRunner` and targets stored ids (`$N` session, `%N` pane), never labels.
 */
import { randomBytes } from "node:crypto";
import { createLogger } from "../core/logger.js";
import type { AuditEntry } from "./audit.js";
import { agentEnvPath } from "./binary.js";
import { TmuxAgentError } from "./errors.js";
import { agentProgram, buildAgentArgv, getKind, resolvePermissionMode, type AgentKind, type PermissionMode } from "./kinds.js";
import { buildSessionName, isSingleLine, validateProject, validateText } from "./names.js";
import { pruneTerminal, reconcile, type LiveSession, type SessionRecord } from "./registry.js";
import { resolveStartDirectory } from "./roots.js";
import type { TmuxRunResult } from "./runner.js";
import type { StartInput } from "./schemas.js";
import {
  compactBlankLines,
  detectState,
  extractNewOutput,
  promptBoxText,
  SCROLLED_AWAY_MARKER,
  sanitizeScreen,
  tailLines,
  wrapUntrusted,
  type AgentState,
} from "./screen.js";
import {
  answerFilePath,
  answerOffset,
  findAnswer,
  readAnswerRecords,
  removeAnswerFiles,
  sweepAnswerFiles,
  writeAnswerSettings,
} from "./answers.js";
import type { AttachResult, ServiceDeps, SessionSummary, StartResult, StopResult, TmuxAgentService } from "./types.js";

const log = createLogger("tmux-agents-service");

// tmux formats (constants of ours, never built from input)
const NEW_SESSION_FORMAT = "#{session_id} #{pane_id} #{session_created}";
/** Runs the agent with an adjusted `PATH` (a constant of ours, never user input). */
const ENV_PROGRAM = "/usr/bin/env";
const LIST_FORMAT = "#{session_name} #{session_id} #{session_created}";
const OWNER_FORMAT = "#{session_id} #{session_created}";
const ATTACHED_FORMAT = "#{session_attached}";

/** Timings (milliseconds). */
const START_SETTLE_MS = 3_000;
const KEY_GAP_MS = 150;
/** After typing: wait this long, then check that the message left the input box (see `ensureSubmitted`). */
const SUBMIT_CHECK_MS = 700;
const SUBMIT_RETRIES = 3;
const SUBMIT_MATCH_CHARS = 30;
const WAIT_POLL_MS = 1_000;
const STOP_POLL_MS = 500;
const RECOVER_INTERRUPT_WAIT_MS = 1_000;
const REAP_INTERVAL_MS = 60_000;

/** Screen lines captured for state detection (status) and for send/wait diffs. */
const STATUS_CAPTURE_LINES = 60;
const SEND_CAPTURE_LINES = 200;
/** After the answer arrived: up to SETTLE_POLLS x SETTLE_POLL_MS for the screen to stop showing `busy`. */
const SETTLE_POLLS = 20;
const SETTLE_POLL_MS = 250;
/** An idle screen without any prompt record for this long: the hooks do not run or the message was no prompt (slash command). */
const PROMPT_RECORD_GRACE_MS = 2_000;
/** An idle screen with a prompt record but no `Stop` record for this long: the turn was interrupted (no Stop hook then). */
const PENDING_IDLE_GRACE_MS = 10_000;
const SCROLL_TO_BOTTOM_ATTEMPTS = 2;
const SCROLL_SETTLE_MS = 150;
const NEW_SESSION_ATTEMPTS = 3;
const PANE_WIDTH = "200";
const PANE_HEIGHT = "50";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmuxError(result: TmuxRunResult, what: string): TmuxAgentError {
  const detail = result.stderr.trim().slice(0, 200);
  return new TmuxAgentError("TMUX_ERROR", `tmux ${what} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Quote a word only when the shell would otherwise split or expand it (readable commands in hints). */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : shellQuote(value);
}

function errorCode(err: unknown): string {
  return err instanceof TmuxAgentError ? err.code : "TMUX_ERROR";
}

const isRunning = (record: SessionRecord) => record.state === "running";

/** Audit fields known before the operation runs; `ok` and `code` are added from the outcome. */
type AuditContext = Omit<AuditEntry, "ok" | "code">;

export function createService(deps: ServiceDeps): TmuxAgentService {
  const { runner, registry, audit, kinds, redact, clock } = deps;
  const cfg = deps.config.tmuxAgents;
  const random = deps.random;
  const prefix = cfg.sessionPrefix;
  let lastStartAt = 0;
  let startChain: Promise<unknown> = Promise.resolve();
  let reaperTimer: NodeJS.Timeout | undefined;
  let reaping = false;

  /** Run `fn` after all earlier calls finished (never overlaps): the start gates must see the effect of the previous start. */
  function serializedStart<T>(fn: () => Promise<T>): Promise<T> {
    const run = startChain.then(fn);
    startChain = run.catch(() => undefined);
    return run;
  }

  // ---- tmux primitives ----------------------------------------------------

  /** Run a tmux command that must succeed. */
  async function must(args: readonly string[], input?: string): Promise<TmuxRunResult> {
    const result = await runner.run(args, input === undefined ? undefined : { input });
    if (result.code !== 0) throw tmuxError(result, args[0] ?? "command");
    return result;
  }

  /** Best effort kill for cleanup paths that already fail with their own error. */
  async function killQuietly(sessionId: string): Promise<void> {
    try {
      await runner.run(["kill-session", "-t", sessionId]);
    } catch (err) {
      log.warn({ err, sessionId }, "kill-session failed; the session may be orphaned");
    }
  }

  async function sessionGone(sessionId: string): Promise<boolean> {
    return (await runner.run(["has-session", "-t", sessionId])).code !== 0;
  }

  /** Kill a session and prove it is gone: a failed kill must not turn into a `stopped` record of a running session. */
  async function killVerified(sessionId: string): Promise<void> {
    try {
      await runner.run(["kill-session", "-t", sessionId]);
    } catch (err) {
      log.warn({ err, sessionId }, "kill-session failed");
    }
    if (!(await sessionGone(sessionId))) {
      throw new TmuxAgentError("TMUX_ERROR", "The session is still alive after kill-session; it stays registered as running");
    }
  }

  async function listLive(): Promise<LiveSession[]> {
    const result = await runner.run(["list-sessions", "-F", LIST_FORMAT]);
    if (result.noServer) return [];
    if (result.code !== 0) throw tmuxError(result, "list-sessions");
    const live: LiveSession[] = [];
    for (const line of result.stdout.split("\n")) {
      const match = /^(.*) (\$\d+) (\d+)$/.exec(line.trim());
      if (match) live.push({ name: match[1]!, sessionId: match[2]!, created: match[3]! });
    }
    return live;
  }

  async function captureOnce(record: SessionRecord, lines: number): Promise<string> {
    const result = await must(["capture-pane", "-p", "-J", "-t", record.tmuxPaneId, "-S", `-${lines}`]);
    return sanitizeScreen(result.stdout);
  }

  /**
   * Claude Code fullscreen keeps its own scrollback (tmux has no history for it) and shows only a viewport. When that viewport
   * is scrolled away from the bottom ("Jump to bottom (ctrl+End)"), a capture returns the middle of an answer instead of its end.
   * Ctrl+End is a navigation key (no text is typed), so it is safe to send before the capture is repeated.
   */
  async function capture(record: SessionRecord, lines: number): Promise<string> {
    let screen = await captureOnce(record, lines);
    for (let attempt = 0; attempt < SCROLL_TO_BOTTOM_ATTEMPTS && SCROLLED_AWAY_MARKER.test(screen); attempt++) {
      await must(["send-keys", "-t", record.tmuxPaneId, "C-End"]);
      await clock.sleep(SCROLL_SETTLE_MS);
      screen = await captureOnce(record, lines);
    }
    return screen;
  }

  // ---- registry helpers ---------------------------------------------------

  const nowIso = () => new Date(clock.now()).toISOString();

  async function findRecord(name: string): Promise<SessionRecord> {
    const { records } = await registry.read();
    const record = records.find((r) => r.name === name);
    if (!record) throw new TmuxAgentError("NOT_FOUND", `Unknown session: ${name}`);
    return record;
  }

  async function patchRecord(name: string, patch: Partial<SessionRecord>): Promise<void> {
    await registry.mutate((records) => ({
      records: records.map((r) => (r.name === name ? { ...r, ...patch } : r)),
      result: undefined,
    }));
  }

  const markEnded = async (name: string, state: "stopped" | "lost") => {
    await patchRecord(name, { state, endedAt: nowIso() });
    await removeAnswerFiles(deps.config.security.dataDir, name); // agent output does not outlive the session
  };

  /**
   * Check that the tmux session behind a record is still OUR session (id and creation time match).
   * Returns false (and marks the record `lost`) when it is gone; throws NOT_OWNED when the id is now used by another session.
   */
  async function verifyAlive(record: SessionRecord): Promise<boolean> {
    if (!isRunning(record)) return false;
    const result = await runner.run(["display-message", "-p", "-t", record.tmuxPaneId, OWNER_FORMAT]);
    if (result.code !== 0) {
      log.warn({ session: record.name }, "tmux session is gone, marking it lost");
      await markEnded(record.name, "lost");
      return false;
    }
    const [id, created] = result.stdout.trim().split(" ");
    if (id !== record.tmuxSessionId || created !== record.tmuxCreated) {
      await markEnded(record.name, "lost");
      throw new TmuxAgentError("NOT_OWNED", `Session ${record.name} no longer matches its tmux session; refusing to touch it`);
    }
    return true;
  }

  /** Whether a client (a human through `attach`) is connected to the session. */
  async function isAttached(record: SessionRecord): Promise<boolean> {
    const result = await runner.run(["display-message", "-p", "-t", record.tmuxPaneId, ATTACHED_FORMAT]);
    return result.code === 0 && Number(result.stdout.trim()) > 0;
  }

  /** Registry record of a session that must be running and owned by us. */
  async function requireRunning(name: string): Promise<SessionRecord> {
    const record = await findRecord(name);
    if (!(await verifyAlive(record))) {
      throw new TmuxAgentError("NOT_FOUND", `Session ${name} is not running`);
    }
    return record;
  }

  function kindOf(record: SessionRecord): AgentKind {
    return getKind(kinds, record.kind);
  }

  function attachCommands(name: string): AttachResult {
    const base = `${cfg.tmuxBinary} -S ${shellQuote(runner.socketPath)}`;
    const target = shellQuote(`=${name}`);
    return { command: `${base} attach -t ${target}`, readOnlyCommand: `${base} attach -r -t ${target}` };
  }

  async function screenState(record: SessionRecord, lines = STATUS_CAPTURE_LINES) {
    const screen = await capture(record, lines);
    return { screen, status: detectState(kindOf(record).detector, screen) };
  }

  async function audited<T>(entry: AuditContext, fn: (entry: AuditContext) => Promise<T>): Promise<T> {
    try {
      const result = await fn(entry);
      await audit.record({ ...entry, ok: true });
      return result;
    } catch (err) {
      await audit.record({ ...entry, ok: false, code: errorCode(err) });
      throw err;
    }
  }

  // ---- start ----------------------------------------------------------------

  interface PreparedStart {
    project: string;
    kind: AgentKind;
    mode: PermissionMode;
    cwd: string;
    /** Argv without the answer hooks (for messages). */
    argv: string[];
    /** Argv of a tmux session: with the answer hooks settings file when the kind supports them. */
    launchArgv: (settingsPath?: string) => string[];
  }

  async function assertStartRate(): Promise<void> {
    const { records } = await registry.read();
    const newest = records.reduce((max, r) => Math.max(max, Date.parse(r.createdAt) || 0), lastStartAt);
    if (clock.now() - newest < cfg.minStartIntervalMs) {
      throw new TmuxAgentError("RATE_LIMITED", "Sessions are started too fast; wait a few seconds");
    }
  }

  /** All gates of `start` that need no tmux call. */
  async function prepareStart(input: StartInput, options: { checkRate: boolean }): Promise<PreparedStart> {
    validateProject(input.project);
    if (!deps.enabledKinds.includes(input.kind)) {
      throw new TmuxAgentError("INVALID_INPUT", `Agent kind is not enabled: ${input.kind}`);
    }
    const kind = getKind(kinds, input.kind);
    const mode = resolvePermissionMode(cfg, input.permissionMode, input.confirmBypass);
    if (mode === "bypass") log.warn({ project: input.project }, "Starting an agent with permission bypass");
    const cwd = resolveStartDirectory(input.directory, {
      allowedRoots: cfg.allowedRoots,
      trustedRoots: cfg.trustedRoots,
      writableDirs: [deps.config.security.workspace, ...deps.config.security.additionalWriteDirs],
    });
    // Pre-flight: no tmux call, registry record or kill of a replaced session happens when the program is missing.
    const binary = deps.resolveBinary(kind.id, agentProgram(kind));
    // tmux ignores `new-session -e PATH=...` for the pane (verified on tmux 3.6), so the `PATH` is set by `env`.
    const envPath = deps.agentBasePath === undefined ? undefined : agentEnvPath(binary, deps.agentBasePath);
    const launchArgv = (settingsPath?: string) => {
      const agentArgv = buildAgentArgv(kinds, kind.id, mode, binary, settingsPath);
      return envPath === undefined ? agentArgv : [ENV_PROGRAM, `PATH=${envPath}`, ...agentArgv];
    };
    if (options.checkRate) await assertStartRate();
    return { project: input.project, kind, mode, cwd, argv: launchArgv(), launchArgv };
  }

  /**
   * After a `new-session` call that threw (timeout, maxBuffer) tmux may still have created the session. It would be live
   * without a record: it counts against `maxSessions`, is never reaped and cannot be stopped. The name was generated a
   * moment ago on our dedicated server, so a live session with exactly this name is ours: kill it by id. Failures are only logged.
   */
  async function removeOrphan(name: string): Promise<void> {
    try {
      const orphan = (await listLive()).find((l) => l.name === name);
      if (!orphan) return;
      log.warn({ name, sessionId: orphan.sessionId }, "new-session failed but the session exists; killing the orphan");
      await killVerified(orphan.sessionId);
    } catch (err) {
      log.warn({ err, name }, "Could not check for an orphan session after a failed new-session");
    }
  }

  async function createTmuxSession(p: PreparedStart) {
    for (let attempt = 0; attempt < NEW_SESSION_ATTEMPTS; attempt++) {
      const name = buildSessionName(p.project, random);
      const dataDir = deps.config.security.dataDir;
      let settingsPath: string | undefined;
      if (p.kind.answerHooks) {
        try {
          settingsPath = await writeAnswerSettings(dataDir, name);
        } catch (err) {
          // The settings file of this name exists: another session uses the name. Pick another name; never touch its files.
          if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw err;
        }
      }
      let result: TmuxRunResult;
      try {
        result = await runner.run([
          "new-session", "-d", "-s", name, "-x", PANE_WIDTH, "-y", PANE_HEIGHT, "-c", p.cwd,
          "-P", "-F", NEW_SESSION_FORMAT, "--", ...p.launchArgv(settingsPath),
        ]);
      } catch (err) {
        // The runner throws on a timeout, an exceeded maxBuffer or a spawn failure: tmux may still have created the session.
        await removeOrphan(name);
        await removeAnswerFiles(dataDir, name);
        throw err;
      }
      if (result.code === 0) {
        const match = /^(\$\d+) (%\d+) (\d+)$/.exec(result.stdout.trim());
        if (!match) throw new TmuxAgentError("TMUX_ERROR", "Unexpected output of tmux new-session");
        return { name, sessionId: match[1]!, paneId: match[2]!, created: match[3]! };
      }
      await removeAnswerFiles(dataDir, name);
      if (!/duplicate session/i.test(result.stderr)) throw tmuxError(result, "new-session");
    }
    throw new TmuxAgentError("TMUX_ERROR", "Could not find a free session name");
  }

  /** Check the limits, create the tmux session and write its record. Callers run it through `serializedStart`. */
  async function register(p: PreparedStart, entry: AuditContext, recoveredFrom?: string): Promise<SessionRecord> {
    const snapshot = await registry.read();
    if (snapshot.corrupt) throw new TmuxAgentError("TMUX_ERROR", "registry corrupt, manual repair needed");
    const live = await listLive();
    if (Math.max(snapshot.records.filter(isRunning).length, live.length) >= cfg.maxSessions) {
      throw new TmuxAgentError("TOO_MANY_SESSIONS", `At most ${cfg.maxSessions} agent sessions may run`);
    }

    const created = await createTmuxSession(p);
    // A recover audits the replaced session as `session` and the new one as `newSession`.
    if (recoveredFrom) entry.newSession = created.name;
    else entry.session = created.name;
    const record: SessionRecord = {
      name: created.name,
      project: p.project,
      kind: p.kind.id,
      cwd: p.cwd,
      permissionMode: p.mode,
      createdAt: nowIso(),
      creatorPid: process.pid,
      instanceId: deps.instanceId,
      tmuxSessionId: created.sessionId,
      tmuxPaneId: created.paneId,
      tmuxCreated: created.created,
      state: "running",
      ...(recoveredFrom ? { recoveredFrom } : {}),
    };
    let overLimit: boolean;
    try {
      // Count again under the lock: another process may have started a session since the first check.
      overLimit = await registry.mutate((records) =>
        records.filter(isRunning).length >= cfg.maxSessions
          ? { records, result: true }
          : { records: [...records, record], result: false },
      );
    } catch (err) {
      await killQuietly(created.sessionId);
      await removeAnswerFiles(deps.config.security.dataDir, created.name);
      throw err;
    }
    if (overLimit) {
      await killQuietly(created.sessionId);
      await removeAnswerFiles(deps.config.security.dataDir, created.name);
      throw new TmuxAgentError("TOO_MANY_SESSIONS", `At most ${cfg.maxSessions} agent sessions may run`);
    }
    return record;
  }

  /** Wait for the TUI to draw, then report the detected state (outside the start serialization: it only reads). */
  async function settle(record: SessionRecord, argv: readonly string[]) {
    await clock.sleep(START_SETTLE_MS);
    let state: AgentState = "unknown";
    let hint: string | undefined;
    try {
      state = (await screenState(record)).status.state;
    } catch (err) {
      log.warn({ err, session: record.name }, "Could not capture the screen after start");
      // verifyAlive marks the record `lost` when the session is gone.
      const alive = await verifyAlive(record).catch(() => false);
      hint = alive
        ? "The screen could not be read yet. Check with agent_session_status."
        : `The agent session ended right after start (the record is now lost). Likely causes: the agent program exited at once ` +
          `(wrong path or flags, not logged in, crash). Run the exact command by hand in ${shellWord(record.cwd)} to see the error: ` +
          `${argv.map(shellWord).join(" ")}. If the program is not found, set tmuxAgents.agentBinaries.${record.kind}.`;
    }
    if (state === "waiting_trust") {
      hint = "The agent shows a trust dialog. Report it to the user and recommend agent_session_attach; do not confirm it.";
    } else if (state === "unknown" && !hint) {
      hint =
        "The screen is not recognized: the agent may still be starting or wait at a dialog. Read it with agent_session_read; " +
        "if it shows a dialog, report it to the user and recommend agent_session_attach.";
    }
    return { record, state, hint };
  }

  const toStartResult = ({ record, state, hint }: Awaited<ReturnType<typeof settle>>): StartResult => ({
    session: record.name,
    project: record.project,
    kind: record.kind,
    permissionMode: record.permissionMode,
    cwd: record.cwd,
    attachCommand: attachCommands(record.name).readOnlyCommand,
    state,
    ...(hint ? { hint } : {}),
  });

  // ---- registry sync --------------------------------------------------------

  /**
   * Mark running records whose tmux session is gone as lost and prune old terminal records (one locked write).
   * Returns the reconcile result for logging.
   */
  async function syncWithTmux() {
    const { records, corrupt } = await registry.read();
    if (corrupt) return undefined;
    const result = reconcile(records, await listLive(), prefix);
    const lost = new Set(result.markLost.map((r) => r.name));
    // Sessions that ended without `markEnded` (killed outside the service, tmux server restart) leave their files behind.
    const running = new Set(records.filter((r) => isRunning(r) && !lost.has(r.name)).map((r) => r.name));
    await sweepAnswerFiles(deps.config.security.dataDir, running, Date.now()).catch(() => undefined);
    const hasOldRecords = pruneTerminal(records, clock.now()).length !== records.length;
    if (lost.size > 0 || hasOldRecords) {
      await registry.mutate((current) => ({
        records: pruneTerminal(
          current.map((r) => (lost.has(r.name) && isRunning(r) ? { ...r, state: "lost" as const, endedAt: nowIso() } : r)),
          clock.now(),
        ),
        result: undefined,
      }));
    }
    return result;
  }

  /** Drop old terminal records (one locked write, no tmux call). */
  const pruneOldRecords = () =>
    registry.mutate((current) => ({ records: pruneTerminal(current, clock.now()), result: undefined }));

  // ---- stop -----------------------------------------------------------------

  async function stopSession(record: SessionRecord, force: boolean): Promise<StopResult> {
    if (force) {
      await killVerified(record.tmuxSessionId);
      await markEnded(record.name, "stopped");
      return { session: record.name, method: "forced", gone: true };
    }
    const kind = kindOf(record);
    await must(["send-keys", "-t", record.tmuxPaneId, "-l", "--", kind.exitInput]);
    await clock.sleep(KEY_GAP_MS);
    await must(["send-keys", "-t", record.tmuxPaneId, "Enter"]);

    const deadline = clock.now() + cfg.stopGraceMs;
    while (clock.now() < deadline) {
      await clock.sleep(STOP_POLL_MS);
      if (await sessionGone(record.tmuxSessionId)) {
        await markEnded(record.name, "stopped");
        return { session: record.name, method: "graceful", gone: true };
      }
    }
    // Still alive after the grace period: make sure it is still our session, then kill it (and prove it is gone).
    if (await verifyAlive(record)) await killVerified(record.tmuxSessionId);
    await markEnded(record.name, "stopped");
    return { session: record.name, method: "kill-after-grace", gone: true };
  }

  // ---- send -----------------------------------------------------------------

  const sentTooSoon = (record: SessionRecord) =>
    record.lastInputAt !== undefined && clock.now() - Date.parse(record.lastInputAt) < cfg.minSendIntervalMs;

  const rateLimitedSend = () => new TmuxAgentError("RATE_LIMITED", "Messages are sent too fast; wait a moment");

  /**
   * Reserve the send slot: rate limit and `lastInputAt` in one locked step (also across processes). Called only after
   * all refusals (busy, waiting, unknown) passed, so a refused send does not use up the slot or reset the reaper clock.
   * Returns the previous `lastInputAt`, so the caller can give the slot back when nothing was typed.
   */
  async function reserveSend(name: string): Promise<string | undefined> {
    type Reservation = "missing" | "limited" | { previous: string | undefined };
    const reservation = await registry.mutate<Reservation>((records) => {
      const record = records.find((r) => r.name === name);
      if (!record) return { records, result: "missing" };
      if (sentTooSoon(record)) return { records, result: "limited" };
      const now = new Date(clock.now()).toISOString();
      return {
        records: records.map((r) => (r.name === name ? { ...r, lastInputAt: now } : r)),
        result: { previous: record.lastInputAt },
      };
    });
    if (reservation === "missing") throw new TmuxAgentError("NOT_FOUND", `Unknown session: ${name}`);
    if (reservation === "limited") throw rateLimitedSend();
    return reservation.previous;
  }

  /** Give a reserved send slot back: the typing failed, so nothing was sent and the reaper clock must not move. */
  async function releaseSend(name: string, previous: string | undefined): Promise<void> {
    await registry
      .mutate((records) => ({
        records: records.map((r) => {
          if (r.name !== name) return r;
          const { lastInputAt: _reserved, ...rest } = r;
          return previous === undefined ? rest : { ...rest, lastInputAt: previous };
        }),
        result: undefined,
      }))
      .catch((err: unknown) => log.warn({ err, session: name }, "Could not release the send slot"));
  }

  async function pressEnter(record: SessionRecord): Promise<void> {
    await clock.sleep(KEY_GAP_MS);
    await must(["send-keys", "-t", record.tmuxPaneId, "Enter"]);
  }

  /**
   * Claude Code can take a fast burst of typed characters for a paste and then treats the Enter that follows as a newline: the
   * message stays in the input box and nothing happens (the agent looks idle, the caller waits for an answer that never comes).
   * Check the box a moment after typing and press Enter again while our text is still in it. An empty box, or other text in it, means
   * the message was submitted, so Enter is never repeated then.
   */
  async function ensureSubmitted(record: SessionRecord, text: string): Promise<void> {
    const words = (value: string) => value.replace(/\s+/g, " ").trim();
    const prefix = words(text).slice(0, SUBMIT_MATCH_CHARS);
    const placeholder = !isSingleLine(text);
    for (let attempt = 0; attempt < SUBMIT_RETRIES; attempt++) {
      await clock.sleep(SUBMIT_CHECK_MS);
      const box = promptBoxText(await capture(record, STATUS_CAPTURE_LINES));
      if (box === undefined) return;
      const shown = words(box);
      const unsent = prefix !== "" && (shown.startsWith(prefix) || (placeholder && /^\[Pasted text\b/.test(shown)));
      if (!unsent) return;
      log.warn({ session: record.name, attempt: attempt + 1 }, "Typed message still in the input box; pressing Enter again");
      await must(["send-keys", "-t", record.tmuxPaneId, "Enter"]);
    }
  }

  /**
   * Type text into the pane. Single lines are typed with `send-keys -l`; multi-line text is pasted from a tmux buffer
   * (text goes through stdin, never argv). tmux eats a trailing ';' of an argument, so those are sent as hex keys.
   */
  async function typeText(record: SessionRecord, text: string): Promise<"keys" | "paste"> {
    const pane = record.tmuxPaneId;
    if (!isSingleLine(text)) {
      const buffer = `pa-${randomBytes(4).toString("hex")}`;
      await must(["load-buffer", "-b", buffer, "-"], text);
      try {
        await must(["paste-buffer", "-p", "-d", "-b", buffer, "-t", pane]);
      } catch (err) {
        await runner.run(["delete-buffer", "-b", buffer]).catch(() => undefined);
        throw err;
      }
      await pressEnter(record);
      return "paste";
    }
    const semicolons = /;*$/.exec(text)?.[0].length ?? 0;
    const head = text.slice(0, text.length - semicolons);
    if (head) await must(["send-keys", "-t", pane, "-l", "--", head]);
    if (semicolons > 0) await must(["send-keys", "-t", pane, "-H", ...Array<string>(semicolons).fill("3b")]);
    await pressEnter(record);
    return "keys";
  }

  /**
   * Poll until the answer is finished. An idle screen counts only when it differs from the one before sending AND the agent
   * was seen busy, or the screen did not change between two polls: right after sending, the echoed message next to an empty
   * prompt would otherwise pass for a finished answer.
   */
  async function waitForIdle(record: SessionRecord, before: string, budgetMs: number) {
    const detector = kindOf(record).detector;
    const deadline = clock.now() + budgetMs;
    let sawBusy = false;
    let previous: string | undefined;
    for (;;) {
      await clock.sleep(WAIT_POLL_MS);
      const screen = await capture(record, SEND_CAPTURE_LINES);
      const { state } = detectState(detector, screen);
      if (state === "busy") sawBusy = true;
      if (state === "waiting_permission" || state === "waiting_trust") return { screen, state, timedOut: false };
      if (state === "idle" && screen !== before && (sawBusy || screen === previous)) return { screen, state, timedOut: false };
      if (clock.now() >= deadline) return { screen, state, timedOut: true };
      previous = screen;
    }
  }

  /**
   * Wait for the exact answer of an agent with hooks. The `Stop` record with the `prompt_id` of our message ends the wait: the
   * screen is NOT trusted to say that the answer is complete, because it can look idle before the answer starts. The screen only
   * tells when to stop waiting for a record that will not come:
   * - the agent waits for a person (permission, trust dialog);
   * - the screen is idle and there is still no prompt record (hooks do not run, or the message was no prompt, for example a
   *   slash command) for `PROMPT_RECORD_GRACE_MS`;
   * - the screen is idle with a prompt record but no `Stop` record for `PENDING_IDLE_GRACE_MS` (an interrupted turn);
   * - the budget ended.
   * Without an answer the caller falls back to the screen.
   */
  async function waitForAnswer(record: SessionRecord, before: string, budgetMs: number, file: string, from: number, sentText: string) {
    const detector = kindOf(record).detector;
    const deadline = clock.now() + budgetMs;
    let idleSince: number | undefined;
    for (;;) {
      await clock.sleep(WAIT_POLL_MS);
      const screen = await capture(record, SEND_CAPTURE_LINES);
      const { state } = detectState(detector, screen);
      const found = findAnswer((await readAnswerRecords(file, from)).records, sentText);
      if (found.status === "answered") {
        // The Stop hook runs a moment before the screen repaints as idle. Wait for that, so the state we report is true and the
        // next `send` is not refused as BUSY.
        let settled = { screen, state };
        for (let i = 0; i < SETTLE_POLLS && settled.state === "busy"; i++) {
          await clock.sleep(SETTLE_POLL_MS);
          const next = await capture(record, SEND_CAPTURE_LINES);
          settled = { screen: next, state: detectState(detector, next).state };
        }
        return { ...settled, timedOut: false, answer: found.text };
      }
      const done = { screen, state, timedOut: false, answer: undefined };
      if (state === "waiting_permission" || state === "waiting_trust") return done;
      if (state === "idle" && screen !== before) {
        idleSince ??= clock.now();
        const idleMs = clock.now() - idleSince;
        if (found.status === "none" && idleMs >= PROMPT_RECORD_GRACE_MS) return done;
        if (found.status === "pending" && idleMs >= PENDING_IDLE_GRACE_MS) return done;
      } else {
        idleSince = undefined;
      }
      if (clock.now() >= deadline) return { ...done, timedOut: true };
    }
  }

  // ---- service --------------------------------------------------------------

  const service: TmuxAgentService = {
    async start(input) {
      return audited({ action: "start", project: input.project, kind: input.kind, permissionMode: input.permissionMode }, async (entry) => {
        const { record, argv } = await serializedStart(async () => {
          const prepared = await prepareStart(input, { checkRate: true });
          // Reserved before the tmux call: concurrent and failed starts count against minStartIntervalMs too.
          lastStartAt = clock.now();
          return { record: await register(prepared, entry), argv: prepared.argv };
        });
        return toStartResult(await settle(record, argv));
      });
    },

    async list({ includeStopped }) {
      let snapshot = await registry.read();
      // Sync with tmux when something may have vanished; prune old terminal records in any case (no tmux call needed).
      const hasOldRecords = pruneTerminal(snapshot.records, clock.now()).length !== snapshot.records.length;
      const refresh = snapshot.records.some(isRunning) ? syncWithTmux : hasOldRecords ? pruneOldRecords : undefined;
      if (refresh) {
        try {
          await refresh();
          snapshot = await registry.read();
        } catch (err) {
          log.warn({ err }, "Could not refresh session states from tmux");
        }
      }
      const sessions = snapshot.records
        .filter((r) => includeStopped || isRunning(r))
        .map((r): SessionSummary => ({
          session: r.name,
          project: r.project,
          kind: r.kind,
          cwd: r.cwd,
          permissionMode: r.permissionMode,
          createdAt: r.createdAt,
          state: r.state,
          ...(r.lastInputAt ? { lastInputAt: r.lastInputAt } : {}),
        }));
      return { sessions, allowedRoots: [...cfg.allowedRoots], ...(snapshot.corrupt ? { corrupt: true as const } : {}) };
    },

    async status({ session }) {
      const record = await findRecord(session);
      const detector = kindOf(record).detector;
      const capturedAt = nowIso();
      if (!(await verifyAlive(record))) {
        const sessionState = (await findRecord(session)).state;
        return {
          session, alive: false, state: "unknown", signal: sessionState, confidence: "high",
          evidence: [], detector, capturedAt, sessionState,
        };
      }
      const { status } = await screenState(record);
      return { session, alive: true, ...status, capturedAt, sessionState: "running" };
    },

    async read({ session, lines }) {
      const record = await requireRunning(session);
      const count = Math.min(lines ?? cfg.defaultOutputLines, cfg.maxOutputLines);
      const screen = compactBlankLines(tailLines(await capture(record, count), count));
      return { session, untrusted: true, lines: count, ...wrapUntrusted(screen, redact) };
    },

    async send(input) {
      return audited({ action: "send", session: input.session, input: input.text }, async () => {
        const record = await findRecord(input.session);
        const kind = kindOf(record);
        const text = validateText(input.text, { maxChars: cfg.maxInputChars, allowedSlash: kind.allowedSlash });
        if (!isSingleLine(text) && kind.multilinePaste === "none") {
          throw new TmuxAgentError("INVALID_INPUT", `Agent kind ${kind.id} does not accept multi-line text`);
        }
        if (sentTooSoon(record)) throw rateLimitedSend(); // cheap early refusal; reserveSend re-checks under the lock
        if (!(await verifyAlive(record))) throw new TmuxAgentError("NOT_FOUND", `Session ${record.name} is not running`);

        const { screen: before, status } = await screenState(record, SEND_CAPTURE_LINES);
        if (status.state === "waiting_trust") {
          throw new TmuxAgentError("WAITING_TRUST", "The agent waits at a trust dialog; the user must decide (agent_session_attach)");
        }
        if (status.state === "waiting_permission" && !(input.answerPermissionPrompt && cfg.allowAnswerPrompts)) {
          throw new TmuxAgentError("WAITING_PERMISSION", "The agent waits for a permission answer; ask the user (agent_session_attach)");
        }
        if (status.state === "busy" && !input.queueWhileBusy) {
          throw new TmuxAgentError("BUSY", "The agent is busy; wait, use queueWhileBusy, or interrupt it");
        }
        // An unrecognized screen may be a dialog with unknown wording: Enter could confirm its default answer.
        if (status.state === "unknown" && !input.allowUnknownState) {
          throw new TmuxAgentError(
            "UNKNOWN_STATE",
            "The screen is not recognized (the agent may be starting or show a dialog); read it with agent_session_read, " +
              "then retry with allowUnknownState or ask the user (agent_session_attach)",
          );
        }

        // Taken before typing: only hook records written after this point can belong to our message.
        const answerFile = kind.answerHooks ? answerFilePath(deps.config.security.dataDir, record.name) : undefined;
        const answerFrom = answerFile ? await answerOffset(answerFile) : 0;

        const previousInput = await reserveSend(record.name);
        let mode: "keys" | "paste";
        try {
          mode = await typeText(record, text);
        } catch (err) {
          await releaseSend(record.name, previousInput);
          throw err;
        }
        // Best effort: the text is typed already, so a failed check must not turn the send into an error.
        await ensureSubmitted(record, text).catch((err: unknown) => {
          log.warn({ err, session: record.name }, "Could not check that the message was submitted");
        });
        const budget = Math.min(input.waitForIdleMs, cfg.maxWaitMs);
        if (budget <= 0) return { session: record.name, sent: true, mode, state: status.state, waited: false, timedOut: false };

        try {
          const { answer, ...waited }: Awaited<ReturnType<typeof waitForIdle>> & { answer?: string } = answerFile
            ? await waitForAnswer(record, before, budget, answerFile, answerFrom, text)
            : await waitForIdle(record, before, budget);
          const output = answer === undefined
            ? { ...wrapUntrusted(extractNewOutput(before, waited.screen, text).text, redact), source: "screen" as const }
            : { ...wrapUntrusted(answer, redact), source: "hook" as const };
          return {
            session: record.name, sent: true, mode, state: waited.state, waited: true, timedOut: waited.timedOut,
            newOutput: { untrusted: true, ...output },
          };
        } catch (err) {
          // The input is already typed: report that instead of an error that suggests it was not sent.
          log.warn({ err, session: record.name }, "Could not read the screen after sending");
          return {
            session: record.name, sent: true, mode, state: "unknown", waited: false, timedOut: false,
            hint: "The text was sent, but the screen could not be read afterwards (the agent may have exited). Check agent_session_status.",
          };
        }
      });
    },

    async interrupt({ session }) {
      return audited({ action: "interrupt", session }, async () => {
        const record = await requireRunning(session);
        await must(["send-keys", "-t", record.tmuxPaneId, kindOf(record).interruptKey]);
        await patchRecord(record.name, { lastInputAt: nowIso() });
        return { session };
      });
    },

    async stop({ session, force, userConfirmed }) {
      return audited({ action: force ? "stop-force" : "stop", session }, async () => {
        if (force && userConfirmed !== true) {
          throw new TmuxAgentError("INVALID_INPUT", "A forced stop needs userConfirmed: true (ask the user first)");
        }
        const record = await requireRunning(session);
        if (!force) {
          const { status } = await screenState(record);
          // Same rule as `send`: on an unrecognized screen Enter could confirm the default answer of a dialog.
          if (status.state === "unknown") {
            throw new TmuxAgentError(
              "UNKNOWN_STATE",
              "The screen is not recognized (the agent may show a dialog); read it with agent_session_read, " +
                "then ask the user (agent_session_attach) about a forced stop",
            );
          }
          if (status.state !== "idle") {
            throw new TmuxAgentError("BUSY", `The agent is ${status.state}; wait, interrupt it, or ask the user about a forced stop`);
          }
        }
        return stopSession(record, force);
      });
    },

    async recover({ session, userConfirmed }) {
      return audited({ action: "recover", session }, async (entry) => {
        if (userConfirmed !== true) throw new TmuxAgentError("INVALID_INPUT", "recover needs userConfirmed: true (ask the user first)");
        const old = await findRecord(session);
        if (old.state === "stopped") throw new TmuxAgentError("NOT_FOUND", `Session ${session} was stopped; use agent_session_start`);
        // All gates that need no tmux call run BEFORE the old session is killed.
        const prepared = await prepareStart(
          {
            project: old.project, directory: old.cwd, kind: old.kind, permissionMode: old.permissionMode,
            ...(old.permissionMode === "bypass" ? { confirmBypass: true as const } : {}),
          },
          { checkRate: false },
        );
        log.warn({ session }, "Forced restart of an agent session; unfinished work is lost");
        if (await verifyAlive(old)) {
          await runner.run(["send-keys", "-t", old.tmuxPaneId, kindOf(old).interruptKey]);
          await clock.sleep(RECOVER_INTERRUPT_WAIT_MS);
          await killVerified(old.tmuxSessionId); // throws (old record stays running) when the session survives
        }
        await markEnded(old.name, "stopped");
        const record = await serializedStart(() => register(prepared, entry, old.name));
        return { ...toStartResult(await settle(record, prepared.argv)), oldSession: old.name, method: "force-restart" as const };
      });
    },

    async attach({ session, readOnly }) {
      const commands = attachCommands((await findRecord(session)).name);
      return { command: readOnly ? commands.readOnlyCommand : commands.command, readOnlyCommand: commands.readOnlyCommand };
    },

    async reconcile() {
      const result = await syncWithTmux();
      if (!result) {
        log.warn("tmux agent registry is corrupt; sessions are not adopted");
        return { adopted: 0, lost: 0, foreign: 0 };
      }
      for (const foreign of result.ignoreForeign) {
        log.warn({ name: foreign.name, sessionId: foreign.sessionId }, "Foreign session with our prefix on the agent tmux server; ignored");
      }
      return { adopted: result.adopt.length, lost: result.markLost.length, foreign: result.ignoreForeign.length };
    },

    async reapOnce() {
      if (cfg.idleReapMinutes === 0 || reaping) return [];
      reaping = true;
      const reaped: string[] = [];
      try {
        const { records } = await registry.read();
        const idleAfterMs = cfg.idleReapMinutes * 60_000;
        for (const record of records.filter(isRunning)) {
          if (clock.now() - Date.parse(record.lastInputAt ?? record.createdAt) < idleAfterMs) continue;
          try {
            if (!(await verifyAlive(record))) continue;
            if ((await screenState(record)).status.state !== "idle") continue;
            if (await isAttached(record)) continue; // a human works in it through attach; lastInputAt does not see that
            const context = { action: "reap", session: record.name, project: record.project, kind: record.kind };
            await audited(context, () => stopSession(record, false));
            reaped.push(record.name);
          } catch (err) {
            log.warn({ err, session: record.name }, "Could not reap an idle session");
          }
        }
      } finally {
        reaping = false;
      }
      return reaped;
    },

    startReaper() {
      if (cfg.idleReapMinutes === 0 || reaperTimer) return;
      reaperTimer = setInterval(() => {
        service.reapOnce().catch((err: unknown) => log.warn({ err }, "Idle reaper failed"));
      }, REAP_INTERVAL_MS);
      reaperTimer.unref();
    },

    close() {
      if (reaperTimer) clearInterval(reaperTimer);
      reaperTimer = undefined;
    },
  };
  return service;
}
