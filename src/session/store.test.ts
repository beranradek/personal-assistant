import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { appendMessage, appendMessages } from "./store.js";
import type { SessionMessage } from "../core/types.js";

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

describe("session JSONL store", () => {
  let tmpDir: string;
  let sessionPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-test-"));
    sessionPath = path.join(tmpDir, "sessions", "test-session.jsonl");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // appendMessage
  // -----------------------------------------------------------------------
  describe("appendMessage", () => {
    it("appends one JSON line to file", async () => {
      const msg = makeMessage();
      await appendMessage(sessionPath, msg);

      const raw = await fs.readFile(sessionPath, "utf-8");
      const lines = raw.trimEnd().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual(msg);
    });

    it("creates file and parent directories if missing", async () => {
      const deepPath = path.join(tmpDir, "a", "b", "c", "session.jsonl");
      const msg = makeMessage();
      await appendMessage(deepPath, msg);

      const stat = await fs.stat(deepPath);
      expect(stat.isFile()).toBe(true);
    });

    it("appends multiple messages to the same file", async () => {
      const msg1 = makeMessage({ content: "First" });
      const msg2 = makeMessage({ content: "Second", role: "assistant" });

      await appendMessage(sessionPath, msg1);
      await appendMessage(sessionPath, msg2);

      const raw = await fs.readFile(sessionPath, "utf-8");
      const lines = raw.trimEnd().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).content).toBe("First");
      expect(JSON.parse(lines[1]).content).toBe("Second");
    });

    it("preserves optional toolName and error fields", async () => {
      const msg = makeMessage({
        role: "tool_result",
        toolName: "bash",
        error: "command failed",
      });
      await appendMessage(sessionPath, msg);

      const raw = await fs.readFile(sessionPath, "utf-8");
      const parsed = JSON.parse(raw.trim());
      expect(parsed.toolName).toBe("bash");
      expect(parsed.error).toBe("command failed");
    });
  });

  // -----------------------------------------------------------------------
  // appendMessages
  // -----------------------------------------------------------------------
  describe("appendMessages", () => {
    it("appends multiple messages at once (single write)", async () => {
      const msgs = [
        makeMessage({ content: "One" }),
        makeMessage({ content: "Two", role: "assistant" }),
        makeMessage({ content: "Three", role: "tool_use", toolName: "bash" }),
      ];

      await appendMessages(sessionPath, msgs);

      const raw = await fs.readFile(sessionPath, "utf-8");
      const lines = raw.trimEnd().split("\n");
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0]).content).toBe("One");
      expect(JSON.parse(lines[1]).content).toBe("Two");
      expect(JSON.parse(lines[2]).content).toBe("Three");
    });

    it("creates file and parent directories if missing", async () => {
      const deepPath = path.join(tmpDir, "x", "y", "session.jsonl");
      await appendMessages(deepPath, [makeMessage()]);

      const stat = await fs.stat(deepPath);
      expect(stat.isFile()).toBe(true);
    });

    it("appends to existing file content", async () => {
      await appendMessage(sessionPath, makeMessage({ content: "Existing" }));
      await appendMessages(sessionPath, [
        makeMessage({ content: "New1" }),
        makeMessage({ content: "New2" }),
      ]);

      const raw = await fs.readFile(sessionPath, "utf-8");
      const lines = raw.trimEnd().split("\n");
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0]).content).toBe("Existing");
      expect(JSON.parse(lines[1]).content).toBe("New1");
      expect(JSON.parse(lines[2]).content).toBe("New2");
    });

    it("handles empty array gracefully", async () => {
      await appendMessages(sessionPath, []);
      // File should not be created for empty array
      await expect(fs.stat(sessionPath)).rejects.toThrow();
    });
  });
});
