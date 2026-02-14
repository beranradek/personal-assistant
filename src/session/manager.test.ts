import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { resolveSessionKey, saveInteraction } from "./manager.js";
import type { SessionMessage, Config } from "../core/types.js";

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

function makeConfig(dataDir: string): Config {
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
      maxHistoryMessages: 50,
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
