import { createEpisodeStore, type EpisodeStore } from "./store.js";
import type { EpisodeListFilters } from "./types.js";
import { createMemoryServer } from "../../tools/memory-server.js";
import type { SearchResult } from "../../core/types.js";

type EpisodeMemoryServerProbeDeps = {
  search: (query: string, maxResults?: number) => Promise<SearchResult[]>;
  redact: (text: string) => string;
  listEpisodes?: (filters?: EpisodeListFilters) => ReturnType<EpisodeStore["listEpisodes"]>;
};

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

export function initializeEpisodeMemoryRuntime(args: {
  dbPath: string;
  openStore?: (dbPath: string) => EpisodeStore;
  onWarn?: (err: unknown) => void;
}): {
  episodeStore?: EpisodeStore;
  memoryServerDeps: {
    listEpisodes?: (filters?: EpisodeListFilters) => ReturnType<EpisodeStore["listEpisodes"]>;
  };
  assistantAvailable: true;
  fallbackTriggered: boolean;
} {
  const episodeStore = openEpisodeStoreSafely(args);
  const memoryServerDeps = buildEpisodeMemoryServerDeps(episodeStore);
  const fallbackTriggered = !("listEpisodes" in memoryServerDeps);

  return {
    episodeStore,
    memoryServerDeps,
    assistantAvailable: true,
    fallbackTriggered,
  };
}

export function runDegradedStoreStartupProbe(args?: {
  dbPath?: string;
  openStore?: (dbPath: string) => EpisodeStore;
  createServer?: (deps: EpisodeMemoryServerProbeDeps) => unknown;
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
  warningTriggered: boolean;
  episodicSurfaceExposed: boolean;
} {
  let warningTriggered = false;
  const runtime = initializeEpisodeMemoryRuntime({
    dbPath: args?.dbPath ?? "episodes.db",
    openStore: args?.openStore,
    onWarn: () => {
      warningTriggered = true;
    },
  });
  const memoryServerProbeDeps: EpisodeMemoryServerProbeDeps = {
    search: async () => [],
    redact: (text) => text,
    ...runtime.memoryServerDeps,
  };
  const createServer = args?.createServer ?? ((deps: EpisodeMemoryServerProbeDeps) => createMemoryServer(deps));
  createServer(memoryServerProbeDeps);
  const episodicSurfaceExposed = "listEpisodes" in memoryServerProbeDeps;

  return {
    actualMode: "raw_audit_fallback",
    actualResults: [
      {
        id: "startup-log-daemon-fallback",
        matchedFields: [],
        matchedFilters: [],
        explanation: runtime.fallbackTriggered
          ? warningTriggered && !episodicSurfaceExposed
            ? "Episodic store open failed; startup wiring emitted warning and memory server degraded to non-episodic paths."
            : "Episodic store open failed; runtime degraded to non-episodic memory paths."
          : "Episodic store stayed available; degraded fallback did not trigger.",
      },
    ],
    assistantAvailable: runtime.assistantAvailable,
    fallbackTriggered: runtime.fallbackTriggered,
    warningTriggered,
    episodicSurfaceExposed,
  };
}
