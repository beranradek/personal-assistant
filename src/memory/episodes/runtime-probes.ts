import { createMemoryServer } from "../../tools/memory-server.js";
import type { SearchResult } from "../../core/types.js";
import { createEpisodeStore, type EpisodeStore } from "./store.js";
import type { EpisodeListFilters } from "./types.js";

type EpisodeMemoryServerProbeDeps = {
  search: (query: string, maxResults?: number) => Promise<SearchResult[]>;
  redact: (text: string) => string;
  listEpisodes?: (filters?: EpisodeListFilters) => ReturnType<EpisodeStore["listEpisodes"]>;
};

type EpisodeMemoryServerFactory = (deps: EpisodeMemoryServerProbeDeps) => unknown;

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

export function initializeEpisodeMemoryServer(args: {
  dbPath: string;
  search: (query: string, maxResults?: number) => Promise<SearchResult[]>;
  redact: (text: string) => string;
  openStore?: (dbPath: string) => EpisodeStore;
  onWarn?: (err: unknown) => void;
  createServer?: EpisodeMemoryServerFactory;
}): {
  episodeStore?: EpisodeStore;
  memoryServer: unknown;
  assistantAvailable: true;
  fallbackTriggered: boolean;
  warningTriggered: boolean;
  // This reflects whether episodic deps were wired into createMemoryServer(...),
  // not post-construction inspection of the returned server object.
  episodicSurfaceExposed: boolean;
} {
  let warningTriggered = false;
  const runtime = initializeEpisodeMemoryRuntime({
    dbPath: args.dbPath,
    openStore: args.openStore,
    onWarn: (err) => {
      warningTriggered = true;
      args.onWarn?.(err);
    },
  });
  const memoryServerDeps: EpisodeMemoryServerProbeDeps = {
    search: args.search,
    redact: args.redact,
    ...runtime.memoryServerDeps,
  };
  const createServer = args.createServer ?? ((deps: EpisodeMemoryServerProbeDeps) => createMemoryServer(deps));
  const memoryServer = createServer(memoryServerDeps);
  const episodicSurfaceExposed = "listEpisodes" in memoryServerDeps;

  return {
    episodeStore: runtime.episodeStore,
    memoryServer,
    assistantAvailable: runtime.assistantAvailable,
    fallbackTriggered: runtime.fallbackTriggered,
    warningTriggered,
    episodicSurfaceExposed,
  };
}

export function runDegradedStoreStartupProbe(args?: {
  dbPath?: string;
  openStore?: (dbPath: string) => EpisodeStore;
  createServer?: EpisodeMemoryServerFactory;
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
  const runtime = initializeEpisodeMemoryServer({
    dbPath: args?.dbPath ?? "episodes.db",
    search: async () => [],
    redact: (text) => text,
    openStore: args?.openStore,
    createServer: args?.createServer,
  });

  return {
    actualMode: "raw_audit_fallback",
    actualResults: [
      {
        id: "startup-log-daemon-fallback",
        matchedFields: [],
        matchedFilters: [],
        explanation: runtime.fallbackTriggered
          ? runtime.warningTriggered && !runtime.episodicSurfaceExposed
            ? "Episodic store open failed; startup wiring emitted warning and memory server degraded to non-episodic paths."
            : "Episodic store open failed; runtime degraded to non-episodic memory paths."
          : "Episodic store stayed available; degraded fallback did not trigger.",
      },
    ],
    assistantAvailable: runtime.assistantAvailable,
    fallbackTriggered: runtime.fallbackTriggered,
    warningTriggered: runtime.warningTriggered,
    episodicSurfaceExposed: runtime.episodicSurfaceExposed,
  };
}
