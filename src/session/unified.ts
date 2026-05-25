import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Config, SessionMessage } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import { sessionKeyToPath } from "./types.js";
import { loadMessages, appendMessages } from "./store.js";

const log = createLogger("session-unified");

export function getUnifiedSessionKey(config: Config): string {
  return config.session.unifiedSessionKey || "user--default";
}

/**
 * One-time migration helper:
 * If the unified session transcript does not exist yet, but legacy per-adapter
 * session files exist, merge them into the unified transcript ordered by timestamp.
 */
export async function migrateLegacySessionsToUnified(
  config: Config,
  redact?: (text: string) => string,
): Promise<void> {
  const sessionsDir = path.join(config.security.dataDir, "sessions");
  const unifiedKey = getUnifiedSessionKey(config);
  const unifiedPath = sessionKeyToPath(config.security.dataDir, unifiedKey);

  try {
    await fs.access(unifiedPath);
    return; // already migrated / in use
  } catch {
    // continue
  }

  let entries: string[] = [];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch {
    return;
  }

  const legacyFiles = entries
    .filter((f) => f.endsWith(".jsonl"))
    .filter((f) => f !== `${unifiedKey}.jsonl`);

  if (legacyFiles.length === 0) return;

  const all: SessionMessage[] = [];
  for (const file of legacyFiles) {
    const fullPath = path.join(sessionsDir, file);
    const messages = await loadMessages(fullPath);
    all.push(...messages);
  }

  if (all.length === 0) return;

  all.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  await appendMessages(unifiedPath, all, redact);

  log.info(
    { unifiedKey, legacyFiles: legacyFiles.length, messages: all.length },
    "migrated legacy sessions into unified transcript",
  );
}
