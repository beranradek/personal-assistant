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

vi.mock("./memory/embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./memory/embeddings.js")>()),
  createEmbeddingProvider: vi.fn(),
}));

vi.mock("./memory/vector-store.js", () => ({
  createVectorStore: vi.fn(),
}));

vi.mock("./memory/episodes/store.js", () => ({
  createEpisodeStore: vi.fn(),
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

vi.mock("./tools/integ-server.js", () => ({
  createIntegServer: vi.fn(),
}));

vi.mock("./tools/http-mcp-server.js", () => ({
  startHttpMcpServer: vi.fn(),
}));

vi.mock("./tmux-agents/startup.js", () => ({
  startTmuxAgentService: vi.fn(),
}));

vi.mock("./tools/tmux-agents-server.js", () => ({
  createTmuxAgentsServer: vi.fn(),
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

vi.mock("./remote/bridge.js", () => ({
  createRemoteBridge: vi.fn(),
}));

vi.mock("./remote/telegram-router.js", () => ({
  createTelegramRouter: vi.fn(),
}));

vi.mock("./remote/slack-router.js", () => ({
  createSlackRouter: vi.fn(),
}));

vi.mock("./adapters/slack.js", () => ({
  createSlackAdapter: vi.fn(),
}));

vi.mock("./adapters/github-webhook.js", () => ({
  createGithubWebhookAdapter: vi.fn(),
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

vi.mock("./memory/daily-reflection.js", () => ({
  runDailyReflection: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./memory/weekly-reflection.js", () => ({
  runWeeklyReflection: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn().mockReturnValue({ stop: vi.fn() }),
  },
}));

vi.mock("./backends/factory.js", () => ({
  createBackend: vi.fn(),
}));

vi.mock("./memory/collect-files.js", () => ({
  collectMemoryFiles: vi.fn().mockReturnValue([]),
}));

vi.mock("./memory/watcher.js", () => ({
  createMemoryWatcher: vi.fn().mockReturnValue({ close: vi.fn() }),
}));

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("./core/logger.js", () => ({
  createLogger: vi.fn(() => mockLogger),
}));

// ---------------------------------------------------------------------------
// Imports -- after mocks are registered
// ---------------------------------------------------------------------------

import { runDegradedDaemonStartupProbe, startDaemon } from "./daemon.js";
import { loadConfig } from "./core/config.js";
import { ensureWorkspace } from "./core/workspace.js";
import { readMemoryFiles } from "./memory/files.js";
import { buildAgentOptions } from "./core/agent-runner.js";
import { createEmbeddingProvider } from "./memory/embeddings.js";
import { createVectorStore } from "./memory/vector-store.js";
import { createEpisodeStore } from "./memory/episodes/store.js";
import { createIndexer } from "./memory/indexer.js";
import { createMemoryServer } from "./tools/memory-server.js";
import { createAssistantServer } from "./tools/assistant-server.js";
import { createIntegServer } from "./tools/integ-server.js";
import { startHttpMcpServer } from "./tools/http-mcp-server.js";
import { startTmuxAgentService } from "./tmux-agents/startup.js";
import { createTmuxAgentsServer } from "./tools/tmux-agents-server.js";
import { createMessageQueue } from "./gateway/queue.js";
import { createRouter } from "./gateway/router.js";
import { createTelegramAdapter } from "./adapters/telegram.js";
import { createSlackAdapter } from "./adapters/slack.js";
import { createRemoteBridge } from "./remote/bridge.js";
import { createTelegramRouter } from "./remote/telegram-router.js";
import { createSlackRouter } from "./remote/slack-router.js";
import * as fsPromises from "node:fs/promises";
import * as osModule from "node:os";
import * as pathModule from "node:path";
import { createGithubWebhookAdapter } from "./adapters/github-webhook.js";
import { createHeartbeatScheduler } from "./heartbeat/scheduler.js";
import { loadCronStore } from "./cron/store.js";
import { armTimer } from "./cron/timer.js";
import { createCronToolManager } from "./cron/tool.js";
import { createBackend } from "./backends/factory.js";
import { createLogger } from "./core/logger.js";

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
      githubWebhook: {
        enabled: false,
        bind: "127.0.0.1",
        port: 19210,
        path: "/personal-assistant/github/webhook",
        botLogin: "",
        secretEnvVar: "PA_GITHUB_WEBHOOK_SECRET",
      },
    },
    heartbeat: {
      enabled: false,
      intervalMinutes: 30,
      activeHours: "8-21",
      deliverTo: "last",
    },
    gateway: { maxQueueSize: 20, processingUpdateIntervalMs: 5000, rateLimiter: { enabled: false, windowMs: 60_000, maxRequests: 20 } },
    agent: { backend: "claude" as const, model: null, maxTurns: 200 },
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
      embedding: { lazyLoad: false, idleUnloadMinutes: 10, dimensions: 768, model: "" },
      sync: { intervalMinutes: 30, watch: false, beforeSearchMinIntervalSeconds: 30 },
    },
    mcpServers: {},
    codex: {
      codexPath: null,
      apiKey: null,
      baseUrl: null,
      sandboxMode: "workspace-write" as const,
      approvalPolicy: "never" as const,
      networkAccess: false,
      reasoningEffort: null,
      skipGitRepoCheck: true,
      configOverrides: {},
      httpMcpPort: 47392,
    },
    reflection: {
      enabled: false,
      schedule: "0 7 * * *",
      maxDailyLogEntries: 500,
    },
    integApi: {
      enabled: false,
      port: 19100,
      bind: "127.0.0.1",
      inboundRateLimit: 100,
      contentFilter: { redactPatterns: [], maxBodyLength: 50000 },
      services: {
        gmail: { enabled: false, scopes: [] },
        calendar: { enabled: false, scopes: [] },
      },
    },
    habits: { enabled: false, pillars: [] },
    drafts: { enabled: false, ttlHours: 24, autoScan: false },
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
    syncFiles: vi.fn().mockResolvedValue(undefined),
    markDirty: vi.fn(),
    isDirty: vi.fn(() => false),
    syncIfDirty: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn(),
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
function makeMockBackend() {
  return {
    name: "claude",
    runTurn: vi.fn(async function* () {}),
    runTurnSync: vi.fn().mockResolvedValue({ response: "", messages: [], partial: false }),
    clearSession: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function setupMocks(config: Config) {
  const mockStore = makeMockStore();
  const mockEmbedder = makeMockEmbedder();
  const mockIndexer = makeMockIndexer();
  const mockQueue = makeMockQueue();
  const mockRouter = makeMockRouter();
  const mockCronManager = makeMockCronManager();
  const mockBackend = makeMockBackend();
  const mockHttpMcpServer = {
    port: config.codex.httpMcpPort,
    close: vi.fn().mockResolvedValue(undefined),
  };

  vi.mocked(loadConfig).mockReturnValue(config);
  vi.mocked(ensureWorkspace).mockResolvedValue(undefined);
  vi.mocked(createEmbeddingProvider).mockResolvedValue(mockEmbedder);
  vi.mocked(createVectorStore).mockReturnValue(mockStore as any);
  vi.mocked(createEpisodeStore).mockReturnValue({
    insertEpisode: vi.fn(),
    getEpisodeById: vi.fn(),
    listEpisodes: vi.fn(() => []),
    close: vi.fn(),
  } as any);
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
  vi.mocked(createIntegServer).mockReturnValue({} as any);
  vi.mocked(startHttpMcpServer).mockResolvedValue(mockHttpMcpServer);
  vi.mocked(createMessageQueue).mockReturnValue(mockQueue as any);
  vi.mocked(createRouter).mockReturnValue(mockRouter);
  vi.mocked(createGithubWebhookAdapter).mockReturnValue(makeMockAdapter("github") as any);
  vi.mocked(createHeartbeatScheduler).mockReturnValue({ stop: vi.fn() });
  vi.mocked(loadCronStore).mockResolvedValue([]);
  vi.mocked(armTimer).mockReturnValue({ disarm: vi.fn() });
  vi.mocked(createCronToolManager).mockReturnValue(mockCronManager);
  vi.mocked(createBackend).mockResolvedValue(mockBackend);

  return {
    mockStore,
    mockEmbedder,
    mockIndexer,
    mockQueue,
    mockRouter,
    mockCronManager,
    mockBackend,
    mockHttpMcpServer,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("daemon", () => {
  let originalProcessOn: typeof process.on;
  let signalHandlers: Map<string, Function>;
  let baselineRejectionListeners: Set<unknown>;

  beforeEach(() => {
    baselineRejectionListeners = new Set(process.listeners("unhandledRejection"));
    vi.clearAllMocks();
    mockLogger.info.mockReset();
    mockLogger.error.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.debug.mockReset();
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
    // startDaemon registers an unhandledRejection listener per call: do not let them pile up across tests
    for (const listener of process.listeners("unhandledRejection")) {
      if (!baselineRejectionListeners.has(listener)) process.off("unhandledRejection", listener as never);
    }
  });

  // -----------------------------------------------------------------------
  // 1. Startup initialization
  // -----------------------------------------------------------------------
  it("initializes config, workspace, queue, and router on startup", async () => {
    const config = makeConfig();
    const { mockQueue, mockRouter, mockBackend } = setupMocks(config);

    await startDaemon("/app");

    expect(loadConfig).toHaveBeenCalledWith("/app");
    expect(ensureWorkspace).toHaveBeenCalledWith(config);
    expect(createMessageQueue).toHaveBeenCalledWith(config, expect.any(Function));
    expect(createRouter).toHaveBeenCalled();
    expect(createEmbeddingProvider).toHaveBeenCalled();
    expect(createVectorStore).toHaveBeenCalled();
    expect(createIndexer).toHaveBeenCalled();
    expect(readMemoryFiles).toHaveBeenCalled();
    expect(buildAgentOptions).toHaveBeenCalled();
    expect(createBackend).toHaveBeenCalledWith(config, expect.any(Object), expect.objectContaining({ configDir: expect.any(String), redact: expect.any(Function) }));
    expect(createMemoryServer).toHaveBeenCalled();
    expect(createAssistantServer).toHaveBeenCalled();
    expect(createIntegServer).toHaveBeenCalledWith(config.integApi);
    expect(mockQueue.processLoop).toHaveBeenCalledWith(mockBackend, config, expect.any(Object));
  });

  it("starts shared HTTP MCP server for Codex backend and passes its port to the backend", async () => {
    const config = makeConfig({
      agent: { backend: "codex", model: null, maxTurns: 200 },
    });
    const { mockQueue, mockBackend } = setupMocks(config);

    await startDaemon("/app");

    expect(startHttpMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.any(Function),
        handleCronAction: expect.any(Function),
        handleExec: expect.any(Function),
        getProcessSession: expect.any(Function),
        listProcessSessions: expect.any(Function),
      }),
      config.codex.httpMcpPort,
    );
    expect(createBackend).toHaveBeenCalledWith(
      config,
      expect.any(Object),
      expect.objectContaining({
        configDir: expect.any(String),
        redact: expect.any(Function),
        httpMcpPort: config.codex.httpMcpPort,
      }),
    );
    expect(mockQueue.processLoop).toHaveBeenCalledWith(mockBackend, config, expect.any(Object));
  });

  it("starts shared HTTP MCP server for Claude when explicitly enabled", async () => {
    const config = makeConfig({
      mcp: { httpServer: { enabled: true } },
    } as Partial<Config>);
    setupMocks(config);

    await startDaemon("/app");

    expect(startHttpMcpServer).toHaveBeenCalledWith(expect.any(Object), config.codex.httpMcpPort);
  });

  it("falls back to stdio MCP when shared HTTP MCP server startup fails", async () => {
    const config = makeConfig({
      agent: { backend: "codex", model: null, maxTurns: 200 },
    });
    const { mockQueue, mockBackend } = setupMocks(config);
    vi.mocked(startHttpMcpServer).mockRejectedValue(new Error("listen EADDRINUSE: address already in use 127.0.0.1:47392"));

    await startDaemon("/app");

    expect(createBackend).toHaveBeenCalledWith(
      config,
      expect.any(Object),
      expect.objectContaining({
        configDir: expect.any(String),
        redact: expect.any(Function),
        httpMcpPort: undefined,
      }),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        port: config.codex.httpMcpPort,
      }),
      "shared HTTP MCP server unavailable; falling back to stdio MCP per Codex turn",
    );
    expect(mockQueue.processLoop).toHaveBeenCalledWith(mockBackend, config, expect.any(Object));
  });

  it("closes shared HTTP MCP server if backend creation fails after startup", async () => {
    const config = makeConfig({
      agent: { backend: "codex", model: null, maxTurns: 200 },
    });
    const { mockHttpMcpServer } = setupMocks(config);
    vi.mocked(createBackend).mockRejectedValueOnce(new Error("codex bootstrap failed"));

    await expect(startDaemon("/app")).rejects.toThrow("codex bootstrap failed");

    expect(startHttpMcpServer).toHaveBeenCalledWith(
      expect.any(Object),
      config.codex.httpMcpPort,
    );
    expect(mockHttpMcpServer.close).toHaveBeenCalledTimes(1);
  });

  describe("tmux agent sessions", () => {
    const mcpServersOf = () => vi.mocked(buildAgentOptions).mock.calls[0]![3] as Record<string, unknown>;

    it("registers no tmuxagents server and no HTTP tool deps when the feature is disabled", async () => {
      const config = makeConfig({ mcp: { httpServer: { enabled: true } } } as Partial<Config>);
      setupMocks(config);
      vi.mocked(startTmuxAgentService).mockResolvedValue(undefined);

      await startDaemon("/app");

      expect(startTmuxAgentService).toHaveBeenCalledWith(config, expect.objectContaining({ caller: "daemon", reaper: true }));
      expect(mcpServersOf()).not.toHaveProperty("tmuxagents");
      expect(createTmuxAgentsServer).not.toHaveBeenCalled();
      expect(vi.mocked(startHttpMcpServer).mock.calls[0]![0]).not.toHaveProperty("tmuxAgents");
    });

    it("registers the tmuxagents SDK server and the HTTP tool deps when the service exists", async () => {
      const config = makeConfig({ mcp: { httpServer: { enabled: true } } } as Partial<Config>);
      setupMocks(config);
      const service = { close: vi.fn(), reconcile: vi.fn(), startReaper: vi.fn() };
      const sdkServer = { name: "tmuxagents-server" };
      vi.mocked(startTmuxAgentService).mockResolvedValue(service as never);
      vi.mocked(createTmuxAgentsServer).mockReturnValue(sdkServer as never);

      await startDaemon("/app");

      expect(createTmuxAgentsServer).toHaveBeenCalledWith(service);
      expect(mcpServersOf()["tmuxagents"]).toBe(sdkServer);
      expect(vi.mocked(startHttpMcpServer).mock.calls[0]![0]).toHaveProperty("tmuxAgents", service);
    });

    it("shutdown closes the service (reaper timer) and kills no session", async () => {
      const config = makeConfig();
      setupMocks(config);
      const service = { close: vi.fn(), kill: vi.fn(), stop: vi.fn() };
      vi.mocked(startTmuxAgentService).mockResolvedValue(service as never);
      vi.mocked(createTmuxAgentsServer).mockReturnValue({} as never);
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

      await startDaemon("/app");
      await signalHandlers.get("SIGTERM")!();

      expect(service.close).toHaveBeenCalledTimes(1);
      expect(service.kill).not.toHaveBeenCalled();
      expect(service.stop).not.toHaveBeenCalled();
      exitSpy.mockRestore();
    });

    it("closes the service when backend creation fails", async () => {
      const config = makeConfig();
      setupMocks(config);
      const service = { close: vi.fn() };
      vi.mocked(startTmuxAgentService).mockResolvedValue(service as never);
      vi.mocked(createTmuxAgentsServer).mockReturnValue({} as never);
      vi.mocked(createBackend).mockRejectedValueOnce(new Error("backend failed"));

      await expect(startDaemon("/app")).rejects.toThrow("backend failed");
      expect(service.close).toHaveBeenCalledTimes(1);
    });
  });

  it("continues startup when episodic store open fails", async () => {
    const config = makeConfig();
    const { mockQueue, mockBackend } = setupMocks(config);
    vi.mocked(createEpisodeStore).mockImplementation(() => {
      throw new Error("episodes.db incompatible schema");
    });

    await startDaemon("/app");

    expect(createMemoryServer).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.any(Function),
        redact: expect.any(Function),
      }),
    );
    const deps = vi.mocked(createMemoryServer).mock.calls[0][0] as Record<string, unknown>;
    expect(deps).not.toHaveProperty("listEpisodes");
    expect(mockQueue.processLoop).toHaveBeenCalledWith(mockBackend, config, expect.any(Object));
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "episodic memory store unavailable; episodic MCP tools disabled",
    );
  });

  it("reports degraded daemon startup through the entrypoint probe", async () => {
    const config = makeConfig();
    setupMocks(config);
    vi.mocked(createEpisodeStore).mockImplementation(() => {
      throw new Error("episodes.db incompatible schema");
    });

    const probe = await runDegradedDaemonStartupProbe({
      config,
      configDir: "/app",
    });

    expect(probe.actualMode).toBe("raw_audit_fallback");
    expect(probe.assistantAvailable).toBe(true);
      expect(probe.fallbackTriggered).toBe(true);
      expect(probe.warningTriggered).toBe(true);
      expect(probe.episodicSurfaceExposed).toBe(false);
      expect(probe.mcpServersInjected).toBe(true);
      expect(probe.actualResults[0]?.id).toBe("startup-log-daemon-entrypoint-fallback");
  });

  it("reports a healthy daemon startup probe without false degraded signal", async () => {
    const config = makeConfig();
    setupMocks(config);

    const probe = await runDegradedDaemonStartupProbe({
      config,
      configDir: "/app",
    });

    expect(probe.assistantAvailable).toBe(true);
      expect(probe.fallbackTriggered).toBe(false);
      expect(probe.warningTriggered).toBe(false);
      expect(probe.episodicSurfaceExposed).toBe(true);
      expect(probe.mcpServersInjected).toBe(true);
      expect(probe.actualResults[0]?.explanation).toContain("did not trigger");
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
        githubWebhook: {
          enabled: false,
          bind: "127.0.0.1",
          port: 19210,
          path: "/personal-assistant/github/webhook",
          botLogin: "",
          secretEnvVar: "PA_GITHUB_WEBHOOK_SECRET",
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

    // GitHub webhook should NOT be created since it's disabled
    expect(createGithubWebhookAdapter).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Remote session mode
  // -----------------------------------------------------------------------
  describe("remote session mode", () => {
    function remoteConfig(telegramEnabled: boolean, slackEnabled = false, defaultChannel?: "telegram" | "slack"): Config {
      const base = makeConfig();
      return makeConfig({
        adapters: {
          ...base.adapters,
          telegram: { ...base.adapters.telegram, enabled: telegramEnabled, allowedUserIds: [4242] },
          slack: { ...base.adapters.slack, enabled: slackEnabled, botToken: "xoxb-test", appToken: "xapp-test", allowedUserIds: ["U1"] },
        },
        claudeCode: { remote: { enabled: true, slack: { progress: false, reactions: true, format: "mrkdwn" }, ...(defaultChannel ? { defaultChannel } : {}) } },
      } as Partial<Config>);
    }

    function mockSlack() {
      const remoteApi = { openDm: vi.fn(), postMessage: vi.fn(), updateMessage: vi.fn(), addReaction: vi.fn(), removeReaction: vi.fn() };
      const slack = { ...makeMockAdapter("slack"), remote: remoteApi };
      vi.mocked(createSlackAdapter).mockReturnValue(slack as any);
      return slack;
    }

    let configDir: string;
    beforeEach(async () => {
      configDir = await fsPromises.mkdtemp(pathModule.join(osModule.tmpdir(), "pa-daemon-remote-"));
      vi.mocked(createRemoteBridge).mockReset();
      vi.mocked(createTelegramRouter).mockReset();
      vi.mocked(createSlackRouter).mockReset();
    });
    afterEach(async () => {
      await fsPromises.rm(configDir, { recursive: true, force: true });
    });

    it("writes the token file, starts the HTTP server with the holder, binds the bridge and wraps onMessage", async () => {
      const config = remoteConfig(true);
      const { mockQueue } = setupMocks(config);
      const telegram = { ...makeMockAdapter("telegram"), createProcessingMessage: vi.fn(), updateProcessingMessage: vi.fn() };
      vi.mocked(createTelegramAdapter).mockReturnValue(telegram as any);
      const bridge = { stop: vi.fn() };
      vi.mocked(createRemoteBridge).mockReturnValue(bridge as any);
      const routed = vi.fn();
      vi.mocked(createTelegramRouter).mockReturnValue(routed);

      await startDaemon(configDir);

      const token = (await fsPromises.readFile(pathModule.join(configDir, "remote-token"), "utf8")).trim();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect((await fsPromises.stat(pathModule.join(configDir, "remote-token"))).mode & 0o777).toBe(0o600);
      const holder = vi.mocked(startHttpMcpServer).mock.calls[0]![2]!;
      expect(holder).toMatchObject({ token, defaultChatIds: { telegram: "telegram:4242" }, bridge });
      expect(createTelegramRouter).toHaveBeenCalledWith(expect.objectContaining({ bridge, enqueue: expect.any(Function), send: expect.any(Function) }));

      // The adapter callback goes through the router.
      const onMessage = vi.mocked(createTelegramAdapter).mock.calls[0]![1];
      const msg = { source: "telegram", sourceId: "4242", text: "/status" };
      onMessage(msg);
      expect(routed).toHaveBeenCalledWith(msg);
      expect(mockQueue.enqueue).not.toHaveBeenCalled();

      // The router's enqueue keeps the normal queue path.
      const routerDeps = vi.mocked(createTelegramRouter).mock.calls[0]![0];
      routerDeps.enqueue(msg);
      expect(mockQueue.enqueue).toHaveBeenCalledWith(msg);
    });

    it("stops the bridge and removes the token file on shutdown", async () => {
      const config = remoteConfig(true);
      setupMocks(config);
      vi.mocked(createTelegramAdapter).mockReturnValue(makeMockAdapter("telegram") as any);
      const bridge = { stop: vi.fn() };
      vi.mocked(createRemoteBridge).mockReturnValue(bridge as any);
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

      await startDaemon(configDir);
      await signalHandlers.get("SIGTERM")!();

      expect(bridge.stop).toHaveBeenCalled();
      await expect(fsPromises.stat(pathModule.join(configDir, "remote-token"))).rejects.toThrow();
      exitSpy.mockRestore();
    });

    it("Slack only: bridge ready, token file written, routers wired, default chat is slack", async () => {
      const config = remoteConfig(false, true);
      const { mockQueue } = setupMocks(config);
      const slack = mockSlack();
      const bridge = { stop: vi.fn() };
      vi.mocked(createRemoteBridge).mockReturnValue(bridge as any);
      const slackRouter = { onMessage: vi.fn(), onCommand: vi.fn().mockResolvedValue("ok") };
      vi.mocked(createSlackRouter).mockReturnValue(slackRouter);
      // Bridge must be bound before the Slack adapter starts.
      let holderBridgeAtStart: unknown;
      slack.start.mockImplementation(() => {
        holderBridgeAtStart = vi.mocked(startHttpMcpServer).mock.calls[0]![2]!.bridge;
      });

      await startDaemon(configDir);

      expect(createTelegramAdapter).not.toHaveBeenCalled();
      expect(createTelegramRouter).not.toHaveBeenCalled();
      expect((await fsPromises.readFile(pathModule.join(configDir, "remote-token"), "utf8")).trim()).toMatch(/^[0-9a-f]{64}$/);
      expect(vi.mocked(startHttpMcpServer).mock.calls[0]![2]).toMatchObject({ defaultChatIds: { slack: "slack:U1" }, bridge });
      expect(holderBridgeAtStart).toBe(bridge);
      expect(createSlackRouter).toHaveBeenCalledWith(expect.objectContaining({ bridge, enqueue: expect.any(Function) }));

      const [, onMessage, options] = vi.mocked(createSlackAdapter).mock.calls[0]!;
      const msg = { source: "slack", sourceId: "D1--1", text: "hi" } as any;
      onMessage(msg);
      expect(slackRouter.onMessage).toHaveBeenCalledWith(msg);
      expect(mockQueue.enqueue).not.toHaveBeenCalled();
      await expect(options!.onCommand!({ userId: "U1", text: "status", channelId: "D1" })).resolves.toBe("ok");
      expect(slackRouter.onCommand).toHaveBeenCalled();
    });

    it("both channels share ONE bridge and the registry resolves both", async () => {
      const config = remoteConfig(true, true, "slack");
      setupMocks(config);
      vi.mocked(createTelegramAdapter).mockReturnValue({ ...makeMockAdapter("telegram"), createProcessingMessage: vi.fn(), updateProcessingMessage: vi.fn() } as any);
      mockSlack();
      const bridge = { stop: vi.fn() };
      vi.mocked(createRemoteBridge).mockReturnValue(bridge as any);
      vi.mocked(createSlackRouter).mockReturnValue({ onMessage: vi.fn(), onCommand: vi.fn() });

      await startDaemon(configDir);

      expect(createRemoteBridge).toHaveBeenCalledTimes(1);
      const registry = vi.mocked(createRemoteBridge).mock.calls[0]![0].channels;
      expect(registry.get("telegram")?.id).toBe("telegram");
      expect(registry.get("slack")?.id).toBe("slack");
      expect(createTelegramRouter).toHaveBeenCalledWith(expect.objectContaining({ bridge }));
      expect(createSlackRouter).toHaveBeenCalledWith(expect.objectContaining({ bridge }));
      expect(vi.mocked(startHttpMcpServer).mock.calls[0]![2]).toMatchObject({
        defaultChatIds: { telegram: "telegram:4242", slack: "slack:U1" },
        defaultChannel: "slack",
        bridge,
      });
    });

    it("the in-daemon MCP handler resolves the default chat with the shared helper", async () => {
      const config = remoteConfig(true, true);
      setupMocks(config);
      vi.mocked(createTelegramAdapter).mockReturnValue(makeMockAdapter("telegram") as any);
      mockSlack();
      const bridge = { stop: vi.fn(), control: vi.fn().mockResolvedValue({ ok: true, message: "m", sessions: [] }) };
      vi.mocked(createRemoteBridge).mockReturnValue(bridge as any);
      vi.mocked(createSlackRouter).mockReturnValue({ onMessage: vi.fn(), onCommand: vi.fn() });

      await startDaemon(configDir);

      const deps = vi.mocked(startHttpMcpServer).mock.calls[0]![0];
      await deps.handleRemoteControl!({ action: "attach", channel: "slack" });
      expect(bridge.control).toHaveBeenLastCalledWith({ action: "attach", channel: "slack", chatId: "slack:U1" });
      await deps.handleRemoteControl!({ action: "attach" });
      expect(bridge.control).toHaveBeenLastCalledWith({ action: "attach", chatId: "telegram:4242" });
      await deps.handleRemoteControl!({ action: "detach" });
      expect(bridge.control).toHaveBeenLastCalledWith({ action: "detach" });
    });

    it("the in-daemon MCP handler refuses a channel that is not enabled", async () => {
      const config = remoteConfig(true);
      setupMocks(config);
      vi.mocked(createTelegramAdapter).mockReturnValue(makeMockAdapter("telegram") as any);
      vi.mocked(createRemoteBridge).mockReturnValue({ stop: vi.fn(), control: vi.fn() } as any);

      await startDaemon(configDir);

      const deps = vi.mocked(startHttpMcpServer).mock.calls[0]![0];
      await expect(deps.handleRemoteControl!({ action: "attach", channel: "slack" })).rejects.toThrow(/slack is not enabled/);
    });

    it("warns when settings.json is group/world readable and Slack is enabled (mode check only)", async () => {
      const config = remoteConfig(false, true);
      setupMocks(config);
      mockSlack();
      vi.mocked(createRemoteBridge).mockReturnValue({ stop: vi.fn() } as any);
      vi.mocked(createSlackRouter).mockReturnValue({ onMessage: vi.fn(), onCommand: vi.fn() });
      const file = pathModule.join(configDir, "settings.json");
      await fsPromises.writeFile(file, "{}", { mode: 0o644 });
      await fsPromises.chmod(file, 0o644);

      await startDaemon(configDir);
      expect(mockLogger.warn.mock.calls.some(([, msg]) => String(msg).includes("group/world readable"))).toBe(true);
      mockLogger.warn.mockClear();

      await fsPromises.chmod(file, 0o600);
      await startDaemon(configDir);
      expect(mockLogger.warn.mock.calls.some(([, msg]) => String(msg).includes("group/world readable"))).toBe(false);
    });

    it("warns once when remote is enabled but no channel is: no token, no routes, no bridge", async () => {
      const config = remoteConfig(false);
      setupMocks(config);

      await startDaemon(configDir);

      const warnings = mockLogger.warn.mock.calls.filter(([msg]) => String(msg).includes("neither adapters.telegram nor adapters.slack"));
      expect(warnings).toHaveLength(1);
      expect(createRemoteBridge).not.toHaveBeenCalled();
      for (const call of vi.mocked(startHttpMcpServer).mock.calls) expect(call[2]).toBeUndefined();
      await expect(fsPromises.stat(pathModule.join(configDir, "remote-token"))).rejects.toThrow();
    });

    it("never touches the token file of a live daemon when the HTTP server cannot bind", async () => {
      const config = remoteConfig(true);
      setupMocks(config);
      vi.mocked(startHttpMcpServer).mockRejectedValue(new Error("listen EADDRINUSE: address already in use"));
      vi.mocked(createTelegramAdapter).mockReturnValue(makeMockAdapter("telegram") as any);
      const tokenFile = pathModule.join(configDir, "remote-token");
      await fsPromises.writeFile(tokenFile, "live-daemon-token\n");
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

      await startDaemon(configDir);
      expect(await fsPromises.readFile(tokenFile, "utf8")).toBe("live-daemon-token\n");
      expect(createRemoteBridge).not.toHaveBeenCalled();

      await signalHandlers.get("SIGTERM")!();
      expect(await fsPromises.readFile(tokenFile, "utf8")).toBe("live-daemon-token\n");
      exitSpy.mockRestore();
    });

    it("the startup probe neither writes a token nor mounts remote routes", async () => {
      const config = remoteConfig(true);
      setupMocks(config);

      await runDegradedDaemonStartupProbe({ config, configDir });

      await expect(fsPromises.stat(pathModule.join(configDir, "remote-token"))).rejects.toThrow();
      for (const call of vi.mocked(startHttpMcpServer).mock.calls) expect(call[2]).toBeUndefined();
    });

    it("does not start the token or router when remote mode is off", async () => {
      const config = makeConfig();
      setupMocks(config);

      await startDaemon(configDir);

      expect(createRemoteBridge).not.toHaveBeenCalled();
      expect(createTelegramRouter).not.toHaveBeenCalled();
      await expect(fsPromises.stat(pathModule.join(configDir, "remote-token"))).rejects.toThrow();
    });
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
      agent: { backend: "codex", model: null, maxTurns: 200 },
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
        githubWebhook: {
          enabled: false,
          bind: "127.0.0.1",
          port: 19210,
          path: "/personal-assistant/github/webhook",
          botLogin: "",
          secretEnvVar: "PA_GITHUB_WEBHOOK_SECRET",
        },
      },
    });

    const mockTelegramAdapter = makeMockAdapter("telegram");
    const { mockQueue, mockStore, mockEmbedder, mockIndexer, mockCronManager, mockBackend, mockHttpMcpServer } =
      setupMocks(config);
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
    expect(mockIndexer.abort).toHaveBeenCalled();
    expect(mockIndexer.abort.mock.invocationCallOrder[0]).toBeLessThan(
      mockBackend.close.mock.invocationCallOrder[0],
    );
    expect(mockBackend.close).toHaveBeenCalled();
    expect(mockHttpMcpServer.close).toHaveBeenCalled();
    expect(mockStore.close).toHaveBeenCalled();
    expect(mockEmbedder.close).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
  });

  // -----------------------------------------------------------------------
  // 6. SIGINT triggers graceful shutdown
  // -----------------------------------------------------------------------
  it("registers SIGINT handler that triggers graceful shutdown", async () => {
    const config = makeConfig({
      agent: { backend: "codex", model: null, maxTurns: 200 },
    });
    const { mockQueue, mockStore, mockEmbedder, mockIndexer, mockCronManager, mockBackend, mockHttpMcpServer } =
      setupMocks(config);

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
    expect(mockIndexer.abort).toHaveBeenCalled();
    expect(mockIndexer.abort.mock.invocationCallOrder[0]).toBeLessThan(
      mockBackend.close.mock.invocationCallOrder[0],
    );
    expect(mockBackend.close).toHaveBeenCalled();
    expect(mockHttpMcpServer.close).toHaveBeenCalled();
    expect(mockStore.close).toHaveBeenCalled();
    expect(mockEmbedder.close).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
  });
});
