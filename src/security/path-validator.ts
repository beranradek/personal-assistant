import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PathValidationOptions {
  workspaceDir: string;
  additionalReadDirs?: string[];
  additionalWriteDirs?: string[];
  operation?: "read" | "write"; // default: "write"
}

export interface PathValidationResult {
  valid: boolean;
  resolvedPath?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a directory path for prefix comparison.
 *
 * Resolves to an absolute path, resolves symlinks if the dir exists,
 * and ensures a trailing path separator so that `/home/user/.pa` does not
 * match `/home/user/.pa-evil`.
 */
function normalizeDir(dir: string): string {
  let resolved = path.resolve(dir);

  // Resolve symlinks on the directory itself if it exists
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // Directory may not exist yet; use the resolved path as-is
  }

  // Ensure trailing separator for safe startsWith comparison
  if (!resolved.endsWith(path.sep)) {
    resolved += path.sep;
  }
  return resolved;
}

/**
 * Check whether `resolvedPath` is equal to or contained within `dir`.
 *
 * Uses trailing-separator comparison to prevent prefix attacks.
 */
function isWithinDir(resolvedPath: string, dir: string): boolean {
  const normalizedDir = normalizeDir(dir);
  // The path itself is the directory (exact match before trailing sep was added)
  const dirWithoutSep = normalizedDir.slice(0, -1);
  if (resolvedPath === dirWithoutSep) {
    return true;
  }
  // The path is inside the directory
  return resolvedPath.startsWith(normalizedDir);
}

// ---------------------------------------------------------------------------
// Main validation function
// ---------------------------------------------------------------------------

/**
 * Validate that `inputPath` resolves to a location within allowed directories.
 *
 * Security logic:
 * 1. Reject empty / whitespace-only / null-byte paths
 * 2. Expand leading `~` to `os.homedir()`
 * 3. Resolve relative paths against `workspaceDir`
 * 4. Resolve to absolute via `path.resolve()`
 * 5. Resolve symlinks via `fs.realpathSync()` (fall back if file doesn't exist)
 * 6. Check if resolved path is within `workspaceDir`
 * 7. For read ops, also check `additionalReadDirs` and `additionalWriteDirs`
 * 8. For write ops, also check `additionalWriteDirs`
 */
export function validatePath(
  inputPath: string,
  options: PathValidationOptions,
): PathValidationResult {
  const {
    workspaceDir,
    additionalReadDirs = [],
    additionalWriteDirs = [],
    operation = "write",
  } = options;

  // ---- Step 1: Reject obviously invalid input ----

  if (!inputPath || inputPath.trim().length === 0) {
    return { valid: false, reason: "Path is empty or whitespace-only" };
  }

  if (inputPath.includes("\0")) {
    return { valid: false, reason: "Path contains null bytes" };
  }

  // ---- Step 2: Expand ~ ----

  let expandedPath = inputPath;
  if (expandedPath === "~") {
    expandedPath = os.homedir();
  } else if (expandedPath.startsWith("~/")) {
    expandedPath = path.join(os.homedir(), expandedPath.slice(2));
  }

  // ---- Step 3: Resolve relative paths against workspaceDir ----

  let absolutePath: string;
  if (path.isAbsolute(expandedPath)) {
    absolutePath = expandedPath;
  } else {
    absolutePath = path.join(workspaceDir, expandedPath);
  }

  // ---- Step 4: Normalize (handles ../ etc.) ----

  absolutePath = path.resolve(absolutePath);

  // ---- Step 5: Resolve symlinks ----

  let resolvedPath: string;
  try {
    resolvedPath = fs.realpathSync(absolutePath);
  } catch {
    // File doesn't exist yet — use the normalized absolute path.
    // This is safe because path.resolve() already removed ../ sequences.
    resolvedPath = absolutePath;
  }

  // ---- Step 6: Check workspace ----

  if (isWithinDir(resolvedPath, workspaceDir)) {
    return { valid: true, resolvedPath };
  }

  // ---- Step 7: Check additional dirs based on operation ----

  // For write operations: only additionalWriteDirs grant access
  // For read operations: both additionalReadDirs and additionalWriteDirs grant access
  const allowedExtraDirs: string[] = [];

  if (operation === "read") {
    allowedExtraDirs.push(...additionalReadDirs, ...additionalWriteDirs);
  } else {
    // write
    allowedExtraDirs.push(...additionalWriteDirs);
  }

  for (const dir of allowedExtraDirs) {
    if (isWithinDir(resolvedPath, dir)) {
      return { valid: true, resolvedPath };
    }
  }

  // ---- Step 8: Denied ----

  return {
    valid: false,
    reason:
      `Path is outside allowed directories: '${inputPath}' resolves to ` +
      `'${resolvedPath}' which is outside workspace '${workspaceDir}'` +
      (allowedExtraDirs.length > 0
        ? ` and additional directories [${allowedExtraDirs.join(", ")}]`
        : ""),
  };
}
