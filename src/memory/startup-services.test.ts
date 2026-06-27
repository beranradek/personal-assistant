import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Config } from "../core/types.js";
import type { EpisodeRecord } from "./episodes/types.js";

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: vi.fn(),
}));

vi.mock("./vector-store.js", () => ({
  createVectorStore: vi.fn(),
}));

vi.mock("./indexer.js", () => ({
  createIndexer: vi.fn(),
}));

vi.mock("./robust-search.js", () => ({
  createRobustMemorySearch: vi.fn(),
}));

vi.mock("../security/content-redaction.js", () => ({
  CONSERVATIVE_PATTERNS: [],
  createRedactor: vi.fn(),
}));

vi.mock("./episodes/runtime-probes.js", () => ({
  initializeEpisodeMemoryRuntime: vi.fn(),
}));

import { createEmbeddingProvider } from "./embeddings.js";
import { createVectorStore } from "./vector-store.js";
import { createIndexer } from "./indexer.js";
import { createRobustMemorySearch } from "./robust-search.js";
import { createRedactor } from "../security/content-redaction.js";
import { initializeEpisodeMemoryRuntime } from "./episodes/runtime-probes.js";
import {
  initializeStartupMemoryServices,
  runDegradedStartupMemoryServicesProbe,
} from "./startup-services.js";

function makeConfig(): Config {
  return {
    security: {
      allowedCommands: [],
      commandsNeedingExtraValidation: [],
      workspace: "/tmp/workspace",
      dataDir: "/tmp/data",
      additionalReadDirs: [],
      additionalWriteDirs: [],
    },
    adapters: {
      telegram: { enabled: false, botToken: "", allowedUserIds: [], mode: "polling" },
      slack: { enabled: false, botToken: "", appToken: "", socketMode: false },
    },
    heartbeat: { enabled: false, intervalMinutes: 60, activeHours: "8-20", deliverTo: "last" },
    gateway: { maxQueueSize: 100 },
    agent: { backend: "claude", model: null, maxTurns: 50 },
    session: { maxHistoryMessages: 50, compactionEnabled: true },
    memory: {
      search: {
        enabled: true,
        hybridWeights: { vector: 0.7, keyword: 0.3 },
        minScore: 0.3,
        maxResults: 6,
        chunkTokens: 400,
        chunkOverlap: 80,
      },
      extraPaths: [],
    },
    mcpServers: {},
    codex: {
      codexPath: null,
      apiKey: null,
      baseUrl: null,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccess: false,
      reasoningEffort: null,
      skipGitRepoCheck: true,
      configOverrides: {},
    },
  };
}

function makeBaseServices() {
  const embedder = {
    dimensions: 768,
    close: vi.fn(),
    embed: vi.fn(async () => [0.1, 0.2]),
    embedBatch: vi.fn(),
  };
  const store = {
    close: vi.fn(),
    upsertChunk: vi.fn(),
    searchVector: vi.fn(() => []),
  };
  const indexer = {
    close: vi.fn(),
    syncFiles: vi.fn(),
    markDirty: vi.fn(),
    isDirty: vi.fn(),
    syncIfDirty: vi.fn(),
    abort: vi.fn(),
  };
  const searchMemory = vi.fn(async () => []);
  const redact = vi.fn((text: string) => text);
  return { embedder, store, indexer, searchMemory, redact };
}

describe("initializeStartupMemoryServices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds shared memory startup services and forwards episodic runtime outputs", async () => {
    const config = makeConfig();
    const { embedder, store, indexer, searchMemory, redact } = makeBaseServices();
    const memoryServer = { name: "memory" };
    const episodeStore = { close: vi.fn(), insertEpisode: vi.fn(), listEpisodes: vi.fn(() => []), getEpisodeById: vi.fn(() => null) };
    const listEpisodes = vi.fn(() => []);

    vi.mocked(createEmbeddingProvider).mockResolvedValue(embedder as any);
    vi.mocked(createVectorStore).mockReturnValue(store as any);
    vi.mocked(createIndexer).mockReturnValue(indexer as any);
    vi.mocked(createRobustMemorySearch).mockReturnValue(searchMemory);
    vi.mocked(createRedactor).mockReturnValue(redact);
    vi.mocked(initializeEpisodeMemoryRuntime).mockReturnValue({
      episodeStore,
      memoryServerDeps: { listEpisodes, insertEpisode: (ep: EpisodeRecord) => episodeStore.insertEpisode(ep) },
      assistantAvailable: true,
      fallbackTriggered: false,
    } as any);

    const createMemoryServerMock = vi.fn(() => memoryServer);

    const result = await initializeStartupMemoryServices({
      config,
      deps: { createMemoryServer: createMemoryServerMock as any },
    });

    expect(createEmbeddingProvider).toHaveBeenCalledOnce();
    expect(createVectorStore).toHaveBeenCalledWith("/tmp/data/vectors.db", 768);
    expect(createIndexer).toHaveBeenCalledWith(store, embedder);
    expect(createRobustMemorySearch).toHaveBeenCalled();
    expect(createRedactor).toHaveBeenCalled();
    expect(initializeEpisodeMemoryRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ dbPath: "/tmp/data/episodes.db" }),
    );
    expect(createMemoryServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        search: searchMemory,
        redact,
        listEpisodes,
      }),
    );
    expect(result.memoryServer).toBe(memoryServer);
    expect(result.episodeStore).toBe(episodeStore);
    expect(result.searchMemory).toBe(searchMemory);
    expect(result.redact).toBe(redact);
    expect(result.fallbackTriggered).toBe(false);
    expect(result.warningTriggered).toBe(false);
    expect(result.episodicSurfaceExposed).toBe(true);
  });

  it("insertEpisode dep calls episodeStore.insertEpisode then embeds into vector store", async () => {
    const config = makeConfig();
    const { embedder, store, indexer, searchMemory, redact } = makeBaseServices();
    const episodeStore = {
      close: vi.fn(),
      insertEpisode: vi.fn(),
      listEpisodes: vi.fn(() => []),
      getEpisodeById: vi.fn(() => null),
    };

    vi.mocked(createEmbeddingProvider).mockResolvedValue(embedder as any);
    vi.mocked(createVectorStore).mockReturnValue(store as any);
    vi.mocked(createIndexer).mockReturnValue(indexer as any);
    vi.mocked(createRobustMemorySearch).mockReturnValue(searchMemory);
    vi.mocked(createRedactor).mockReturnValue(redact);
    vi.mocked(initializeEpisodeMemoryRuntime).mockReturnValue({
      episodeStore,
      memoryServerDeps: { listEpisodes: vi.fn(() => []), insertEpisode: vi.fn() },
      assistantAvailable: true,
      fallbackTriggered: false,
    } as any);

    let capturedInsert: ((ep: EpisodeRecord) => Promise<void>) | undefined;
    const createMemoryServerMock = vi.fn((deps: any) => {
      capturedInsert = deps.insertEpisode;
      return { name: "memory" };
    });

    await initializeStartupMemoryServices({
      config,
      deps: { createMemoryServer: createMemoryServerMock as any },
    });

    expect(capturedInsert).toBeDefined();

    const fakeEpisode = { id: "ep-abc", semanticEmbeddingText: "action: Test" } as EpisodeRecord;
    await capturedInsert!(fakeEpisode);

    expect(episodeStore.insertEpisode).toHaveBeenCalledWith(fakeEpisode);
    expect(embedder.embed).toHaveBeenCalledWith("action: Test");
    expect(store.upsertChunk).toHaveBeenCalledWith(
      expect.objectContaining({ id: "episode:ep-abc", path: "episode:ep-abc", text: "action: Test" }),
    );
  });

  it("embedding failure in insertEpisodeWithEmbedding is non-fatal — episode still inserted", async () => {
    const config = makeConfig();
    const { embedder, store, indexer, searchMemory, redact } = makeBaseServices();
    embedder.embed.mockRejectedValue(new Error("embedder down"));
    const episodeStore = {
      close: vi.fn(),
      insertEpisode: vi.fn(),
      listEpisodes: vi.fn(() => []),
      getEpisodeById: vi.fn(() => null),
    };

    vi.mocked(createEmbeddingProvider).mockResolvedValue(embedder as any);
    vi.mocked(createVectorStore).mockReturnValue(store as any);
    vi.mocked(createIndexer).mockReturnValue(indexer as any);
    vi.mocked(createRobustMemorySearch).mockReturnValue(searchMemory);
    vi.mocked(createRedactor).mockReturnValue(redact);
    vi.mocked(initializeEpisodeMemoryRuntime).mockReturnValue({
      episodeStore,
      memoryServerDeps: { listEpisodes: vi.fn(() => []), insertEpisode: vi.fn() },
      assistantAvailable: true,
      fallbackTriggered: false,
    } as any);

    let capturedInsert: ((ep: EpisodeRecord) => Promise<void>) | undefined;
    const createMemoryServerMock = vi.fn((deps: any) => {
      capturedInsert = deps.insertEpisode;
      return { name: "memory" };
    });

    await initializeStartupMemoryServices({
      config,
      deps: { createMemoryServer: createMemoryServerMock as any },
    });

    const fakeEpisode = { id: "ep-x", semanticEmbeddingText: "text" } as EpisodeRecord;
    await expect(capturedInsert!(fakeEpisode)).resolves.toBeUndefined();
    expect(episodeStore.insertEpisode).toHaveBeenCalledWith(fakeEpisode);
    expect(store.upsertChunk).not.toHaveBeenCalled();
  });

  it("forwards episodic warning callback through the shared startup helper", async () => {
    const config = makeConfig();
    const onEpisodeWarn = vi.fn();
    const { embedder, store, indexer, searchMemory, redact } = makeBaseServices();

    vi.mocked(createEmbeddingProvider).mockResolvedValue(embedder as any);
    vi.mocked(createVectorStore).mockReturnValue(store as any);
    vi.mocked(createIndexer).mockReturnValue(indexer as any);
    vi.mocked(createRobustMemorySearch).mockReturnValue(searchMemory);
    vi.mocked(createRedactor).mockReturnValue(redact);
    vi.mocked(initializeEpisodeMemoryRuntime).mockImplementation(({ onWarn }) => {
      onWarn?.(new Error("episodes.db incompatible schema"));
      return {
        episodeStore: undefined,
        memoryServerDeps: {},
        assistantAvailable: true,
        fallbackTriggered: true,
      } as any;
    });

    const createMemoryServerMock = vi.fn(() => ({ name: "memory" }));

    await initializeStartupMemoryServices({
      config,
      onEpisodeWarn,
      deps: { createMemoryServer: createMemoryServerMock as any },
    });

    expect(onEpisodeWarn).toHaveBeenCalledOnce();
    expect(onEpisodeWarn.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("reports degraded shared startup probe using the full startup-services path", async () => {
    const config = makeConfig();
    const { embedder, store, indexer, searchMemory, redact } = makeBaseServices();

    vi.mocked(createEmbeddingProvider).mockResolvedValue(embedder as any);
    vi.mocked(createVectorStore).mockReturnValue(store as any);
    vi.mocked(createIndexer).mockReturnValue(indexer as any);
    vi.mocked(createRobustMemorySearch).mockReturnValue(searchMemory);
    vi.mocked(createRedactor).mockReturnValue(redact);
    vi.mocked(initializeEpisodeMemoryRuntime).mockImplementation(({ onWarn }) => {
      onWarn?.(new Error("episodes.db incompatible schema"));
      return {
        episodeStore: undefined,
        memoryServerDeps: {},
        assistantAvailable: true,
        fallbackTriggered: true,
      } as any;
    });

    const createMemoryServerMock = vi.fn(() => ({ name: "memory" }));

    const probe = await runDegradedStartupMemoryServicesProbe({
      config,
      deps: { createMemoryServer: createMemoryServerMock as any },
    });

    expect(probe.actualMode).toBe("raw_audit_fallback");
    expect(probe.assistantAvailable).toBe(true);
    expect(probe.warningTriggered).toBe(true);
    expect(probe.episodicSurfaceExposed).toBe(false);
    expect(probe.actualResults[0]?.explanation).toContain("degraded correctly");
  });
});
