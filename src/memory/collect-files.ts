import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Collect all memory-related file paths for indexing.
 *
 * Always includes MEMORY.md from workspaceDir, auto-discovers all .md files in
 * the memory/ subdirectory of workspaceDir, and adds any extraPaths (resolved
 * relative to workspaceDir if not absolute). Returned paths are deduplicated.
 */
export function collectMemoryFiles(
  workspaceDir: string,
  extraPaths: string[],
): string[] {
  const paths: string[] = [];

  // 1. Always include MEMORY.md
  paths.push(path.join(workspaceDir, "MEMORY.md"));

  // 2. Auto-discover .md files in memory/ subdirectory
  const memorySubdir = path.join(workspaceDir, "memory");
  try {
    const entries = fs.readdirSync(memorySubdir);
    for (const entry of entries) {
      if (entry.endsWith(".md")) {
        paths.push(path.join(memorySubdir, entry));
      }
    }
  } catch {
    // memory/ directory does not exist — silently skip
  }

  // 3. Include extraPaths, resolving relative paths against workspaceDir
  for (const p of extraPaths) {
    const resolved = path.isAbsolute(p) ? p : path.join(workspaceDir, p);
    paths.push(resolved);
  }

  // 4. Deduplicate while preserving order
  return [...new Set(paths)];
}
