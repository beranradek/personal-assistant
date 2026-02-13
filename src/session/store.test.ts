import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  appendMessage,
  appendMessages,
  loadTranscript,
  rewriteTranscript,
} from "./store.js";
import type { SessionMessage } from "../core/types.js";
import type { CompactionEntry, TranscriptLine } from "./types.js";

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

  // -----------------------------------------------------------------------
  // loadTranscript
  // -----------------------------------------------------------------------
  describe("loadTranscript", () => {
    it("reads all messages from JSONL file", async () => {
      const msgs = [
        makeMessage({ content: "First" }),
        makeMessage({ content: "Second", role: "assistant" }),
      ];
      await appendMessages(sessionPath, msgs);

      const transcript = await loadTranscript(sessionPath);
      expect(transcript).toHaveLength(2);
      expect(transcript[0]).toEqual(msgs[0]);
      expect(transcript[1]).toEqual(msgs[1]);
    });

    it("returns empty array for non-existent file", async () => {
      const result = await loadTranscript(
        path.join(tmpDir, "nonexistent.jsonl"),
      );
      expect(result).toEqual([]);
    });

    it("handles corrupt lines gracefully (skip, log warning)", async () => {
      // Write a mix of valid and corrupt lines
      const validMsg = makeMessage({ content: "Valid" });
      const lines = [
        JSON.stringify(validMsg),
        "this is not valid json{{{",
        JSON.stringify(makeMessage({ content: "Also valid" })),
        "{broken",
      ].join("\n") + "\n";

      await fs.mkdir(path.dirname(sessionPath), { recursive: true });
      await fs.writeFile(sessionPath, lines);

      const transcript = await loadTranscript(sessionPath);
      expect(transcript).toHaveLength(2);
      expect((transcript[0] as SessionMessage).content).toBe("Valid");
      expect((transcript[1] as SessionMessage).content).toBe("Also valid");
    });

    it("skips empty lines without warnings", async () => {
      const validMsg = makeMessage({ content: "Hello" });
      const lines = [
        JSON.stringify(validMsg),
        "",
        "",
        JSON.stringify(makeMessage({ content: "World" })),
        "",
      ].join("\n");

      await fs.mkdir(path.dirname(sessionPath), { recursive: true });
      await fs.writeFile(sessionPath, lines);

      const transcript = await loadTranscript(sessionPath);
      expect(transcript).toHaveLength(2);
    });

    it("loads compaction entries alongside regular messages", async () => {
      const msg = makeMessage({ content: "Hello" });
      const compaction: CompactionEntry = {
        type: "compaction",
        timestamp: "2025-06-15T12:00:00.000Z",
        messagesBefore: 100,
        messagesAfter: 10,
      };

      const content = [
        JSON.stringify(compaction),
        JSON.stringify(msg),
      ].join("\n") + "\n";

      await fs.mkdir(path.dirname(sessionPath), { recursive: true });
      await fs.writeFile(sessionPath, content);

      const transcript = await loadTranscript(sessionPath);
      expect(transcript).toHaveLength(2);
      expect((transcript[0] as CompactionEntry).type).toBe("compaction");
      expect((transcript[1] as SessionMessage).role).toBe("user");
    });
  });

  // -----------------------------------------------------------------------
  // rewriteTranscript
  // -----------------------------------------------------------------------
  describe("rewriteTranscript", () => {
    it("atomically replaces file content (tmp + rename)", async () => {
      // Write initial content
      await appendMessages(sessionPath, [
        makeMessage({ content: "Old1" }),
        makeMessage({ content: "Old2" }),
      ]);

      const newLines: TranscriptLine[] = [
        makeMessage({ content: "New1" }),
        makeMessage({ content: "New2" }),
        makeMessage({ content: "New3" }),
      ];

      await rewriteTranscript(sessionPath, newLines);

      const transcript = await loadTranscript(sessionPath);
      expect(transcript).toHaveLength(3);
      expect((transcript[0] as SessionMessage).content).toBe("New1");
      expect((transcript[1] as SessionMessage).content).toBe("New2");
      expect((transcript[2] as SessionMessage).content).toBe("New3");
    });

    it("creates .bak backup before rewrite", async () => {
      const original = [makeMessage({ content: "Original" })];
      await appendMessages(sessionPath, original);

      await rewriteTranscript(sessionPath, [
        makeMessage({ content: "Replaced" }),
      ]);

      const bakPath = sessionPath + ".bak";
      const bakContent = await fs.readFile(bakPath, "utf-8");
      const bakParsed = JSON.parse(bakContent.trim());
      expect(bakParsed.content).toBe("Original");
    });

    it("works when no existing file (no .bak created)", async () => {
      const newLines: TranscriptLine[] = [
        makeMessage({ content: "Fresh" }),
      ];

      await rewriteTranscript(sessionPath, newLines);

      const transcript = await loadTranscript(sessionPath);
      expect(transcript).toHaveLength(1);
      expect((transcript[0] as SessionMessage).content).toBe("Fresh");

      // No .bak should exist since there was no original file
      await expect(fs.stat(sessionPath + ".bak")).rejects.toThrow();
    });

    it("does not leave .tmp file after successful rewrite", async () => {
      await appendMessages(sessionPath, [makeMessage()]);
      await rewriteTranscript(sessionPath, [makeMessage({ content: "New" })]);

      const tmpPath = sessionPath + ".tmp";
      await expect(fs.stat(tmpPath)).rejects.toThrow();
    });

    it("writes valid JSONL in rewritten file", async () => {
      const compaction: CompactionEntry = {
        type: "compaction",
        timestamp: "2025-06-15T12:00:00.000Z",
        messagesBefore: 50,
        messagesAfter: 5,
      };
      const msg = makeMessage({ content: "After compaction" });

      await rewriteTranscript(sessionPath, [compaction, msg]);

      const raw = await fs.readFile(sessionPath, "utf-8");
      const lines = raw.trimEnd().split("\n");
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it("creates parent directories if needed", async () => {
      const deepPath = path.join(tmpDir, "deep", "dir", "session.jsonl");

      await rewriteTranscript(deepPath, [makeMessage({ content: "Deep" })]);

      const transcript = await loadTranscript(deepPath);
      expect(transcript).toHaveLength(1);
    });
  });
});
