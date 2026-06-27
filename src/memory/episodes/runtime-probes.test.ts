import { describe, expect, it, vi } from "vitest";
const { mockCreateMemoryServer } = vi.hoisted(() => ({
  mockCreateMemoryServer: vi.fn(() => ({ type: "sdk" })),
}));

vi.mock("../../tools/memory-server.js", () => ({
  createMemoryServer: mockCreateMemoryServer,
}));

import {
  buildEpisodeMemoryServerDeps,
  initializeEpisodeMemoryServer,
  initializeEpisodeMemoryRuntime,
  openEpisodeStoreSafely,
  runDegradedStoreStartupProbe,
} from "./runtime-probes.js";
import type { EpisodeStore } from "./store.js";

describe("episodic runtime probes", () => {
  it("openEpisodeStoreSafely returns undefined and calls warning hook on failure", () => {
    const onWarn = vi.fn();
    const store = openEpisodeStoreSafely({
      dbPath: "/tmp/episodes.db",
      openStore: () => {
        throw new Error("episodes.db corrupted");
      },
      onWarn,
    });

    expect(store).toBeUndefined();
    expect(onWarn).toHaveBeenCalledOnce();
  });

  it("buildEpisodeMemoryServerDeps omits episodic deps when store is unavailable", () => {
    expect(buildEpisodeMemoryServerDeps()).toEqual({});
  });

  it("initializeEpisodeMemoryRuntime returns fallback state from the production startup helper", () => {
    const onWarn = vi.fn();

    const result = initializeEpisodeMemoryRuntime({
      dbPath: "/tmp/episodes.db",
      openStore: () => {
        throw new Error("episodes.db incompatible schema");
      },
      onWarn,
    });

    expect(result.episodeStore).toBeUndefined();
    expect(result.memoryServerDeps).toEqual({});
    expect(result.assistantAvailable).toBe(true);
    expect(result.fallbackTriggered).toBe(true);
    expect(onWarn).toHaveBeenCalledOnce();
  });

  it("initializeEpisodeMemoryServer returns warning and wiring state directly", () => {
    const store = {
      listEpisodes: vi.fn(() => []),
      insertEpisode: vi.fn(),
      close: vi.fn(),
    } as unknown as EpisodeStore;
    const createServer = vi.fn(() => ({ type: "sdk" }));

    const result = initializeEpisodeMemoryServer({
      dbPath: "/tmp/episodes.db",
      search: async () => [],
      redact: (text) => text,
      openStore: () => store,
      createServer,
    });

    expect(result.episodeStore).toBe(store);
    expect(result.memoryServer).toEqual({ type: "sdk" });
    expect(result.assistantAvailable).toBe(true);
    expect(result.fallbackTriggered).toBe(false);
    expect(result.warningTriggered).toBe(false);
    expect(result.episodicSurfaceExposed).toBe(true);
    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        listEpisodes: expect.any(Function),
        insertEpisode: expect.any(Function),
        search: expect.any(Function),
        redact: expect.any(Function),
      }),
    );
  });

  it("runDegradedStoreStartupProbe exercises the safe-open degraded path", () => {
    const createServer = vi.fn();
    const result = runDegradedStoreStartupProbe({
      openStore: () => {
        throw new Error("episodes.db incompatible schema");
      },
      createServer,
    });

    expect(result.actualMode).toBe("raw_audit_fallback");
    expect(result.assistantAvailable).toBe(true);
    expect(result.fallbackTriggered).toBe(true);
    expect(result.warningTriggered).toBe(true);
    expect(result.episodicSurfaceExposed).toBe(false);
    expect(result.actualResults[0]?.explanation).toContain("degraded");
    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.any(Function),
        redact: expect.any(Function),
      }),
    );
    expect(createServer.mock.calls[0]?.[0]).not.toHaveProperty("listEpisodes");
    expect(createServer.mock.calls[0]?.[0]).not.toHaveProperty("insertEpisode");
  });

  it("runDegradedStoreStartupProbe uses memory server wiring in the default path", () => {
    mockCreateMemoryServer.mockClear();

    const result = runDegradedStoreStartupProbe({
      openStore: () => {
        throw new Error("episodes.db incompatible schema");
      },
    });

    expect(result.warningTriggered).toBe(true);
    expect(result.episodicSurfaceExposed).toBe(false);
    expect(mockCreateMemoryServer).toHaveBeenCalledOnce();
    expect(mockCreateMemoryServer.mock.calls[0]?.[0]).not.toHaveProperty("listEpisodes");
  });

  it("runDegradedStoreStartupProbe reports non-degraded availability when store opens", () => {
    const store = {
      listEpisodes: vi.fn(() => []),
      insertEpisode: vi.fn(),
      close: vi.fn(),
    } as unknown as EpisodeStore;
    const createServer = vi.fn();

    const result = runDegradedStoreStartupProbe({
      openStore: () => store,
      createServer,
    });

    expect(result.assistantAvailable).toBe(true);
    expect(result.fallbackTriggered).toBe(false);
    expect(result.warningTriggered).toBe(false);
    expect(result.episodicSurfaceExposed).toBe(true);
    expect(createServer.mock.calls[0]?.[0]).toHaveProperty("listEpisodes");
    expect(createServer.mock.calls[0]?.[0]).toHaveProperty("insertEpisode");
  });
});
