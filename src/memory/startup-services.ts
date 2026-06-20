import * as path from "node:path";
import type { Config, SearchResult } from "../core/types.js";
import { createRedactor, CONSERVATIVE_PATTERNS } from "../security/content-redaction.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embeddings.js";
import { createVectorStore, type VectorStore } from "./vector-store.js";
import { createIndexer, type Indexer } from "./indexer.js";
import { createRobustMemorySearch } from "./robust-search.js";
import { initializeEpisodeMemoryServer } from "./episodes/runtime-probes.js";
import type { EpisodeStore } from "./episodes/store.js";

type MemorySearchFn = (query: string, maxResults?: number) => Promise<SearchResult[]>;
type RedactFn = (text: string) => string;

export type StartupMemoryServices = {
  embedder: EmbeddingProvider;
  store: VectorStore;
  indexer: Indexer;
  searchMemory: MemorySearchFn;
  redact: RedactFn;
  memoryServer: unknown;
  episodeStore?: EpisodeStore;
};

export async function initializeStartupMemoryServices(args: {
  config: Config;
  onEpisodeWarn?: (err: unknown) => void;
}): Promise<StartupMemoryServices> {
  const embedder = await createEmbeddingProvider();
  const dbPath = path.join(args.config.security.dataDir, "vectors.db");
  const store = createVectorStore(dbPath, embedder.dimensions);
  const indexer = createIndexer(store, embedder);
  const searchMemory = createRobustMemorySearch({
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
  const redact = createRedactor(CONSERVATIVE_PATTERNS);
  const episodeRuntime = initializeEpisodeMemoryServer({
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
  };
}
