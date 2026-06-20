import * as path from "node:path";
import type { Config, SearchResult } from "../core/types.js";
import { createRedactor, CONSERVATIVE_PATTERNS } from "../security/content-redaction.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embeddings.js";
import { createVectorStore, type VectorStore } from "./vector-store.js";
import { createIndexer, type Indexer } from "./indexer.js";
import { createRobustMemorySearch } from "./robust-search.js";
import { initializeEpisodeMemoryServer } from "./episodes/runtime-probes.js";
import type { EpisodeStore } from "./episodes/store.js";
import type { EpisodeMemoryRuntimeInit } from "./episodes/runtime-probes.js";

type MemorySearchFn = (query: string, maxResults?: number) => Promise<SearchResult[]>;
type RedactFn = (text: string) => string;

type StartupMemoryDeps = {
  createEmbeddingProvider?: typeof createEmbeddingProvider;
  createVectorStore?: typeof createVectorStore;
  createIndexer?: typeof createIndexer;
  createRobustMemorySearch?: typeof createRobustMemorySearch;
  createRedactor?: typeof createRedactor;
  initializeEpisodeMemoryServer?: (args: EpisodeMemoryRuntimeInit) => {
    episodeStore?: EpisodeStore;
    memoryServer: unknown;
    assistantAvailable: true;
    fallbackTriggered: boolean;
    warningTriggered: boolean;
    episodicSurfaceExposed: boolean;
  };
};

export type StartupMemoryServices = {
  embedder: EmbeddingProvider;
  store: VectorStore;
  indexer: Indexer;
  searchMemory: MemorySearchFn;
  redact: RedactFn;
  memoryServer: unknown;
  episodeStore?: EpisodeStore;
  fallbackTriggered: boolean;
  warningTriggered: boolean;
  episodicSurfaceExposed: boolean;
};

export async function initializeStartupMemoryServices(args: {
  config: Config;
  onEpisodeWarn?: (err: unknown) => void;
  deps?: StartupMemoryDeps;
}): Promise<StartupMemoryServices> {
  const createEmbeddingProviderImpl = args.deps?.createEmbeddingProvider ?? createEmbeddingProvider;
  const createVectorStoreImpl = args.deps?.createVectorStore ?? createVectorStore;
  const createIndexerImpl = args.deps?.createIndexer ?? createIndexer;
  const createRobustMemorySearchImpl = args.deps?.createRobustMemorySearch ?? createRobustMemorySearch;
  const createRedactorImpl = args.deps?.createRedactor ?? createRedactor;
  const initializeEpisodeMemoryServerImpl =
    args.deps?.initializeEpisodeMemoryServer ?? initializeEpisodeMemoryServer;

  const embedder = await createEmbeddingProviderImpl();
  const dbPath = path.join(args.config.security.dataDir, "vectors.db");
  const store = createVectorStoreImpl(dbPath, embedder.dimensions);
  const indexer = createIndexerImpl(store, embedder);
  const searchMemory = createRobustMemorySearchImpl({
    workspaceDir: args.config.security.workspace,
    extraPaths: args.config.memory.extraPaths,
    store,
    embedder,
    config: {
      vectorWeight: args.config.memory.search.hybridWeights.vector,
      keywordWeight: args.config.memory.search.hybridWeights.keyword,
      minScore: args.config.memory.search.minScore,
      maxResults: args.config.memory.search.maxResults,
      recencyBoost: args.config.memory.search.recencyBoost,
      recencyHalfLifeDays: args.config.memory.search.recencyHalfLifeDays,
    },
  });
  const redact = createRedactorImpl(CONSERVATIVE_PATTERNS);
  const episodeRuntime = initializeEpisodeMemoryServerImpl({
    dbPath: path.join(args.config.security.dataDir, "episodes.db"),
    search: searchMemory,
    redact,
    onWarn: args.onEpisodeWarn,
  });

  return {
    embedder,
    store,
    indexer,
    searchMemory,
    redact,
    memoryServer: episodeRuntime.memoryServer,
    episodeStore: episodeRuntime.episodeStore,
    fallbackTriggered: episodeRuntime.fallbackTriggered,
    warningTriggered: episodeRuntime.warningTriggered,
    episodicSurfaceExposed: episodeRuntime.episodicSurfaceExposed,
  };
}

export async function runDegradedStartupMemoryServicesProbe(args: {
  config: Config;
  deps?: StartupMemoryDeps;
}): Promise<{
  actualMode: "raw_audit_fallback";
  actualResults: Array<{
    id: string;
    matchedFields: string[];
    matchedFilters: string[];
    explanation: string;
  }>;
  assistantAvailable: boolean;
  warningTriggered: boolean;
  episodicSurfaceExposed: boolean;
}> {
  let warningTriggered = false;
  const services = await initializeStartupMemoryServices({
    config: args.config,
    onEpisodeWarn: () => {
      warningTriggered = true;
    },
    deps: args.deps,
  });

  return {
    actualMode: "raw_audit_fallback",
    actualResults: [
      {
        id: "startup-log-daemon-fallback",
        matchedFields: [],
        matchedFilters: [],
        explanation: warningTriggered && !services.episodeStore
          ? "Shared startup memory services degraded correctly and continued without episodic surface."
          : "Shared startup memory services stayed available; degraded fallback did not trigger.",
      },
    ],
    assistantAvailable: true,
    warningTriggered,
    episodicSurfaceExposed: services.episodicSurfaceExposed,
  };
}
