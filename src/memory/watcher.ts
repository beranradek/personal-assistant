import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../core/logger.js";

const log = createLogger("memory-watcher");

export interface MemoryWatcher {
  close(): void;
}

/**
 * Watch workspace memory files (MEMORY.md and memory/ directory) for changes.
 * Calls `onChanged` (debounced) when any .md file is created, modified, or deleted.
 */
export function createMemoryWatcher(
  workspaceDir: string,
  onChanged: () => void,
  options?: { debounceMs?: number },
): MemoryWatcher {
  const debounceMs = options?.debounceMs ?? 500;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const watchers: fs.FSWatcher[] = [];

  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChanged();
    }, debounceMs);
  };

  // Watch MEMORY.md directly
  const memoryMdPath = path.join(workspaceDir, "MEMORY.md");
  try {
    const w = fs.watch(memoryMdPath, () => trigger());
    watchers.push(w);
  } catch {
    log.debug("MEMORY.md not found, skipping watch");
  }

  // Watch memory/ directory (recursive for subdirs)
  const memoryDir = path.join(workspaceDir, "memory");
  try {
    const w = fs.watch(memoryDir, { recursive: true }, (_event, filename) => {
      if (filename && filename.endsWith(".md")) {
        trigger();
      }
    });
    watchers.push(w);
  } catch {
    log.debug("memory/ directory not found, skipping watch");
  }

  return {
    close() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const w of watchers) {
        w.close();
      }
      watchers.length = 0;
    },
  };
}
