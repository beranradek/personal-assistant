import * as path from "node:path";
import type { Config, SearchResult } from "../core/types.js";
import { createRedactor, CONSERVATIVE_PATTERNS } from "../security/content-redaction.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embeddings.js";
import { createVectorStore, type VectorStore } from "./vector-store.js";
import { createIndexer, type Indexer } from "./indexer.js";
import { createRobustMemorySearch } from "./robust-search.js";
import { initializeEpisodeMemoryRuntime } from "./episodes/runtime-probes.js";
import type { EpisodeStore } from "./episodes/store.js";
import type { EpisodeRecord } from "./episodes/types.js";
import { createMemoryServer } from "../tools/memory-server.js";

type MemorySearchFn = (query: string, maxResults?: number) => Promise<SearchResult[]>;
type RedactFn = (text: string) => string;

type StartupMemoryDeps = {
  createEmbeddingProvider?: typeof createEmbeddingProvider;
  createVectorStore?: typeof createVectorStore;
  createIndexer?: typeof createIndexer;
  createRobustMemorySearch?: typeof createRobustMemorySearch;
  createRedactor?: typeof createRedactor;
  openEpisodeStore?: (dbPath: string) => EpisodeStore;
  createMemoryServer?: typeof createMemoryServer;
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
  const createMemoryServerImpl = args.deps?.createMemoryServer ?? createMemoryServer;

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

  let warningTriggered = false;
  const episodeRuntime = initializeEpisodeMemoryRuntime({
    dbPath: path.join(args.config.security.dataDir, "episodes.db"),
    openStore: args.deps?.openEpisodeStore,
    onWarn: (err) => {
      warningTriggered = true;
      args.onEpisodeWarn?.(err);
    },
  });
  const episodeStore = episodeRuntime.episodeStore;

  const insertEpisodeWithEmbedding = episodeStore
    ? async (episode: EpisodeRecord): Promise<void> => {
        episodeStore.insertEpisode(episode);
        try {
          const embedding = await embedder.embed(episode.semanticEmbeddingText);
          store.upsertChunk({
            id: `episode:${episode.id}`,
            path: `episode:${episode.id}`,
            text: episode.semanticEmbeddingText,
            embedding,
            startLine: 0,
            endLine: 0,
          });
        } catch {
          // Non-fatal: keyword search still works without the vector
        }
      }
    : undefined;

  const searchEpisodesVector = episodeStore
    ? async (query: string, maxResults = 10): Promise<EpisodeRecord[]> => {
        const embedding = await embedder.embed(query);
        const results = store.searchVector(embedding, maxResults * 2);
        return results
          .filter((r) => r.path.startsWith("episode:"))
          .map((r) => episodeStore.getEpisodeById(r.path.slice("episode:".length)))
          .filter((ep): ep is EpisodeRecord => ep !== null);
      }
    : undefined;

  const memoryServer = createMemoryServerImpl({
    search: searchMemory,
    redact,
    ...episodeRuntime.memoryServerDeps,
    ...(insertEpisodeWithEmbedding ? { insertEpisode: insertEpisodeWithEmbedding } : {}),
    ...(searchEpisodesVector ? { searchEpisodesVector } : {}),
  });

  return {
    embedder,
    store,
    indexer,
    searchMemory,
    redact,
    memoryServer,
    episodeStore,
    fallbackTriggered: episodeRuntime.fallbackTriggered,
    warningTriggered,
    episodicSurfaceExposed: !!episodeStore,
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

  const result = {
    actualMode: "raw_audit_fallback" as const,
    actualResults: [
      {
        id: "startup-log-daemon-fallback",
        matchedFields: [] as string[],
        matchedFilters: [] as string[],
        explanation: warningTriggered && !services.episodeStore
          ? "Shared startup memory services degraded correctly and continued without episodic surface."
          : "Shared startup memory services stayed available; degraded fallback did not trigger.",
      },
    ],
    assistantAvailable: true as const,
    warningTriggered,
    episodicSurfaceExposed: services.episodicSurfaceExposed,
  };

  services.episodeStore?.close();
  services.store.close();
  services.indexer.close();
  await services.embedder.close();

  return result;
}
