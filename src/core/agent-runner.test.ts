import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Config } from "./types.js";

// ---------------------------------------------------------------------------
// Mocks – must be declared before importing the module under test
// ---------------------------------------------------------------------------

// Mock the Claude Agent SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

// Mock session manager
vi.mock("../session/manager.js", () => ({
  saveInteraction: vi.fn(),
}));

// Mock daily audit log
vi.mock("../memory/daily-log.js", () => ({
  appendAuditEntry: vi.fn(),
}));

// Mock bash security hook
vi.mock("../security/bash-hook.js", () => ({
  bashSecurityHook: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports – after mocks are registered
// ---------------------------------------------------------------------------

import {
  buildAgentOptions,
  runAgentTurn,
  streamAgentTurn,
  clearSdkSessionIds,
} from "./agent-runner.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { saveInteraction } from "../session/manager.js";
import { appendAuditEntry } from "../memory/daily-log.js";

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
    agent: { model: null, maxTurns: 10 },
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
    ...overrides,
  };
}

/**
 * Create a mock async generator that yields the given SDK messages, simulating
 * the query() return value.
 */
async function* mockQueryGenerator(messages: Array<Record<string, unknown>>) {
  for (const msg of messages) {
    yield msg;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent-runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSdkSessionIds();
    vi.useFakeTimers({ now: new Date("2025-06-15T12:00:00.000Z") });
  });

  // -----------------------------------------------------------------------
  // buildAgentOptions
  // -----------------------------------------------------------------------
  describe("buildAgentOptions", () => {
    it("returns valid options object with all required fields", () => {
      const config = makeConfig();
      const opts = buildAgentOptions(
        config,
        "/tmp/workspace",
        "Memory context here",
        {},
      );

      expect(opts).toBeDefined();
      expect(opts.systemPrompt).toBeDefined();
      expect(opts.cwd).toBeDefined();
      expect(opts.tools).toBeDefined();
      expect(opts.allowedTools).toBeDefined();
      expect(opts.sandbox).toBeDefined();
      expect(opts.mcpServers).toBeDefined();
      expect(opts.maxTurns).toBeDefined();
    });

    it('system prompt uses preset: "claude_code" with append: memoryContent', () => {
      const config = makeConfig();
      const memoryContent = "You have a meeting at 3pm today.";
      const opts = buildAgentOptions(
        config,
        "/tmp/workspace",
        memoryContent,
        {},
      );

      expect(opts.systemPrompt).toEqual({
        type: "preset",
        preset: "claude_code",
        append: memoryContent,
      });
    });

    it("cwd set to workspace directory", () => {
      const config = makeConfig();
      const opts = buildAgentOptions(
        config,
        "/home/user/workspace",
        "",
        {},
      );

      expect(opts.cwd).toBe("/home/user/workspace");
    });

    it("sandbox enabled with autoAllowBashIfSandboxed: true", () => {
      const config = makeConfig();
      const opts = buildAgentOptions(config, "/tmp/workspace", "", {});

      expect(opts.sandbox).toEqual({
        enabled: true,
        autoAllowBashIfSandboxed: true,
      });
    });

    it("allowedTools includes standard tools", () => {
      const config = makeConfig();
      const opts = buildAgentOptions(config, "/tmp/workspace", "", {});

      const expectedTools = [
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "Bash",
        "WebFetch",
        "WebSearch",
      ];
      for (const tool of expectedTools) {
        expect(opts.allowedTools).toContain(tool);
      }
    });

    it("allowedTools includes wildcard patterns for provided MCP servers", () => {
      const config = makeConfig();
      const mcpServers = {
        memory: { command: "node", args: ["./memory-server.js"] },
        assistant: { command: "node", args: ["./assistant-server.js"] },
      };
      const opts = buildAgentOptions(config, "/tmp/workspace", "", mcpServers);

      expect(opts.allowedTools).toContain("mcp__memory__*");
      expect(opts.allowedTools).toContain("mcp__assistant__*");
    });

    it("allowedTools includes wildcard patterns for user-configured MCP servers", () => {
      const config = makeConfig();
      const mcpServers = {
        memory: {},
        assistant: {},
        "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
        context7: { command: "npx", args: ["-y", "@upstash/context7-mcp@latest"] },
      };
      const opts = buildAgentOptions(config, "/tmp/workspace", "", mcpServers);

      expect(opts.allowedTools).toContain("mcp__chrome-devtools__*");
      expect(opts.allowedTools).toContain("mcp__context7__*");
    });

    it("allowedTools has no MCP patterns when no MCP servers provided", () => {
      const config = makeConfig();
      const opts = buildAgentOptions(config, "/tmp/workspace", "", {});

      const mcpPatterns = opts.allowedTools.filter((t) => t.startsWith("mcp__"));
      expect(mcpPatterns).toHaveLength(0);
    });

    it("mcpServers includes provided servers", () => {
      const config = makeConfig();
      const mcpServers = {
        memory: { command: "node", args: ["./memory-server.js"] },
        assistant: { command: "node", args: ["./assistant-server.js"] },
      };
      const opts = buildAgentOptions(
        config,
        "/tmp/workspace",
        "",
        mcpServers,
      );

      expect(opts.mcpServers).toBe(mcpServers);
      expect(opts.mcpServers).toHaveProperty("memory");
      expect(opts.mcpServers).toHaveProperty("assistant");
    });

    it("uses model from config when set", () => {
      const config = makeConfig({
        agent: { model: "claude-sonnet-4-5-20250929", maxTurns: 10 },
      });
      const opts = buildAgentOptions(config, "/tmp/workspace", "", {});

      expect(opts.model).toBe("claude-sonnet-4-5-20250929");
    });

    it("model is undefined when config.agent.model is null", () => {
      const config = makeConfig({ agent: { model: null, maxTurns: 10 } });
      const opts = buildAgentOptions(config, "/tmp/workspace", "", {});

      expect(opts.model).toBeUndefined();
    });

    it("maxTurns from config", () => {
      const config = makeConfig({ agent: { model: null, maxTurns: 42 } });
      const opts = buildAgentOptions(config, "/tmp/workspace", "", {});

      expect(opts.maxTurns).toBe(42);
    });

    it("settingSources includes 'project'", () => {
      const config = makeConfig();
      const opts = buildAgentOptions(config, "/tmp/workspace", "", {});

      expect(opts.settingSources).toContain("project");
    });

    it("hooks includes PreToolUse with Bash matcher", () => {
      const config = makeConfig();
      const opts = buildAgentOptions(config, "/tmp/workspace", "", {});

      expect(opts.hooks).toBeDefined();
      expect(opts.hooks.PreToolUse).toBeDefined();
      expect(Array.isArray(opts.hooks.PreToolUse)).toBe(true);
      expect(opts.hooks.PreToolUse.length).toBeGreaterThan(0);

      const bashMatcher = opts.hooks.PreToolUse[0];
      expect(bashMatcher.matcher).toBe("Bash");
      expect(bashMatcher.hooks).toBeDefined();
      expect(bashMatcher.hooks.length).toBeGreaterThan(0);
      expect(typeof bashMatcher.hooks[0]).toBe("function");
    });

    it("tools preset is claude_code", () => {
      const config = makeConfig();
      const opts = buildAgentOptions(config, "/tmp/workspace", "", {});

      expect(opts.tools).toEqual({
        type: "preset",
        preset: "claude_code",
      });
    });
  });

  // -----------------------------------------------------------------------
  // runAgentTurn
  // -----------------------------------------------------------------------
  describe("runAgentTurn", () => {
    it("first call for a session key does not use resume", async () => {
      const config = makeConfig();
      const sessionKey = "telegram--123456";

      vi.mocked(query).mockReturnValue(
        mockQueryGenerator([
          {
            type: "assistant",
            session_id: "sdk-session-abc",
            message: {
              content: [{ type: "text", text: "Response text" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            session_id: "sdk-session-abc",
            result: "Response text",
          },
        ]) as any,
      );
      vi.mocked(saveInteraction).mockResolvedValue(undefined);

      vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

      const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
      await runAgentTurn("Hello", sessionKey, agentOptions, config);

      // First call should NOT have resume
      const callArgs = vi.mocked(query).mock.calls[0][0];
      expect(callArgs.options).not.toHaveProperty("resume");
    });

    it("second call for the same session key uses resume with captured session ID", async () => {
      const config = makeConfig();
      const sessionKey = "telegram--123456";

      vi.mocked(query).mockReturnValue(
        mockQueryGenerator([
          {
            type: "assistant",
            session_id: "sdk-session-abc",
            message: {
              content: [{ type: "text", text: "First response" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            session_id: "sdk-session-abc",
            result: "First response",
          },
        ]) as any,
      );
      vi.mocked(saveInteraction).mockResolvedValue(undefined);

      vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

      const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});

      // First call - captures session ID
      await runAgentTurn("Hello", sessionKey, agentOptions, config);

      vi.mocked(query).mockReturnValue(
        mockQueryGenerator([
          {
            type: "assistant",
            session_id: "sdk-session-abc",
            message: {
              content: [{ type: "text", text: "Second response" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            session_id: "sdk-session-abc",
            result: "Second response",
          },
        ]) as any,
      );

      // Second call - should resume
      await runAgentTurn("Follow up", sessionKey, agentOptions, config);

      const secondCallArgs = vi.mocked(query).mock.calls[1][0];
      expect(secondCallArgs.options).toHaveProperty(
        "resume",
        "sdk-session-abc",
      );
    });

    it("different session keys get independent SDK sessions", async () => {
      const config = makeConfig();

      vi.mocked(saveInteraction).mockResolvedValue(undefined);

      vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

      const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});

      // First session
      vi.mocked(query).mockReturnValue(
        mockQueryGenerator([
          {
            type: "assistant",
            session_id: "sdk-session-111",
            message: {
              content: [{ type: "text", text: "Response A" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            session_id: "sdk-session-111",
            result: "Response A",
          },
        ]) as any,
      );
      await runAgentTurn("Hello", "telegram--111", agentOptions, config);

      // Second session (different key)
      vi.mocked(query).mockReturnValue(
        mockQueryGenerator([
          {
            type: "assistant",
            session_id: "sdk-session-222",
            message: {
              content: [{ type: "text", text: "Response B" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            session_id: "sdk-session-222",
            result: "Response B",
          },
        ]) as any,
      );
      await runAgentTurn("Hello", "slack--222", agentOptions, config);

      // Resume first session
      vi.mocked(query).mockReturnValue(
        mockQueryGenerator([
          {
            type: "assistant",
            session_id: "sdk-session-111",
            message: {
              content: [{ type: "text", text: "Response A2" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            session_id: "sdk-session-111",
            result: "Response A2",
          },
        ]) as any,
      );
      await runAgentTurn("Follow up", "telegram--111", agentOptions, config);

      const thirdCallArgs = vi.mocked(query).mock.calls[2][0];
      expect(thirdCallArgs.options).toHaveProperty(
        "resume",
        "sdk-session-111",
      );
    });

    it("after agent turn, saves messages to session transcript", async () => {
      const config = makeConfig();
      const sessionKey = "terminal--default";

      vi.mocked(query).mockReturnValue(
        mockQueryGenerator([
          {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "Hello there!" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            result: "Hello there!",
          },
        ]) as any,
      );
      vi.mocked(saveInteraction).mockResolvedValue(undefined);

      vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

      const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
      await runAgentTurn("Hi", sessionKey, agentOptions, config);

      expect(saveInteraction).toHaveBeenCalledWith(
        sessionKey,
        expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "Hi" }),
          expect.objectContaining({
            role: "assistant",
            content: "Hello there!",
          }),
        ]),
        config,
      );
    });

    it("new session works correctly", async () => {
      const config = makeConfig();
      const sessionKey = "slack--C123--thread1";

      vi.mocked(query).mockReturnValue(
        mockQueryGenerator([
          {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "Welcome!" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            result: "Welcome!",
          },
        ]) as any,
      );
      vi.mocked(saveInteraction).mockResolvedValue(undefined);

      vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

      const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
      const result = await runAgentTurn(
        "First message",
        sessionKey,
        agentOptions,
        config,
      );

      expect(result.response).toBe("Welcome!");
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]).toMatchObject({
        role: "user",
        content: "First message",
      });
      expect(result.messages[1]).toMatchObject({
        role: "assistant",
        content: "Welcome!",
      });
    });

    it("returns response text and messages from agent turn", async () => {
      const config = makeConfig();
      const sessionKey = "terminal--default";

      vi.mocked(query).mockReturnValue(
        mockQueryGenerator([
          {
            type: "assistant",
            message: {
              content: [
                { type: "text", text: "Part 1. " },
                { type: "text", text: "Part 2." },
              ],
            },
          },
          {
            type: "result",
            subtype: "success",
            result: "Part 1. Part 2.",
          },
        ]) as any,
      );
      vi.mocked(saveInteraction).mockResolvedValue(undefined);

      vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

      const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
      const result = await runAgentTurn(
        "Hello",
        sessionKey,
        agentOptions,
        config,
      );

      expect(result.response).toBe("Part 1. Part 2.");
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[1].role).toBe("assistant");
    });

    it("appends audit entry after turn completes", async () => {
      const config = makeConfig();
      const sessionKey = "telegram--123456";

      vi.mocked(query).mockReturnValue(
        mockQueryGenerator([
          {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "Audited" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            result: "Audited",
          },
        ]) as any,
      );
      vi.mocked(saveInteraction).mockResolvedValue(undefined);

      vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

      const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
      await runAgentTurn("Audit this", sessionKey, agentOptions, config);

      expect(appendAuditEntry).toHaveBeenCalledWith(
        config.security.workspace,
        expect.objectContaining({
          source: "telegram",
          sessionKey,
          type: "interaction",
          userMessage: "Audit this",
          assistantResponse: "Audited",
        }),
      );
    });

    it("calls query with correct prompt and options", async () => {
      const config = makeConfig();
      const sessionKey = "terminal--default";

      vi.mocked(query).mockReturnValue(
        mockQueryGenerator([
          {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "OK" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            result: "OK",
          },
        ]) as any,
      );
      vi.mocked(saveInteraction).mockResolvedValue(undefined);

      vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

      const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
      await runAgentTurn("Hello SDK", sessionKey, agentOptions, config);

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Hello SDK",
          options: expect.objectContaining({
            cwd: "/tmp/workspace",
          }),
        }),
      );
    });

    it("handles string content blocks from assistant messages", async () => {
      const config = makeConfig();
      const sessionKey = "terminal--default";

      vi.mocked(query).mockReturnValue(
        mockQueryGenerator([
          {
            type: "assistant",
            message: {
              content: ["Direct string content"],
            },
          },
          {
            type: "result",
            subtype: "success",
            result: "Direct string content",
          },
        ]) as any,
      );
      vi.mocked(saveInteraction).mockResolvedValue(undefined);

      vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

      const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
      const result = await runAgentTurn(
        "Hello",
        sessionKey,
        agentOptions,
        config,
      );

      expect(result.response).toBe("Direct string content");
    });

    it("ignores non-assistant messages in the stream", async () => {
      const config = makeConfig();
      const sessionKey = "terminal--default";

      vi.mocked(query).mockReturnValue(
        mockQueryGenerator([
          {
            type: "system",
            subtype: "init",
            tools: [],
          },
          {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "Actual response" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            result: "Actual response",
          },
        ]) as any,
      );
      vi.mocked(saveInteraction).mockResolvedValue(undefined);

      vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

      const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
      const result = await runAgentTurn(
        "Hello",
        sessionKey,
        agentOptions,
        config,
      );

      expect(result.response).toBe("Actual response");
    });

    it("returns partial: false on successful turn", async () => {
      const config = makeConfig();
      const sessionKey = "terminal--default";

      vi.mocked(query).mockReturnValue(
        mockQueryGenerator([
          {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "Complete" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            result: "Complete",
          },
        ]) as any,
      );
      vi.mocked(saveInteraction).mockResolvedValue(undefined);
      vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

      const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
      const result = await runAgentTurn("Hi", sessionKey, agentOptions, config);

      expect(result.partial).toBe(false);
    });

    it("returns partial: true when transport error occurs after collecting response", async () => {
      const config = makeConfig();
      const sessionKey = "terminal--default";

      async function* transportErrorGenerator() {
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Partial response" }],
          },
        };
        throw new Error("ProcessTransport is not ready for writing");
      }

      vi.mocked(query).mockReturnValue(transportErrorGenerator() as any);
      vi.mocked(saveInteraction).mockResolvedValue(undefined);
      vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

      const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
      const result = await runAgentTurn("Hi", sessionKey, agentOptions, config);

      expect(result.partial).toBe(true);
      expect(result.response).toBe("Partial response");
    });

    it("re-throws transport error when no response was collected", async () => {
      const config = makeConfig();
      const sessionKey = "terminal--default";

      async function* transportErrorGenerator() {
        throw new Error("ProcessTransport is not ready for writing");
      }

      vi.mocked(query).mockReturnValue(transportErrorGenerator() as any);

      const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});

      await expect(
        runAgentTurn("Hi", sessionKey, agentOptions, config),
      ).rejects.toThrow("ProcessTransport is not ready");
    });
  });

  // -----------------------------------------------------------------------
  // streamAgentTurn
  // -----------------------------------------------------------------------
  describe("streamAgentTurn", () => {
    /** Collect all events from the async generator into an array. */
    async function collectEvents(
      gen: AsyncGenerator<unknown>,
    ): Promise<Array<Record<string, unknown>>> {
      const events: Array<Record<string, unknown>> = [];
      for await (const ev of gen) {
        events.push(ev as Record<string, unknown>);
      }
      return events;
    }

    it("yields text_delta events from stream_event messages", async () => {
      const config = makeConfig();
      const sessionKey = "terminal--default";

      vi.mocked(query).mockReturnValue(
        mockQueryGenerator([
          {
            type: "stream_event",
            session_id: "sdk-stream-1",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "Hello " },
            },
          },
          {
            type: "stream_event",
            session_id: "sdk-stream-1",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "world!" },
            },
          },
          {
            type: "assistant",
            session_id: "sdk-stream-1",
            message: {
              content: [{ type: "text", text: "Hello world!" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            session_id: "sdk-stream-1",
            result: "Hello world!",
          },
        ]) as any,
      );
      vi.mocked(saveInteraction).mockResolvedValue(undefined);
      vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

      const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
      const events = await collectEvents(
        streamAgentTurn("Hi", sessionKey, agentOptions, config),
      );

      const textDeltas = events.filter((e) => e.type === "text_delta");
      expect(textDeltas).toHaveLength(2);
      expect(textDeltas[0]).toEqual({ type: "text_delta", text: "Hello " });
      expect(textDeltas[1]).toEqual({ type: "text_delta", text: "world!" });
    });

    it("yields tool_start events from content_block_start with tool_use", async () => {
      const config = makeConfig();
      const sessionKey = "terminal--default";

      vi.mocked(query).mockReturnValue(
        mockQueryGenerator([
          {
            type: "stream_event",
            session_id: "sdk-stream-2",
            event: {
              type: "content_block_start",
              index: 1,
              content_block: { type: "tool_use", id: "tu_1", name: "Bash", input: {} },
            },
          },
          {
            type: "stream_event",
            session_id: "sdk-stream-2",
            event: { type: "content_block_stop", index: 1 },
          },
          {
            type: "assistant",
            session_id: "sdk-stream-2",
            message: {
              content: [{ type: "text", text: "Done" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            session_id: "sdk-stream-2",
            result: "Done",
          },
        ]) as any,
      );
      vi.mocked(saveInteraction).mockResolvedValue(undefined);
      vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

      const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
      const events = await collectEvents(
        streamAgentTurn("Run ls", sessionKey, agentOptions, config),
      );

      const toolStarts = events.filter((e) => e.type === "tool_start");
      expect(toolStarts).toHaveLength(1);
      expect(toolStarts[0]).toEqual({ type: "tool_start", toolName: "Bash" });
    });

    it("yields tool_progress events from SDK tool_progress messages", async () => {
      const config = makeConfig();
      const sessionKey = "terminal--default";

      vi.mocked(query).mockReturnValue(
        mockQueryGenerator([
          {
            type: "tool_progress",
            tool_use_id: "tu_1",
            tool_name: "Bash",
            parent_tool_use_id: null,
            elapsed_time_seconds: 5,
            session_id: "sdk-stream-3",
          },
          {
            type: "assistant",
            session_id: "sdk-stream-3",
            message: {
              content: [{ type: "text", text: "Done" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            session_id: "sdk-stream-3",
            result: "Done",
          },
        ]) as any,
      );
      vi.mocked(saveInteraction).mockResolvedValue(undefined);
      vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

      const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
      const events = await collectEvents(
        streamAgentTurn("Run long task", sessionKey, agentOptions, config),
      );

      const progEvents = events.filter((e) => e.type === "tool_progress");
      expect(progEvents).toHaveLength(1);
      expect(progEvents[0]).toEqual({
        type: "tool_progress",
        toolName: "Bash",
        elapsedSeconds: 5,
      });
    });

    it("captures session ID for future resumption", async () => {
      const config = makeConfig();
      const sessionKey = "terminal--stream-resume";

      vi.mocked(query).mockReturnValue(
        mockQueryGenerator([
          {
            type: "stream_event",
            session_id: "sdk-stream-resume-1",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "Hi" },
            },
          },
          {
            type: "assistant",
            session_id: "sdk-stream-resume-1",
            message: {
              content: [{ type: "text", text: "Hi" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            session_id: "sdk-stream-resume-1",
            result: "Hi",
          },
        ]) as any,
      );
      vi.mocked(saveInteraction).mockResolvedValue(undefined);
      vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

      const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});

      // First call - captures session ID
      await collectEvents(
        streamAgentTurn("Hello", sessionKey, agentOptions, config),
      );

      // Second call - should use resume
      vi.mocked(query).mockReturnValue(
        mockQueryGenerator([
          {
            type: "assistant",
            session_id: "sdk-stream-resume-1",
            message: {
              content: [{ type: "text", text: "Again" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            session_id: "sdk-stream-resume-1",
            result: "Again",
          },
        ]) as any,
      );

      await collectEvents(
        streamAgentTurn("Follow up", sessionKey, agentOptions, config),
      );

      const secondCallArgs = vi.mocked(query).mock.calls[1][0];
      expect(secondCallArgs.options).toHaveProperty(
        "resume",
        "sdk-stream-resume-1",
      );
    });

    it("saves audit entry after stream completes", async () => {
      const config = makeConfig();
      const sessionKey = "telegram--audit-stream";

      vi.mocked(query).mockReturnValue(
        mockQueryGenerator([
          {
            type: "assistant",
            session_id: "sdk-stream-audit",
            message: {
              content: [{ type: "text", text: "Audited stream" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            session_id: "sdk-stream-audit",
            result: "Audited stream",
          },
        ]) as any,
      );
      vi.mocked(saveInteraction).mockResolvedValue(undefined);
      vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

      const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
      await collectEvents(
        streamAgentTurn("Audit this", sessionKey, agentOptions, config),
      );

      expect(appendAuditEntry).toHaveBeenCalledWith(
        config.security.workspace,
        expect.objectContaining({
          source: "telegram",
          sessionKey,
          type: "interaction",
          userMessage: "Audit this",
          assistantResponse: "Audited stream",
        }),
      );
    });

    it("yields result event with partial:true on transport error with partial response", async () => {
      const config = makeConfig();
      const sessionKey = "terminal--default";

      async function* transportErrorStreamGenerator() {
        yield {
          type: "assistant",
          session_id: "sdk-stream-partial",
          message: {
            content: [{ type: "text", text: "Partial stream" }],
          },
        };
        throw new Error("ProcessTransport is not ready for writing");
      }

      vi.mocked(query).mockReturnValue(transportErrorStreamGenerator() as any);
      vi.mocked(saveInteraction).mockResolvedValue(undefined);
      vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

      const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
      const events = await collectEvents(
        streamAgentTurn("Hi", sessionKey, agentOptions, config),
      );

      const resultEvents = events.filter((e) => e.type === "result");
      expect(resultEvents).toHaveLength(1);
      expect(resultEvents[0]).toMatchObject({
        type: "result",
        response: "Partial stream",
        partial: true,
      });
    });

    it("yields error event on non-transport error with no response", async () => {
      const config = makeConfig();
      const sessionKey = "terminal--default";

      async function* errorStreamGenerator() {
        throw new Error("Something went wrong");
      }

      vi.mocked(query).mockReturnValue(errorStreamGenerator() as any);

      const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
      const events = await collectEvents(
        streamAgentTurn("Hi", sessionKey, agentOptions, config),
      );

      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents).toHaveLength(1);
      expect((errorEvents[0] as any).error).toContain("Something went wrong");
    });

    it("buffers tool input JSON and yields tool_input event on content_block_stop", async () => {
      const config = makeConfig();
      const sessionKey = "terminal--default";

      vi.mocked(query).mockReturnValue(
        mockQueryGenerator([
          {
            type: "stream_event",
            session_id: "sdk-stream-tool",
            event: {
              type: "content_block_start",
              index: 1,
              content_block: { type: "tool_use", id: "tu_1", name: "Read", input: {} },
            },
          },
          {
            type: "stream_event",
            session_id: "sdk-stream-tool",
            event: {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: '{"file_path":' },
            },
          },
          {
            type: "stream_event",
            session_id: "sdk-stream-tool",
            event: {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: '"/src/foo.ts"}' },
            },
          },
          {
            type: "stream_event",
            session_id: "sdk-stream-tool",
            event: { type: "content_block_stop", index: 1 },
          },
          {
            type: "assistant",
            session_id: "sdk-stream-tool",
            message: {
              content: [{ type: "text", text: "Read the file" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            session_id: "sdk-stream-tool",
            result: "Read the file",
          },
        ]) as any,
      );
      vi.mocked(saveInteraction).mockResolvedValue(undefined);
      vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

      const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
      const events = await collectEvents(
        streamAgentTurn("Read foo", sessionKey, agentOptions, config),
      );

      const toolInputs = events.filter((e) => e.type === "tool_input");
      expect(toolInputs).toHaveLength(1);
      expect(toolInputs[0]).toEqual({
        type: "tool_input",
        toolName: "Read",
        input: { file_path: "/src/foo.ts" },
      });
    });
  });
});
