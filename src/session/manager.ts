import type { SessionMessage } from "../core/types.js";
import type { Config } from "../core/types.js";
import { sessionKeyToPath } from "./types.js";
import { loadTranscript, appendMessages } from "./store.js";
import { isCompactionEntry } from "./types.js";

/**
 * Build a session key from adapter source, source ID, and optional thread ID.
 * Parts are joined with "--".
 *
 * Examples:
 *   resolveSessionKey("terminal", "default")         => "terminal--default"
 *   resolveSessionKey("telegram", "123456")           => "telegram--123456"
 *   resolveSessionKey("slack", "C123", "thread_ts")   => "slack--C123--thread_ts"
 */
export function resolveSessionKey(
  source: string,
  sourceId: string,
  threadId?: string,
): string {
  const parts = [source, sourceId];
  if (threadId) parts.push(threadId);
  return parts.join("--");
}

/**
 * Load conversation history for a session.
 *
 * 1. Reads the JSONL transcript from disk.
 * 2. Filters out compaction entries.
 * 3. Sanitizes messages (truncates large tool_result content).
 * 4. Returns only the last `maxHistoryMessages` messages.
 *
 * Returns an empty array if the session file does not exist.
 */
export async function loadHistory(
  sessionKey: string,
  config: Config,
): Promise<SessionMessage[]> {
  const sessionPath = sessionKeyToPath(config.security.dataDir, sessionKey);
  const transcript = await loadTranscript(sessionPath);

  // Filter out compaction entries
  const messages = transcript.filter(
    (line): line is SessionMessage => !isCompactionEntry(line),
  );

  // Sanitize: truncate large tool result content
  const sanitized = messages.map((msg) => sanitizeMessage(msg));

  // Truncate to last maxHistoryMessages
  const max = config.session.maxHistoryMessages;
  return sanitized.slice(-max);
}

/**
 * Persist all messages from a single agent turn to the session transcript.
 * Creates the sessions directory and file if they do not exist.
 */
export async function saveInteraction(
  sessionKey: string,
  messages: SessionMessage[],
  config: Config,
): Promise<void> {
  const sessionPath = sessionKeyToPath(config.security.dataDir, sessionKey);
  await appendMessages(sessionPath, messages);
}

/**
 * Sanitize a single message.
 * For tool_result messages with content exceeding 500 characters,
 * the content is truncated to 500 characters with a "... [truncated]" suffix.
 */
function sanitizeMessage(msg: SessionMessage): SessionMessage {
  if (msg.role === "tool_result" && msg.content && msg.content.length > 500) {
    return { ...msg, content: msg.content.slice(0, 500) + "... [truncated]" };
  }
  return msg;
}
