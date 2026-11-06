import { createLogger } from "../core/logger.js";
import type { Config } from "../core/types.js";
import { createTmuxAgentService, type CreateTmuxAgentServiceOptions } from "./index.js";
import type { TmuxAgentService } from "./types.js";

const log = createLogger("tmux-agents");

export interface StartTmuxAgentServiceOptions extends CreateTmuxAgentServiceOptions {
  /** Run the idle reaper. Only the daemon does, so that exactly one reaper exists. */
  reaper: boolean;
}

/**
 * Create the tmux agent service for a process (daemon or `pa mcp-server`), log the effective settings, warn about a
 * `tmux` entry in the Bash allowlist, adopt surviving sessions and optionally start the reaper.
 * Returns `undefined` when `tmuxAgents.enabled` is not true: callers then register no tools.
 */
export async function startTmuxAgentService(
  config: Pick<Config, "security" | "tmuxAgents">,
  options: StartTmuxAgentServiceOptions,
): Promise<TmuxAgentService | undefined> {
  // `?.`: configs built by hand (tests, probes) may lack the whole block
  if (config.tmuxAgents?.enabled !== true) return undefined;
  const service = createTmuxAgentService(config, options);
  if (!service) return undefined;

  const cfg = config.tmuxAgents;
  log.info(
    {
      socketPath: cfg.socketPath,
      allowedRoots: cfg.allowedRoots.length,
      trustedRoots: cfg.trustedRoots.length,
      maxSessions: cfg.maxSessions,
      bypassAllowed: cfg.allowPermissionBypass,
      caller: options.caller,
    },
    "Tmux agent sessions enabled",
  );
  if (config.security.allowedCommands.includes("tmux")) {
    log.warn(
      "'tmux' is in security.allowedCommands: the assistant could run tmux through Bash and bypass the agent session " +
        "guards. Remove it (the agent session tools run tmux themselves).",
    );
  }
  try {
    const summary = await service.reconcile();
    log.info(summary, "Tmux agent sessions reconciled");
  } catch (err) {
    log.warn({ err }, "Could not reconcile tmux agent sessions");
  }
  if (options.reaper) service.startReaper();
  return service;
}
