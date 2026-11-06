import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemorySync } from "./sync.js";

function makeIndexer(syncFiles: (files: string[]) => Promise<void> = async () => undefined) {
  return { syncFiles: vi.fn(syncFiles), abort: vi.fn() };
}

describe("createMemorySync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("syncs the collected files", async () => {
    const indexer = makeIndexer();
    const sync = createMemorySync({ indexer, collectFiles: () => ["/a.md", "/b.md"] });
    await sync.sync("test");
    expect(indexer.syncFiles).toHaveBeenCalledWith(["/a.md", "/b.md"], { prune: true });
  });

  it("checks only the search file set before a search and never prunes with it", async () => {
    const indexer = makeIndexer();
    const sync = createMemorySync({
      indexer,
      collectFiles: () => ["/a.md", "/daily/1.jsonl"],
      collectSearchFiles: () => ["/a.md"],
    });
    await sync.syncIfStale();
    expect(indexer.syncFiles).toHaveBeenLastCalledWith(["/a.md"], { prune: false });
    await sync.sync("periodic");
    expect(indexer.syncFiles).toHaveBeenLastCalledWith(["/a.md", "/daily/1.jsonl"], { prune: true });
  });

  it("checks on every search by default, so a note written a moment ago is indexed", async () => {
    const indexer = makeIndexer();
    const sync = createMemorySync({ indexer, collectFiles: () => [] });
    await sync.syncIfStale();
    await sync.syncIfStale();
    expect(indexer.syncFiles).toHaveBeenCalledTimes(2);
  });

  it("does not count a failed run as a recent sync", async () => {
    const indexer = makeIndexer();
    indexer.syncFiles.mockRejectedValueOnce(new Error("worker died"));
    const sync = createMemorySync({ indexer, collectFiles: () => [], minIntervalMs: 60_000 });
    await sync.syncIfStale();
    await sync.syncIfStale();
    expect(indexer.syncFiles).toHaveBeenCalledTimes(2);
  });

  it("shares one run between concurrent callers", async () => {
    let release: () => void = () => undefined;
    const indexer = makeIndexer(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const sync = createMemorySync({ indexer, collectFiles: () => [] });
    const first = sync.sync("a");
    const second = sync.sync("b");
    expect(sync.getCurrentSyncPromise()).not.toBeNull();
    release();
    await Promise.all([first, second]);
    expect(indexer.syncFiles).toHaveBeenCalledTimes(1);
    expect(sync.getCurrentSyncPromise()).toBeNull();
  });

  it("swallows sync errors and allows a later run", async () => {
    const indexer = makeIndexer();
    indexer.syncFiles.mockRejectedValueOnce(new Error("boom"));
    const sync = createMemorySync({ indexer, collectFiles: () => [] });
    await expect(sync.sync("a")).resolves.toBeUndefined();
    await sync.sync("b");
    expect(indexer.syncFiles).toHaveBeenCalledTimes(2);
  });

  it("syncIfStale runs the first time and skips within the minimum interval", async () => {
    const indexer = makeIndexer();
    const sync = createMemorySync({ indexer, collectFiles: () => [], minIntervalMs: 30_000 });
    await sync.syncIfStale();
    await sync.syncIfStale();
    expect(indexer.syncFiles).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_001);
    await sync.syncIfStale();
    expect(indexer.syncFiles).toHaveBeenCalledTimes(2);
  });

  it("syncIfStale stops waiting after maxWaitMs but the sync keeps running", async () => {
    let release: () => void = () => undefined;
    const indexer = makeIndexer(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const sync = createMemorySync({ indexer, collectFiles: () => [], maxWaitMs: 1000 });
    let waited = false;
    const pending = sync.syncIfStale().then(() => {
      waited = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(waited).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await pending;
    expect(waited).toBe(true);
    expect(sync.getCurrentSyncPromise()).not.toBeNull();
    release();
    await sync.getCurrentSyncPromise();
    expect(sync.getCurrentSyncPromise()).toBeNull();
  });

  it("stop() aborts the indexer and refuses new runs", async () => {
    const indexer = makeIndexer();
    const sync = createMemorySync({ indexer, collectFiles: () => [] });
    sync.stop();
    expect(indexer.abort).toHaveBeenCalledOnce();
    await sync.sync("late");
    await sync.syncIfStale();
    expect(indexer.syncFiles).not.toHaveBeenCalled();
  });
});
