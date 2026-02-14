import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionMessage } from "../core/types.js";

// ---------------------------------------------------------------------------
// Per-path write lock to prevent concurrent file corruption
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<void>>();

async function withLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(filePath) ?? Promise.resolve();
  let release: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(filePath, next);

  await prev;
  try {
    return await fn();
  } finally {
    release!();
    // Clean up if we're the last in line
    if (locks.get(filePath) === next) {
      locks.delete(filePath);
    }
  }
}

/**
 * Append a single message to a session JSONL file.
 * Creates parent directories and the file if they don't exist.
 */
export async function appendMessage(
  sessionPath: string,
  message: SessionMessage,
): Promise<void> {
  return withLock(sessionPath, async () => {
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    await fs.appendFile(sessionPath, JSON.stringify(message) + "\n", "utf-8");
  });
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
  return withLock(sessionPath, async () => {
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    const data = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await fs.appendFile(sessionPath, data, "utf-8");
  });
}
