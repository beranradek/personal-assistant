import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { appendAuditEntry, readAuditEntries } from "./daily-log.js";
import type { AuditEntry } from "../core/types.js";

describe("daily audit log", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daily-log-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("appendAuditEntry", () => {
    it("creates daily/YYYY-MM-DD.jsonl if missing", async () => {
      const entry: AuditEntry = {
        timestamp: "2025-06-15T10:30:00.000Z",
        source: "telegram",
        sessionKey: "telegram--123",
        type: "interaction",
        userMessage: "Hello",
        assistantResponse: "Hi there!",
      };

      await appendAuditEntry(tmpDir, entry);

      const filePath = path.join(tmpDir, "daily", "2025-06-15.jsonl");
      const stat = await fs.stat(filePath);
      expect(stat.isFile()).toBe(true);
    });

    it("creates daily/ directory if missing", async () => {
      const entry: AuditEntry = {
        timestamp: "2025-06-15T10:30:00.000Z",
        source: "terminal",
        sessionKey: "terminal--default",
        type: "interaction",
        userMessage: "test",
        assistantResponse: "response",
      };

      await appendAuditEntry(tmpDir, entry);

      const dirPath = path.join(tmpDir, "daily");
      const stat = await fs.stat(dirPath);
      expect(stat.isDirectory()).toBe(true);
    });

    it("appends JSONL entry with timestamp, source, sessionKey, type", async () => {
      const entry: AuditEntry = {
        timestamp: "2025-06-15T10:30:00.000Z",
        source: "slack",
        sessionKey: "slack--C123",
        type: "interaction",
        userMessage: "Hi",
        assistantResponse: "Hello",
      };

      await appendAuditEntry(tmpDir, entry);

      const filePath = path.join(tmpDir, "daily", "2025-06-15.jsonl");
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content.trim());

      expect(parsed.timestamp).toBe("2025-06-15T10:30:00.000Z");
      expect(parsed.source).toBe("slack");
      expect(parsed.sessionKey).toBe("slack--C123");
      expect(parsed.type).toBe("interaction");
    });

    it("writes interaction type with userMessage and assistantResponse", async () => {
      const entry: AuditEntry = {
        timestamp: "2025-06-15T10:30:00.000Z",
        source: "telegram",
        sessionKey: "telegram--456",
        type: "interaction",
        userMessage: "What time is it?",
        assistantResponse: "It is 10:30 AM.",
      };

      await appendAuditEntry(tmpDir, entry);

      const entries = await readAuditEntries(tmpDir, "2025-06-15");
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("interaction");
      expect(entries[0].userMessage).toBe("What time is it?");
      expect(entries[0].assistantResponse).toBe("It is 10:30 AM.");
    });

    it("writes tool_call type with toolName, toolInput, toolResult, durationMs", async () => {
      const entry: AuditEntry = {
        timestamp: "2025-06-15T10:31:00.000Z",
        source: "terminal",
        sessionKey: "terminal--default",
        type: "tool_call",
        toolName: "bash",
        toolInput: { command: "ls" },
        toolResult: { output: "file1.txt\nfile2.txt" },
        durationMs: 150,
      };

      await appendAuditEntry(tmpDir, entry);

      const entries = await readAuditEntries(tmpDir, "2025-06-15");
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("tool_call");
      expect(entries[0].toolName).toBe("bash");
      expect(entries[0].toolInput).toEqual({ command: "ls" });
      expect(entries[0].toolResult).toEqual({ output: "file1.txt\nfile2.txt" });
      expect(entries[0].durationMs).toBe(150);
    });

    it("writes error type with errorMessage, stack, context", async () => {
      const entry: AuditEntry = {
        timestamp: "2025-06-15T10:32:00.000Z",
        source: "telegram",
        sessionKey: "telegram--789",
        type: "error",
        errorMessage: "Something went wrong",
        stack: "Error: Something went wrong\n    at foo.ts:10",
        context: "processing user message",
      };

      await appendAuditEntry(tmpDir, entry);

      const entries = await readAuditEntries(tmpDir, "2025-06-15");
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("error");
      expect(entries[0].errorMessage).toBe("Something went wrong");
      expect(entries[0].stack).toBe(
        "Error: Something went wrong\n    at foo.ts:10",
      );
      expect(entries[0].context).toBe("processing user message");
    });

    it("appends multiple entries on the same day to the same file", async () => {
      const entry1: AuditEntry = {
        timestamp: "2025-06-15T10:00:00.000Z",
        source: "telegram",
        sessionKey: "telegram--123",
        type: "interaction",
        userMessage: "First",
        assistantResponse: "Response 1",
      };

      const entry2: AuditEntry = {
        timestamp: "2025-06-15T14:00:00.000Z",
        source: "telegram",
        sessionKey: "telegram--123",
        type: "interaction",
        userMessage: "Second",
        assistantResponse: "Response 2",
      };

      await appendAuditEntry(tmpDir, entry1);
      await appendAuditEntry(tmpDir, entry2);

      const entries = await readAuditEntries(tmpDir, "2025-06-15");
      expect(entries).toHaveLength(2);
      expect(entries[0].userMessage).toBe("First");
      expect(entries[1].userMessage).toBe("Second");
    });

    it("creates a new file for the next day", async () => {
      const entry1: AuditEntry = {
        timestamp: "2025-06-15T23:00:00.000Z",
        source: "telegram",
        sessionKey: "telegram--123",
        type: "interaction",
        userMessage: "Day 1",
        assistantResponse: "Response",
      };

      const entry2: AuditEntry = {
        timestamp: "2025-06-16T08:00:00.000Z",
        source: "telegram",
        sessionKey: "telegram--123",
        type: "interaction",
        userMessage: "Day 2",
        assistantResponse: "Response",
      };

      await appendAuditEntry(tmpDir, entry1);
      await appendAuditEntry(tmpDir, entry2);

      const day1Entries = await readAuditEntries(tmpDir, "2025-06-15");
      const day2Entries = await readAuditEntries(tmpDir, "2025-06-16");

      expect(day1Entries).toHaveLength(1);
      expect(day1Entries[0].userMessage).toBe("Day 1");
      expect(day2Entries).toHaveLength(1);
      expect(day2Entries[0].userMessage).toBe("Day 2");
    });

    it("writes valid JSONL format (one JSON object per line)", async () => {
      const entry1: AuditEntry = {
        timestamp: "2025-06-15T10:00:00.000Z",
        source: "terminal",
        sessionKey: "terminal--default",
        type: "interaction",
        userMessage: "A",
        assistantResponse: "B",
      };

      const entry2: AuditEntry = {
        timestamp: "2025-06-15T11:00:00.000Z",
        source: "terminal",
        sessionKey: "terminal--default",
        type: "tool_call",
        toolName: "bash",
        toolInput: { command: "pwd" },
        toolResult: "/home/user",
        durationMs: 50,
      };

      await appendAuditEntry(tmpDir, entry1);
      await appendAuditEntry(tmpDir, entry2);

      const filePath = path.join(tmpDir, "daily", "2025-06-15.jsonl");
      const raw = await fs.readFile(filePath, "utf-8");
      const lines = raw.trimEnd().split("\n");

      expect(lines).toHaveLength(2);
      // Each line should be valid JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });

  describe("readAuditEntries", () => {
    it("returns empty array when file does not exist", async () => {
      const entries = await readAuditEntries(tmpDir, "2025-01-01");
      expect(entries).toEqual([]);
    });

    it("returns empty array when daily/ directory does not exist", async () => {
      const nonExistent = path.join(tmpDir, "no-such-dir");
      const entries = await readAuditEntries(nonExistent, "2025-01-01");
      expect(entries).toEqual([]);
    });

    it("reads all entries from a JSONL file for the given date", async () => {
      const entry1: AuditEntry = {
        timestamp: "2025-06-15T10:00:00.000Z",
        source: "telegram",
        sessionKey: "telegram--123",
        type: "interaction",
        userMessage: "Hello",
        assistantResponse: "Hi",
      };

      const entry2: AuditEntry = {
        timestamp: "2025-06-15T12:00:00.000Z",
        source: "slack",
        sessionKey: "slack--C456",
        type: "error",
        errorMessage: "timeout",
        context: "api call",
      };

      await appendAuditEntry(tmpDir, entry1);
      await appendAuditEntry(tmpDir, entry2);

      const entries = await readAuditEntries(tmpDir, "2025-06-15");
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual(entry1);
      expect(entries[1]).toEqual(entry2);
    });
  });
});
