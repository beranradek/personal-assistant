/** `pa agents-view` command: user-facing entry (open the view) and the hidden `--watch` controller mode. */
import * as path from "node:path";
import { loadConfig } from "../core/config.js";
import type { Config } from "../core/types.js";
import { createRegistry } from "./registry.js";
import { createTmuxRunner } from "./runner.js";
import { createViewLog } from "./view-log.js";
import {
  createAgentSessionLister,
  createRegisteredSessionLister,
  createUserTmux,
  openAgentsView,
  parseAgentsViewArgs,
  preflightAssistantCommand,
  resolveAssistantCwd,
  resolveInteractiveShell,
  runViewController,
  showAgentsView,
  type AgentsViewArgs,
  type UserTmux,
} from "./view.js";

export interface AgentsViewCliDeps {
  user?: UserTmux;
  /** Live agent sessions (default: `list-sessions` on the configured agents socket, limited to registered running sessions). */
  listAgentSessions?: () => Promise<string[]>;
  env?: NodeJS.ProcessEnv;
  /** Directory `pa agents-view` runs in (default: `process.cwd()`); the default start directory of the assistant pane. */
  cwd?: string;
  /** Node and script path used to start the controller window (default: this process). */
  execPath?: string;
  scriptPath?: string;
  out?: (line: string) => void;
  /** stdin and stdout are a terminal (default: checked on this process). */
  isTty?: boolean;
  /** Where the controller logs errors (default: `<dataDir>/tmux-agents/view.log`). */
  onControllerError?: (err: unknown) => void;
}

/** Build the controller command (argv) for the hidden window. */
function controllerArgv(
  runtime: { execPath: string; scriptPath: string },
  configPath: string | undefined,
  windowId: string,
  readOnly: boolean,
): string[] {
  return [
    runtime.execPath, runtime.scriptPath, ...(configPath ? ["--config", configPath] : []),
    "agents-view", "--watch", windowId, ...(readOnly ? ["--read-only"] : []),
  ];
}

/**
 * Both modes need a terminal. The assistant's Bash tool has none, so it cannot start a view (and with it a shell command through
 * `--assistant`); the controller runs in a tmux pane, which has one. This is a guard on top of the Bash allowlist, which lists `pa`
 * as a whole and does not look at subcommands.
 */
function requireTerminal(deps: AgentsViewCliDeps): void {
  const tty = deps.isTty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!tty) {
    throw new Error("pa agents-view needs an interactive terminal (stdin and stdout must be a TTY). Run it yourself, not from a tool.");
  }
}

/** The agents server's sessions that the service also has as running records (never a foreign `pa-...` session). */
function defaultListAgentSessions(agents: Config["tmuxAgents"], dataDir: string): () => Promise<string[]> {
  const runner = createTmuxRunner({ tmuxBinary: agents.tmuxBinary, socketPath: agents.socketPath, envAllowlist: [] });
  return createRegisteredSessionLister(createAgentSessionLister(runner), createRegistry({ dir: path.join(dataDir, "tmux-agents") }));
}

/** The hidden controller (runs in the `amy-ctl-<n>` window of the view): keeps the panes in sync until the view ends. */
async function runWatch(
  parsed: AgentsViewArgs & { watch: string },
  config: Config,
  user: UserTmux,
  listAgentSessions: () => Promise<string[]>,
  deps: AgentsViewCliDeps,
): Promise<number> {
  const env = deps.env ?? process.env;
  // The controller is started by `pa agents-view` inside a tmux pane (which sets TMUX_PANE); never by hand elsewhere.
  if (!env["TMUX_PANE"]) throw new Error("The agents view controller runs inside a tmux pane (started by `pa agents-view`).");
  const agents = config.tmuxAgents;
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  for (const signal of signals) process.once(signal, stop);
  try {
    const end = await runViewController({
      user,
      listAgentSessions,
      tmuxBinary: agents.tmuxBinary,
      agentSocketPath: agents.socketPath,
      readOnly: parsed.readOnly,
      windowId: parsed.watch,
      signal: abort.signal,
      onError: deps.onControllerError ?? createViewLog(path.join(config.security.dataDir, "tmux-agents")),
    });
    return end === "tmux-unreachable" ? 1 : 0;
  } finally {
    for (const signal of signals) process.off(signal, stop);
  }
}

/**
 * Run `pa agents-view`. `args` are the CLI arguments after `agents-view` without `--config`; `configPath` is the value of
 * `--config` (passed on to the controller so it finds the same agents socket).
 */
export async function runAgentsView(
  configDir: string,
  args: readonly string[],
  configPath: string | undefined,
  deps: AgentsViewCliDeps = {},
): Promise<number> {
  requireTerminal(deps);
  const out = deps.out ?? ((line: string) => console.log(line));
  const parsed = parseAgentsViewArgs(args);
  const config = loadConfig(configDir);
  const agents = config.tmuxAgents;
  const user = deps.user ?? createUserTmux({ tmuxBinary: agents.tmuxBinary });
  const listAgentSessions = deps.listAgentSessions ?? defaultListAgentSessions(agents, config.security.dataDir);

  if (parsed.watch !== undefined) return runWatch({ ...parsed, watch: parsed.watch }, config, user, listAgentSessions, deps);

  const env = deps.env ?? process.env;
  // An assistant word that is no program (an alias) would make the only pane die at once: refuse before anything is created.
  if (!parsed.interactiveShell) preflightAssistantCommand(parsed.assistant, env);
  if (!agents.enabled) out("Note: tmuxAgents.enabled is false in settings, so no agent panes will appear.");
  // Fail early (in the foreground) when the agents socket directory is unusable; the controller runs hidden.
  await listAgentSessions();

  const insideTmux = env["TMUX"] !== undefined;
  const assistantCwd = resolveAssistantCwd(parsed.assistantCwd, deps.cwd ?? process.cwd());
  const interactiveShell = parsed.interactiveShell ? resolveInteractiveShell(env) : undefined;
  if (interactiveShell && !/(^|\/)(zsh|bash)$/.test(interactiveShell)) {
    out(`Note: --interactive-shell is verified only with zsh and bash (shell: ${interactiveShell}).`);
  }
  const runtime = { execPath: deps.execPath ?? process.execPath, scriptPath: deps.scriptPath ?? process.argv[1] ?? "pa" };
  const view = await openAgentsView(user, {
    session: parsed.session,
    assistant: parsed.assistant,
    assistantCwd,
    interactiveShell,
    insideTmux,
    controllerArgv: (windowId) => controllerArgv(runtime, configPath, windowId, parsed.readOnly),
  });
  for (const warning of view.warnings) out(`Note: ${warning}`);
  out(view.created ? "Agents view created." : "Agents view already exists.");
  if (!parsed.attach) return 0;
  return showAgentsView(user, view, insideTmux);
}
