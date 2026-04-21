import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveUserPath } from "./config.js";

export type ClaudePromptLogEntry = {
  timestamp: string;
  kind: "turn_start";
  backend: "claude";
  sessionKey: string;
  trigger: "heartbeat" | "user";
  systemPrompt: {
    type: "preset";
    preset: string;
    append: string;
  };
  userMessage: string;
};

export type CodexPromptLogEntry = {
  timestamp: string;
  kind: "turn_start";
  backend: "codex";
  sessionKey: string;
  trigger: "heartbeat" | "user";
  developerInstructions: string;
  userMessage: string;
};

export type PromptLogEntry = ClaudePromptLogEntry | CodexPromptLogEntry;
export type PromptLogWriteEntry =
  | Omit<ClaudePromptLogEntry, "trigger">
  | Omit<CodexPromptLogEntry, "trigger">;

function dateFromTimestamp(timestamp: string): string {
  const match = timestamp.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1]!;
  return new Date().toISOString().slice(0, 10);
}

function triggerFromSessionKey(sessionKey: string): "heartbeat" | "user" {
  return sessionKey.startsWith("heartbeat--") ? "heartbeat" : "user";
}

function redactEntry(entry: PromptLogEntry, redact: (text: string) => string): PromptLogEntry {
  if (entry.backend === "claude") {
    return {
      ...entry,
      systemPrompt: {
        ...entry.systemPrompt,
        append: redact(entry.systemPrompt.append),
      },
      userMessage: redact(entry.userMessage),
    };
  }
  return {
    ...entry,
    developerInstructions: redact(entry.developerInstructions),
    userMessage: redact(entry.userMessage),
  };
}

/**
 * Append a prompt log entry to a separate JSONL file (outside workspace `daily/` logs).
 *
 * Stored under `{dataDir}/prompt-log/YYYY-MM-DD.jsonl`.
 */
export async function appendPromptLog(
  dataDir: string,
  entry: PromptLogWriteEntry,
  redact?: (text: string) => string,
): Promise<void> {
  const resolvedDataDir = resolveUserPath(dataDir);
  const safe: PromptLogEntry = redact
    ? redactEntry(
        { ...entry, trigger: triggerFromSessionKey(entry.sessionKey) } as PromptLogEntry,
        redact,
      )
    : ({ ...entry, trigger: triggerFromSessionKey(entry.sessionKey) } as PromptLogEntry);

  const date = dateFromTimestamp(safe.timestamp);
  const dir = path.join(resolvedDataDir, "prompt-log");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const filePath = path.join(dir, `${date}.jsonl`);
  await fs.appendFile(filePath, JSON.stringify(safe) + "\n", { encoding: "utf-8", mode: 0o600 });
}
