import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadConversationHistory,
  appendCompactionEntry,
  loadLatestSummary,
} from "./compactor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "compactor-test-"));
}

async function writeJsonl(filePath: string, rows: object[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// loadConversationHistory
// ---------------------------------------------------------------------------

describe("loadConversationHistory", () => {
  let tmpDir: string;
  let sessionPath: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    sessionPath = path.join(tmpDir, "session.jsonl");
  });

  it("returns empty array when file does not exist", async () => {
    const result = await loadConversationHistory(sessionPath);
    expect(result).toEqual([]);
  });

  it("returns only user and assistant messages", async () => {
    await writeJsonl(sessionPath, [
      { role: "user", content: "Hello", timestamp: "2026-01-01T00:00:00Z" },
      { role: "assistant", content: "Hi", timestamp: "2026-01-01T00:00:01Z" },
      { role: "tool_use", content: "...", timestamp: "2026-01-01T00:00:02Z", toolName: "Bash" },
      { role: "tool_result", content: "ok", timestamp: "2026-01-01T00:00:03Z", toolName: "Bash" },
      { role: "compaction", content: "old summary", timestamp: "2026-01-01T00:00:04Z" },
    ]);
    const result = await loadConversationHistory(sessionPath);
    expect(result).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ]);
  });

  it("skips malformed lines", async () => {
    await fs.writeFile(
      sessionPath,
      [
        JSON.stringify({ role: "user", content: "Good", timestamp: "2026-01-01T00:00:00Z" }),
        "not-json",
        JSON.stringify({ role: "assistant", content: "OK", timestamp: "2026-01-01T00:00:01Z" }),
      ].join("\n") + "\n",
    );
    const result = await loadConversationHistory(sessionPath);
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// appendCompactionEntry
// ---------------------------------------------------------------------------

describe("appendCompactionEntry", () => {
  let tmpDir: string;
  let sessionPath: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    sessionPath = path.join(tmpDir, "sessions", "test.jsonl");
  });

  it("creates the file with the summary when it does not exist", async () => {
    await appendCompactionEntry(sessionPath, "first summary");
    const raw = await fs.readFile(sessionPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.role).toBe("compaction");
    expect(entry.content).toBe("first summary");
  });

  it("preserves user/assistant lines and adds compaction entry", async () => {
    await writeJsonl(sessionPath, [
      { role: "user", content: "Q1", timestamp: "t1" },
      { role: "assistant", content: "A1", timestamp: "t2" },
    ]);
    await appendCompactionEntry(sessionPath, "summary1");
    const raw = await fs.readFile(sessionPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ role: "user", content: "Q1" });
    expect(lines[1]).toMatchObject({ role: "assistant", content: "A1" });
    expect(lines[2]).toMatchObject({ role: "compaction", content: "summary1" });
  });

  it("replaces an existing compaction entry instead of accumulating", async () => {
    await writeJsonl(sessionPath, [
      { role: "user", content: "Q1", timestamp: "t1" },
      { role: "compaction", content: "old summary", timestamp: "t2" },
      { role: "assistant", content: "A1", timestamp: "t3" },
    ]);
    await appendCompactionEntry(sessionPath, "new summary");
    const raw = await fs.readFile(sessionPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    // Old compaction entry is gone; new one appears at the end
    const compactionLines = lines.filter((l) => l.role === "compaction");
    expect(compactionLines).toHaveLength(1);
    expect(compactionLines[0].content).toBe("new summary");
    // user and assistant lines preserved
    expect(lines.filter((l) => l.role === "user")).toHaveLength(1);
    expect(lines.filter((l) => l.role === "assistant")).toHaveLength(1);
  });

  it("drops ALL previous compaction entries (not just the first)", async () => {
    await writeJsonl(sessionPath, [
      { role: "compaction", content: "summary1", timestamp: "t1" },
      { role: "user", content: "Q", timestamp: "t2" },
      { role: "compaction", content: "summary2", timestamp: "t3" },
    ]);
    await appendCompactionEntry(sessionPath, "summary3");
    const raw = await fs.readFile(sessionPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const compactionLines = lines.filter((l) => l.role === "compaction");
    expect(compactionLines).toHaveLength(1);
    expect(compactionLines[0].content).toBe("summary3");
  });
});

// ---------------------------------------------------------------------------
// loadLatestSummary
// ---------------------------------------------------------------------------

describe("loadLatestSummary", () => {
  let tmpDir: string;
  let sessionPath: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    sessionPath = path.join(tmpDir, "session.jsonl");
  });

  it("returns null when file does not exist", async () => {
    expect(await loadLatestSummary(sessionPath)).toBeNull();
  });

  it("returns null when no compaction entry exists", async () => {
    await writeJsonl(sessionPath, [
      { role: "user", content: "Hello", timestamp: "t1" },
    ]);
    expect(await loadLatestSummary(sessionPath)).toBeNull();
  });

  it("returns the content of the only compaction entry", async () => {
    await writeJsonl(sessionPath, [
      { role: "user", content: "Q", timestamp: "t1" },
      { role: "compaction", content: "my summary", timestamp: "t2" },
    ]);
    expect(await loadLatestSummary(sessionPath)).toBe("my summary");
  });

  it("returns the LAST compaction entry when multiple exist", async () => {
    await writeJsonl(sessionPath, [
      { role: "compaction", content: "old", timestamp: "t1" },
      { role: "user", content: "Q", timestamp: "t2" },
      { role: "compaction", content: "latest", timestamp: "t3" },
    ]);
    expect(await loadLatestSummary(sessionPath)).toBe("latest");
  });
});
