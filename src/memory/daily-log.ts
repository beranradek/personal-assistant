import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AuditEntry } from "../core/types.js";

/**
 * Extract the YYYY-MM-DD date portion from an ISO-8601 timestamp.
 * Falls back to today's date if the timestamp is missing or unparseable.
 */
function dateFromTimestamp(timestamp: string | undefined): string {
  if (timestamp) {
    const match = timestamp.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) {
      return match[1];
    }
  }
  return new Date().toISOString().slice(0, 10);
}

/**
 * Append a single audit entry to the daily JSONL log file.
 *
 * The file is stored at `{workspaceDir}/daily/YYYY-MM-DD.jsonl`.
 * The `daily/` directory and the file itself are created automatically
 * if they do not exist yet.
 */
export async function appendAuditEntry(
  workspaceDir: string,
  entry: AuditEntry,
): Promise<void> {
  const date = dateFromTimestamp(entry.timestamp);
  const dailyDir = path.join(workspaceDir, "daily");

  await fs.mkdir(dailyDir, { recursive: true });

  const filePath = path.join(dailyDir, `${date}.jsonl`);
  await fs.appendFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * Read all audit entries from the JSONL log file for a given date.
 *
 * Returns an empty array if the file or directory does not exist.
 */
export async function readAuditEntries(
  workspaceDir: string,
  date: string,
): Promise<AuditEntry[]> {
  const filePath = path.join(workspaceDir, "daily", `${date}.jsonl`);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const lines = raw.trimEnd().split("\n");
  const entries: AuditEntry[] = [];

  for (const line of lines) {
    if (line.trim()) {
      entries.push(JSON.parse(line) as AuditEntry);
    }
  }

  return entries;
}
