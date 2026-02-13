import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { resolveSessionKey, loadHistory, saveInteraction } from "./manager.js";
import type { SessionMessage, Config } from "../core/types.js";
import type { CompactionEntry } from "./types.js";

function makeMessage(
  overrides: Partial<SessionMessage> = {},
): SessionMessage {
  return {
    role: "user",
    content: "Hello",
    timestamp: "2025-06-15T10:00:00.000Z",
    ...overrides,
  };
}

function makeConfig(dataDir: string, maxHistoryMessages = 50): Config {
  return {
    security: {
      allowedCommands: [],
      commandsNeedingExtraValidation: [],
      workspace: "/tmp/workspace",
      dataDir,
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
    gateway: {
      maxQueueSize: 100,
    },
    agent: {
      model: null,
      maxTurns: 10,
    },
    session: {
      maxHistoryMessages,
      compactionEnabled: false,
    },
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
  };
}

describe("session manager", () => {
  // -----------------------------------------------------------------------
  // resolveSessionKey
  // -----------------------------------------------------------------------
  describe("resolveSessionKey", () => {
    it('resolveSessionKey("terminal", "default") returns "terminal--default"', () => {
      expect(resolveSessionKey("terminal", "default")).toBe("terminal--default");
    });

    it('resolveSessionKey("telegram", "123456") returns "telegram--123456"', () => {
      expect(resolveSessionKey("telegram", "123456")).toBe("telegram--123456");
    });

    it('resolveSessionKey("slack", "C123", "thread_ts") returns "slack--C123--thread_ts"', () => {
      expect(resolveSessionKey("slack", "C123", "thread_ts")).toBe(
        "slack--C123--thread_ts",
      );
    });
  });

  // -----------------------------------------------------------------------
  // loadHistory
  // -----------------------------------------------------------------------
  describe("loadHistory", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "session-manager-test-"),
      );
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("loads transcript and returns sanitized messages", async () => {
      const config = makeConfig(tmpDir);
      const sessionKey = "terminal--default";
      const sessionPath = path.join(tmpDir, "sessions", `${sessionKey}.jsonl`);

      // Write some messages to disk
      const messages: SessionMessage[] = [
        makeMessage({ content: "Hi", role: "user" }),
        makeMessage({ content: "Hello there!", role: "assistant" }),
      ];
      await fs.mkdir(path.dirname(sessionPath), { recursive: true });
      const data = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
      await fs.writeFile(sessionPath, data);

      const history = await loadHistory(sessionKey, config);
      expect(history).toHaveLength(2);
      expect(history[0].content).toBe("Hi");
      expect(history[1].content).toBe("Hello there!");
    });

    it("sanitizes: truncates tool_result content over 500 chars", async () => {
      const config = makeConfig(tmpDir);
      const sessionKey = "terminal--default";
      const sessionPath = path.join(tmpDir, "sessions", `${sessionKey}.jsonl`);

      const longContent = "x".repeat(600);
      const messages: SessionMessage[] = [
        makeMessage({ content: "run it", role: "user" }),
        makeMessage({
          content: longContent,
          role: "tool_result",
          toolName: "bash",
        }),
      ];
      await fs.mkdir(path.dirname(sessionPath), { recursive: true });
      const data = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
      await fs.writeFile(sessionPath, data);

      const history = await loadHistory(sessionKey, config);
      expect(history).toHaveLength(2);
      // The tool_result with >500 chars should be truncated
      expect(history[1].content.length).toBeLessThan(longContent.length);
      expect(history[1].content).toBe("x".repeat(500) + "... [truncated]");
    });

    it("does not truncate tool_result content that is 500 chars or less", async () => {
      const config = makeConfig(tmpDir);
      const sessionKey = "terminal--default";
      const sessionPath = path.join(tmpDir, "sessions", `${sessionKey}.jsonl`);

      const shortContent = "y".repeat(500);
      const messages: SessionMessage[] = [
        makeMessage({
          content: shortContent,
          role: "tool_result",
          toolName: "bash",
        }),
      ];
      await fs.mkdir(path.dirname(sessionPath), { recursive: true });
      const data = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
      await fs.writeFile(sessionPath, data);

      const history = await loadHistory(sessionKey, config);
      expect(history[0].content).toBe(shortContent);
    });

    it("truncates: returns only last maxHistoryMessages messages", async () => {
      const maxMessages = 3;
      const config = makeConfig(tmpDir, maxMessages);
      const sessionKey = "terminal--default";
      const sessionPath = path.join(tmpDir, "sessions", `${sessionKey}.jsonl`);

      // Write 5 messages, but only last 3 should be returned
      const messages: SessionMessage[] = [];
      for (let i = 0; i < 5; i++) {
        messages.push(makeMessage({ content: `Message ${i}` }));
      }
      await fs.mkdir(path.dirname(sessionPath), { recursive: true });
      const data = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
      await fs.writeFile(sessionPath, data);

      const history = await loadHistory(sessionKey, config);
      expect(history).toHaveLength(3);
      expect(history[0].content).toBe("Message 2");
      expect(history[1].content).toBe("Message 3");
      expect(history[2].content).toBe("Message 4");
    });

    it("handles non-existent session (returns empty history)", async () => {
      const config = makeConfig(tmpDir);
      const sessionKey = "nonexistent--session";

      const history = await loadHistory(sessionKey, config);
      expect(history).toEqual([]);
    });

    it("filters out compaction entries from transcript", async () => {
      const config = makeConfig(tmpDir);
      const sessionKey = "terminal--default";
      const sessionPath = path.join(tmpDir, "sessions", `${sessionKey}.jsonl`);

      const compaction: CompactionEntry = {
        type: "compaction",
        timestamp: "2025-06-15T12:00:00.000Z",
        messagesBefore: 100,
        messagesAfter: 10,
      };
      const msg = makeMessage({ content: "After compaction" });

      await fs.mkdir(path.dirname(sessionPath), { recursive: true });
      const data =
        JSON.stringify(compaction) + "\n" + JSON.stringify(msg) + "\n";
      await fs.writeFile(sessionPath, data);

      const history = await loadHistory(sessionKey, config);
      expect(history).toHaveLength(1);
      expect(history[0].content).toBe("After compaction");
    });
  });

  // -----------------------------------------------------------------------
  // saveInteraction
  // -----------------------------------------------------------------------
  describe("saveInteraction", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "session-manager-test-"),
      );
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("appends all messages from one agent turn", async () => {
      const config = makeConfig(tmpDir);
      const sessionKey = "telegram--123456";
      const sessionPath = path.join(tmpDir, "sessions", `${sessionKey}.jsonl`);

      const messages: SessionMessage[] = [
        makeMessage({ content: "User question", role: "user" }),
        makeMessage({ content: "ls /tmp", role: "tool_use", toolName: "bash" }),
        makeMessage({
          content: "file1\nfile2",
          role: "tool_result",
          toolName: "bash",
        }),
        makeMessage({ content: "Here are your files", role: "assistant" }),
      ];

      await saveInteraction(sessionKey, messages, config);

      // Verify the file was written correctly
      const raw = await fs.readFile(sessionPath, "utf-8");
      const lines = raw.trimEnd().split("\n");
      expect(lines).toHaveLength(4);
      expect(JSON.parse(lines[0]).content).toBe("User question");
      expect(JSON.parse(lines[1]).content).toBe("ls /tmp");
      expect(JSON.parse(lines[2]).content).toBe("file1\nfile2");
      expect(JSON.parse(lines[3]).content).toBe("Here are your files");
    });

    it("creates sessions directory if missing", async () => {
      const config = makeConfig(tmpDir);
      const sessionKey = "slack--C123--thread_ts";
      const sessionPath = path.join(tmpDir, "sessions", `${sessionKey}.jsonl`);

      // Sessions dir doesn't exist yet
      await expect(
        fs.stat(path.join(tmpDir, "sessions")),
      ).rejects.toThrow();

      await saveInteraction(
        sessionKey,
        [makeMessage({ content: "First message" })],
        config,
      );

      // Now the sessions dir and file should exist
      const stat = await fs.stat(sessionPath);
      expect(stat.isFile()).toBe(true);
    });

    it("appends to existing session file", async () => {
      const config = makeConfig(tmpDir);
      const sessionKey = "terminal--default";
      const sessionPath = path.join(tmpDir, "sessions", `${sessionKey}.jsonl`);

      // First interaction
      await saveInteraction(
        sessionKey,
        [makeMessage({ content: "Turn 1" })],
        config,
      );

      // Second interaction
      await saveInteraction(
        sessionKey,
        [makeMessage({ content: "Turn 2" })],
        config,
      );

      const raw = await fs.readFile(sessionPath, "utf-8");
      const lines = raw.trimEnd().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).content).toBe("Turn 1");
      expect(JSON.parse(lines[1]).content).toBe("Turn 2");
    });
  });
});
