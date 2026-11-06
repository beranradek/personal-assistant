import * as fs from "node:fs";
import * as path from "node:path";
import { TmuxAgentError } from "./errors.js";

export interface RootsPolicy {
  /** Directories where agents may start. */
  allowedRoots: readonly string[];
  /** Entries of allowedRoots that may lie under a directory the assistant can write (D20). */
  trustedRoots: readonly string[];
  /** Directories the assistant can write: `security.workspace` and `security.additionalWriteDirs`. */
  writableDirs: readonly string[];
}

/** Resolve symlinks; `undefined` when the path does not exist or cannot be read. */
function realpathOrUndefined(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

/**
 * Whether `target` equals `dir` or lies inside it. Trailing-separator comparison prevents prefix attacks
 * (`/a/root-evil` is not inside `/a/root`). Both paths must already be real paths.
 * Same logic as `isWithinDir` in `src/security/path-validator.ts` (copied on purpose, plan decision OD2).
 */
export function isWithinDir(target: string, dir: string): boolean {
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return target === prefix.slice(0, -1) || target.startsWith(prefix);
}

/** Reject text that cannot be a plain absolute directory path. tmux expands `#` in `-c`, so `#` is refused everywhere. */
function assertPlainAbsolutePath(directory: string): void {
  if (directory.includes("\0")) throw new TmuxAgentError("ROOT_NOT_ALLOWED", "Directory contains a NUL character");
  if (directory.startsWith("~") || !path.isAbsolute(directory)) {
    throw new TmuxAgentError("ROOT_NOT_ALLOWED", "Directory must be an absolute path (no ~ expansion)");
  }
  if (directory.includes("#")) throw new TmuxAgentError("ROOT_NOT_ALLOWED", "Directory must not contain '#'");
}

/**
 * Resolve `directory` to a real directory path inside one of the allowed roots.
 * Returns the real path and the (real path of the) matching root.
 */
export function resolveAllowedDirectory(
  directory: string,
  allowedRoots: readonly string[],
): { cwd: string; root: string } {
  assertPlainAbsolutePath(directory);
  const cwd = realpathOrUndefined(directory);
  if (cwd === undefined || !fs.statSync(cwd).isDirectory()) {
    throw new TmuxAgentError("ROOT_NOT_ALLOWED", "Directory does not exist or is not a directory");
  }
  if (cwd.includes("#")) throw new TmuxAgentError("ROOT_NOT_ALLOWED", "Directory must not contain '#'");
  for (const allowed of allowedRoots) {
    const root = realpathOrUndefined(allowed);
    if (root !== undefined && isWithinDir(cwd, root)) return { cwd, root };
  }
  throw new TmuxAgentError("ROOT_NOT_ALLOWED", "Directory is not inside tmuxAgents.allowedRoots");
}

/**
 * A directory the assistant can write could hold a planted `.claude/settings.json` (hook, allow rule).
 * Starting an agent there is allowed only when the matching allowed root is also a trusted root (D20).
 */
export function checkTrust(cwd: string, root: string, policy: Pick<RootsPolicy, "trustedRoots" | "writableDirs">): void {
  const writable = policy.writableDirs.some((dir) => {
    const real = realpathOrUndefined(dir) ?? path.resolve(dir);
    return isWithinDir(cwd, real);
  });
  if (!writable) return;
  const trusted = policy.trustedRoots.some((t) => realpathOrUndefined(t) === root);
  if (!trusted) {
    throw new TmuxAgentError(
      "ROOT_NOT_TRUSTED",
      "Directory is writable by the assistant; add its allowed root to tmuxAgents.trustedRoots to start agents there",
    );
  }
}

/** Resolve and check a start directory: allowed root, no `#`, trust boundary. Returns the real path. */
export function resolveStartDirectory(directory: string, policy: RootsPolicy): string {
  const { cwd, root } = resolveAllowedDirectory(directory, policy.allowedRoots);
  checkTrust(cwd, root, policy);
  return cwd;
}
