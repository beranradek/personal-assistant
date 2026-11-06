/** `pa agents-view` command: user-facing entry (open the view) and the hidden `--watch` controller mode. */
import { loadConfig } from "../core/config.js";
import { createTmuxRunner } from "./runner.js";
import {
  createAgentSessionLister,
  createUserTmux,
  openAgentsView,
  parseAgentsViewArgs,
  resolveAssistantCwd,
  resolveInteractiveShell,
  runViewController,
  showAgentsView,
  type UserTmux,
} from "./view.js";

export interface AgentsViewCliDeps {
  user?: UserTmux;
  /** Live agent sessions (default: `list-sessions` on the configured agents socket). */
  listAgentSessions?: () => Promise<string[]>;
  env?: NodeJS.ProcessEnv;
  /** Directory `pa agents-view` runs in (default: `process.cwd()`); the default start directory of the assistant pane. */
  cwd?: string;
  /** Node and script path used to start the controller window (default: this process). */
  execPath?: string;
  scriptPath?: string;
  out?: (line: string) => void;
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
 * Run `pa agents-view`. `args` are the CLI arguments after `agents-view` without `--config`; `configPath` is the value of
 * `--config` (passed on to the controller so it finds the same agents socket).
 */
export async function runAgentsView(
  configDir: string,
  args: readonly string[],
  configPath: string | undefined,
  deps: AgentsViewCliDeps = {},
): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const parsed = parseAgentsViewArgs(args);
  const config = loadConfig(configDir);
  const agents = config.tmuxAgents;
  const user = deps.user ?? createUserTmux({ tmuxBinary: agents.tmuxBinary });
  const listAgentSessions =
    deps.listAgentSessions ??
    createAgentSessionLister(createTmuxRunner({ tmuxBinary: agents.tmuxBinary, socketPath: agents.socketPath, envAllowlist: [] }));

  if (parsed.watch !== undefined) {
    const abort = new AbortController();
    const stop = (): void => abort.abort();
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, stop);
    const end = await runViewController({
      user,
      listAgentSessions,
      tmuxBinary: agents.tmuxBinary,
      agentSocketPath: agents.socketPath,
      readOnly: parsed.readOnly,
      windowId: parsed.watch,
      signal: abort.signal,
    });
    return end === "tmux-unreachable" ? 1 : 0;
  }

  if (!agents.enabled) out("Note: tmuxAgents.enabled is false in settings, so no agent panes will appear.");
  // Fail early (in the foreground) when the agents socket directory is unusable; the controller runs hidden.
  await listAgentSessions();

  const env = deps.env ?? process.env;
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
  out(view.created ? "Agents view created." : "Agents view already exists.");
  if (!parsed.attach) return 0;
  return showAgentsView(user, view, insideTmux);
}
