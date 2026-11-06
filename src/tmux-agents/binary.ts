import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TmuxAgentsConfig } from "../core/types.js";
import { TmuxAgentError } from "./errors.js";
import { KINDS, type KindTable } from "./kinds.js";

/** Resolves the program of an agent kind to an absolute executable path, or throws `AGENT_BINARY_NOT_FOUND`. */
export type BinaryResolver = (kindId: string, command: string) => string;

/** Where a program was found, for the log line. */
export type BinarySource = "setting" | "command" | "PATH" | "known location";

export interface BinaryResolverDeps {
  /** Environment whose `PATH` is searched: the same one that the tmux server (and so the agent) gets. */
  env?: NodeJS.ProcessEnv;
  /** Kind table with the well-known install locations (default: the production table). */
  kinds?: KindTable;
  /** Home directory for `~/` in well-known locations (default: the home of the daemon user). */
  home?: string;
  /** Called when a program was resolved by a search (not for a cache hit). */
  onResolved?: (kindId: string, file: string, source: BinarySource) => void;
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
 * Resolve the program of an agent kind to an absolute path before a tmux session is created. A systemd user service often
 * has a short `PATH` (no `~/.local/bin`), so a bare `claude` would make the session die at once. Order:
 * 1. `tmuxAgents.agentBinaries.<kind>` (optional override; must be executable, no fallback when it is not),
 * 2. an absolute command of the kind,
 * 3. the `PATH` of the allowlisted environment,
 * 4. the well-known install locations of the kind.
 * A result is cached per resolver and checked again on every use; a failure is never cached, so a program that is installed
 * later is found without a restart. No shell is involved.
 */
export function createBinaryResolver(
  config: Pick<TmuxAgentsConfig, "agentBinaries">,
  deps: BinaryResolverDeps = {},
): BinaryResolver {
  const searchPath = (deps.env ?? process.env)["PATH"] ?? "";
  const kinds = deps.kinds ?? KINDS;
  const home = deps.home ?? os.homedir();
  const cache = new Map<string, string>();

  const expand = (location: string): string => (location.startsWith("~/") ? path.join(home, location.slice(2)) : location);

  function search(kindId: string, command: string): { file: string; source: BinarySource } | undefined {
    const configured = Object.hasOwn(config.agentBinaries, kindId) ? config.agentBinaries[kindId] : undefined;
    if (configured !== undefined) {
      if (isExecutableFile(configured)) return { file: configured, source: "setting" };
      throw new TmuxAgentError("AGENT_BINARY_NOT_FOUND", `tmuxAgents.agentBinaries.${kindId} is not an executable file: ${configured}`);
    }
    if (path.isAbsolute(command)) {
      if (isExecutableFile(command)) return { file: command, source: "command" };
      throw new TmuxAgentError("AGENT_BINARY_NOT_FOUND", `Agent program is not an executable file: ${command}`);
    }
    for (const dir of searchPath.split(path.delimiter)) {
      if (!path.isAbsolute(dir)) continue;
      const candidate = path.join(dir, command);
      if (isExecutableFile(candidate)) return { file: candidate, source: "PATH" };
    }
    for (const candidate of knownLocations(kindId)) {
      if (isExecutableFile(candidate)) return { file: candidate, source: "known location" };
    }
    return undefined;
  }

  function knownLocations(kindId: string): string[] {
    const kind = Object.hasOwn(kinds, kindId) ? kinds[kindId] : undefined;
    return (kind?.knownLocations ?? []).map(expand).filter((location) => path.isAbsolute(location));
  }

  return (kindId, command) => {
    const cached = cache.get(kindId);
    if (cached !== undefined) {
      if (isExecutableFile(cached)) return cached;
      cache.delete(kindId);
    }
    const found = search(kindId, command);
    if (!found) {
      const locations = knownLocations(kindId);
      throw new TmuxAgentError(
        "AGENT_BINARY_NOT_FOUND",
        `Agent program "${command}" (kind ${kindId}) was not found. Searched the PATH of the agent environment ` +
          `(${searchPath === "" ? "PATH is empty" : searchPath})` +
          (locations.length > 0 ? ` and these locations: ${locations.join(", ")}` : "") +
          `. Install it, or set tmuxAgents.agentBinaries.${kindId} to its absolute path.`,
      );
    }
    cache.set(kindId, found.file);
    deps.onResolved?.(kindId, found.file, found.source);
    return found.file;
  };
}

/**
 * `PATH` for the agent session: the directory of the resolved program first, so that wrappers and siblings of the program are
 * found. Returns `undefined` when the directory is already on the `PATH` (nothing to override).
 */
export function agentEnvPath(binary: string, basePath: string | undefined): string | undefined {
  if (!path.isAbsolute(binary)) return undefined;
  const dir = path.dirname(binary);
  const entries = (basePath ?? "").split(path.delimiter).filter((entry) => entry !== "");
  if (entries.includes(dir)) return undefined;
  return [dir, ...entries].join(path.delimiter);
}
