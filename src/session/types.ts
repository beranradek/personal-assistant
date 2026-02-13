import * as path from "node:path";
import { z } from "zod";
import { SessionMessageSchema } from "../core/types.js";

// Re-export SessionMessage from core types to avoid duplication
export type { SessionMessage } from "../core/types.js";

/** Zod schema for a compaction entry. */
export const CompactionEntrySchema = z.object({
  type: z.literal("compaction"),
  timestamp: z.string(),
  messagesBefore: z.number(),
  messagesAfter: z.number(),
});

/** Marker entry written when the transcript is compacted. */
export type CompactionEntry = z.infer<typeof CompactionEntrySchema>;

/** Zod schema for a single line in a session JSONL transcript. */
export const TranscriptLineSchema = z.union([CompactionEntrySchema, SessionMessageSchema]);

/** A single line in a session JSONL transcript. */
export type TranscriptLine = z.infer<typeof TranscriptLineSchema>;

/** Type guard: returns true if the transcript line is a compaction entry. */
export function isCompactionEntry(line: TranscriptLine): line is CompactionEntry {
  return "type" in line && (line as CompactionEntry).type === "compaction";
}

/** Convert a session key (e.g. "telegram--123") to an absolute JSONL path. */
export function sessionKeyToPath(dataDir: string, sessionKey: string): string {
  return path.join(dataDir, "sessions", `${sessionKey}.jsonl`);
}
