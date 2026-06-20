import { describe, expect, it, vi } from "vitest";
import {
  buildEpisodeMemoryServerDeps,
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

  it("runDegradedStoreStartupProbe exercises the safe-open degraded path", () => {
    const result = runDegradedStoreStartupProbe({
      openStore: () => {
        throw new Error("episodes.db incompatible schema");
      },
    });

    expect(result.actualMode).toBe("raw_audit_fallback");
    expect(result.assistantAvailable).toBe(true);
    expect(result.fallbackTriggered).toBe(true);
    expect(result.actualResults[0]?.explanation).toContain("degraded");
  });

  it("runDegradedStoreStartupProbe reports non-degraded availability when store opens", () => {
    const store = {
      listEpisodes: vi.fn(() => []),
    } as unknown as EpisodeStore;

    const result = runDegradedStoreStartupProbe({
      openStore: () => store,
    });

    expect(result.assistantAvailable).toBe(true);
    expect(result.fallbackTriggered).toBe(false);
  });
});
