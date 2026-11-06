/**
 * `pa agents-view`: one tmux window in the USER's own tmux with the main assistant on the left and one pane per agent
 * session on the right (stacked). The agent panes are tmux clients of the agents' server: writable by default (the user can
 * type into an agent), read-only with `--read-only`. A small controller process adds and removes the panes while the
 * assistant starts and stops agent sessions.
 *
 * This is a user CLI, not an assistant tool: it uses its own tmux runner for the user's tmux (default server, user config)
 * with a fixed subcommand allowlist. The agents' dedicated server is only listed (`list-sessions`) and attached to.
 */
import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { SESSION_PATTERN } from "./names.js";
import type { TmuxRunner } from "./runner.js";
import { execTmux } from "./tmux-exec.js";

/** The only tmux subcommands that the view may run on the user's tmux. */
export const USER_TMUX_SUBCOMMANDS = [
  "has-session",
  "new-session",
  "new-window",
  "split-window",
  "select-layout",
  "select-pane",
  "select-window",
  "list-panes",
  "list-windows",
  "list-sessions",
  "set-option",
  "attach-session",
  "switch-client",
  "display-message",
  "kill-window",
] as const;

const ALLOWED = new Set<string>(USER_TMUX_SUBCOMMANDS);

export const VIEW_WINDOW_NAME = "amy";
export const VIEW_CTL_WINDOW_NAME = "amy-ctl";
export const DEFAULT_VIEW_SESSION = "amy";
export const DEFAULT_ASSISTANT_COMMAND = "pa claude";
/** Controller poll interval. One cheap `list-sessions` and one `list-panes` per tick. */
export const VIEW_POLL_MS = 2_000;
/** The controller gives up after this many failing ticks in a row (tmux unreachable). */
const MAX_CONSECUTIVE_FAILURES = 5;
const MAIN_PANE_WIDTH = "50%";
/** Pane border label: the agent session name, or `assistant` for the main pane. */
const PANE_BORDER_FORMAT = " #{?@pa_agent,#{@pa_agent},assistant} ";
/** `new-session`/`new-window` print `<window id>|<pane id>` of what they created. */
const PRINT_CREATED = ["-P", "-F", "#{window_id}|#{pane_id}"];
/** Name of the user's own tmux session that holds the view (not an agent session: see `SESSION_PATTERN`). */
const VIEW_SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const WINDOW_ID_PATTERN = /^@[0-9]+$/;
const MAX_ASSISTANT_COMMAND_LENGTH = 2_000;

export interface UserTmuxResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runner for the user's own tmux. */
export interface UserTmux {
  run(args: readonly string[]): Promise<UserTmuxResult>;
  /** `attach-session` with the terminal of this process (needs a TTY). Resolves with the tmux exit code. */
  attach(target: string): Promise<number>;
}

export interface UserTmuxOptions {
  tmuxBinary?: string;
  /** Private socket (tests). Default: the user's default tmux server. */
  socketPath?: string;
  /** tmux config file (tests pass /dev/null). Default: tmux reads the user's own configuration. */
  configFile?: string;
  env?: NodeJS.ProcessEnv;
  execFile?: typeof nodeExecFile;
  spawn?: typeof nodeSpawn;
}

export function createUserTmux(options: UserTmuxOptions = {}): UserTmux {
  const binary = options.tmuxBinary ?? "tmux";
  const execFile = options.execFile ?? nodeExecFile;
  const spawn = options.spawn ?? nodeSpawn;
  const env = options.env ?? process.env;
  const socketArgs = [...(options.configFile ? ["-f", options.configFile] : []), ...(options.socketPath ? ["-S", options.socketPath] : [])];

  return {
    run(args) {
      return execTmux({ binary, prefix: socketArgs, allowed: ALLOWED, args, env, execFile });
    },
    attach(target) {
      return new Promise<number>((resolve, reject) => {
        const child = spawn(binary, [...socketArgs, "attach-session", "-t", target], { env, stdio: "inherit" });
        child.on("error", reject);
        child.on("exit", (code) => resolve(code ?? 0));
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Validation and argument parsing
// ---------------------------------------------------------------------------

export function validateViewSession(name: string): string {
  if (!VIEW_SESSION_PATTERN.test(name)) {
    throw new Error(`Invalid tmux session name (use letters, digits, '_' and '-', at most 32 characters): ${name}`);
  }
  return name;
}

/** The assistant command is typed by the user on their own CLI and runs through the tmux shell (like `tmux new-window <cmd>`). */
export function validateAssistantCommand(command: string): string {
  const trimmed = command.trim();
  if (trimmed === "" || trimmed.length > MAX_ASSISTANT_COMMAND_LENGTH) throw new Error("Invalid --assistant command (empty or too long)");
  if (/[\x00\n\r]/.test(trimmed)) throw new Error("Invalid --assistant command (newline or NUL)");
  if (trimmed.startsWith("-") || trimmed.endsWith(";")) {
    throw new Error("Invalid --assistant command (must not start with '-' or end with ';')");
  }
  return trimmed;
}

/**
 * Resolve the start directory of the assistant pane: an existing directory, made absolute against `cwd`
 * (default: the directory `pa agents-view` runs in). Used for the assistant pane only, never for agent panes.
 */
export function resolveAssistantCwd(value: string | undefined, cwd: string): string {
  if (value !== undefined && /[\x00\n\r]/.test(value)) throw new Error("Invalid --assistant-cwd (newline or NUL)");
  const resolved = path.resolve(cwd, value ?? ".");
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(resolved).isDirectory();
  } catch {
    // reported below
  }
  if (!isDirectory) throw new Error(`--assistant-cwd is not an existing directory: ${resolved}`);
  return resolved;
}

/**
 * Shell for `--interactive-shell`: `$SHELL` when it is an absolute path to an executable, else `/bin/sh`.
 * Only zsh and bash are verified to load their rc files (and so aliases) this way.
 */
export function resolveInteractiveShell(env: NodeJS.ProcessEnv): string {
  const candidate = env["SHELL"];
  if (candidate && path.isAbsolute(candidate) && !candidate.includes("\0")) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // fall back
    }
  }
  return "/bin/sh";
}

/**
 * argv of the assistant command for tmux. Default: ONE element, which tmux runs through `$SHELL -c` (non-interactive, rc files and
 * aliases are not loaded). With `interactiveShell`: `<shell> -i -c <command>`, as separate argv elements (no extra shell string),
 * so the rc files (aliases) load. No `exec` in front: an alias is not expanded after `exec`.
 */
export function buildAssistantCommand(assistant: string, interactiveShell?: string): string[] {
  return interactiveShell ? [interactiveShell, "-i", "-c", assistant] : [assistant];
}

export interface AgentsViewArgs {
  assistant: string;
  /** Start directory of the assistant pane (resolved later; default: the current directory). */
  assistantCwd?: string;
  /** Run the assistant command in an interactive shell so that aliases work. Default off. */
  interactiveShell: boolean;
  /** Agent panes are read-only (`attach -r`). Default: writable. */
  readOnly: boolean;
  /** Explicit session name. Without it: a new window in the current tmux session when run inside tmux, else session `amy`. */
  session?: string;
  attach: boolean;
  /** Internal controller mode: the window id to keep in sync. */
  watch?: string;
}

/** Parse the arguments after `agents-view` (`--config <path>` already removed). */
export function parseAgentsViewArgs(args: readonly string[]): AgentsViewArgs {
  const result: AgentsViewArgs = { assistant: DEFAULT_ASSISTANT_COMMAND, interactiveShell: false, readOnly: false, attach: true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = (): string => {
      const next = args[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--assistant") result.assistant = validateAssistantCommand(value());
    else if (arg === "--assistant-cwd") {
      const dir = value();
      if (/[\x00\n\r]/.test(dir)) throw new Error("Invalid --assistant-cwd (newline or NUL)");
      result.assistantCwd = dir;
    } else if (arg === "--interactive-shell" || arg === "-i") result.interactiveShell = true;
    else if (arg === "--read-only") result.readOnly = true;
    else if (arg === "--session") result.session = validateViewSession(value());
    else if (arg === "--no-attach") result.attach = false;
    else if (arg === "--watch") {
      const id = value();
      if (!WINDOW_ID_PATTERN.test(id)) throw new Error(`Invalid window id: ${id}`);
      result.watch = id;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pure reconcile logic
// ---------------------------------------------------------------------------

export interface ViewState {
  /** Sessions for which the controller created a pane and that were alive at the last tick. */
  known: ReadonlySet<string>;
  /** Sessions whose pane the user closed by hand while the session lives: not re-added. */
  dismissed: ReadonlySet<string>;
}

export const EMPTY_VIEW_STATE: ViewState = { known: new Set(), dismissed: new Set() };

/**
 * Decide which agent sessions need a new pane.
 * `live`: sessions on the agents server; `panesWithAgent`: sessions that have a pane now.
 * A known session without a pane that is still alive was closed by the user: it is dismissed until the session ends.
 */
export function planView(
  live: readonly string[],
  panesWithAgent: ReadonlySet<string>,
  state: ViewState,
): { toAdd: string[]; next: ViewState } {
  const liveSet = new Set(live.filter((name) => SESSION_PATTERN.test(name)));
  const known = new Set<string>();
  const dismissed = new Set<string>();
  for (const name of state.dismissed) if (liveSet.has(name)) dismissed.add(name);
  for (const name of state.known) {
    if (!liveSet.has(name)) continue; // the session ended: its pane closes by itself
    if (panesWithAgent.has(name)) known.add(name);
    else dismissed.add(name);
  }
  const toAdd = [...liveSet].filter((name) => !panesWithAgent.has(name) && !dismissed.has(name)).sort();
  for (const name of toAdd) known.add(name);
  for (const name of liveSet) if (panesWithAgent.has(name)) known.add(name);
  return { toAdd, next: { known, dismissed } };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function mustSucceed(result: UserTmuxResult, what: string): string {
  if (result.code !== 0) throw new Error(`tmux ${what} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  return result.stdout;
}

export interface ViewPane {
  paneId: string;
  main: boolean;
  /** Agent session mirrored by this pane (empty for other panes). */
  agent: string;
}

/** Panes of the view window, or `null` when the window (or the tmux server) is gone. */
export async function listViewPanes(user: UserTmux, windowId: string): Promise<ViewPane[] | null> {
  const result = await user.run(["list-panes", "-t", windowId, "-F", "#{pane_id}|#{@pa_main}|#{@pa_agent}"]);
  if (result.code !== 0) return null;
  const panes: ViewPane[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [paneId = "", main = "", agent = ""] = line.split("|");
    if (!/^%[0-9]+$/.test(paneId)) continue;
    panes.push({ paneId, main: main === "1", agent: SESSION_PATTERN.test(agent) ? agent : "" });
  }
  return panes;
}

/** Re-apply the layout: assistant on the left, the other panes stacked on the right. */
export async function applyViewLayout(user: UserTmux, windowId: string): Promise<void> {
  mustSucceed(await user.run(["select-layout", "-t", windowId, "main-vertical"]), "select-layout");
}

async function configureViewWindow(user: UserTmux, windowId: string, mainPaneId: string): Promise<void> {
  const steps: string[][] = [
    ["set-option", "-p", "-t", mainPaneId, "@pa_main", "1"],
    ["set-option", "-w", "-t", windowId, "remain-on-exit", "off"],
    ["set-option", "-w", "-t", windowId, "main-pane-width", MAIN_PANE_WIDTH],
    ["set-option", "-w", "-t", windowId, "pane-border-status", "top"],
    ["set-option", "-w", "-t", windowId, "pane-border-format", PANE_BORDER_FORMAT],
  ];
  for (const step of steps) mustSucceed(await user.run(step), step[0]!);
}

interface WindowRef {
  id: string;
  name: string;
}

async function listWindows(user: UserTmux, sessionTarget: string): Promise<WindowRef[]> {
  const out = mustSucceed(await user.run(["list-windows", "-t", sessionTarget, "-F", "#{window_id}|#{window_name}"]), "list-windows");
  return out
    .split("\n")
    .filter((line) => line.includes("|"))
    .map((line) => {
      const [id = "", name = ""] = line.split("|");
      return { id, name };
    });
}

export interface OpenViewOptions {
  /** Explicit session name; see `AgentsViewArgs.session`. */
  session?: string;
  assistant: string;
  /** Absolute start directory of the assistant pane (`-c`); the controller window and agent panes do not get it. */
  assistantCwd: string;
  /** Shell for `--interactive-shell` (see `buildAssistantCommand`); undefined runs the command through the tmux shell. */
  interactiveShell?: string;
  /** True when this process runs inside the user's tmux ($TMUX is set). */
  insideTmux: boolean;
  /** Command (argv) for the hidden controller window; receives the view window id. */
  controllerArgv: (windowId: string) => string[];
}

export interface OpenedView {
  windowId: string;
  /** tmux target of the session that holds the window (`=name` or a session id). */
  sessionTarget: string;
  /** True when the view window was created now (false: an existing view was reused). */
  created: boolean;
  mode: "session" | "window";
}

/** Create the view window (and the controller window) when missing. Idempotent. */
export async function openAgentsView(user: UserTmux, options: OpenViewOptions): Promise<OpenedView> {
  const mode: OpenedView["mode"] = options.session !== undefined || !options.insideTmux ? "session" : "window";
  let sessionTarget: string;
  let windowId: string | undefined;
  let mainPaneId: string | undefined;
  /** Shared tail of `new-session` / `new-window` for the assistant pane: start directory, printed ids, command. */
  const assistantArgs = [
    "-c", options.assistantCwd, ...PRINT_CREATED, "--", ...buildAssistantCommand(options.assistant, options.interactiveShell),
  ];

  if (mode === "session") {
    const name = options.session ?? DEFAULT_VIEW_SESSION;
    sessionTarget = `=${name}`;
    if ((await user.run(["has-session", "-t", sessionTarget])).code !== 0) {
      const create = ["new-session", "-d", "-s", name, "-n", VIEW_WINDOW_NAME, ...assistantArgs];
      [windowId, mainPaneId] = mustSucceed(await user.run(create), "new-session").trim().split("|");
    }
  } else {
    sessionTarget = mustSucceed(await user.run(["display-message", "-p", "#{session_id}"]), "display-message").trim();
  }

  if (windowId === undefined) {
    const existing = (await listWindows(user, sessionTarget)).find((window) => window.name === VIEW_WINDOW_NAME);
    if (existing) windowId = existing.id;
    else {
      const create = ["new-window", "-d", "-t", `${sessionTarget}:`, "-n", VIEW_WINDOW_NAME, ...assistantArgs];
      [windowId, mainPaneId] = mustSucceed(await user.run(create), "new-window").trim().split("|");
    }
  }
  if (!windowId || !WINDOW_ID_PATTERN.test(windowId)) throw new Error("tmux did not return a window id");

  const created = mainPaneId !== undefined;
  if (mainPaneId !== undefined) await configureViewWindow(user, windowId, mainPaneId);

  const hasController = (await listWindows(user, sessionTarget)).some((window) => window.name === VIEW_CTL_WINDOW_NAME);
  if (!hasController) {
    const create = ["new-window", "-d", "-t", `${sessionTarget}:`, "-n", VIEW_CTL_WINDOW_NAME, "--", ...options.controllerArgv(windowId)];
    mustSucceed(await user.run(create), "new-window");
  }
  await applyViewLayout(user, windowId);
  return { windowId, sessionTarget, created, mode };
}

/** Show the view: select its window, then attach (outside tmux) or switch the client (inside tmux). */
export async function showAgentsView(user: UserTmux, view: OpenedView, insideTmux: boolean): Promise<number> {
  mustSucceed(await user.run(["select-window", "-t", view.windowId]), "select-window");
  if (view.mode === "window") return 0;
  if (insideTmux) {
    mustSucceed(await user.run(["switch-client", "-t", view.sessionTarget]), "switch-client");
    return 0;
  }
  return user.attach(view.sessionTarget);
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export type ViewControllerEnd = "window-gone" | "assistant-gone" | "tmux-unreachable" | "aborted";

export interface ViewControllerDeps {
  user: UserTmux;
  /** Live agent sessions on the agents server (names; an absent server gives `[]`). */
  listAgentSessions: () => Promise<string[]>;
  /** tmux binary and socket for the nested attach inside each agent pane. */
  tmuxBinary: string;
  agentSocketPath: string;
  /** Attach read-only (`attach -r`). Default: writable, so the user can type into the agent. */
  readOnly?: boolean;
  windowId: string;
  signal: AbortSignal;
  pollMs?: number;
  /** Sleep that ends early on abort (default: a timer that is cleared on abort). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onError?: (err: unknown) => void;
}

/** List the live sessions of the agents server through the (read-only used) agents runner. */
export function createAgentSessionLister(runner: Pick<TmuxRunner, "run">): () => Promise<string[]> {
  return async () => {
    const result = await runner.run(["list-sessions", "-F", "#{session_name}"]);
    if (result.noServer) return [];
    if (result.code !== 0) throw new Error(`tmux list-sessions failed: ${result.stderr.trim()}`);
    return result.stdout.split("\n").filter((line) => SESSION_PATTERN.test(line));
  };
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

async function addAgentPane(deps: ViewControllerDeps, session: string): Promise<void> {
  const created = mustSucceed(
    await deps.user.run([
      "split-window", "-d", "-t", deps.windowId, "-P", "-F", "#{pane_id}", "--",
      "env", "-u", "TMUX", deps.tmuxBinary, "-u", "-S", deps.agentSocketPath, "attach-session",
      ...(deps.readOnly ? ["-r"] : []), "-t", `=${session}`,
    ]),
    "split-window",
  ).trim();
  if (!/^%[0-9]+$/.test(created)) throw new Error("tmux did not return a pane id");
  // A failing tag means the pane is already gone (the session ended at once): not an error for the loop.
  const tagged = await deps.user.run(["set-option", "-p", "-t", created, "@pa_agent", session]);
  if (tagged.code !== 0) deps.onError?.(new Error(`tmux set-option failed: ${tagged.stderr.trim()}`));
}

/**
 * Keep the view window in sync with the live agent sessions until the window or the assistant pane is gone, tmux stays
 * unreachable, or `signal` aborts. Panes of ended sessions close by themselves (the nested attach exits).
 * The agents server's options are never changed.
 */
export async function runViewController(deps: ViewControllerDeps): Promise<ViewControllerEnd> {
  const pollMs = deps.pollMs ?? VIEW_POLL_MS;
  const sleep = deps.sleep ?? abortableSleep;
  let state = EMPTY_VIEW_STATE;
  let layoutPaneCount = -1;
  let failures = 0;

  while (!deps.signal.aborted) {
    try {
      const panes = await listViewPanes(deps.user, deps.windowId);
      if (panes === null) return "window-gone";
      if (!panes.some((pane) => pane.main)) {
        await deps.user.run(["kill-window", "-t", deps.windowId]);
        return "assistant-gone";
      }
      const live = await deps.listAgentSessions();
      const plan = planView(live, new Set(panes.filter((pane) => pane.agent !== "").map((pane) => pane.agent)), state);
      let paneCount = panes.length;
      for (const session of plan.toAdd) {
        await addAgentPane(deps, session);
        paneCount++;
      }
      state = plan.next;
      if (paneCount !== layoutPaneCount) {
        await applyViewLayout(deps.user, deps.windowId);
        layoutPaneCount = paneCount;
      }
      failures = 0;
    } catch (err) {
      deps.onError?.(err);
      if (++failures >= MAX_CONSECUTIVE_FAILURES) return "tmux-unreachable";
    }
    await sleep(pollMs, deps.signal);
  }
  return "aborted";
}
