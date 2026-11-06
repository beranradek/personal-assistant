import { createLogger } from "../core/logger.js";
import type { Indexer } from "./indexer.js";

const log = createLogger("memory-sync");

export interface MemorySync {
  /** Index changed memory files now (all files, removed files are pruned). Concurrent calls share one run. */
  sync(reason: string): Promise<void>;
  /**
   * Index changed files that searches rely on, unless a successful sync finished less than
   * `minIntervalMs` ago. Waits for it at most `maxWaitMs` (it keeps running in the background after
   * that). Never rejects.
   */
  syncIfStale(): Promise<void>;
  /** Promise of the run in progress, if any (used for graceful shutdown). */
  getCurrentSyncPromise(): Promise<void> | null;
  /** Refuse new runs and abort the one in progress. */
  stop(): void;
}

export function createMemorySync(args: {
  indexer: Pick<Indexer, "syncFiles" | "abort">;
  /** All files to keep indexed (used by startup, background and shutdown-safe full syncs). */
  collectFiles: () => string[];
  /**
   * Files to check right before a search. Defaults to `collectFiles`. Use a smaller set (without
   * the daily logs that change on every turn) to keep searches fast; such a sync never prunes.
   */
  collectSearchFiles?: () => string[];
  /** Minimum time between "sync before search" runs. Default: 0 (the changed-file check is cheap). */
  minIntervalMs?: number;
  /** Longest time a search waits for the sync. Default: 15 s. */
  maxWaitMs?: number;
}): MemorySync {
  const minIntervalMs = args.minIntervalMs ?? 0;
  const maxWaitMs = args.maxWaitMs ?? 15_000;
  let current: Promise<void> | null = null;
  let lastSuccessAt = 0;
  let stopped = false;

  const run = (reason: string, collect: () => string[], prune: boolean): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (current) return current;
    const promise = (async () => {
      try {
        const files = collect();
        log.info({ fileCount: files.length, reason }, "Syncing memory files");
        await args.indexer.syncFiles(files, { prune });
        lastSuccessAt = Date.now();
      } catch (err) {
        // A failed run must not delay the next attempt.
        log.error({ err, reason }, "Memory sync failed");
      } finally {
        current = null;
      }
    })();
    current = promise;
    return promise;
  };

  return {
    sync: (reason) => run(reason, args.collectFiles, true),
    async syncIfStale(): Promise<void> {
      if (stopped) return;
      if (!current && Date.now() - lastSuccessAt < minIntervalMs) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, maxWaitMs);
        timer.unref();
      });
      try {
        const searchFiles = args.collectSearchFiles ?? args.collectFiles;
        // Pruning only makes sense when the full file set is checked.
        await Promise.race([run("search", searchFiles, args.collectSearchFiles === undefined), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    getCurrentSyncPromise: () => current,
    stop(): void {
      stopped = true;
      args.indexer.abort();
    },
  };
}
