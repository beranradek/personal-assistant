import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Config } from "./core/types.js";
import type { AgentTurnResult } from "./core/agent-runner.js";
import type { AgentBackend, StreamEvent } from "./backends/interface.js";

// ---------------------------------------------------------------------------
// Mocks – must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("./core/config.js", () => ({
  loadConfig: vi.fn(),
  resolveUserPath: vi.fn((p: string) => p),
}));

vi.mock("./core/workspace.js", () => ({
  ensureWorkspace: vi.fn(),
}));

vi.mock("./memory/files.js", () => ({
  readMemoryFiles: vi.fn(),
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

vi.mock("./core/agent-runner.js", () => ({
  buildAgentOptions: vi.fn(),
}));

vi.mock("./backends/factory.js", () => ({
  createBackend: vi.fn(),
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
// Imports – after mocks are registered
// ---------------------------------------------------------------------------

import { handleLine, handleLineStreaming, TERMINAL_SESSION_KEY, createTerminalSession } from "./terminal.js";
import { loadConfig } from "./core/config.js";
import { ensureWorkspace } from "./core/workspace.js";
import { readMemoryFiles } from "./memory/files.js";
import { createEmbeddingProvider } from "./memory/embeddings.js";
import { createVectorStore } from "./memory/vector-store.js";
import { createIndexer } from "./memory/indexer.js";
import { createMemoryServer } from "./tools/memory-server.js";
import { createAssistantServer } from "./tools/assistant-server.js";
import { createCronToolManager } from "./cron/tool.js";
import { buildAgentOptions } from "./core/agent-runner.js";
import { createBackend } from "./backends/factory.js";

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
      intervalMinutes: 60,
      activeHours: "09:00-17:00",
      deliverTo: "last",
    },
    gateway: { maxQueueSize: 100 },
    agent: { backend: "claude" as const, model: null, maxTurns: 10 },
    session: { maxHistoryMessages: 50, compactionEnabled: true },
    memory: {
      search: {
        enabled: false,
        hybridWeights: { vector: 0.7, keyword: 0.3 },
        minScore: 0.3,
        maxResults: 10,
        chunkTokens: 512,
        chunkOverlap: 64,
      },
      extraPaths: [],
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
    },
    ...overrides,
  };
}

function makeBackend(overrides: Partial<AgentBackend> = {}): AgentBackend {
  return {
    name: "test",
    runTurn: vi.fn(async function* () {}) as unknown as AgentBackend["runTurn"],
    runTurnSync: vi.fn().mockResolvedValue({
      response: "",
      messages: [],
      partial: false,
    }),
    clearSession: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("terminal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // TERMINAL_SESSION_KEY
  // -----------------------------------------------------------------------
  describe("TERMINAL_SESSION_KEY", () => {
    it('equals "terminal--default"', () => {
      expect(TERMINAL_SESSION_KEY).toBe("terminal--default");
    });
  });

  // -----------------------------------------------------------------------
  // createTerminalSession
  // -----------------------------------------------------------------------
  describe("createTerminalSession", () => {
    function setupSessionMocks(config: Config) {
      const mockEmbedder = {
        embed: vi.fn(),
        embedBatch: vi.fn(),
        dimensions: 768,
        close: vi.fn(),
      };
      const mockStore = {
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
      const mockIndexer = {
        syncFiles: vi.fn(),
        markDirty: vi.fn(),
        isDirty: vi.fn(() => false),
        syncIfDirty: vi.fn(),
        close: vi.fn(),
      };
      const mockCronManager = {
        handleAction: vi.fn(),
        rearmTimer: vi.fn(),
        stop: vi.fn(),
      };
      const mockBackend = makeBackend();

      vi.mocked(loadConfig).mockReturnValue(config);
      vi.mocked(ensureWorkspace).mockResolvedValue(undefined);
      vi.mocked(createEmbeddingProvider).mockResolvedValue(mockEmbedder);
      vi.mocked(createVectorStore).mockReturnValue(mockStore as any);
      vi.mocked(createIndexer).mockReturnValue(mockIndexer);
      vi.mocked(readMemoryFiles).mockResolvedValue("memory content");
      vi.mocked(createMemoryServer).mockReturnValue({} as any);
      vi.mocked(createAssistantServer).mockReturnValue({} as any);
      vi.mocked(createCronToolManager).mockReturnValue(mockCronManager);
      vi.mocked(createBackend).mockResolvedValue(mockBackend);

      return { mockEmbedder, mockStore, mockIndexer, mockCronManager, mockBackend };
    }

    it("creates a terminal session with config and backend", async () => {
      const config = makeConfig();
      const { mockBackend } = setupSessionMocks(config);
      vi.mocked(buildAgentOptions).mockReturnValue({} as any);

      const session = await createTerminalSession("/app");

      expect(loadConfig).toHaveBeenCalledWith("/app");
      expect(ensureWorkspace).toHaveBeenCalledWith(config);
      expect(readMemoryFiles).toHaveBeenCalledWith(config.security.workspace, {
        includeHeartbeat: false,
      });
      expect(session.config).toBe(config);
      expect(session.backend).toBe(mockBackend);
      expect(session.sessionKey).toBe("terminal--default");
    });

    it("initializes memory system and MCP servers", async () => {
      const config = makeConfig();
      setupSessionMocks(config);
      vi.mocked(buildAgentOptions).mockReturnValue({} as any);

      await createTerminalSession("/app");

      expect(createEmbeddingProvider).toHaveBeenCalled();
      expect(createVectorStore).toHaveBeenCalled();
      expect(createIndexer).toHaveBeenCalled();
      expect(createMemoryServer).toHaveBeenCalled();
      expect(createAssistantServer).toHaveBeenCalled();
      expect(createCronToolManager).toHaveBeenCalled();
    });

    it("passes memory and assistant MCP servers to buildAgentOptions", async () => {
      const config = makeConfig();
      setupSessionMocks(config);
      const mockMemoryServer = { name: "memory" };
      const mockAssistantServer = { name: "assistant" };
      vi.mocked(createMemoryServer).mockReturnValue(mockMemoryServer as any);
      vi.mocked(createAssistantServer).mockReturnValue(mockAssistantServer as any);
      vi.mocked(buildAgentOptions).mockReturnValue({} as any);

      await createTerminalSession("/app");

      expect(buildAgentOptions).toHaveBeenCalledWith(
        config,
        config.security.workspace,
        "memory content",
        expect.objectContaining({
          memory: mockMemoryServer,
          assistant: mockAssistantServer,
        }),
      );
    });

    it("merges user-configured MCP servers with built-in ones", async () => {
      const config = makeConfig({
        mcpServers: { "chrome-devtools": { command: "npx", args: [] } },
      });
      setupSessionMocks(config);
      vi.mocked(buildAgentOptions).mockReturnValue({} as any);

      await createTerminalSession("/app");

      expect(buildAgentOptions).toHaveBeenCalledWith(
        config,
        config.security.workspace,
        "memory content",
        expect.objectContaining({
          "chrome-devtools": { command: "npx", args: [] },
          memory: expect.anything(),
          assistant: expect.anything(),
        }),
      );
    });

    it("cleanup releases resources", async () => {
      const config = makeConfig();
      const { mockStore, mockEmbedder, mockCronManager, mockBackend } = setupSessionMocks(config);
      vi.mocked(buildAgentOptions).mockReturnValue({} as any);

      const session = await createTerminalSession("/app");
      await session.cleanup();

      expect(mockCronManager.stop).toHaveBeenCalled();
      expect(mockStore.close).toHaveBeenCalled();
      expect(mockEmbedder.close).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // handleLine
  // -----------------------------------------------------------------------
  describe("handleLine", () => {
    it("sends user input to backend with terminal session key", async () => {
      const backend = makeBackend();
      const turnResult: AgentTurnResult = {
        response: "Hello back!",
        messages: [
          { role: "user", content: "Hello", timestamp: "2025-06-15T12:00:00.000Z" },
          { role: "assistant", content: "Hello back!", timestamp: "2025-06-15T12:00:01.000Z" },
        ],
        partial: false,
      };
      vi.mocked(backend.runTurnSync).mockResolvedValue(turnResult);

      const result = await handleLine("Hello", TERMINAL_SESSION_KEY, backend);

      expect(backend.runTurnSync).toHaveBeenCalledWith(
        "Hello",
        "terminal--default",
      );
      expect(result).toEqual({ response: "Hello back!", error: null });
    });

    it("returns null for empty input (skips, re-prompts)", async () => {
      const backend = makeBackend();

      const result = await handleLine("", TERMINAL_SESSION_KEY, backend);

      expect(result).toBeNull();
      expect(backend.runTurnSync).not.toHaveBeenCalled();
    });

    it("returns null for whitespace-only input", async () => {
      const backend = makeBackend();

      const result = await handleLine("   \t  ", TERMINAL_SESSION_KEY, backend);

      expect(result).toBeNull();
      expect(backend.runTurnSync).not.toHaveBeenCalled();
    });

    it("trims input before sending to backend", async () => {
      const backend = makeBackend();
      const turnResult: AgentTurnResult = {
        response: "Trimmed!",
        messages: [
          { role: "user", content: "  hello  ", timestamp: "2025-06-15T12:00:00.000Z" },
          { role: "assistant", content: "Trimmed!", timestamp: "2025-06-15T12:00:01.000Z" },
        ],
        partial: false,
      };
      vi.mocked(backend.runTurnSync).mockResolvedValue(turnResult);

      await handleLine("  hello  ", TERMINAL_SESSION_KEY, backend);

      expect(backend.runTurnSync).toHaveBeenCalledWith(
        "hello",
        "terminal--default",
      );
    });

    it("returns error message when backend throws", async () => {
      const backend = makeBackend();
      vi.mocked(backend.runTurnSync).mockRejectedValue(new Error("SDK connection failed"));

      const result = await handleLine("Hello", TERMINAL_SESSION_KEY, backend);

      expect(result).toEqual({
        response: null,
        error: "SDK connection failed",
      });
    });

    it("returns error string for non-Error thrown values", async () => {
      const backend = makeBackend();
      vi.mocked(backend.runTurnSync).mockRejectedValue("string error");

      const result = await handleLine("Hello", TERMINAL_SESSION_KEY, backend);

      expect(result).toEqual({
        response: null,
        error: "string error",
      });
    });

    it("streams agent response to stdout", async () => {
      const backend = makeBackend();
      const turnResult: AgentTurnResult = {
        response: "The answer is 42",
        messages: [
          { role: "user", content: "What is the answer?", timestamp: "2025-06-15T12:00:00.000Z" },
          { role: "assistant", content: "The answer is 42", timestamp: "2025-06-15T12:00:01.000Z" },
        ],
        partial: false,
      };
      vi.mocked(backend.runTurnSync).mockResolvedValue(turnResult);

      const result = await handleLine("What is the answer?", TERMINAL_SESSION_KEY, backend);

      // The handleLine function returns the response which the caller outputs to stdout
      expect(result).not.toBeNull();
      expect(result!.response).toBe("The answer is 42");
    });
  });

  // -----------------------------------------------------------------------
  // handleLineStreaming
  // -----------------------------------------------------------------------
  describe("handleLineStreaming", () => {
    it("yields stream events from backend.runTurn", async () => {
      const backend = makeBackend();

      async function* mockStream(): AsyncGenerator<StreamEvent> {
        yield { type: "text_delta", text: "Hello" };
        yield { type: "result", response: "Hello", messages: [], partial: false };
      }
      vi.mocked(backend.runTurn).mockReturnValue(mockStream());

      const events: StreamEvent[] = [];
      for await (const event of handleLineStreaming("Hi", TERMINAL_SESSION_KEY, backend)) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: "text_delta", text: "Hello" });
      expect(backend.runTurn).toHaveBeenCalledWith("Hi", "terminal--default");
    });

    it("returns empty generator for empty input", async () => {
      const backend = makeBackend();

      const events: StreamEvent[] = [];
      for await (const event of handleLineStreaming("", TERMINAL_SESSION_KEY, backend)) {
        events.push(event);
      }

      expect(events).toHaveLength(0);
      expect(backend.runTurn).not.toHaveBeenCalled();
    });

    it("returns empty generator for whitespace-only input", async () => {
      const backend = makeBackend();

      const events: StreamEvent[] = [];
      for await (const event of handleLineStreaming("   ", TERMINAL_SESSION_KEY, backend)) {
        events.push(event);
      }

      expect(events).toHaveLength(0);
    });

    it("handles /clear command by yielding a result event", async () => {
      const backend = makeBackend();

      const events: StreamEvent[] = [];
      for await (const event of handleLineStreaming("/clear", TERMINAL_SESSION_KEY, backend)) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "result",
        response: "Conversation cleared. Starting fresh.",
        messages: [],
        partial: false,
      });
    });

    it("trims input before sending to backend.runTurn", async () => {
      const backend = makeBackend();

      async function* mockStream(): AsyncGenerator<StreamEvent> {
        yield { type: "result", response: "ok", messages: [], partial: false };
      }
      vi.mocked(backend.runTurn).mockReturnValue(mockStream());

      const events: StreamEvent[] = [];
      for await (const event of handleLineStreaming("  hello  ", TERMINAL_SESSION_KEY, backend)) {
        events.push(event);
      }

      expect(backend.runTurn).toHaveBeenCalledWith("hello", "terminal--default");
    });
  });
});
