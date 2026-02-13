import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createLogger } from "../core/logger.js";
import type { SessionMessage } from "../core/types.js";
import type { TranscriptLine } from "./types.js";

const log = createLogger("session-store");

/**
 * Append a single message to a session JSONL file.
 * Creates parent directories and the file if they don't exist.
 */
export async function appendMessage(
  sessionPath: string,
  message: SessionMessage,
): Promise<void> {
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  await fs.appendFile(sessionPath, JSON.stringify(message) + "\n", "utf-8");
}

/**
 * Append multiple messages to a session JSONL file in a single write.
 * Creates parent directories and the file if they don't exist.
 * No-op for an empty array.
 */
export async function appendMessages(
  sessionPath: string,
  messages: SessionMessage[],
): Promise<void> {
  if (messages.length === 0) return;
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  const data = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  await fs.appendFile(sessionPath, data, "utf-8");
}

/**
 * Load the full transcript from a session JSONL file.
 * Returns an empty array if the file does not exist.
 * Corrupt (non-parseable) lines are skipped with a warning log.
 * Empty lines are silently skipped.
 */
export async function loadTranscript(
  sessionPath: string,
): Promise<TranscriptLine[]> {
  let raw: string;
  try {
    raw = await fs.readFile(sessionPath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const lines = raw.split("\n");
  const result: TranscriptLine[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    try {
      result.push(JSON.parse(trimmed) as TranscriptLine);
    } catch {
      log.warn({ line: trimmed }, "Skipping corrupt transcript line");
    }
  }

  return result;
}

/**
 * Atomically replace the contents of a session JSONL file.
 *
 * 1. If the file already exists, copy it to `${sessionPath}.bak`
 * 2. Write new content to `${sessionPath}.tmp`
 * 3. Rename `.tmp` to the real path (atomic on most filesystems)
 */
export async function rewriteTranscript(
  sessionPath: string,
  lines: TranscriptLine[],
): Promise<void> {
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });

  // Step 1: backup existing file if it exists
  try {
    await fs.copyFile(sessionPath, sessionPath + ".bak");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    // No existing file to backup — that's fine
  }

  // Step 2: write to tmp file
  const tmpPath = sessionPath + ".tmp";
  const data = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  await fs.writeFile(tmpPath, data, "utf-8");

  // Step 3: atomic rename
  await fs.rename(tmpPath, sessionPath);
}
