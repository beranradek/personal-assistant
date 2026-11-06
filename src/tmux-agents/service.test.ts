import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TmuxAgentsConfigSchema } from "../core/types.js";
import { createRedactor, CONSERVATIVE_PATTERNS } from "../security/content-redaction.js";
import type { AuditEntry } from "./audit.js";
import type { BinaryResolver } from "./binary.js";
import { TmuxAgentError } from "./errors.js";
import { FakeClock, FakeTmux } from "./fake-tmux.test-helper.js";
import { KINDS, type KindTable } from "./kinds.js";
import { createTmuxAgentService, type TmuxAgentService } from "./index.js";
import { createRegistry, type Registry } from "./registry.js";
import { ALLOWED_SUBCOMMANDS } from "./runner.js";
import type { StartInput } from "./schemas.js";

const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");
const IDLE = fixture("claude-idle.txt");
const BUSY = fixture("claude-busy.txt");
const PERMISSION = fixture("claude-permission.txt");
const TRUST = fixture("claude-trust.txt");
const EMPTY = fixture("claude-empty.txt");
// A real screen after a message "work": the echoed message, the reply, a done line and the prompt box.
const PROMPT_BOX = ["─".repeat(60), "❯", "─".repeat(60), "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n");
const answerScreen = (reply: string, secs = 3) => `❯ work\n\n${reply}\n\n✻ Worked for ${secs}s · done 12:35\n\n${PROMPT_BOX}\n`;
/** A dialog with wording the detector does not know: only its menu shape is recognized. */
const UNKNOWN_MENU = "Some new dialog\n\n  ❯ 1. Allow once\n    2. Deny\n";

/** Union of the tmux subcommands used by all tests; compared with the fixed set at the end. */
const usedSubcommands = new Set<string>();

async function errorOf(promise: Promise<unknown>): Promise<TmuxAgentError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof TmuxAgentError) return err;
    throw err;
  }
  throw new Error("expected a TmuxAgentError");
}

const codeOf = async (promise: Promise<unknown>) => (await errorOf(promise)).code;
const failed = (stderr: string) => ({ code: 1, stdout: "", stderr, noServer: false });

describe("TmuxAgentService", () => {
  let tmp: string;
  let root: string;
  let projectDir: string;
  let tmux: FakeTmux;
  let clock: FakeClock;
  let registry: Registry;
  let audits: AuditEntry[];

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "service-test-")));
    root = path.join(tmp, "root");
    projectDir = path.join(root, "proj");
    fs.mkdirSync(projectDir, { recursive: true });
    tmux = new FakeTmux();
    tmux.defaultScreen = IDLE;
    clock = new FakeClock();
    registry = createRegistry({ dir: path.join(tmp, "reg") });
    audits = [];
  });

  afterEach(() => {
    for (const s of tmux.subcommands()) usedSubcommands.add(s);
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  afterAll(() => {
    expect([...usedSubcommands].sort()).toEqual([...ALLOWED_SUBCOMMANDS].sort());
  });

  function make(
    over: Record<string, unknown> = {},
    extra: { kinds?: KindTable; registry?: Registry; workspace?: string; resolveBinary?: BinaryResolver; agentBasePath?: string } = {},
  ): TmuxAgentService {
    const tmuxAgents = TmuxAgentsConfigSchema.parse({
      enabled: true,
      allowedRoots: [root],
      minStartIntervalMs: 0,
      minSendIntervalMs: 0,
      ...over,
    });
    let n = 0;
    const service = createTmuxAgentService(
      {
        security: { workspace: extra.workspace ?? path.join(tmp, "ws"), additionalWriteDirs: [], dataDir: path.join(tmp, "data") },
        tmuxAgents,
      } as never,
      {
        redact: createRedactor(CONSERVATIVE_PATTERNS),
        caller: "test",
        runner: tmux,
        registry: extra.registry ?? registry,
        audit: { record: async (entry) => void audits.push(entry) },
        clock,
        // The production resolver checks the real file system; most tests do not care where `claude` lives.
        resolveBinary: extra.resolveBinary ?? ((_kind, command) => command),
        ...(extra.agentBasePath !== undefined ? { agentBasePath: extra.agentBasePath } : {}),
        random: () => (n++ % 65536) / 65536,
        ...(extra.kinds ? { kinds: extra.kinds } : {}),
      },
    );
    if (!service) throw new Error("service disabled");
    return service;
  }

  const startInput = (over: Partial<StartInput> = {}): StartInput => ({
    project: "proj",
    directory: projectDir,
    kind: "claude",
    permissionMode: "default",
    ...over,
  });

  const sendInput = (session: string, text: string, over: Record<string, unknown> = {}) => ({
    session,
    text,
    waitForIdleMs: 0,
    queueWhileBusy: false,
    answerPermissionPrompt: false,
    ...over,
  });

  async function started(service: TmuxAgentService, over: Partial<StartInput> = {}) {
    const result = await service.start(startInput(over));
    return { result, name: result.session, fake: tmux.byName(result.session) };
  }

  // -------------------------------------------------------------------------
  // agent binary and an agent that ends right after start
  // -------------------------------------------------------------------------

  describe("agent binary", () => {
    it("fails before any tmux call and writes no record when the binary is not found", async () => {
      const service = make({}, {
        resolveBinary: () => {
          throw new TmuxAgentError("AGENT_BINARY_NOT_FOUND", "claude not found; set tmuxAgents.agentBinaries.claude");
        },
      });
      expect(await codeOf(service.start(startInput()))).toBe("AGENT_BINARY_NOT_FOUND");
      expect(tmux.calls).toEqual([]);
      expect((await registry.read()).records).toEqual([]);
    });

    it("starts the resolved binary with the flags of the kind and mode", async () => {
      const service = make({}, { resolveBinary: (kind, command) => `/opt/agents/${kind}-${command}`, agentBasePath: "/opt/agents" });
      const { fake } = await started(service, { permissionMode: "plan" });
      expect(fake.argv).toEqual(["/opt/agents/claude-claude", "--setting-sources", "user", "--permission-mode", "plan"]);
    });

    it("puts the directory of the resolved binary first on the PATH of the agent (through /usr/bin/env)", async () => {
      const service = make({}, { resolveBinary: () => "/home/u/.local/bin/claude", agentBasePath: "/usr/bin:/bin" });
      const { fake } = await started(service);
      expect(fake.argv).toEqual([
        "/usr/bin/env", "PATH=/home/u/.local/bin:/usr/bin:/bin", "/home/u/.local/bin/claude", "--setting-sources", "user",
      ]);
    });

    it("does not wrap the agent when the directory of the binary is on the PATH already", async () => {
      const service = make({}, { resolveBinary: () => "/usr/bin/claude", agentBasePath: "/usr/bin:/bin" });
      const { fake } = await started(service);
      expect(fake.argv).toEqual(["/usr/bin/claude", "--setting-sources", "user"]);
    });

    it("checks the binary of a recover before the old session is killed", async () => {
      let found = true;
      const service = make({}, {
        resolveBinary: (_kind, command) => {
          if (!found) throw new TmuxAgentError("AGENT_BINARY_NOT_FOUND", "claude not found");
          return command;
        },
      });
      const { name } = await started(service);
      found = false;
      expect(await codeOf(service.recover({ session: name, userConfirmed: true }))).toBe("AGENT_BINARY_NOT_FOUND");
      expect(tmux.callsOf("kill-session")).toEqual([]);
    });

    it("marks the session lost and explains what to check when it ended right after start", async () => {
      tmux.override = (args) =>
        args[0] === "capture-pane" || args[0] === "display-message" ? failed("can't find pane") : undefined;
      const service = make();
      const result = await service.start(startInput());
      expect(result.state).toBe("unknown");
      expect(result.hint).toMatch(/ended right after start/);
      expect(result.hint).toContain("claude --setting-sources user");
      expect(result.hint).toContain("tmuxAgents.agentBinaries");
      const [record] = (await registry.read()).records;
      expect(record?.state).toBe("lost");
      expect(record?.endedAt).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // factory
  // -------------------------------------------------------------------------

  it("returns undefined when disabled", () => {
    const tmuxAgents = TmuxAgentsConfigSchema.parse({});
    expect(createTmuxAgentService({ security: {}, tmuxAgents } as never, { redact: (t) => t, caller: "x" })).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  describe("start", () => {
    it("runs new-session with fixed argv, stores the ids, waits for the TUI and reports the state", async () => {
      const service = make();
      const before = clock.now();
      const { result, fake } = await started(service);

      const call = tmux.callsOf("new-session")[0]!.args;
      expect(call).toEqual([
        "new-session", "-d", "-s", "pa-proj-0000", "-x", "200", "-y", "50", "-c", projectDir,
        "-P", "-F", "#{session_id} #{pane_id} #{session_created}", "--", "claude", "--setting-sources", "user",
      ]);
      expect(clock.now() - before).toBeGreaterThanOrEqual(3000);
      expect(result).toMatchObject({ session: "pa-proj-0000", project: "proj", kind: "claude", cwd: projectDir, state: "idle" });
      expect(result.attachCommand).toContain("attach -r -t '=pa-proj-0000'");
      expect(result.attachCommand).toContain("-S '/tmp/fake-tmux/tmux.sock'");

      const { records } = await registry.read();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        name: "pa-proj-0000", tmuxSessionId: fake.id, tmuxPaneId: fake.paneId, tmuxCreated: fake.created,
        state: "running", creatorPid: process.pid, permissionMode: "default",
      });
      expect(audits).toEqual([expect.objectContaining({ action: "start", ok: true, session: "pa-proj-0000", project: "proj" })]);
    });

    it("passes acceptEdits mode flags", async () => {
      await started(make(), { permissionMode: "acceptEdits" });
      expect(tmux.callsOf("new-session")[0]!.args.slice(-5)).toEqual([
        "claude", "--setting-sources", "user", "--permission-mode", "acceptEdits",
      ]);
    });

    it("reports a trust dialog with a hint", async () => {
      tmux.defaultScreen = TRUST;
      const { result } = await started(make());
      expect(result.state).toBe("waiting_trust");
      expect(result.hint).toMatch(/trust dialog/);
      expect(result.hint).toMatch(/agent_session_attach/);
    });

    it("hints when the screen is not recognized after start", async () => {
      tmux.defaultScreen = EMPTY;
      const { result } = await started(make());
      expect(result.state).toBe("unknown");
      expect(result.hint).toMatch(/not recognized/);
      expect(result.hint).toMatch(/agent_session_attach/);
    });

    it("serializes concurrent starts: the second one sees the first and is rate limited", async () => {
      const service = make({ minStartIntervalMs: 10_000, maxSessions: 3 });
      const results = await Promise.allSettled([service.start(startInput()), service.start(startInput())]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect((rejected.reason as TmuxAgentError).code).toBe("RATE_LIMITED");
      expect(tmux.callsOf("new-session")).toHaveLength(1);
    });

    it("a failed start also counts against minStartIntervalMs", async () => {
      const service = make({ minStartIntervalMs: 10_000 });
      tmux.override = (args) => (args[0] === "new-session" ? failed("boom") : undefined);
      expect(await codeOf(service.start(startInput()))).toBe("TMUX_ERROR");
      tmux.override = undefined;
      expect(await codeOf(service.start(startInput()))).toBe("RATE_LIMITED");
    });

    it("kills an orphan when new-session times out after tmux created the session", async () => {
      const service = make();
      tmux.override = (args) => {
        if (args[0] !== "new-session") return undefined;
        tmux.addSession(args[args.indexOf("-s") + 1]!);
        throw new TmuxAgentError("TIMEOUT", "tmux new-session timed out");
      };
      expect(await codeOf(service.start(startInput()))).toBe("TIMEOUT");
      expect(tmux.sessions.size).toBe(0);
      expect(tmux.callsOf("kill-session")).toHaveLength(1);
      expect((await registry.read()).records).toEqual([]);
    });

    it("kills an orphan when new-session fails after tmux created the session (for example maxBuffer)", async () => {
      const service = make();
      tmux.override = (args) => {
        if (args[0] !== "new-session") return undefined;
        tmux.addSession(args[args.indexOf("-s") + 1]!);
        throw new TmuxAgentError("TMUX_ERROR", "tmux new-session produced too much output");
      };
      expect(await codeOf(service.start(startInput()))).toBe("TMUX_ERROR");
      expect(tmux.sessions.size).toBe(0);
      expect((await registry.read()).records).toEqual([]);
    });

    it("leaves a foreign session alone when new-session times out and no session with our name exists", async () => {
      const service = make();
      tmux.addSession("other");
      tmux.override = (args) => {
        if (args[0] === "new-session") throw new TmuxAgentError("TIMEOUT", "tmux new-session timed out");
        return undefined;
      };
      expect(await codeOf(service.start(startInput()))).toBe("TIMEOUT");
      expect(tmux.sessions.size).toBe(1);
      expect(tmux.callsOf("kill-session")).toHaveLength(0);
    });

    it("hints when the screen cannot be captured after start but the session is alive", async () => {
      const service = make();
      tmux.override = (args) => (args[0] === "capture-pane" ? failed("can't find pane") : undefined);
      const { result } = await started(service);
      expect(result.state).toBe("unknown");
      expect(result.hint).toMatch(/could not be read yet/);
      expect((await registry.read()).records[0]?.state).toBe("running");
    });

    it.each([
      ["root not allowed", () => ({ directory: tmp })],
      ["cwd with #", () => ({ directory: path.join(root, "h#sh") })],
      ["kind not enabled", () => ({ kind: "other" })],
      ["bypass without settings", () => ({ permissionMode: "bypass" as const, confirmBypass: true as const })],
    ])("rejects %s without any tmux call", async (_label, input) => {
      fs.mkdirSync(path.join(root, "h#sh"));
      await expect(make().start(startInput(input()))).rejects.toBeInstanceOf(TmuxAgentError);
      expect(tmux.calls).toHaveLength(0);
      expect((await registry.read()).records).toHaveLength(0);
    });

    it("rejects bypass without confirmBypass even when the setting allows it", async () => {
      const service = make({ allowPermissionBypass: true });
      expect(await codeOf(service.start(startInput({ permissionMode: "bypass" })))).toBe("BYPASS_NOT_ALLOWED");
      expect(tmux.calls).toHaveLength(0);
    });

    it("starts in bypass mode when settings and confirmation agree", async () => {
      const service = make({ allowPermissionBypass: true });
      await service.start(startInput({ permissionMode: "bypass", confirmBypass: true }));
      expect(tmux.callsOf("new-session")[0]!.args).toContain("--dangerously-skip-permissions");
    });

    it("refuses a cwd under the workspace unless its root is trusted", async () => {
      // the workspace is the allowed root itself, so every project in it is writable by the assistant
      expect(await codeOf(make({}, { workspace: root }).start(startInput()))).toBe("ROOT_NOT_TRUSTED");
      expect(tmux.calls).toHaveLength(0);
      await expect(make({ trustedRoots: [root] }, { workspace: root }).start(startInput())).resolves.toBeDefined();
    });

    it("rate limits starts", async () => {
      const service = make({ minStartIntervalMs: 10_000 });
      await started(service);
      expect(await codeOf(service.start(startInput()))).toBe("RATE_LIMITED");
      clock.t += 10_000;
      await expect(service.start(startInput())).resolves.toBeDefined();
    });

    it("refuses the start over maxSessions (registry count)", async () => {
      const service = make({ maxSessions: 1 });
      await started(service);
      expect(await codeOf(service.start(startInput()))).toBe("TOO_MANY_SESSIONS");
      expect(tmux.callsOf("new-session")).toHaveLength(1);
    });

    it("counts live sessions of the own server even with an empty registry", async () => {
      tmux.addSession("pa-x-aaaa");
      tmux.addSession("pa-y-bbbb");
      const service = make({ maxSessions: 2 });
      expect(await codeOf(service.start(startInput()))).toBe("TOO_MANY_SESSIONS");
      expect(tmux.callsOf("new-session")).toHaveLength(0);
    });

    it("refuses to start with a corrupt registry", async () => {
      fs.mkdirSync(path.join(tmp, "reg"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "reg", "registry.json"), "{broken");
      const error = await errorOf(make().start(startInput()));
      expect(error.code).toBe("TMUX_ERROR");
      expect(error.message).toBe("registry corrupt, manual repair needed");
      expect(tmux.callsOf("new-session")).toHaveLength(0);
    });

    it("kills the new session when another process filled the limit meanwhile", async () => {
      const real = registry;
      const first = createRegistry({ dir: path.join(tmp, "reg") });
      const other = (name: string, id: string) => ({
        name, project: "o", kind: "claude", cwd: "/x", permissionMode: "default" as const, createdAt: new Date(clock.now()).toISOString(),
        creatorPid: 1, instanceId: "i", tmuxSessionId: id, tmuxPaneId: `%${id.slice(1)}`, tmuxCreated: "5", state: "running" as const,
      });
      await first.mutate(() => ({ records: [other("pa-o-0001", "$91"), other("pa-o-0002", "$92")], result: undefined }));
      // the service first sees an empty registry (a stale read), then the real one under the lock
      const stale = { read: vi.fn(), mutate: real.mutate.bind(real) } as unknown as Registry;
      (stale.read as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ records: [], corrupt: false })
        .mockResolvedValueOnce({ records: [], corrupt: false })
        .mockImplementation(real.read.bind(real));
      const service = make({ maxSessions: 2 }, { registry: stale });
      expect(await codeOf(service.start(startInput()))).toBe("TOO_MANY_SESSIONS");
      expect(tmux.callsOf("kill-session")).toHaveLength(1);
      expect(tmux.sessions.size).toBe(0);
    });

    it("retries a duplicate session name with a new suffix, then gives up", async () => {
      tmux.addSession("pa-proj-0000");
      const ok = await make().start(startInput());
      expect(ok.session).toBe("pa-proj-0001");

      tmux.calls.length = 0;
      tmux.override = (args) => (args[0] === "new-session" ? failed("duplicate session: x") : undefined);
      const error = await errorOf(make().start(startInput()));
      expect(error.code).toBe("TMUX_ERROR");
      expect(tmux.callsOf("new-session")).toHaveLength(3);
    });

    it("leaves no registry record when tmux fails", async () => {
      tmux.override = (args) => (args[0] === "new-session" ? failed("boom") : undefined);
      expect(await codeOf(make().start(startInput()))).toBe("TMUX_ERROR");
      expect((await registry.read()).records).toHaveLength(0);
      expect(audits[0]).toMatchObject({ action: "start", ok: false, code: "TMUX_ERROR" });
    });

    it("kills the new session when the registry write fails", async () => {
      const failing = { read: registry.read, mutate: vi.fn().mockRejectedValue(new Error("disk full")) } as unknown as Registry;
      await expect(make({}, { registry: failing }).start(startInput())).rejects.toThrow("disk full");
      expect(tmux.callsOf("kill-session")).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // list / status / read / attach / reconcile
  // -------------------------------------------------------------------------

  describe("list, status, read, attach", () => {
    it("lists registry sessions only and honours includeStopped", async () => {
      const service = make();
      const { name } = await started(service);
      tmux.addSession("someone-elses");
      expect((await service.list({ includeStopped: false })).sessions.map((s) => s.session)).toEqual([name]);
      await service.stop({ session: name, force: true, userConfirmed: true });
      expect((await service.list({ includeStopped: false })).sessions).toEqual([]);
      const all = await service.list({ includeStopped: true });
      expect(all.sessions).toEqual([expect.objectContaining({ session: name, state: "stopped" })]);
    });

    it("returns the configured allowedRoots with the list", async () => {
      const service = make();
      expect((await service.list({ includeStopped: false })).allowedRoots).toEqual([root]);
    });

    it("marks vanished sessions as lost when listing", async () => {
      const service = make();
      const { name, fake } = await started(service);
      tmux.sessions.delete(fake.id);
      const all = await service.list({ includeStopped: true });
      expect(all.sessions).toEqual([expect.objectContaining({ session: name, state: "lost" })]);
    });

    it("status checks ownership, captures the pane and runs the detector", async () => {
      const service = make();
      const { name, fake } = await started(service);
      tmux.calls.length = 0;
      const status = await service.status({ session: name });
      expect(tmux.calls.map((c) => c.args)).toEqual([
        ["display-message", "-p", "-t", fake.paneId, "#{session_id} #{session_created}"],
        ["capture-pane", "-p", "-J", "-t", fake.paneId, "-S", "-60"],
      ]);
      expect(status).toMatchObject({ alive: true, state: "idle", confidence: "high", detector: "claude@1", sessionState: "running" });
    });

    it("status reports busy", async () => {
      const service = make();
      const { name, fake } = await started(service);
      fake.screen = BUSY;
      expect((await service.status({ session: name })).state).toBe("busy");
    });

    it("status of a vanished session: alive false, record marked lost", async () => {
      const service = make();
      const { name, fake } = await started(service);
      tmux.sessions.delete(fake.id);
      expect(await service.status({ session: name })).toMatchObject({ alive: false, sessionState: "lost", state: "unknown" });
      expect((await registry.read()).records[0]!.state).toBe("lost");
    });

    it("status rejects unknown names and sessions whose tmux id or creation time differ", async () => {
      const service = make();
      expect(await codeOf(service.status({ session: "pa-nope-1234" }))).toBe("NOT_FOUND");
      const { name, fake } = await started(service);
      fake.created = "123";
      expect(await codeOf(service.status({ session: name }))).toBe("NOT_OWNED");
      expect(tmux.callsOf("kill-session")).toHaveLength(0);
    });

    it("read caps lines at maxOutputLines, redacts and marks the output untrusted", async () => {
      const service = make({ maxOutputLines: 5 });
      const { name, fake } = await started(service);
      fake.screen = `${"filler\n".repeat(10)}key sk-abcdefghijklmnopqrstuvwxyz\nlast line\n`;
      tmux.calls.length = 0;
      const result = await service.read({ session: name, lines: 300 });
      expect(tmux.callsOf("capture-pane")[0]!.args).toContain("-5");
      expect(result).toMatchObject({ untrusted: true, redacted: true, truncated: false, lines: 5 });
      expect(result.output).toBe("filler\nfiller\nfiller\nkey [REDACTED]\nlast line".split("\n").slice(-5).join("\n"));
      expect(result.output).not.toContain("sk-abc");
    });

    it("read uses tmuxAgents.defaultOutputLines when no line count is given", async () => {
      const service = make({ defaultOutputLines: 5 });
      const { name, fake } = await started(service);
      fake.screen = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
      const result = await service.read({ session: name });
      expect(result.lines).toBe(5);
      expect(result.output).toBe("line 16\nline 17\nline 18\nline 19\nline 20");
      expect(tmux.callsOf("capture-pane").at(-1)!.args).toContain("-5");
      expect((await service.read({ session: name, lines: 10 })).lines).toBe(10);
    });

    it("reconcile prunes old stopped and lost records but keeps recent and running ones", async () => {
      const service = make();
      const { name } = await started(service);
      const base = (await registry.read()).records[0]!;
      const day = 24 * 60 * 60 * 1000;
      const ended = (n: number, state: "stopped" | "lost", daysAgo: number) => ({
        ...base, name: `pa-old-000${n}`, tmuxSessionId: `$9${n}`, tmuxPaneId: `%9${n}`, state,
        endedAt: new Date(clock.now() - daysAgo * day).toISOString(),
      });
      await registry.mutate((records) => ({
        records: [...records, ended(1, "stopped", 8), ended(2, "lost", 30), ended(3, "stopped", 1)],
        result: undefined,
      }));
      await service.reconcile();
      expect((await registry.read()).records.map((r) => r.name)).toEqual([name, "pa-old-0003"]);
    });

    it("list prunes old terminal records even when no session is running", async () => {
      const service = make();
      const { name } = await started(service);
      await service.stop({ session: name, force: true, userConfirmed: true });
      clock.t += 8 * 24 * 60 * 60 * 1000;
      tmux.calls.length = 0;
      expect((await service.list({ includeStopped: true })).sessions).toEqual([]);
      expect((await registry.read()).records).toEqual([]);
      expect(tmux.calls).toEqual([]); // nothing to sync, so no tmux call
    });

    it("marks vanished sessions lost with an endedAt time", async () => {
      const service = make();
      const { name, fake } = await started(service);
      tmux.sessions.delete(fake.id);
      await service.reconcile();
      expect((await registry.read()).records[0]).toMatchObject({ name, state: "lost", endedAt: new Date(clock.now()).toISOString() });
    });

    it("attach returns commands and makes no tmux call", async () => {
      const service = make();
      const { name } = await started(service);
      tmux.calls.length = 0;
      const result = await service.attach({ session: name, readOnly: true });
      expect(tmux.calls).toHaveLength(0);
      expect(result.command).toBe(`tmux -S '/tmp/fake-tmux/tmux.sock' attach -r -t '=${name}'`);
      expect(result.readOnlyCommand).toBe(result.command);
      const writable = await service.attach({ session: name, readOnly: false });
      expect(writable.command).toBe(`tmux -S '/tmp/fake-tmux/tmux.sock' attach -t '=${name}'`);
      expect(await codeOf(service.attach({ session: "pa-x-0000", readOnly: true }))).toBe("NOT_FOUND");
    });

    it("reconcile adopts survivors, marks vanished ones lost and only logs foreign sessions", async () => {
      const service = make();
      const a = await started(service);
      await service.start(startInput());
      tmux.sessions.delete(a.fake.id);
      tmux.addSession("pa-foreign-ffff");
      tmux.calls.length = 0;
      expect(await service.reconcile()).toEqual({ adopted: 1, lost: 1, foreign: 1 });
      expect(tmux.subcommands()).toEqual(["list-sessions"]);
      expect((await registry.read()).records.map((r) => r.state)).toEqual(["lost", "running"]);
      expect(tmux.sessions.size).toBe(2);
    });

    it("reconcile with a corrupt registry adopts nothing", async () => {
      fs.mkdirSync(path.join(tmp, "reg"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "reg", "registry.json"), "nope");
      expect(await make().reconcile()).toEqual({ adopted: 0, lost: 0, foreign: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // send / interrupt
  // -------------------------------------------------------------------------

  describe("send and interrupt", () => {
    it("types a single line with send-keys -l and a separate Enter after a gap", async () => {
      const service = make();
      const { name, fake } = await started(service);
      tmux.calls.length = 0;
      const t0 = clock.now();
      const result = await service.send(sendInput(name, "hello agent"));
      const sends = tmux.callsOf("send-keys").map((c) => c.args);
      expect(sends).toEqual([
        ["send-keys", "-t", fake.paneId, "-l", "--", "hello agent"],
        ["send-keys", "-t", fake.paneId, "Enter"],
      ]);
      expect(clock.now() - t0).toBe(150);
      expect(result).toMatchObject({ sent: true, mode: "keys", waited: false, timedOut: false, state: "idle" });
      expect(audits.at(-1)).toMatchObject({ action: "send", ok: true, input: "hello agent" });
    });

    it("passes dangerous-looking text as ONE argv element", async () => {
      const service = make();
      const { name } = await started(service);
      for (const text of ["-rf dash", "a;b $(touch x) `id` \"q\" 'q'", "x \\ y"]) {
        tmux.calls.length = 0;
        await service.send(sendInput(name, text));
        const typed = tmux.callsOf("send-keys")[0]!.args;
        expect(typed.slice(-1)[0]).toBe(text);
        expect(typed.filter((a) => a === text)).toHaveLength(1);
      }
    });

    it("sends trailing semicolons as hex keys because tmux eats a trailing ';'", async () => {
      const service = make();
      const { name, fake } = await started(service);
      tmux.calls.length = 0;
      await service.send(sendInput(name, "run it;;"));
      expect(tmux.callsOf("send-keys").map((c) => c.args)).toEqual([
        ["send-keys", "-t", fake.paneId, "-l", "--", "run it"],
        ["send-keys", "-t", fake.paneId, "-H", "3b", "3b"],
        ["send-keys", "-t", fake.paneId, "Enter"],
      ]);
      for (const call of tmux.calls) expect(call.args.some((a) => a.endsWith(";"))).toBe(false);
    });

    it("pastes multi-line text through a tmux buffer, never through argv", async () => {
      const service = make();
      const { name, fake } = await started(service);
      tmux.calls.length = 0;
      const result = await service.send(sendInput(name, "line one\nline two;"));
      const load = tmux.callsOf("load-buffer")[0]!;
      expect(load.args.slice(0, 2)).toEqual(["load-buffer", "-b"]);
      expect(load.args.slice(-1)).toEqual(["-"]);
      expect(load.input).toBe("line one\nline two;");
      expect(tmux.callsOf("paste-buffer")[0]!.args).toEqual(["paste-buffer", "-p", "-d", "-b", load.args[2], "-t", fake.paneId]);
      expect(tmux.calls.at(-1)!.args).toEqual(["send-keys", "-t", fake.paneId, "Enter"]);
      expect(tmux.subcommands().indexOf("load-buffer")).toBeLessThan(tmux.subcommands().indexOf("paste-buffer"));
      expect(result.mode).toBe("paste");
      expect(fake.pasted).toEqual(["line one\nline two;"]);
      expect(JSON.stringify(tmux.calls.map((c) => c.args))).not.toContain("line one");
    });

    it("deletes the tmux buffer when the paste fails", async () => {
      const service = make();
      const { name } = await started(service);
      tmux.override = (args) => (args[0] === "paste-buffer" ? failed("nope") : undefined);
      expect(await codeOf(service.send(sendInput(name, "a\nb")))).toBe("TMUX_ERROR");
      expect(tmux.callsOf("delete-buffer")).toHaveLength(1);
      expect(tmux.buffers.size).toBe(0);
    });

    it("rejects multi-line text for kinds without paste support", async () => {
      const kinds: KindTable = { plain: { ...KINDS["claude"]!, id: "plain", multilinePaste: "none" } };
      const service = make({}, { kinds });
      const { name } = await started(service, { kind: "plain" });
      tmux.calls.length = 0;
      expect(await codeOf(service.send(sendInput(name, "a\nb")))).toBe("INVALID_INPUT");
      expect(tmux.calls).toHaveLength(0);
    });

    it.each([
      ["control characters", "a\x1bb"],
      ["C1 characters", "a\u009bb"],
      ["too long text", "x".repeat(5000)],
      ["a shell escape", "!ls"],
      ["a slash command", " /permissions"],
      ["a memory note", "# remember this"],
    ])("refuses %s before any tmux call", async (_label, text) => {
      const service = make();
      const { name } = await started(service);
      tmux.calls.length = 0;
      expect(await codeOf(service.send(sendInput(name, text)))).toBe("INVALID_INPUT");
      expect(tmux.calls).toHaveLength(0);
    });

    it("allows the kind's slash commands", async () => {
      const service = make();
      const { name } = await started(service);
      await expect(service.send(sendInput(name, "/clear"))).resolves.toMatchObject({ sent: true });
    });

    it("rate limits sends inside minSendIntervalMs", async () => {
      const service = make({ minSendIntervalMs: 1_500 });
      const { name } = await started(service);
      await service.send(sendInput(name, "one"));
      expect(await codeOf(service.send(sendInput(name, "two")))).toBe("RATE_LIMITED");
      clock.t += 1_500;
      await expect(service.send(sendInput(name, "three"))).resolves.toBeDefined();
    });

    it("refuses while busy unless queueWhileBusy is set", async () => {
      const service = make();
      const { name, fake } = await started(service);
      fake.screen = BUSY;
      expect(await codeOf(service.send(sendInput(name, "more")))).toBe("BUSY");
      await expect(service.send(sendInput(name, "more", { queueWhileBusy: true }))).resolves.toMatchObject({ sent: true });
    });

    it("refuses at a permission prompt unless the prompt may be answered AND the setting allows it", async () => {
      const denied = make();
      const { name, fake } = await started(denied);
      fake.screen = PERMISSION;
      expect(await codeOf(denied.send(sendInput(name, "1")))).toBe("WAITING_PERMISSION");
      expect(await codeOf(denied.send(sendInput(name, "1", { answerPermissionPrompt: true })))).toBe("WAITING_PERMISSION");

      const allowed = make({ allowAnswerPrompts: true });
      expect(await codeOf(allowed.send(sendInput(name, "1")))).toBe("WAITING_PERMISSION");
      await expect(allowed.send(sendInput(name, "1", { answerPermissionPrompt: true }))).resolves.toMatchObject({ sent: true });
      // the input guard is NOT lifted by allowAnswerPrompts
      expect(await codeOf(allowed.send(sendInput(name, "/permissions", { answerPermissionPrompt: true })))).toBe("INVALID_INPUT");
    });

    it("never answers a trust dialog", async () => {
      const service = make({ allowAnswerPrompts: true });
      const { name, fake } = await started(service);
      fake.screen = TRUST;
      const attempt = service.send(sendInput(name, "1", { answerPermissionPrompt: true, queueWhileBusy: true }));
      expect(await codeOf(attempt)).toBe("WAITING_TRUST");
      expect(tmux.callsOf("send-keys")).toHaveLength(0);
    });

    it("waitForIdleMs polls until idle and returns the redacted new output", async () => {
      const service = make();
      const { name, fake } = await started(service);
      let polls = 0;
      fake.screen = () => {
        polls++;
        if (polls <= 1) return IDLE; // the capture before sending
        if (polls <= 3) return BUSY;
        return answerScreen("● reply with sk-abcdefghijklmnopqrstuvwxyz");
      };
      const result = await service.send(sendInput(name, "work", { waitForIdleMs: 30_000 }));
      expect(result).toMatchObject({ waited: true, timedOut: false, state: "idle" });
      expect(result.newOutput).toMatchObject({ untrusted: true, redacted: true });
      expect(result.newOutput!.output).toContain("[REDACTED]");
      expect(result.newOutput!.output).not.toContain("sk-abc");
    });

    it("waitForIdleMs times out (capped by maxWaitMs) and reports it", async () => {
      const service = make({ maxWaitMs: 5_000 });
      const { name, fake } = await started(service);
      let polls = 0;
      fake.screen = () => (++polls <= 1 ? IDLE : BUSY);
      const t0 = clock.now();
      const result = await service.send(sendInput(name, "work", { waitForIdleMs: 300_000 }));
      expect(result).toMatchObject({ waited: true, timedOut: true, state: "busy" });
      expect(clock.now() - t0).toBeLessThan(10_000);
    });

    it("does not take the unchanged old prompt for a finished answer", async () => {
      const service = make();
      const { name } = await started(service);
      const result = await service.send(sendInput(name, "work", { waitForIdleMs: 3_000 }));
      expect(result.timedOut).toBe(true);
    });

    it("stops waiting when the agent asks for a permission", async () => {
      const service = make();
      const { name, fake } = await started(service);
      let polls = 0;
      fake.screen = () => (++polls <= 1 ? IDLE : PERMISSION);
      const result = await service.send(sendInput(name, "work", { waitForIdleMs: 30_000 }));
      expect(result).toMatchObject({ state: "waiting_permission", timedOut: false });
    });

    it("refuses an unrecognized screen unless allowUnknownState is set", async () => {
      const service = make();
      const { name, fake } = await started(service);
      fake.screen = EMPTY;
      expect(await codeOf(service.send(sendInput(name, "hello")))).toBe("UNKNOWN_STATE");
      expect(tmux.callsOf("send-keys")).toHaveLength(0);
      await expect(service.send(sendInput(name, "hello", { allowUnknownState: true }))).resolves.toMatchObject({ sent: true });
    });

    it("allowUnknownState never overrides a dialog", async () => {
      const service = make({ allowAnswerPrompts: true });
      const { name, fake } = await started(service);
      fake.screen = TRUST;
      expect(await codeOf(service.send(sendInput(name, "1", { allowUnknownState: true, answerPermissionPrompt: true })))).toBe(
        "WAITING_TRUST",
      );
      fake.screen = UNKNOWN_MENU;
      expect(await codeOf(service.send(sendInput(name, "1", { allowUnknownState: true })))).toBe("WAITING_PERMISSION");
      expect(tmux.callsOf("send-keys")).toHaveLength(0);
    });

    it("refuses a dialog with unknown wording because it looks like a menu", async () => {
      const service = make();
      const { name, fake } = await started(service);
      fake.screen = UNKNOWN_MENU;
      expect(await codeOf(service.send(sendInput(name, "hello")))).toBe("WAITING_PERMISSION");
    });

    it("applies the leading-character guard to every line of multi-line text", async () => {
      const service = make();
      const { name } = await started(service);
      tmux.calls.length = 0;
      expect(await codeOf(service.send(sendInput(name, "Please run the tests\n!rm -rf ~")))).toBe("INVALID_INPUT");
      expect(await codeOf(service.send(sendInput(name, "task\n/permissions")))).toBe("INVALID_INPUT");
      expect(tmux.callsOf("send-keys")).toHaveLength(0);
      expect(tmux.callsOf("load-buffer")).toHaveLength(0);
    });

    it("a refused send does not use up the send slot", async () => {
      const service = make({ minSendIntervalMs: 1_500 });
      const { name, fake } = await started(service);
      fake.screen = BUSY;
      expect(await codeOf(service.send(sendInput(name, "more")))).toBe("BUSY");
      expect((await registry.read()).records[0]!.lastInputAt).toBeUndefined();
      fake.screen = IDLE;
      await expect(service.send(sendInput(name, "now"))).resolves.toMatchObject({ sent: true });
    });

    it("a send whose typing fails gives the send slot back", async () => {
      const service = make({ minSendIntervalMs: 1_500 });
      const { name } = await started(service);
      await service.send(sendInput(name, "one"));
      const before = (await registry.read()).records[0]!.lastInputAt;
      clock.t += 2_000;
      tmux.override = (args) => (args[0] === "send-keys" && args.includes("-l") ? failed("pane gone") : undefined);
      expect(await codeOf(service.send(sendInput(name, "two")))).toBe("TMUX_ERROR");
      expect((await registry.read()).records[0]!.lastInputAt).toBe(before);
      tmux.override = undefined;
      await expect(service.send(sendInput(name, "three"))).resolves.toMatchObject({ sent: true });
    });

    it("a send to a session that vanished from the registry is NOT_FOUND, not RATE_LIMITED", async () => {
      let wipe = false;
      const wiping: Registry = {
        ...registry,
        mutate: async (fn) => {
          if (wipe) await registry.mutate(() => ({ records: [], result: undefined }));
          return registry.mutate(fn);
        },
      };
      const service = make({}, { registry: wiping });
      const { name } = await started(service);
      wipe = true; // the record disappears (manual repair) between the checks and the slot reservation
      expect(await codeOf(service.send(sendInput(name, "hello")))).toBe("NOT_FOUND");
    });

    it("rate limits before any tmux call", async () => {
      const service = make({ minSendIntervalMs: 1_500 });
      const { name } = await started(service);
      await service.send(sendInput(name, "one"));
      tmux.calls.length = 0;
      expect(await codeOf(service.send(sendInput(name, "two")))).toBe("RATE_LIMITED");
      expect(tmux.calls).toEqual([]);
    });

    it("waitForIdle does not take the echoed message next to an empty prompt for the answer", async () => {
      const service = make();
      const { name, fake } = await started(service);
      const echo = `❯ work\n\n${PROMPT_BOX}\n`;
      const answer = answerScreen("● the real answer");
      const screens = [IDLE, echo, BUSY, answer];
      let polls = 0;
      fake.screen = () => screens[Math.min(polls++, screens.length - 1)]!;
      const result = await service.send(sendInput(name, "work", { waitForIdleMs: 30_000 }));
      expect(result).toMatchObject({ timedOut: false, state: "idle" });
      expect(result.newOutput!.output).toContain("the real answer");
      // Only the reply: no echoed message, no prompt box, no footer.
      expect(result.newOutput!.output).not.toContain("❯");
      expect(result.newOutput!.output).not.toContain("auto mode");
    });

    it("waitForIdle accepts a fast answer when the screen is stable across two polls", async () => {
      const service = make();
      const { name, fake } = await started(service);
      const answer = answerScreen("● quick answer", 1);
      let polls = 0;
      fake.screen = () => (polls++ === 0 ? IDLE : answer);
      const t0 = clock.now();
      const result = await service.send(sendInput(name, "work", { waitForIdleMs: 30_000 }));
      expect(result).toMatchObject({ timedOut: false, state: "idle" });
      expect(result.newOutput!.output).toContain("quick answer");
      expect(clock.now() - t0).toBeLessThan(5_000);
    });

    it("reports a sent message when the screen cannot be read afterwards", async () => {
      const service = make();
      const { name, fake } = await started(service);
      let polls = 0;
      fake.screen = () => {
        if (polls++ > 0) throw new Error("pane is gone");
        return IDLE;
      };
      const result = await service.send(sendInput(name, "work", { waitForIdleMs: 30_000 }));
      expect(result).toMatchObject({ sent: true, state: "unknown", waited: false });
      expect(result.hint).toMatch(/was sent/);
      expect(tmux.callsOf("send-keys").length).toBeGreaterThan(0);
    });

    it("interrupt sends only C-c and counts as input", async () => {
      const service = make();
      const { name, fake } = await started(service);
      tmux.calls.length = 0;
      await service.interrupt({ session: name });
      expect(tmux.callsOf("send-keys").map((c) => c.args)).toEqual([["send-keys", "-t", fake.paneId, "C-c"]]);
      expect((await registry.read()).records[0]!.lastInputAt).toBeDefined();
    });

    it("refuses to talk to a session that is gone", async () => {
      const service = make();
      const { name, fake } = await started(service);
      tmux.sessions.delete(fake.id);
      expect(await codeOf(service.send(sendInput(name, "hi")))).toBe("NOT_FOUND");
      expect(await codeOf(service.interrupt({ session: name }))).toBe("NOT_FOUND");
      expect(await codeOf(service.read({ session: name, lines: 10 }))).toBe("NOT_FOUND");
    });
  });

  // -------------------------------------------------------------------------
  // stop / recover / reaper
  // -------------------------------------------------------------------------

  describe("stop, recover, reaper", () => {
    /** Make a fake agent that exits when it receives /exit + Enter (unless `stubborn`). */
    function exitsOnSlashExit(stubborn = false): void {
      let pending = false;
      tmux.onSendKeys = (session, keys) => {
        if (keys.includes("/exit")) pending = true;
        else if (keys.includes("Enter") && pending && !stubborn) tmux.sessions.delete(session.id);
      };
    }

    it("refuses to stop a busy agent without force", async () => {
      const service = make();
      const { name, fake } = await started(service);
      fake.screen = BUSY;
      expect(await codeOf(service.stop({ session: name, force: false }))).toBe("BUSY");
      expect(tmux.callsOf("kill-session")).toHaveLength(0);
    });

    it("refuses a graceful stop on an unrecognized screen: Enter could confirm a dialog", async () => {
      const service = make();
      const { name, fake } = await started(service);
      fake.screen = EMPTY;
      tmux.calls.length = 0;
      expect(await codeOf(service.stop({ session: name, force: false }))).toBe("UNKNOWN_STATE");
      expect(tmux.callsOf("send-keys")).toHaveLength(0);
      expect(tmux.callsOf("kill-session")).toHaveLength(0);
      // the forced path with confirmation still works
      await expect(service.stop({ session: name, force: true, userConfirmed: true })).resolves.toMatchObject({ method: "forced" });
    });

    it("force without userConfirmed is INVALID_INPUT", async () => {
      const service = make();
      const { name } = await started(service);
      expect(await codeOf(service.stop({ session: name, force: true }))).toBe("INVALID_INPUT");
      expect(tmux.callsOf("kill-session")).toHaveLength(0);
    });

    it("stops an idle agent gracefully with /exit", async () => {
      const service = make();
      const { name, fake } = await started(service);
      exitsOnSlashExit();
      tmux.calls.length = 0;
      const result = await service.stop({ session: name, force: false });
      expect(result).toEqual({ session: name, method: "graceful", gone: true });
      expect(tmux.callsOf("send-keys").map((c) => c.args)).toEqual([
        ["send-keys", "-t", fake.paneId, "-l", "--", "/exit"],
        ["send-keys", "-t", fake.paneId, "Enter"],
      ]);
      expect(tmux.callsOf("kill-session")).toHaveLength(0);
      expect((await registry.read()).records[0]!.state).toBe("stopped");
    });

    it("kills after the grace period when the agent ignores /exit", async () => {
      const service = make({ stopGraceMs: 2_000 });
      const { name, fake } = await started(service);
      exitsOnSlashExit(true);
      const t0 = clock.now();
      const result = await service.stop({ session: name, force: false });
      expect(result.method).toBe("kill-after-grace");
      expect(clock.now() - t0).toBeGreaterThanOrEqual(2_000);
      expect(tmux.callsOf("kill-session").map((c) => c.args)).toEqual([["kill-session", "-t", fake.id]]);
      expect((await registry.read()).records[0]!.state).toBe("stopped");
    });

    it("forced stop with confirmation kills right away", async () => {
      const service = make();
      const { name, fake } = await started(service);
      fake.screen = BUSY;
      const result = await service.stop({ session: name, force: true, userConfirmed: true });
      expect(result.method).toBe("forced");
      expect(tmux.sessions.size).toBe(0);
      expect(audits.at(-1)).toMatchObject({ action: "stop-force", ok: true });
    });

    it("a forced stop whose kill fails keeps the record running and reports the error", async () => {
      const service = make();
      const { name } = await started(service);
      tmux.override = (args) => (args[0] === "kill-session" ? failed("server hiccup") : undefined);
      expect(await codeOf(service.stop({ session: name, force: true, userConfirmed: true }))).toBe("TMUX_ERROR");
      expect(tmux.sessions.size).toBe(1);
      expect((await registry.read()).records[0]).toMatchObject({ state: "running" });
      expect((await registry.read()).records[0]!.endedAt).toBeUndefined();
    });

    it("a kill after the grace period that fails keeps the record running", async () => {
      const service = make({ stopGraceMs: 1_000 });
      const { name } = await started(service);
      exitsOnSlashExit(true);
      tmux.override = (args) => (args[0] === "kill-session" ? failed("server hiccup") : undefined);
      expect(await codeOf(service.stop({ session: name, force: false }))).toBe("TMUX_ERROR");
      expect((await registry.read()).records[0]).toMatchObject({ state: "running" });
    });

    it("stopped records get an endedAt time", async () => {
      const service = make();
      const { name } = await started(service);
      await service.stop({ session: name, force: true, userConfirmed: true });
      expect((await registry.read()).records[0]).toMatchObject({ state: "stopped", endedAt: new Date(clock.now()).toISOString() });
    });

    it("never kills when ownership cannot be verified", async () => {
      const service = make();
      const { name, fake } = await started(service);
      fake.created = "42";
      expect(await codeOf(service.stop({ session: name, force: true, userConfirmed: true }))).toBe("NOT_OWNED");
      expect(tmux.callsOf("kill-session")).toHaveLength(0);
    });

    it("recover needs userConfirmed", async () => {
      const service = make();
      const { name } = await started(service);
      expect(await codeOf(service.recover({ session: name, userConfirmed: undefined as never }))).toBe("INVALID_INPUT");
      expect(tmux.callsOf("kill-session")).toHaveLength(0);
    });

    it("recover interrupts, kills the old session and starts a new one in the same cwd, kind and mode", async () => {
      const service = make({ maxSessions: 1, allowPermissionBypass: true });
      const { name, fake } = await started(service, { permissionMode: "bypass", confirmBypass: true });
      const result = await service.recover({ session: name, userConfirmed: true });
      expect(result).toMatchObject({ oldSession: name, method: "force-restart", cwd: projectDir, permissionMode: "bypass" });
      expect(result.session).not.toBe(name);
      expect(tmux.callsOf("send-keys")[0]!.args).toEqual(["send-keys", "-t", fake.paneId, "C-c"]);
      expect(tmux.callsOf("kill-session").map((c) => c.args)).toEqual([["kill-session", "-t", fake.id]]);
      const { records } = await registry.read();
      expect(records.map((r) => r.state)).toEqual(["stopped", "running"]);
      expect(records[1]).toMatchObject({ recoveredFrom: name });
    });

    it("recover audits the old session as session and the new one as newSession", async () => {
      const service = make({ maxSessions: 1 });
      const { name } = await started(service);
      const result = await service.recover({ session: name, userConfirmed: true });
      expect(audits.at(-1)).toMatchObject({ action: "recover", session: name, newSession: result.session, ok: true });
    });

    it("recover does not start a new session when the old one survives the kill", async () => {
      const service = make({ maxSessions: 2 });
      const { name } = await started(service);
      tmux.override = (args) => (args[0] === "kill-session" ? failed("server hiccup") : undefined);
      expect(await codeOf(service.recover({ session: name, userConfirmed: true }))).toBe("TMUX_ERROR");
      expect(tmux.callsOf("new-session")).toHaveLength(1);
      expect((await registry.read()).records).toEqual([expect.objectContaining({ name, state: "running" })]);
    });

    it("recover re-checks the start gates BEFORE killing the old session", async () => {
      const first = make({ allowPermissionBypass: true });
      const { name } = await started(first, { permissionMode: "bypass", confirmBypass: true });
      const later = make({ allowPermissionBypass: false });
      expect(await codeOf(later.recover({ session: name, userConfirmed: true }))).toBe("BYPASS_NOT_ALLOWED");
      expect(tmux.callsOf("kill-session")).toHaveLength(0);
      expect(tmux.sessions.size).toBe(1);
    });

    it("recover of a lost session just starts a new one", async () => {
      const service = make();
      const { name, fake } = await started(service);
      tmux.sessions.delete(fake.id);
      const result = await service.recover({ session: name, userConfirmed: true });
      expect(result.oldSession).toBe(name);
      expect(tmux.callsOf("kill-session")).toHaveLength(0);
    });

    it("reaper stops idle sessions older than idleReapMinutes and leaves busy ones alone", async () => {
      const service = make({ idleReapMinutes: 1, maxSessions: 3 });
      const idle = await started(service);
      const busy = await started(service);
      busy.fake.screen = BUSY;
      exitsOnSlashExit();
      expect(await service.reapOnce()).toEqual([]);
      clock.t += 61_000;
      expect(await service.reapOnce()).toEqual([idle.name]);
      const states = Object.fromEntries((await registry.read()).records.map((r) => [r.name, r.state]));
      expect(states).toEqual({ [idle.name]: "stopped", [busy.name]: "running" });
      expect(audits.some((a) => a.action === "reap" && a.session === idle.name)).toBe(true);
    });

    it("the reaper leaves a session alone while a human is attached to it", async () => {
      const service = make({ idleReapMinutes: 1 });
      const { name, fake } = await started(service);
      fake.attached = 1;
      clock.t += 61_000;
      expect(await service.reapOnce()).toEqual([]);
      expect(tmux.callsOf("send-keys")).toHaveLength(0);
      fake.attached = 0;
      exitsOnSlashExit();
      expect(await service.reapOnce()).toEqual([name]);
    });

    it("a recent send keeps a session from being reaped", async () => {
      const service = make({ idleReapMinutes: 1 });
      const { name } = await started(service);
      clock.t += 50_000;
      await service.send(sendInput(name, "still here"));
      clock.t += 30_000;
      expect(await service.reapOnce()).toEqual([]);
    });

    it("idleReapMinutes=0 never creates a timer or reaps", async () => {
      const spy = vi.spyOn(globalThis, "setInterval");
      const service = make({ idleReapMinutes: 0 });
      service.startReaper();
      expect(spy).not.toHaveBeenCalled();
      expect(await service.reapOnce()).toEqual([]);
    });

    it("close clears the reaper timer and kills no session", async () => {
      vi.useFakeTimers();
      try {
        const service = make({ idleReapMinutes: 1 });
        const { name } = await started(service);
        service.startReaper();
        service.startReaper(); // idempotent
        expect(vi.getTimerCount()).toBe(1);
        service.close();
        expect(vi.getTimerCount()).toBe(0);
        expect(tmux.sessions.size).toBe(1);
        expect((await registry.read()).records[0]).toMatchObject({ name, state: "running" });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
