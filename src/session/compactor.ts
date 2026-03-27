/**
 * Session Compactor
 * =================
 *
 * Implements LLM-based context pruning for long-running sessions.
 *
 * When a session exceeds `maxHistoryMessages / 2` turns, this module:
 *   1. Reads the user/assistant messages from the JSONL audit trail
 *      (tool_use, tool_result, and compaction entries are excluded)
 *   2. Calls the Anthropic Messages API directly (fast/cheap model) to produce
 *      a concise summary of the conversation so far
 *   3. Appends a `{ role: "compaction", ... }` entry to the JSONL so the
 *      summary survives daemon restarts
 *
 * The caller (agent-runner) is responsible for:
 *   - Clearing the SDK session ID so the next turn starts a fresh session
 *   - Injecting the summary into `systemPrompt.append`
 */

import type { SessionMessage } from "../core/types.js";
import { loadMessages } from "./store.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A minimal message shape for summarization — role + text only. */
interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

// ---------------------------------------------------------------------------
// loadConversationHistory
// ---------------------------------------------------------------------------

/**
 * Load all user/assistant messages from a session JSONL file.
 * Filters out tool_use, tool_result, and compaction entries so only
 * human-readable conversation content is passed to the summarizer.
 */
export async function loadConversationHistory(
  sessionPath: string,
): Promise<ConversationTurn[]> {
  const all = await loadMessages(sessionPath);
  return all
    .filter((m): m is SessionMessage & { role: "user" | "assistant" } =>
      m.role === "user" || m.role === "assistant",
    )
    .map((m) => ({ role: m.role, content: m.content }));
}

// ---------------------------------------------------------------------------
// summarizeConversation
// ---------------------------------------------------------------------------

/**
 * Call the Anthropic Messages API directly to produce a concise summary of
 * the conversation history. Uses Node 22's built-in `fetch`.
 *
 * @param messages - Array of user/assistant turns (oldest first)
 * @param model    - Anthropic model ID to use for summarization
 * @returns        - Compact summary string (≤400 words)
 */
export async function summarizeConversation(
  messages: ConversationTurn[],
  model: string,
): Promise<string> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set — cannot summarize conversation",
    );
  }

  const conversationText = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content:
            "Create a concise summary of the following conversation. " +
            "Focus on: key topics discussed, decisions made, tasks completed " +
            "or in progress, and important context the assistant should " +
            "remember. Keep the summary under 400 words.\n\n" +
            "<conversation>\n" +
            conversationText +
            "\n</conversation>",
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text?: string }>;
  };
  const text = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");

  if (!text) throw new Error("Empty summary returned from Anthropic API");
  return text;
}

// ---------------------------------------------------------------------------
// appendCompactionEntry
// ---------------------------------------------------------------------------

/**
 * Append a compaction summary entry to a session JSONL file.
 * Written directly (not through the shared lock) because it is a
 * single append called only during the compaction path, which is
 * itself serialised by the gateway queue.
 */
export async function appendCompactionEntry(
  sessionPath: string,
  summary: string,
): Promise<void> {
  const entry: SessionMessage = {
    role: "compaction",
    content: summary,
    timestamp: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(sessionPath), { recursive: true, mode: 0o700 });
  await fs.appendFile(sessionPath, JSON.stringify(entry) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

// ---------------------------------------------------------------------------
// loadLatestSummary
// ---------------------------------------------------------------------------

/**
 * Return the content of the most recent `compaction` entry in a JSONL file,
 * or `null` if none exists. Used on session resume after a daemon restart.
 */
export async function loadLatestSummary(
  sessionPath: string,
): Promise<string | null> {
  const all = await loadMessages(sessionPath);
  let latest: string | null = null;
  for (const entry of all) {
    if (entry.role === "compaction") {
      latest = entry.content;
    }
  }
  return latest;
}
