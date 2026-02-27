import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AdapterMessage, Adapter, Config } from "../core/types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../core/logger.js", () => ({
  createLogger: () => mockLog,
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
    gateway: { maxQueueSize: 5, processingUpdateIntervalMs: 5000 },
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
      const config = makeConfig({ gateway: { maxQueueSize: 3, processingUpdateIntervalMs: 5000 } });
      const queue = createMessageQueue(config);

      const r1 = queue.enqueue(makeMessage({ text: "one" }));
      const r2 = queue.enqueue(makeMessage({ text: "two" }));
      const r3 = queue.enqueue(makeMessage({ text: "three" }));

      expect(r1).toEqual({ accepted: true });
      expect(r2).toEqual({ accepted: true });
      expect(r3).toEqual({ accepted: true });
    });

    it("rejects with { accepted: false } when queue is at maxQueueSize", () => {
      const config = makeConfig({ gateway: { maxQueueSize: 2, processingUpdateIntervalMs: 5000 } });
      const queue = createMessageQueue(config);

      queue.enqueue(makeMessage({ text: "one" }));
      queue.enqueue(makeMessage({ text: "two" }));
      const result = queue.enqueue(makeMessage({ text: "three" }));

      expect(result).toEqual({ accepted: false, reason: "Queue full" });
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
        partial: false,
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
          return { response: `reply to ${message}`, messages: [], partial: false };
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
  // processLoop and stop
  // -------------------------------------------------------------------------
  describe("processLoop / stop", () => {
    it("processes enqueued messages via the loop", async () => {
      const config = makeConfig();
      const agentOptions = makeAgentOptions();
      const router = createRouter();
      const adapter = makeAdapter("telegram");
      router.register(adapter);

      vi.mocked(runAgentTurn).mockResolvedValue({
        response: "reply",
        messages: [],
        partial: false,
      });

      const queue = createMessageQueue(config);
      queue.enqueue(makeMessage({ text: "hello" }));

      // Start the loop in the background
      const loopDone = queue.processLoop(agentOptions, config, router);

      // Wait for processing to happen
      await vi.waitFor(() => {
        expect(runAgentTurn).toHaveBeenCalledTimes(1);
      });

      queue.stop();
      await loopDone;

      expect(adapter.sendResponse).toHaveBeenCalledTimes(1);
    });

    it("stop() causes processLoop to resolve", async () => {
      const config = makeConfig();
      const agentOptions = makeAgentOptions();
      const router = createRouter();

      const queue = createMessageQueue(config);
      const loopDone = queue.processLoop(agentOptions, config, router);

      // Stop immediately (no messages to process)
      queue.stop();
      await loopDone;
      // If we get here, the loop resolved successfully
    });

    it("wakes up the loop when a message is enqueued while waiting", async () => {
      const config = makeConfig();
      const agentOptions = makeAgentOptions();
      const router = createRouter();

      vi.mocked(runAgentTurn).mockResolvedValue({
        response: "reply",
        messages: [],
        partial: false,
      });

      const queue = createMessageQueue(config);
      const loopDone = queue.processLoop(agentOptions, config, router);

      // Enqueue after loop has started (it should be waiting for a message)
      queue.enqueue(makeMessage({ text: "late arrival" }));

      await vi.waitFor(() => {
        expect(runAgentTurn).toHaveBeenCalledTimes(1);
      });

      queue.stop();
      await loopDone;

      expect(runAgentTurn).toHaveBeenCalledWith(
        "late arrival",
        "telegram--123456",
        agentOptions,
        config,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------
  describe("error handling", () => {
    it("logs error and sends error response when runAgentTurn throws", async () => {
      const config = makeConfig();
      const agentOptions = makeAgentOptions();
      const router = createRouter();
      const adapter = makeAdapter("telegram");
      router.register(adapter);

      vi.mocked(runAgentTurn).mockRejectedValue(new Error("agent failure"));

      const queue = createMessageQueue(config);
      queue.enqueue(makeMessage({ text: "boom" }));

      const result = await queue.processNext(agentOptions, config, router);

      expect(result).toBe(true);
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining("failed to process"),
      );
      // Should have sent an error response to the user
      expect(adapter.sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "telegram",
          sourceId: "123456",
          text: expect.stringContaining("something went wrong"),
        }),
      );
    });

    it("notifies user when agent returns empty response", async () => {
      const config = makeConfig();
      const agentOptions = makeAgentOptions();
      const router = createRouter();
      const adapter = makeAdapter("telegram");
      router.register(adapter);

      vi.mocked(runAgentTurn).mockResolvedValue({
        response: "",
        messages: [],
        partial: false,
      });

      const queue = createMessageQueue(config);
      queue.enqueue(makeMessage({ text: "Hello" }));

      await queue.processNext(agentOptions, config, router);

      expect(adapter.sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "telegram",
          sourceId: "123456",
          text: expect.stringContaining("nothing to respond with"),
        }),
      );
    });

    it("appends partial notice when response is marked partial", async () => {
      const config = makeConfig();
      const agentOptions = makeAgentOptions();
      const router = createRouter();
      const adapter = makeAdapter("telegram");
      router.register(adapter);

      vi.mocked(runAgentTurn).mockResolvedValue({
        response: "Partial answer here",
        messages: [],
        partial: true,
      });

      const queue = createMessageQueue(config);
      queue.enqueue(makeMessage({ text: "Hello" }));

      await queue.processNext(agentOptions, config, router);

      expect(adapter.sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("incomplete"),
        }),
      );
      // Original response text should still be present
      expect(adapter.sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Partial answer here"),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Heartbeat routing
  // -------------------------------------------------------------------------
  describe("heartbeat routing", () => {
    it("routes heartbeat response to last adapter when deliverTo is 'last'", async () => {
      const config = makeConfig({
        heartbeat: { enabled: true, intervalMinutes: 30, activeHours: "8-21", deliverTo: "last" as const },
      });
      const agentOptions = makeAgentOptions();
      const router = createRouter();
      const telegram = makeAdapter("telegram");
      router.register(telegram);

      vi.mocked(runAgentTurn).mockResolvedValue({
        response: "heartbeat reply",
        messages: [],
        partial: false,
      });

      const queue = createMessageQueue(config);

      // First, a user message from telegram to establish "last" adapter
      queue.enqueue(makeMessage({ source: "telegram", sourceId: "42", text: "hi" }));
      await queue.processNext(agentOptions, config, router);

      vi.clearAllMocks();

      // Now process a heartbeat message
      queue.enqueue({ source: "heartbeat", sourceId: "last", text: "heartbeat prompt" });
      vi.mocked(runAgentTurn).mockResolvedValue({
        response: "heartbeat reply",
        messages: [],
        partial: false,
      });
      await queue.processNext(agentOptions, config, router);

      expect(telegram.sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "telegram",
          sourceId: "42",
          text: "heartbeat reply",
        }),
      );
    });

    it("routes heartbeat response directly to named adapter when deliverTo is 'telegram'", async () => {
      const config = makeConfig({
        heartbeat: { enabled: true, intervalMinutes: 30, activeHours: "8-21", deliverTo: "telegram" as const },
      });
      const agentOptions = makeAgentOptions();
      const router = createRouter();
      const telegram = makeAdapter("telegram");
      router.register(telegram);

      vi.mocked(runAgentTurn).mockResolvedValue({
        response: "heartbeat reply",
        messages: [],
        partial: false,
      });

      const queue = createMessageQueue(config);

      // A telegram message first so the queue knows the sourceId
      queue.enqueue(makeMessage({ source: "telegram", sourceId: "42", text: "hi" }));
      await queue.processNext(agentOptions, config, router);

      vi.clearAllMocks();
      vi.mocked(runAgentTurn).mockResolvedValue({
        response: "heartbeat reply",
        messages: [],
        partial: false,
      });

      queue.enqueue({ source: "heartbeat", sourceId: "telegram", text: "heartbeat prompt" });
      await queue.processNext(agentOptions, config, router);

      expect(telegram.sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "telegram",
          sourceId: "42",
          text: "heartbeat reply",
        }),
      );
    });

    it("drops heartbeat response when deliverTo is 'last' and no adapter has been used", async () => {
      const config = makeConfig({
        heartbeat: { enabled: true, intervalMinutes: 30, activeHours: "8-21", deliverTo: "last" as const },
      });
      const agentOptions = makeAgentOptions();
      const router = createRouter();

      vi.mocked(runAgentTurn).mockResolvedValue({
        response: "heartbeat reply",
        messages: [],
        partial: false,
      });

      const queue = createMessageQueue(config);
      queue.enqueue({ source: "heartbeat", sourceId: "last", text: "heartbeat prompt" });
      await queue.processNext(agentOptions, config, router);

      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ deliverTo: "last" }),
        expect.stringContaining("no adapter target"),
      );
    });

    it("drops heartbeat response when target adapter has no recorded sourceId", async () => {
      const config = makeConfig({
        heartbeat: { enabled: true, intervalMinutes: 30, activeHours: "8-21", deliverTo: "slack" as const },
      });
      const agentOptions = makeAgentOptions();
      const router = createRouter();
      const telegram = makeAdapter("telegram");
      router.register(telegram);

      vi.mocked(runAgentTurn).mockResolvedValue({
        response: "reply",
        messages: [],
        partial: false,
      });

      const queue = createMessageQueue(config);

      // Only telegram has been used, but deliverTo is slack
      queue.enqueue(makeMessage({ source: "telegram", sourceId: "42", text: "hi" }));
      await queue.processNext(agentOptions, config, router);

      vi.clearAllMocks();
      vi.mocked(runAgentTurn).mockResolvedValue({
        response: "heartbeat reply",
        messages: [],
        partial: false,
      });

      queue.enqueue({ source: "heartbeat", sourceId: "slack", text: "heartbeat prompt" });
      await queue.processNext(agentOptions, config, router);

      expect(telegram.sendResponse).not.toHaveBeenCalled();
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ deliverTo: "slack" }),
        expect.stringContaining("no adapter target"),
      );
    });

    it("suppresses heartbeat response containing HEARTBEAT_OK", async () => {
      const config = makeConfig({
        heartbeat: { enabled: true, intervalMinutes: 30, activeHours: "8-21", deliverTo: "last" as const },
      });
      const agentOptions = makeAgentOptions();
      const router = createRouter();
      const telegram = makeAdapter("telegram");
      router.register(telegram);

      const queue = createMessageQueue(config);

      // Establish last adapter
      vi.mocked(runAgentTurn).mockResolvedValue({ response: "ok", messages: [], partial: false });
      queue.enqueue(makeMessage({ source: "telegram", sourceId: "42", text: "hi" }));
      await queue.processNext(agentOptions, config, router);

      vi.clearAllMocks();

      // Heartbeat where agent responds with HEARTBEAT_OK
      vi.mocked(runAgentTurn).mockResolvedValue({
        response: "HEARTBEAT_OK",
        messages: [],
        partial: false,
      });
      queue.enqueue({ source: "heartbeat", sourceId: "last", text: "heartbeat prompt" });
      await queue.processNext(agentOptions, config, router);

      expect(telegram.sendResponse).not.toHaveBeenCalled();
      expect(mockLog.debug).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey: expect.any(String) }),
        expect.stringContaining("heartbeat OK"),
      );
    });

    it("suppresses heartbeat response when HEARTBEAT_OK is embedded in text", async () => {
      const config = makeConfig({
        heartbeat: { enabled: true, intervalMinutes: 30, activeHours: "8-21", deliverTo: "last" as const },
      });
      const agentOptions = makeAgentOptions();
      const router = createRouter();
      const telegram = makeAdapter("telegram");
      router.register(telegram);

      const queue = createMessageQueue(config);

      // Establish last adapter
      vi.mocked(runAgentTurn).mockResolvedValue({ response: "ok", messages: [], partial: false });
      queue.enqueue(makeMessage({ source: "telegram", sourceId: "42", text: "hi" }));
      await queue.processNext(agentOptions, config, router);

      vi.clearAllMocks();

      // Heartbeat where agent embeds HEARTBEAT_OK in a longer response
      vi.mocked(runAgentTurn).mockResolvedValue({
        response: "Nothing needs attention. HEARTBEAT_OK.",
        messages: [],
        partial: false,
      });
      queue.enqueue({ source: "heartbeat", sourceId: "last", text: "heartbeat prompt" });
      await queue.processNext(agentOptions, config, router);

      expect(telegram.sendResponse).not.toHaveBeenCalled();
    });

    it("delivers heartbeat response when it does NOT contain HEARTBEAT_OK", async () => {
      const config = makeConfig({
        heartbeat: { enabled: true, intervalMinutes: 30, activeHours: "8-21", deliverTo: "last" as const },
      });
      const agentOptions = makeAgentOptions();
      const router = createRouter();
      const telegram = makeAdapter("telegram");
      router.register(telegram);

      const queue = createMessageQueue(config);

      // Establish last adapter
      vi.mocked(runAgentTurn).mockResolvedValue({ response: "ok", messages: [], partial: false });
      queue.enqueue(makeMessage({ source: "telegram", sourceId: "42", text: "hi" }));
      await queue.processNext(agentOptions, config, router);

      vi.clearAllMocks();

      // Heartbeat where agent has something important to say
      vi.mocked(runAgentTurn).mockResolvedValue({
        response: "Your build failed! Check the logs.",
        messages: [],
        partial: false,
      });
      queue.enqueue({ source: "heartbeat", sourceId: "last", text: "heartbeat prompt" });
      await queue.processNext(agentOptions, config, router);

      expect(telegram.sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "telegram",
          sourceId: "42",
          text: "Your build failed! Check the logs.",
        }),
      );
    });

    it("routes heartbeat error response to correct adapter", async () => {
      const config = makeConfig({
        heartbeat: { enabled: true, intervalMinutes: 30, activeHours: "8-21", deliverTo: "last" as const },
      });
      const agentOptions = makeAgentOptions();
      const router = createRouter();
      const telegram = makeAdapter("telegram");
      router.register(telegram);

      const queue = createMessageQueue(config);

      // Establish last adapter
      vi.mocked(runAgentTurn).mockResolvedValue({ response: "ok", messages: [], partial: false });
      queue.enqueue(makeMessage({ source: "telegram", sourceId: "42", text: "hi" }));
      await queue.processNext(agentOptions, config, router);

      vi.clearAllMocks();
      vi.mocked(runAgentTurn).mockRejectedValue(new Error("agent failure"));

      queue.enqueue({ source: "heartbeat", sourceId: "last", text: "heartbeat prompt" });
      await queue.processNext(agentOptions, config, router);

      expect(telegram.sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "telegram",
          sourceId: "42",
          text: expect.stringContaining("something went wrong"),
        }),
      );
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
    it("handles unknown adapter gracefully (logs warning)", async () => {
      const router = createRouter();

      const response: AdapterMessage = {
        source: "unknown_adapter",
        sourceId: "999",
        text: "Lost message",
      };

      // Should not throw
      await expect(router.route(response)).resolves.toBeUndefined();

      // Should log a warning about the missing adapter
      expect(mockLog.warn).toHaveBeenCalledWith(
        { source: "unknown_adapter" },
        expect.stringContaining("no adapter"),
      );
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

  // -------------------------------------------------------------------------
  // getAdapter
  // -------------------------------------------------------------------------
  describe("getAdapter", () => {
    it("returns registered adapter by name", () => {
      const router = createRouter();
      const adapter = makeAdapter("telegram");
      router.register(adapter);

      expect(router.getAdapter("telegram")).toBe(adapter);
    });

    it("returns undefined for unregistered adapter", () => {
      const router = createRouter();

      expect(router.getAdapter("nonexistent")).toBeUndefined();
    });
  });
});
