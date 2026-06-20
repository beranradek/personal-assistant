import { createEpisodeStore, type EpisodeStore } from "./store.js";
import type { EpisodeListFilters } from "./types.js";

export function openEpisodeStoreSafely(args: {
  dbPath: string;
  openStore?: (dbPath: string) => EpisodeStore;
  onWarn?: (err: unknown) => void;
}): EpisodeStore | undefined {
  const openStore = args.openStore ?? createEpisodeStore;
  try {
    return openStore(args.dbPath);
  } catch (err) {
    args.onWarn?.(err);
    return undefined;
  }
}

export function buildEpisodeMemoryServerDeps(episodeStore?: Pick<EpisodeStore, "listEpisodes">): {
  listEpisodes?: (filters?: EpisodeListFilters) => ReturnType<EpisodeStore["listEpisodes"]>;
} {
  if (!episodeStore) return {};
  return {
    listEpisodes: (filters) => episodeStore.listEpisodes(filters),
  };
}

export function runDegradedStoreStartupProbe(args?: {
  dbPath?: string;
  openStore?: (dbPath: string) => EpisodeStore;
}): {
  actualMode: "raw_audit_fallback";
  actualResults: Array<{
    id: string;
    matchedFields: string[];
    matchedFilters: string[];
    explanation: string;
  }>;
  assistantAvailable: boolean;
  fallbackTriggered: boolean;
} {
  const episodeStore = openEpisodeStoreSafely({
    dbPath: args?.dbPath ?? "episodes.db",
    openStore: args?.openStore,
  });
  const memoryDeps = buildEpisodeMemoryServerDeps(episodeStore);
  const fallbackTriggered = !("listEpisodes" in memoryDeps);

  return {
    actualMode: "raw_audit_fallback",
    actualResults: [
      {
        id: "startup-log-daemon-fallback",
        matchedFields: [],
        matchedFilters: [],
        explanation: fallbackTriggered
          ? "Episodic store open failed; runtime degraded to non-episodic memory paths."
          : "Episodic store stayed available; degraded fallback did not trigger.",
      },
    ],
    assistantAvailable: true,
    fallbackTriggered,
  };
}
