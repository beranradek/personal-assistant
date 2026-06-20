import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Config } from "../core/types.js";

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
  initializeEpisodeMemoryServer: vi.fn(),
}));

import { createEmbeddingProvider } from "./embeddings.js";
import { createVectorStore } from "./vector-store.js";
import { createIndexer } from "./indexer.js";
import { createRobustMemorySearch } from "./robust-search.js";
import { createRedactor } from "../security/content-redaction.js";
import { initializeEpisodeMemoryServer } from "./episodes/runtime-probes.js";
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

describe("initializeStartupMemoryServices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds shared memory startup services and forwards episodic runtime outputs", async () => {
    const config = makeConfig();
    const embedder = { dimensions: 768, close: vi.fn(), embed: vi.fn(), embedBatch: vi.fn() };
    const store = { close: vi.fn() };
    const indexer = { close: vi.fn(), syncFiles: vi.fn(), markDirty: vi.fn(), isDirty: vi.fn(), syncIfDirty: vi.fn(), abort: vi.fn() };
    const searchMemory = vi.fn(async () => []);
    const redact = vi.fn((text: string) => text);
    const memoryServer = { name: "memory" };
    const episodeStore = { close: vi.fn() };

    vi.mocked(createEmbeddingProvider).mockResolvedValue(embedder as any);
    vi.mocked(createVectorStore).mockReturnValue(store as any);
    vi.mocked(createIndexer).mockReturnValue(indexer as any);
    vi.mocked(createRobustMemorySearch).mockReturnValue(searchMemory);
    vi.mocked(createRedactor).mockReturnValue(redact);
    vi.mocked(initializeEpisodeMemoryServer).mockReturnValue({
      episodeStore,
      memoryServer,
      assistantAvailable: true,
      fallbackTriggered: false,
      warningTriggered: false,
      episodicSurfaceExposed: true,
    });

    const result = await initializeStartupMemoryServices({ config });

    expect(createEmbeddingProvider).toHaveBeenCalledOnce();
    expect(createVectorStore).toHaveBeenCalledWith("/tmp/data/vectors.db", 768);
    expect(createIndexer).toHaveBeenCalledWith(store, embedder);
    expect(createRobustMemorySearch).toHaveBeenCalled();
    expect(createRedactor).toHaveBeenCalled();
    expect(initializeEpisodeMemoryServer).toHaveBeenCalledWith(
      expect.objectContaining({
        dbPath: "/tmp/data/episodes.db",
        search: searchMemory,
        redact,
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

  it("forwards episodic warning callback through the shared startup helper", async () => {
    const config = makeConfig();
    const onEpisodeWarn = vi.fn();
    const embedder = { dimensions: 768, close: vi.fn(), embed: vi.fn(), embedBatch: vi.fn() };
    const store = { close: vi.fn() };
    const indexer = { close: vi.fn(), syncFiles: vi.fn(), markDirty: vi.fn(), isDirty: vi.fn(), syncIfDirty: vi.fn(), abort: vi.fn() };
    const searchMemory = vi.fn(async () => []);
    const redact = vi.fn((text: string) => text);

    vi.mocked(createEmbeddingProvider).mockResolvedValue(embedder as any);
    vi.mocked(createVectorStore).mockReturnValue(store as any);
    vi.mocked(createIndexer).mockReturnValue(indexer as any);
    vi.mocked(createRobustMemorySearch).mockReturnValue(searchMemory);
    vi.mocked(createRedactor).mockReturnValue(redact);
    vi.mocked(initializeEpisodeMemoryServer).mockImplementation(({ onWarn }) => {
      onWarn?.(new Error("episodes.db incompatible schema"));
      return {
        episodeStore: undefined,
        memoryServer: { name: "memory" },
        assistantAvailable: true,
        fallbackTriggered: true,
        warningTriggered: true,
        episodicSurfaceExposed: false,
      };
    });

    await initializeStartupMemoryServices({ config, onEpisodeWarn });

    expect(onEpisodeWarn).toHaveBeenCalledOnce();
    expect(onEpisodeWarn.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("reports degraded shared startup probe using the full startup-services path", async () => {
    const config = makeConfig();
    const embedder = { dimensions: 768, close: vi.fn(), embed: vi.fn(), embedBatch: vi.fn() };
    const store = { close: vi.fn() };
    const indexer = { close: vi.fn(), syncFiles: vi.fn(), markDirty: vi.fn(), isDirty: vi.fn(), syncIfDirty: vi.fn(), abort: vi.fn() };
    const searchMemory = vi.fn(async () => []);
    const redact = vi.fn((text: string) => text);

    vi.mocked(createEmbeddingProvider).mockResolvedValue(embedder as any);
    vi.mocked(createVectorStore).mockReturnValue(store as any);
    vi.mocked(createIndexer).mockReturnValue(indexer as any);
    vi.mocked(createRobustMemorySearch).mockReturnValue(searchMemory);
    vi.mocked(createRedactor).mockReturnValue(redact);
    vi.mocked(initializeEpisodeMemoryServer).mockImplementation(({ onWarn }) => {
      onWarn?.(new Error("episodes.db incompatible schema"));
      return {
        episodeStore: undefined,
        memoryServer: { name: "memory" },
        assistantAvailable: true,
        fallbackTriggered: true,
        warningTriggered: true,
        episodicSurfaceExposed: false,
      };
    });

    const probe = await runDegradedStartupMemoryServicesProbe({ config });

    expect(probe.actualMode).toBe("raw_audit_fallback");
    expect(probe.assistantAvailable).toBe(true);
    expect(probe.warningTriggered).toBe(true);
    expect(probe.episodicSurfaceExposed).toBe(false);
    expect(probe.actualResults[0]?.explanation).toContain("degraded correctly");
  });
});
