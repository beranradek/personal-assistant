import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { compactIfNeeded } from "./compactor.js";
import { appendMessages, loadTranscript } from "./store.js";
import type { SessionMessage } from "../core/types.js";
import type { CompactionEntry, TranscriptLine } from "./types.js";
import { isCompactionEntry } from "./types.js";

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

describe("compactIfNeeded", () => {
  let tmpDir: string;
  let sessionPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "compactor-test-"));
    sessionPath = path.join(tmpDir, "sessions", "test-session.jsonl");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("does nothing when message count is under threshold", async () => {
    const messages = Array.from({ length: 5 }, (_, i) =>
      makeMessage({ content: `msg-${i}` }),
    );
    await appendMessages(sessionPath, messages);

    const result = await compactIfNeeded(sessionPath, 10);

    expect(result).toEqual({ compacted: false });

    // Transcript unchanged
    const transcript = await loadTranscript(sessionPath);
    expect(transcript).toHaveLength(5);
  });

  it("compacts when over threshold: keeps last threshold messages, removes older ones", async () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      makeMessage({ content: `msg-${i}` }),
    );
    await appendMessages(sessionPath, messages);

    const result = await compactIfNeeded(sessionPath, 10);

    expect(result).toEqual({
      compacted: true,
      messagesBefore: 20,
      messagesAfter: 10,
    });

    const transcript = await loadTranscript(sessionPath);
    // 10 kept messages + 1 compaction entry
    const msgs = transcript.filter((l) => !isCompactionEntry(l));
    expect(msgs).toHaveLength(10);
  });

  it("creates .bak archive before rewriting", async () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      makeMessage({ content: `msg-${i}` }),
    );
    await appendMessages(sessionPath, messages);

    await compactIfNeeded(sessionPath, 10);

    const bakPath = sessionPath + ".bak";
    const bakStat = await fs.stat(bakPath);
    expect(bakStat.isFile()).toBe(true);

    // The backup should contain the original 20 messages
    const bakRaw = await fs.readFile(bakPath, "utf-8");
    const bakLines = bakRaw.trimEnd().split("\n").filter((l) => l.trim() !== "");
    expect(bakLines).toHaveLength(20);
  });

  it("appends compaction metadata entry with messagesBefore and messagesAfter", async () => {
    const messages = Array.from({ length: 15 }, (_, i) =>
      makeMessage({ content: `msg-${i}` }),
    );
    await appendMessages(sessionPath, messages);

    await compactIfNeeded(sessionPath, 5);

    const transcript = await loadTranscript(sessionPath);
    const compactionEntries = transcript.filter(isCompactionEntry) as CompactionEntry[];
    expect(compactionEntries).toHaveLength(1);
    expect(compactionEntries[0].type).toBe("compaction");
    expect(compactionEntries[0].messagesBefore).toBe(15);
    expect(compactionEntries[0].messagesAfter).toBe(5);
    expect(compactionEntries[0].timestamp).toBeDefined();
  });

  it("returns { compacted: boolean, messagesBefore?, messagesAfter? }", async () => {
    const messages = Array.from({ length: 3 }, (_, i) =>
      makeMessage({ content: `msg-${i}` }),
    );
    await appendMessages(sessionPath, messages);

    // Under threshold
    const resultUnder = await compactIfNeeded(sessionPath, 10);
    expect(resultUnder.compacted).toBe(false);
    expect(resultUnder.messagesBefore).toBeUndefined();
    expect(resultUnder.messagesAfter).toBeUndefined();

    // Over threshold - add more messages
    const moreMessages = Array.from({ length: 20 }, (_, i) =>
      makeMessage({ content: `extra-${i}` }),
    );
    await appendMessages(sessionPath, moreMessages);

    const resultOver = await compactIfNeeded(sessionPath, 10);
    expect(resultOver.compacted).toBe(true);
    expect(typeof resultOver.messagesBefore).toBe("number");
    expect(typeof resultOver.messagesAfter).toBe("number");
  });

  it("preserves message order after compaction", async () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      makeMessage({ content: `msg-${i}` }),
    );
    await appendMessages(sessionPath, messages);

    await compactIfNeeded(sessionPath, 10);

    const transcript = await loadTranscript(sessionPath);
    const msgs = transcript.filter((l) => !isCompactionEntry(l)) as SessionMessage[];

    // Should keep the last 10 messages (msg-10 through msg-19)
    for (let i = 0; i < 10; i++) {
      expect(msgs[i].content).toBe(`msg-${i + 10}`);
    }
  });

  it("handles empty transcript (no-op)", async () => {
    // File doesn't exist yet
    const result = await compactIfNeeded(sessionPath, 10);

    expect(result).toEqual({ compacted: false });
  });

  it("preserves existing compaction entries in the count (they don't count as messages for threshold)", async () => {
    // Manually build a transcript with a compaction entry mixed in
    const line0 = makeMessage({ content: "msg-0" });
    const line1 = makeMessage({ content: "msg-1" });
    const compaction: CompactionEntry = {
      type: "compaction",
      timestamp: "2025-06-15T11:00:00.000Z",
      messagesBefore: 50,
      messagesAfter: 5,
    };
    const line2 = makeMessage({ content: "msg-2" });
    const line3 = makeMessage({ content: "msg-3" });
    const line4 = makeMessage({ content: "msg-4" });
    const line5 = makeMessage({ content: "msg-5" });
    const line6 = makeMessage({ content: "msg-6" });

    // Write as JSONL with compaction entry in the middle
    const allLines: TranscriptLine[] = [line0, line1, compaction, line2, line3, line4, line5, line6];
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    const data = allLines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    await fs.writeFile(sessionPath, data, "utf-8");

    // 7 actual messages, threshold is 5 => should compact
    const result = await compactIfNeeded(sessionPath, 5);

    expect(result).toEqual({
      compacted: true,
      messagesBefore: 7,
      messagesAfter: 5,
    });

    const transcript = await loadTranscript(sessionPath);
    const msgs = transcript.filter((l) => !isCompactionEntry(l)) as SessionMessage[];
    const compactions = transcript.filter(isCompactionEntry) as CompactionEntry[];

    // Should keep exactly 5 messages (the last 5)
    expect(msgs).toHaveLength(5);
    expect(msgs[0].content).toBe("msg-2");
    expect(msgs[4].content).toBe("msg-6");

    // Should have the new compaction entry (old one was in the removed portion)
    // The new compaction entry records the current compaction
    expect(compactions.length).toBeGreaterThanOrEqual(1);
    const newCompaction = compactions[compactions.length - 1];
    expect(newCompaction.messagesBefore).toBe(7);
    expect(newCompaction.messagesAfter).toBe(5);
  });
});
