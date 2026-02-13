import * as path from "node:path";

// Re-export SessionMessage from core types to avoid duplication
export type { SessionMessage } from "../core/types.js";

/** Marker entry written when the transcript is compacted. */
export interface CompactionEntry {
  type: "compaction";
  timestamp: string;
  messagesBefore: number;
  messagesAfter: number;
}

/** A single line in a session JSONL transcript. */
export type TranscriptLine = import("../core/types.js").SessionMessage | CompactionEntry;

/** Type guard: returns true if the transcript line is a compaction entry. */
export function isCompactionEntry(line: TranscriptLine): line is CompactionEntry {
  return "type" in line && (line as CompactionEntry).type === "compaction";
}

/** Convert a session key (e.g. "telegram--123") to an absolute JSONL path. */
export function sessionKeyToPath(dataDir: string, sessionKey: string): string {
  return path.join(dataDir, "sessions", `${sessionKey}.jsonl`);
}
