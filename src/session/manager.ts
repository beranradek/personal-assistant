import type { SessionMessage } from "../core/types.js";
import type { Config } from "../core/types.js";
import { sessionKeyToPath } from "./types.js";
import { appendMessages } from "./store.js";

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
