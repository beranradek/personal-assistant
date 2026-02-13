import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Config } from "./core/types.js";

// ---------------------------------------------------------------------------
// Mocks -- must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("./core/config.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("./core/workspace.js", () => ({
  ensureWorkspace: vi.fn(),
}));

vi.mock("./memory/files.js", () => ({
  readMemoryFiles: vi.fn(),
}));

vi.mock("./core/agent-runner.js", () => ({
  buildAgentOptions: vi.fn(),
  runAgentTurn: vi.fn(),
}));

vi.mock("./memory/embeddings.js", () => ({
  createEmbeddingProvider: vi.fn(),
}));

vi.mock("./memory/vector-store.js", () => ({
  createVectorStore: vi.fn(),
}));

vi.mock("./memory/indexer.js", () => ({
  createIndexer: vi.fn(),
}));

vi.mock("./memory/hybrid-search.js", () => ({
  hybridSearch: vi.fn(),
}));

vi.mock("./tools/memory-server.js", () => ({
  createMemoryServer: vi.fn(),
}));

vi.mock("./tools/assistant-server.js", () => ({
  createAssistantServer: vi.fn(),
}));

vi.mock("./gateway/queue.js", () => ({
  createMessageQueue: vi.fn(),
}));

vi.mock("./gateway/router.js", () => ({
  createRouter: vi.fn(),
}));

vi.mock("./adapters/telegram.js", () => ({
  createTelegramAdapter: vi.fn(),
}));

vi.mock("./adapters/slack.js", () => ({
  createSlackAdapter: vi.fn(),
}));

vi.mock("./heartbeat/scheduler.js", () => ({
  createHeartbeatScheduler: vi.fn(),
}));

vi.mock("./heartbeat/system-events.js", () => ({
  drainSystemEvents: vi.fn(),
}));

vi.mock("./heartbeat/prompts.js", () => ({
  resolveHeartbeatPrompt: vi.fn(),
}));

vi.mock("./cron/store.js", () => ({
  loadCronStore: vi.fn(),
}));

vi.mock("./cron/timer.js", () => ({
  armTimer: vi.fn(),
}));

vi.mock("./cron/tool.js", () => ({
  createCronToolManager: vi.fn(),
}));

vi.mock("./exec/tool.js", () => ({
  handleExec: vi.fn(),
}));

vi.mock("./exec/process-registry.js", () => ({
  getSession: vi.fn(),
  listSessions: vi.fn(),
}));

vi.mock("./core/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Imports -- after mocks are registered
// ---------------------------------------------------------------------------

import { startDaemon } from "./daemon.js";
import { loadConfig } from "./core/config.js";
import { ensureWorkspace } from "./core/workspace.js";
import { readMemoryFiles } from "./memory/files.js";
import { buildAgentOptions } from "./core/agent-runner.js";
import { createEmbeddingProvider } from "./memory/embeddings.js";
import { createVectorStore } from "./memory/vector-store.js";
import { createIndexer } from "./memory/indexer.js";
import { createMemoryServer } from "./tools/memory-server.js";
import { createAssistantServer } from "./tools/assistant-server.js";
import { createMessageQueue } from "./gateway/queue.js";
import { createRouter } from "./gateway/router.js";
import { createTelegramAdapter } from "./adapters/telegram.js";
import { createSlackAdapter } from "./adapters/slack.js";
import { createHeartbeatScheduler } from "./heartbeat/scheduler.js";
import { loadCronStore } from "./cron/store.js";
import { armTimer } from "./cron/timer.js";
import { createCronToolManager } from "./cron/tool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    security: {
      allowedCommands: ["ls", "cat"],
      commandsNeedingExtraValidation: ["rm"],
      workspace: "/tmp/workspace",
      dataDir: "/tmp/data",
      additionalReadDirs: [],
      additionalWriteDirs: [],
    },
    adapters: {
      telegram: {
        enabled: false,
        botToken: "",
        allowedUserIds: [],
        mode: "polling",
      },
      slack: {
        enabled: false,
        botToken: "",
        appToken: "",
        socketMode: false,
      },
    },
    heartbeat: {
      enabled: false,
      intervalMinutes: 30,
      activeHours: "8-21",
      deliverTo: "last",
    },
    gateway: { maxQueueSize: 20 },
    agent: { model: null, maxTurns: 200 },
    session: { maxHistoryMessages: 50, compactionEnabled: true },
    memory: {
      search: {
        enabled: true,
        hybridWeights: { vector: 0.7, keyword: 0.3 },
        minScore: 0.35,
        maxResults: 6,
        chunkTokens: 400,
        chunkOverlap: 80,
      },
      extraPaths: [],
    },
    mcpServers: {},
    ...overrides,
  };
}

function makeMockQueue() {
  return {
    enqueue: vi.fn(() => ({ accepted: true })),
    processNext: vi.fn(),
    size: vi.fn(() => 0),
    processLoop: vi.fn(),
    stop: vi.fn(),
  };
}

function makeMockRouter() {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    route: vi.fn(),
  };
}

function makeMockAdapter(name: string) {
  return {
    name,
    start: vi.fn(),
    stop: vi.fn(),
    sendResponse: vi.fn(),
  };
}

function makeMockIndexer() {
  return {
    syncFiles: vi.fn(),
    markDirty: vi.fn(),
    isDirty: vi.fn(() => false),
    syncIfDirty: vi.fn(),
    close: vi.fn(),
  };
}

function makeMockStore() {
  return {
    upsertChunk: vi.fn(),
    searchVector: vi.fn(),
    searchKeyword: vi.fn(),
    deleteChunksForFile: vi.fn(),
    getFileHash: vi.fn(),
    setFileHash: vi.fn(),
    getTrackedFilePaths: vi.fn(() => []),
    deleteFileHash: vi.fn(),
    close: vi.fn(),
  };
}

function makeMockEmbedder() {
  return {
    embed: vi.fn(),
    embedBatch: vi.fn(),
    dimensions: 768,
    close: vi.fn(),
  };
}

function makeMockCronManager() {
  return {
    handleAction: vi.fn(),
    rearmTimer: vi.fn(),
    stop: vi.fn(),
  };
}

/**
 * Set up common mocks for a successful daemon startup.
 * Returns references to all mock objects so tests can assert on them.
 */
function setupMocks(config: Config) {
  const mockStore = makeMockStore();
  const mockEmbedder = makeMockEmbedder();
  const mockIndexer = makeMockIndexer();
  const mockQueue = makeMockQueue();
  const mockRouter = makeMockRouter();
  const mockCronManager = makeMockCronManager();

  vi.mocked(loadConfig).mockReturnValue(config);
  vi.mocked(ensureWorkspace).mockResolvedValue(undefined);
  vi.mocked(createEmbeddingProvider).mockResolvedValue(mockEmbedder);
  vi.mocked(createVectorStore).mockReturnValue(mockStore as any);
  vi.mocked(createIndexer).mockReturnValue(mockIndexer);
  vi.mocked(readMemoryFiles).mockResolvedValue("memory content");
  vi.mocked(buildAgentOptions).mockReturnValue({
    systemPrompt: { type: "preset", preset: "claude_code", append: "memory content" },
    cwd: "/tmp/workspace",
    tools: { type: "preset", preset: "claude_code" },
    allowedTools: [],
    sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
    hooks: {},
    mcpServers: {},
    settingSources: ["project"],
    maxTurns: 200,
  });
  vi.mocked(createMemoryServer).mockReturnValue({} as any);
  vi.mocked(createAssistantServer).mockReturnValue({} as any);
  vi.mocked(createMessageQueue).mockReturnValue(mockQueue as any);
  vi.mocked(createRouter).mockReturnValue(mockRouter);
  vi.mocked(createHeartbeatScheduler).mockReturnValue({ stop: vi.fn() });
  vi.mocked(loadCronStore).mockResolvedValue([]);
  vi.mocked(armTimer).mockReturnValue({ disarm: vi.fn() });
  vi.mocked(createCronToolManager).mockReturnValue(mockCronManager);

  return {
    mockStore,
    mockEmbedder,
    mockIndexer,
    mockQueue,
    mockRouter,
    mockCronManager,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("daemon", () => {
  let originalProcessOn: typeof process.on;
  let signalHandlers: Map<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();
    signalHandlers = new Map();
    // Capture signal handlers without actually registering them on process
    originalProcessOn = process.on;
    vi.spyOn(process, "once").mockImplementation((event: string, handler: any) => {
      signalHandlers.set(event, handler);
      return process;
    });
  });

  afterEach(() => {
    // Restore process.on
    (process as any).on = originalProcessOn;
  });

  // -----------------------------------------------------------------------
  // 1. Startup initialization
  // -----------------------------------------------------------------------
  it("initializes config, workspace, queue, and router on startup", async () => {
    const config = makeConfig();
    const { mockQueue, mockRouter } = setupMocks(config);

    await startDaemon("/app");

    expect(loadConfig).toHaveBeenCalledWith("/app");
    expect(ensureWorkspace).toHaveBeenCalledWith(config);
    expect(createMessageQueue).toHaveBeenCalledWith(config);
    expect(createRouter).toHaveBeenCalled();
    expect(createEmbeddingProvider).toHaveBeenCalled();
    expect(createVectorStore).toHaveBeenCalled();
    expect(createIndexer).toHaveBeenCalled();
    expect(readMemoryFiles).toHaveBeenCalled();
    expect(buildAgentOptions).toHaveBeenCalled();
    expect(createMemoryServer).toHaveBeenCalled();
    expect(createAssistantServer).toHaveBeenCalled();
    expect(mockQueue.processLoop).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 2. Starts enabled adapters only (skips disabled)
  // -----------------------------------------------------------------------
  it("starts enabled adapters only and skips disabled ones", async () => {
    const config = makeConfig({
      adapters: {
        telegram: {
          enabled: true,
          botToken: "tg-token",
          allowedUserIds: [],
          mode: "polling",
        },
        slack: {
          enabled: false,
          botToken: "",
          appToken: "",
          socketMode: false,
        },
      },
    });

    const mockTelegramAdapter = makeMockAdapter("telegram");
    const mockSlackAdapter = makeMockAdapter("slack");
    const { mockRouter } = setupMocks(config);

    vi.mocked(createTelegramAdapter).mockReturnValue(mockTelegramAdapter);
    vi.mocked(createSlackAdapter).mockReturnValue(mockSlackAdapter);

    await startDaemon("/app");

    // Telegram should be created, started, and registered
    expect(createTelegramAdapter).toHaveBeenCalled();
    expect(mockTelegramAdapter.start).toHaveBeenCalled();
    expect(mockRouter.register).toHaveBeenCalledWith(mockTelegramAdapter);

    // Slack should NOT be created since it's disabled
    expect(createSlackAdapter).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 3. Starts heartbeat scheduler if enabled
  // -----------------------------------------------------------------------
  it("starts heartbeat scheduler when heartbeat is enabled", async () => {
    const config = makeConfig({
      heartbeat: {
        enabled: true,
        intervalMinutes: 15,
        activeHours: "8-21",
        deliverTo: "last",
      },
    });

    setupMocks(config);

    await startDaemon("/app");

    expect(createHeartbeatScheduler).toHaveBeenCalledWith(
      config,
      expect.any(Function),
    );
  });

  // -----------------------------------------------------------------------
  // 4. Loads persisted cron jobs and arms timer
  // -----------------------------------------------------------------------
  it("loads persisted cron jobs and arms timer via cron tool manager", async () => {
    const config = makeConfig();
    const { mockCronManager } = setupMocks(config);

    await startDaemon("/app");

    expect(createCronToolManager).toHaveBeenCalled();
    expect(mockCronManager.rearmTimer).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 5. SIGTERM triggers graceful shutdown
  // -----------------------------------------------------------------------
  it("registers SIGTERM handler that triggers graceful shutdown", async () => {
    const config = makeConfig({
      adapters: {
        telegram: {
          enabled: true,
          botToken: "tg-token",
          allowedUserIds: [],
          mode: "polling",
        },
        slack: {
          enabled: false,
          botToken: "",
          appToken: "",
          socketMode: false,
        },
      },
    });

    const mockTelegramAdapter = makeMockAdapter("telegram");
    const { mockQueue, mockStore, mockEmbedder, mockCronManager } = setupMocks(config);
    vi.mocked(createTelegramAdapter).mockReturnValue(mockTelegramAdapter);

    const mockHeartbeatStop = vi.fn();
    vi.mocked(createHeartbeatScheduler).mockReturnValue({ stop: mockHeartbeatStop });

    // Prevent process.exit from actually exiting
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await startDaemon("/app");

    // Verify SIGTERM handler was registered
    expect(signalHandlers.has("SIGTERM")).toBe(true);

    // Trigger the shutdown handler
    const shutdownHandler = signalHandlers.get("SIGTERM")!;
    await shutdownHandler();

    // Verify graceful shutdown sequence
    expect(mockQueue.stop).toHaveBeenCalled();
    expect(mockTelegramAdapter.stop).toHaveBeenCalled();
    expect(mockHeartbeatStop).toHaveBeenCalled();
    expect(mockCronManager.stop).toHaveBeenCalled();
    expect(mockStore.close).toHaveBeenCalled();
    expect(mockEmbedder.close).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
  });

  // -----------------------------------------------------------------------
  // 6. SIGINT triggers graceful shutdown
  // -----------------------------------------------------------------------
  it("registers SIGINT handler that triggers graceful shutdown", async () => {
    const config = makeConfig();
    const { mockQueue, mockStore, mockEmbedder, mockCronManager } = setupMocks(config);

    const mockHeartbeatStop = vi.fn();
    vi.mocked(createHeartbeatScheduler).mockReturnValue({ stop: mockHeartbeatStop });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await startDaemon("/app");

    // Verify SIGINT handler was registered
    expect(signalHandlers.has("SIGINT")).toBe(true);

    // Trigger the shutdown handler
    const shutdownHandler = signalHandlers.get("SIGINT")!;
    await shutdownHandler();

    // Verify graceful shutdown
    expect(mockQueue.stop).toHaveBeenCalled();
    expect(mockStore.close).toHaveBeenCalled();
    expect(mockEmbedder.close).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
  });
});
