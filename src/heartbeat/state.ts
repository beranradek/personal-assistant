import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Snapshot of what was reported in a heartbeat run.
 * Persisted to {dataDir}/heartbeat-state.json.
 */
export interface HeartbeatState {
  /** ISO timestamp of the last heartbeat run */
  lastRun: string;
  /** Arbitrary keyed context buckets — reserved for future use */
  snapshot: Record<string, unknown>;
  /** The list of context items reported during the last run */
  notifiedItems: string[];
}

const STATE_FILE = "heartbeat-state.json";

/**
 * Load persisted heartbeat state from disk.
 * Returns null if the file doesn't exist or cannot be parsed.
 */
export async function loadState(dataDir: string): Promise<HeartbeatState | null> {
  const filePath = path.join(dataDir, STATE_FILE);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "lastRun" in parsed &&
      "notifiedItems" in parsed
    ) {
      return parsed as HeartbeatState;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist heartbeat state to disk with restricted permissions (0o600).
 */
export async function saveState(dataDir: string, state: HeartbeatState): Promise<void> {
  const filePath = path.join(dataDir, STATE_FILE);
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/**
 * Diff the previous heartbeat state against the current set of context items.
 *
 * @param previous - State from the last heartbeat run (null if first run)
 * @param currentItems - Items present in the current heartbeat context
 * @returns Categorized lists: new items, resolved items, and unchanged items
 */
export function diffState(
  previous: HeartbeatState | null,
  currentItems: string[],
): { newItems: string[]; resolvedItems: string[]; unchanged: string[] } {
  if (!previous) {
    return { newItems: currentItems, resolvedItems: [], unchanged: [] };
  }

  const prevSet = new Set(previous.notifiedItems);
  const currSet = new Set(currentItems);

  const newItems = currentItems.filter((item) => !prevSet.has(item));
  const resolvedItems = previous.notifiedItems.filter((item) => !currSet.has(item));
  const unchanged = currentItems.filter((item) => prevSet.has(item));

  return { newItems, resolvedItems, unchanged };
}
