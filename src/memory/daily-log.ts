import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AuditEntrySchema } from "../core/types.js";
import type { AuditEntry } from "../core/types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("daily-log");

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

function redactAuditEntry(
  entry: AuditEntry,
  redact: (text: string) => string,
): AuditEntry {
  return {
    ...entry,
    ...(entry.userMessage ? { userMessage: redact(entry.userMessage) } : {}),
    ...(entry.errorMessage ? { errorMessage: redact(entry.errorMessage) } : {}),
    ...(entry.assistantResponse ? { assistantResponse: redact(entry.assistantResponse) } : {}),
    ...(entry.toolResult && typeof entry.toolResult === "string"
      ? { toolResult: redact(entry.toolResult) }
      : {}),
  };
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
  redact?: (text: string) => string,
): Promise<void> {
  const safe = redact ? redactAuditEntry(entry, redact) : entry;
  const date = dateFromTimestamp(safe.timestamp);
  const dailyDir = path.join(workspaceDir, "daily");

  await fs.mkdir(dailyDir, { recursive: true, mode: 0o700 });

  const filePath = path.join(dailyDir, `${date}.jsonl`);
  await fs.appendFile(filePath, JSON.stringify(safe) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
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
      try {
        entries.push(AuditEntrySchema.parse(JSON.parse(line)));
      } catch {
        log.warn({ line }, "Skipping invalid audit entry");
      }
    }
  }

  return entries;
}
