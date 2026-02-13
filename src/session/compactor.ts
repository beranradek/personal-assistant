import { loadTranscript, rewriteTranscript } from "./store.js";
import { isCompactionEntry } from "./types.js";
import type { CompactionEntry, TranscriptLine } from "./types.js";
import type { SessionMessage } from "../core/types.js";

export interface CompactionResult {
  compacted: boolean;
  messagesBefore?: number;
  messagesAfter?: number;
}

/**
 * Compact a session transcript if the number of messages exceeds `threshold`.
 *
 * Flow:
 * 1. Load transcript
 * 2. Separate messages from compaction entries
 * 3. Count messages (excluding compaction entries)
 * 4. If message count <= threshold, return { compacted: false }
 * 5. Keep last `threshold` messages
 * 6. Use rewriteTranscript which handles .bak backup and atomic write
 * 7. The rewritten file contains: kept messages + a new compaction metadata entry
 * 8. Return { compacted: true, messagesBefore, messagesAfter: threshold }
 */
export async function compactIfNeeded(
  sessionPath: string,
  threshold: number,
): Promise<CompactionResult> {
  const transcript = await loadTranscript(sessionPath);

  // Separate messages from compaction entries
  const messages: SessionMessage[] = [];
  const compactionEntries: CompactionEntry[] = [];

  for (const line of transcript) {
    if (isCompactionEntry(line)) {
      compactionEntries.push(line);
    } else {
      messages.push(line as SessionMessage);
    }
  }

  const messageCount = messages.length;

  // If under threshold, nothing to do
  if (messageCount <= threshold) {
    return { compacted: false };
  }

  // Keep the last `threshold` messages
  const keptMessages = messages.slice(-threshold);

  // Build the new compaction entry
  const compactionEntry: CompactionEntry = {
    type: "compaction",
    timestamp: new Date().toISOString(),
    messagesBefore: messageCount,
    messagesAfter: threshold,
  };

  // Rewrite: kept messages + new compaction entry
  const newTranscript: TranscriptLine[] = [...keptMessages, compactionEntry];

  await rewriteTranscript(sessionPath, newTranscript);

  return {
    compacted: true,
    messagesBefore: messageCount,
    messagesAfter: threshold,
  };
}
