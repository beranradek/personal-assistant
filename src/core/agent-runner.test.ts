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

// Mock session compactor
vi.mock("../session/compactor.js", () => ({
  compactIfNeeded: vi.fn(),
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
  clearSdkSessionIds,
} from "./agent-runner.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { saveInteraction } from "../session/manager.js";
import { compactIfNeeded } from "../session/compactor.js";
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

    it("allowedTools includes MCP tool names", () => {
      const config = makeConfig();
      const opts = buildAgentOptions(config, "/tmp/workspace", "", {});

      expect(opts.allowedTools).toContain("mcp__memory__memory_search");
      expect(opts.allowedTools).toContain("mcp__assistant__cron");
      expect(opts.allowedTools).toContain("mcp__assistant__exec");
      expect(opts.allowedTools).toContain("mcp__assistant__process");
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
      vi.mocked(compactIfNeeded).mockResolvedValue({ compacted: false });
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
      vi.mocked(compactIfNeeded).mockResolvedValue({ compacted: false });
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
      vi.mocked(compactIfNeeded).mockResolvedValue({ compacted: false });
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
      vi.mocked(compactIfNeeded).mockResolvedValue({ compacted: false });
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

    it("calls compaction check after saving", async () => {
      const config = makeConfig({
        session: { maxHistoryMessages: 50, compactionEnabled: true },
      });
      const sessionKey = "telegram--123456";

      vi.mocked(query).mockReturnValue(
        mockQueryGenerator([
          {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "Done" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            result: "Done",
          },
        ]) as any,
      );
      vi.mocked(saveInteraction).mockResolvedValue(undefined);
      vi.mocked(compactIfNeeded).mockResolvedValue({ compacted: false });
      vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

      const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
      await runAgentTurn("Compact me", sessionKey, agentOptions, config);

      // Verify compactIfNeeded was called
      expect(compactIfNeeded).toHaveBeenCalled();

      // Verify it was called after saveInteraction
      const saveOrder = vi.mocked(saveInteraction).mock.invocationCallOrder[0];
      const compactOrder =
        vi.mocked(compactIfNeeded).mock.invocationCallOrder[0];
      expect(compactOrder).toBeGreaterThan(saveOrder);
    });

    it("does not call compaction when compactionEnabled is false", async () => {
      const config = makeConfig({
        session: { maxHistoryMessages: 50, compactionEnabled: false },
      });
      const sessionKey = "terminal--default";

      vi.mocked(query).mockReturnValue(
        mockQueryGenerator([
          {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "No compact" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            result: "No compact",
          },
        ]) as any,
      );
      vi.mocked(saveInteraction).mockResolvedValue(undefined);
      vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

      const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
      await runAgentTurn("Hello", sessionKey, agentOptions, config);

      expect(compactIfNeeded).not.toHaveBeenCalled();
    });

    it("empty history (new session) works correctly", async () => {
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
      vi.mocked(compactIfNeeded).mockResolvedValue({ compacted: false });
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
      vi.mocked(compactIfNeeded).mockResolvedValue({ compacted: false });
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
      vi.mocked(compactIfNeeded).mockResolvedValue({ compacted: false });
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
      vi.mocked(compactIfNeeded).mockResolvedValue({ compacted: false });
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
      vi.mocked(compactIfNeeded).mockResolvedValue({ compacted: false });
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
      vi.mocked(compactIfNeeded).mockResolvedValue({ compacted: false });
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
  });
});
