import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AdapterMessage, Adapter, Config } from "../core/types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../core/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock("../core/agent-runner.js", () => ({
  runAgentTurn: vi.fn(),
}));

vi.mock("../session/manager.js", () => ({
  resolveSessionKey: vi.fn(
    (source: string, sourceId: string) => `${source}--${sourceId}`,
  ),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createMessageQueue } from "./queue.js";
import { createRouter } from "./router.js";
import { runAgentTurn } from "../core/agent-runner.js";
import type { AgentOptions, AgentTurnResult } from "../core/agent-runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<AdapterMessage> = {}): AdapterMessage {
  return {
    source: "telegram",
    sourceId: "123456",
    text: "Hello",
    ...overrides,
  };
}

function makeConfig(overrides: Partial<Config> = {}): Config {
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
      telegram: {
        enabled: false,
        botToken: "",
        allowedUserIds: [],
        mode: "polling" as const,
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
      activeHours: "8-21",
      deliverTo: "last" as const,
    },
    gateway: { maxQueueSize: 5 },
    agent: { model: null, maxTurns: 10 },
    session: { maxHistoryMessages: 50, compactionEnabled: false },
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
    ...overrides,
  } as Config;
}

function makeAdapter(name: string): Adapter {
  return {
    name,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendResponse: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAgentOptions(): AgentOptions {
  return {
    systemPrompt: { type: "preset", preset: "claude_code", append: "" },
    cwd: "/tmp/workspace",
    tools: { type: "preset", preset: "claude_code" },
    allowedTools: [],
    sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
    hooks: {},
    mcpServers: {},
    settingSources: ["project"],
    maxTurns: 10,
  };
}

// ---------------------------------------------------------------------------
// Tests: MessageQueue
// ---------------------------------------------------------------------------

describe("MessageQueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // enqueue
  // -------------------------------------------------------------------------
  describe("enqueue", () => {
    it("adds message to queue and returns { accepted: true }", () => {
      const config = makeConfig();
      const queue = createMessageQueue(config);

      const result = queue.enqueue(makeMessage());

      expect(result).toEqual({ accepted: true });
    });

    it("accepts messages up to maxQueueSize", () => {
      const config = makeConfig({ gateway: { maxQueueSize: 3 } });
      const queue = createMessageQueue(config);

      const r1 = queue.enqueue(makeMessage({ text: "one" }));
      const r2 = queue.enqueue(makeMessage({ text: "two" }));
      const r3 = queue.enqueue(makeMessage({ text: "three" }));

      expect(r1).toEqual({ accepted: true });
      expect(r2).toEqual({ accepted: true });
      expect(r3).toEqual({ accepted: true });
    });

    it("rejects with { accepted: false } when queue is at maxQueueSize", () => {
      const config = makeConfig({ gateway: { maxQueueSize: 2 } });
      const queue = createMessageQueue(config);

      queue.enqueue(makeMessage({ text: "one" }));
      queue.enqueue(makeMessage({ text: "two" }));
      const result = queue.enqueue(makeMessage({ text: "three" }));

      expect(result).toEqual({ accepted: false });
    });
  });

  // -------------------------------------------------------------------------
  // processNext
  // -------------------------------------------------------------------------
  describe("processNext", () => {
    it("dequeues and processes one message via agent runner", async () => {
      const config = makeConfig();
      const agentOptions = makeAgentOptions();
      const router = createRouter();

      const turnResult: AgentTurnResult = {
        response: "Hi there!",
        messages: [],
      };
      vi.mocked(runAgentTurn).mockResolvedValue(turnResult);

      const queue = createMessageQueue(config);
      queue.enqueue(makeMessage({ text: "Hello" }));

      const processed = await queue.processNext(agentOptions, config, router);

      expect(processed).toBe(true);
      expect(runAgentTurn).toHaveBeenCalledWith(
        "Hello",
        "telegram--123456",
        agentOptions,
        config,
      );
    });

    it("returns false when queue is empty", async () => {
      const config = makeConfig();
      const agentOptions = makeAgentOptions();
      const router = createRouter();

      const queue = createMessageQueue(config);
      const processed = await queue.processNext(agentOptions, config, router);

      expect(processed).toBe(false);
      expect(runAgentTurn).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // FIFO order
  // -------------------------------------------------------------------------
  describe("FIFO order", () => {
    it("processes messages in first-in, first-out order", async () => {
      const config = makeConfig();
      const agentOptions = makeAgentOptions();
      const router = createRouter();

      const processedTexts: string[] = [];
      vi.mocked(runAgentTurn).mockImplementation(
        async (message: string) => {
          processedTexts.push(message);
          return { response: `reply to ${message}`, messages: [] };
        },
      );

      const queue = createMessageQueue(config);
      queue.enqueue(makeMessage({ text: "first" }));
      queue.enqueue(makeMessage({ text: "second" }));
      queue.enqueue(makeMessage({ text: "third" }));

      await queue.processNext(agentOptions, config, router);
      await queue.processNext(agentOptions, config, router);
      await queue.processNext(agentOptions, config, router);

      expect(processedTexts).toEqual(["first", "second", "third"]);
    });
  });

  // -------------------------------------------------------------------------
  // Serial processing
  // -------------------------------------------------------------------------
  describe("serial processing", () => {
    it("only processes one message at a time", async () => {
      const config = makeConfig();
      const agentOptions = makeAgentOptions();
      const router = createRouter();

      let concurrentCount = 0;
      let maxConcurrent = 0;

      vi.mocked(runAgentTurn).mockImplementation(async (message: string) => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrentCount--;
        return { response: `reply to ${message}`, messages: [] };
      });

      const queue = createMessageQueue(config);
      queue.enqueue(makeMessage({ text: "a" }));
      queue.enqueue(makeMessage({ text: "b" }));

      // Start both processNext calls concurrently
      const p1 = queue.processNext(agentOptions, config, router);
      const p2 = queue.processNext(agentOptions, config, router);

      await Promise.all([p1, p2]);

      expect(maxConcurrent).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // size
  // -------------------------------------------------------------------------
  describe("size", () => {
    it("returns current queue depth", () => {
      const config = makeConfig();
      const queue = createMessageQueue(config);

      expect(queue.size()).toBe(0);
      queue.enqueue(makeMessage());
      expect(queue.size()).toBe(1);
      queue.enqueue(makeMessage());
      expect(queue.size()).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: Router
// ---------------------------------------------------------------------------

describe("Router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // register / route
  // -------------------------------------------------------------------------
  describe("route", () => {
    it("delivers response back to the source adapter", async () => {
      const router = createRouter();
      const adapter = makeAdapter("telegram");
      router.register(adapter);

      const response: AdapterMessage = {
        source: "telegram",
        sourceId: "123456",
        text: "Here is your answer",
      };

      await router.route(response);

      expect(adapter.sendResponse).toHaveBeenCalledWith(response);
    });

    it("routes to the correct adapter when multiple are registered", async () => {
      const router = createRouter();
      const telegram = makeAdapter("telegram");
      const slack = makeAdapter("slack");
      router.register(telegram);
      router.register(slack);

      const response: AdapterMessage = {
        source: "slack",
        sourceId: "C123",
        text: "Slack reply",
      };

      await router.route(response);

      expect(slack.sendResponse).toHaveBeenCalledWith(response);
      expect(telegram.sendResponse).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Unknown adapter
  // -------------------------------------------------------------------------
  describe("unknown adapter", () => {
    it("handles unknown adapter gracefully (does not throw)", async () => {
      const router = createRouter();

      const response: AdapterMessage = {
        source: "unknown_adapter",
        sourceId: "999",
        text: "Lost message",
      };

      // Should not throw
      await expect(router.route(response)).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // unregister
  // -------------------------------------------------------------------------
  describe("unregister", () => {
    it("removes an adapter so it no longer receives messages", async () => {
      const router = createRouter();
      const adapter = makeAdapter("telegram");
      router.register(adapter);
      router.unregister("telegram");

      const response: AdapterMessage = {
        source: "telegram",
        sourceId: "123456",
        text: "Should not arrive",
      };

      await router.route(response);

      expect(adapter.sendResponse).not.toHaveBeenCalled();
    });
  });
});
