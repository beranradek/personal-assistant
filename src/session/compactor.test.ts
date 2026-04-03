import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadConversationHistory,
  appendCompactionEntry,
  loadLatestSummary,
  flushPreCompactionContext,
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

// ---------------------------------------------------------------------------
// flushPreCompactionContext
// ---------------------------------------------------------------------------

describe("flushPreCompactionContext", () => {
  let tmpDir: string;
  let workspaceDir: string;
  const SESSION_KEY = "terminal--default";

  /** Helper to build a minimal Anthropic API success response. */
  function mockAnthropicResponse(text: string): Response {
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flush-test-"));
    workspaceDir = tmpDir;
    process.env["ANTHROPIC_API_KEY"] = "test-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["ANTHROPIC_API_KEY"];
  });

  it("appends audit entry with context 'pre-compaction' when API succeeds", async () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `Message ${i}`,
    }));

    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      mockAnthropicResponse("• Decision 1\n• Action item A"),
    );

    await flushPreCompactionContext(
      messages,
      workspaceDir,
      SESSION_KEY,
      "claude-haiku-4-5-20251001",
    );

    const today = new Date().toISOString().slice(0, 10);
    const logPath = path.join(workspaceDir, "daily", `${today}.jsonl`);
    const raw = await fs.readFile(logPath, "utf-8");
    const entry = JSON.parse(raw.trim().split("\n")[0]!);
    expect(entry.context).toBe("pre-compaction");
    expect(entry.type).toBe("interaction");
    expect(entry.sessionKey).toBe(SESSION_KEY);
    expect(entry.assistantResponse).toBe("• Decision 1\n• Action item A");
  });

  it("logs a warning and does not throw when the API returns an error", async () => {
    const messages = [
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi" },
    ];

    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response("Service Unavailable", { status: 503 }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      flushPreCompactionContext(messages, workspaceDir, SESSION_KEY),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Pre-compaction flush failed"),
      expect.any(String),
    );
  });

  it("still writes extraction for trivial messages", async () => {
    const messages = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
    ];

    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      mockAnthropicResponse("• No significant decisions"),
    );

    await flushPreCompactionContext(messages, workspaceDir, SESSION_KEY);

    const today = new Date().toISOString().slice(0, 10);
    const logPath = path.join(workspaceDir, "daily", `${today}.jsonl`);
    const raw = await fs.readFile(logPath, "utf-8");
    expect(raw).toContain("pre-compaction");
  });

  it("includes conversation text in the API request prompt", async () => {
    const messages = [
      { role: "user" as const, content: "My important decision" },
      { role: "assistant" as const, content: "Acknowledged" },
    ];

    let capturedBody: any;
    vi.spyOn(global, "fetch").mockImplementationOnce(async (_url, opts) => {
      capturedBody = JSON.parse((opts as any).body);
      return mockAnthropicResponse("• Important decision captured");
    });

    await flushPreCompactionContext(messages, workspaceDir, SESSION_KEY);

    const promptContent = capturedBody.messages[0].content as string;
    expect(promptContent).toContain("My important decision");
    expect(promptContent).toContain("Extract key decisions");
  });
});
