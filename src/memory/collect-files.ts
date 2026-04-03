import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Scan the daily/ subdirectory of workspaceDir for .jsonl audit log files
 * whose date (parsed from the filename YYYY-MM-DD.jsonl) falls within the
 * given retention window (i.e. not older than retentionDays from today).
 */
export function collectDailyLogFiles(
  workspaceDir: string,
  retentionDays: number,
): string[] {
  const dailyDir = path.join(workspaceDir, "daily");
  const result: string[] = [];

  let entries: string[];
  try {
    entries = fs.readdirSync(dailyDir);
  } catch {
    // daily/ directory does not exist — silently skip
    return result;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  // Normalize to start of day (UTC) for date-only comparisons
  cutoff.setUTCHours(0, 0, 0, 0);

  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;

    // Parse date from filename YYYY-MM-DD.jsonl
    const dateStr = entry.slice(0, 10); // "YYYY-MM-DD"
    const fileDate = new Date(dateStr + "T00:00:00.000Z");
    if (isNaN(fileDate.getTime())) continue;

    if (fileDate >= cutoff) {
      result.push(path.join(dailyDir, entry));
    }
  }

  return result;
}

export interface DailyLogIndexingOptions {
  indexDailyLogs: boolean;
  dailyLogRetentionDays: number;
}

/**
 * Collect all memory-related file paths for indexing.
 *
 * Always includes MEMORY.md from workspaceDir, auto-discovers all .md files in
 * the memory/ subdirectory of workspaceDir, and adds any extraPaths (resolved
 * relative to workspaceDir if not absolute). When dailyLogOptions is provided
 * and indexDailyLogs is true, also includes daily JSONL audit log files within
 * the configured retention window. Returned paths are deduplicated.
 */
export function collectMemoryFiles(
  workspaceDir: string,
  extraPaths: string[],
  dailyLogOptions?: DailyLogIndexingOptions,
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

  // 4. Include daily JSONL audit logs when enabled
  if (dailyLogOptions?.indexDailyLogs) {
    const dailyFiles = collectDailyLogFiles(
      workspaceDir,
      dailyLogOptions.dailyLogRetentionDays,
    );
    paths.push(...dailyFiles);
  }

  // 5. Deduplicate while preserving order
  return [...new Set(paths)];
}
