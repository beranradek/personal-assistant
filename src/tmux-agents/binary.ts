import * as fs from "node:fs";
import * as path from "node:path";
import type { TmuxAgentsConfig } from "../core/types.js";
import { TmuxAgentError } from "./errors.js";

/** Resolves the program of an agent kind to an absolute executable path, or throws `AGENT_BINARY_NOT_FOUND`. */
export type BinaryResolver = (kindId: string, command: string) => string;

export interface BinaryResolverDeps {
  /** Environment whose `PATH` is searched: the same one that the tmux server (and so the agent) gets. */
  env?: NodeJS.ProcessEnv;
}

function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pre-flight check of the agent program before a tmux session is created. A systemd user service often has a short `PATH`
 * (no `~/.local/bin`), so a bare `claude` would make the session die at once. Order: `tmuxAgents.agentBinaries.<kind>`
 * (must be executable, no fallback), an absolute command of the kind, then the `PATH` of the allowlisted environment.
 */
export function createBinaryResolver(
  config: Pick<TmuxAgentsConfig, "agentBinaries">,
  deps: BinaryResolverDeps = {},
): BinaryResolver {
  const searchPath = (deps.env ?? process.env)["PATH"] ?? "";

  return (kindId, command) => {
    const setting = `tmuxAgents.agentBinaries.${kindId}`;
    const configured = Object.hasOwn(config.agentBinaries, kindId) ? config.agentBinaries[kindId] : undefined;
    if (configured !== undefined) {
      if (isExecutableFile(configured)) return configured;
      throw new TmuxAgentError("AGENT_BINARY_NOT_FOUND", `${setting} is not an executable file: ${configured}`);
    }
    if (path.isAbsolute(command)) {
      if (isExecutableFile(command)) return command;
      throw new TmuxAgentError("AGENT_BINARY_NOT_FOUND", `Agent program is not an executable file: ${command}`);
    }
    for (const dir of searchPath.split(path.delimiter)) {
      if (!path.isAbsolute(dir)) continue;
      const candidate = path.join(dir, command);
      if (isExecutableFile(candidate)) return candidate;
    }
    throw new TmuxAgentError(
      "AGENT_BINARY_NOT_FOUND",
      `Agent program "${command}" (kind ${kindId}) was not found on the PATH of the agent environment ` +
        `(${searchPath === "" ? "PATH is empty" : searchPath}). Set ${setting} to its absolute path.`,
    );
  };
}
