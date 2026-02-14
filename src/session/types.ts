import * as path from "node:path";

// Re-export SessionMessage from core types to avoid duplication
export type { SessionMessage } from "../core/types.js";

/** Convert a session key (e.g. "telegram--123") to an absolute JSONL path. */
export function sessionKeyToPath(dataDir: string, sessionKey: string): string {
  return path.join(dataDir, "sessions", `${sessionKey}.jsonl`);
}
