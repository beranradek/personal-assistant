import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLazyEmbeddingProvider,
  createMockEmbeddingProvider,
  type EmbeddingProvider,
} from "./embeddings.js";

function trackedFactory(dimensions = 8) {
  const state = { created: 0, closed: 0 };
  const create = async (): Promise<EmbeddingProvider> => {
    state.created++;
    const inner = createMockEmbeddingProvider(dimensions);
    return {
      ...inner,
      close: async () => {
        state.closed++;
      },
    };
  };
  return { state, create };
}

describe("createLazyEmbeddingProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not load the model until the first embed call", async () => {
    const { state, create } = trackedFactory();
    const lazy = createLazyEmbeddingProvider({ dimensions: 8, create });
    expect(lazy.dimensions).toBe(8);
    expect(lazy.isLoaded()).toBe(false);
    expect(state.created).toBe(0);

    const vec = await lazy.embed("hello");
    expect(vec).toHaveLength(8);
    expect(lazy.isLoaded()).toBe(true);
    expect(state.created).toBe(1);
  });

  it("loads the model once for concurrent first calls", async () => {
    const { state, create } = trackedFactory();
    const lazy = createLazyEmbeddingProvider({ dimensions: 8, create });
    await Promise.all([lazy.embed("a"), lazy.embedBatch(["b", "c"]), lazy.embed("d")]);
    expect(state.created).toBe(1);
  });

  it("unloads after the idle period and reloads on the next call", async () => {
    const { state, create } = trackedFactory();
    const onLoad = vi.fn();
    const onUnload = vi.fn();
    const lazy = createLazyEmbeddingProvider({ dimensions: 8, create, idleUnloadMs: 1000, onLoad, onUnload });

    await lazy.embed("a");
    expect(lazy.isLoaded()).toBe(true);

    await vi.advanceTimersByTimeAsync(999);
    expect(lazy.isLoaded()).toBe(true);
    await vi.advanceTimersByTimeAsync(2);
    expect(lazy.isLoaded()).toBe(false);
    expect(state.closed).toBe(1);
    expect(onUnload).toHaveBeenCalledTimes(1);

    await lazy.embed("b");
    expect(state.created).toBe(2);
    expect(onLoad).toHaveBeenCalledTimes(2);
  });

  it("each embed call restarts the idle timer", async () => {
    const { create } = trackedFactory();
    const lazy = createLazyEmbeddingProvider({ dimensions: 8, create, idleUnloadMs: 1000 });
    await lazy.embed("a");
    await vi.advanceTimersByTimeAsync(800);
    await lazy.embed("b");
    await vi.advanceTimersByTimeAsync(800);
    expect(lazy.isLoaded()).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(lazy.isLoaded()).toBe(false);
  });

  it("never unloads while a call is in flight", async () => {
    const state = { closed: 0 };
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lazy = createLazyEmbeddingProvider({
      dimensions: 8,
      idleUnloadMs: 100,
      create: async () => ({
        dimensions: 8,
        embed: async () => {
          await gate;
          return new Array(8).fill(0.1);
        },
        embedBatch: async () => [],
        close: async () => {
          state.closed++;
        },
      }),
    });
    const pending = lazy.embed("slow");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.closed).toBe(0);
    release();
    await pending;
    await vi.advanceTimersByTimeAsync(101);
    expect(state.closed).toBe(1);
  });

  it("keeps the model loaded forever when idleUnloadMs is 0", async () => {
    const { state, create } = trackedFactory();
    const lazy = createLazyEmbeddingProvider({ dimensions: 8, create, idleUnloadMs: 0 });
    await lazy.embed("a");
    await vi.advanceTimersByTimeAsync(24 * 3600 * 1000);
    expect(lazy.isLoaded()).toBe(true);
    expect(state.closed).toBe(0);
  });

  it("rejects a model whose dimension differs from the configured one and closes it", async () => {
    const { state, create } = trackedFactory(4);
    const lazy = createLazyEmbeddingProvider({ dimensions: 8, create });
    await expect(lazy.embed("a")).rejects.toThrow(/4 dimensions.*8/);
    expect(lazy.isLoaded()).toBe(false);
    expect(state.closed).toBe(1);
  });

  it("retries loading after a failed load", async () => {
    let attempts = 0;
    const lazy = createLazyEmbeddingProvider({
      dimensions: 8,
      create: async () => {
        attempts++;
        if (attempts === 1) throw new Error("download failed");
        return createMockEmbeddingProvider(8);
      },
    });
    await expect(lazy.embed("a")).rejects.toThrow("download failed");
    await expect(lazy.embed("a")).resolves.toHaveLength(8);
    expect(attempts).toBe(2);
  });

  it("close() releases a loaded model and rejects later calls", async () => {
    const { state, create } = trackedFactory();
    const lazy = createLazyEmbeddingProvider({ dimensions: 8, create, idleUnloadMs: 1000 });
    await lazy.embed("a");
    await lazy.close();
    expect(state.closed).toBe(1);
    await lazy.close();
    expect(state.closed).toBe(1);
    await expect(lazy.embed("b")).rejects.toThrow(/closed/);
  });

  it("close() without ever loading does not create the model", async () => {
    const { state, create } = trackedFactory();
    const lazy = createLazyEmbeddingProvider({ dimensions: 8, create });
    await lazy.close();
    expect(state.created).toBe(0);
  });
});
