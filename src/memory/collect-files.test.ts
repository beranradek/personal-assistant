import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { collectMemoryFiles, collectDailyLogFiles } from "./collect-files.js";

describe("collectMemoryFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "collect-files-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("always includes MEMORY.md from workspaceDir", async () => {
    const result = collectMemoryFiles(tmpDir, []);

    expect(result).toContain(path.join(tmpDir, "MEMORY.md"));
  });

  it("discovers .md files in memory/ subdirectory", async () => {
    const memoryDir = path.join(tmpDir, "memory");
    await fs.mkdir(memoryDir);
    await fs.writeFile(path.join(memoryDir, "notes.md"), "notes");
    await fs.writeFile(path.join(memoryDir, "journal.md"), "journal");
    await fs.writeFile(path.join(memoryDir, "not-markdown.txt"), "text");

    const result = collectMemoryFiles(tmpDir, []);

    expect(result).toContain(path.join(memoryDir, "notes.md"));
    expect(result).toContain(path.join(memoryDir, "journal.md"));
    expect(result).not.toContain(path.join(memoryDir, "not-markdown.txt"));
  });

  it("includes extraPaths resolved relative to workspaceDir when not absolute", async () => {
    const result = collectMemoryFiles(tmpDir, ["skills/tool.md"]);

    expect(result).toContain(path.join(tmpDir, "skills/tool.md"));
  });

  it("includes absolute extraPaths as-is", async () => {
    const absolutePath = "/some/absolute/path.md";
    const result = collectMemoryFiles(tmpDir, [absolutePath]);

    expect(result).toContain(absolutePath);
  });

  it("returns gracefully when memory/ directory does not exist", async () => {
    // No memory/ subdirectory created
    const result = collectMemoryFiles(tmpDir, []);

    expect(result).toEqual([path.join(tmpDir, "MEMORY.md")]);
  });

  it("deduplicates paths", async () => {
    const memoryMd = path.join(tmpDir, "MEMORY.md");

    // Pass MEMORY.md as an extra path (already included by default)
    const result = collectMemoryFiles(tmpDir, ["MEMORY.md"]);

    const count = result.filter((p) => p === memoryMd).length;
    expect(count).toBe(1);
  });

  it("deduplicates absolute extra paths", async () => {
    const absolutePath = path.join(tmpDir, "MEMORY.md");

    const result = collectMemoryFiles(tmpDir, [absolutePath]);

    const count = result.filter((p) => p === absolutePath).length;
    expect(count).toBe(1);
  });
});

describe("collectDailyLogFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "collect-daily-test-"));
    await fs.mkdir(path.join(tmpDir, "daily"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("includes .jsonl files within retention window", async () => {
    // A file dated 2 days ago should be included with retentionDays=90
    const today = new Date();
    const twoDaysAgo = new Date(today);
    twoDaysAgo.setDate(today.getDate() - 2);
    const dateStr = twoDaysAgo.toISOString().slice(0, 10);
    await fs.writeFile(path.join(tmpDir, "daily", `${dateStr}.jsonl`), "{}");

    const result = collectDailyLogFiles(tmpDir, 90);

    expect(result).toContain(path.join(tmpDir, "daily", `${dateStr}.jsonl`));
  });

  it("excludes .jsonl files older than retention window", async () => {
    // A file dated 100 days ago should be excluded with retentionDays=90
    const today = new Date();
    const oldDate = new Date(today);
    oldDate.setDate(today.getDate() - 100);
    const dateStr = oldDate.toISOString().slice(0, 10);
    await fs.writeFile(path.join(tmpDir, "daily", `${dateStr}.jsonl`), "{}");

    const result = collectDailyLogFiles(tmpDir, 90);

    expect(result).not.toContain(path.join(tmpDir, "daily", `${dateStr}.jsonl`));
  });

  it("ignores non-.jsonl files", async () => {
    await fs.writeFile(path.join(tmpDir, "daily", "2026-01-01.txt"), "text");

    const result = collectDailyLogFiles(tmpDir, 90);

    expect(result).toHaveLength(0);
  });

  it("returns empty array when daily/ directory does not exist", async () => {
    const result = collectDailyLogFiles(path.join(tmpDir, "nonexistent"), 90);

    expect(result).toEqual([]);
  });

  it("ignores files with invalid date format in filename", async () => {
    await fs.writeFile(path.join(tmpDir, "daily", "invalid-name.jsonl"), "{}");

    const result = collectDailyLogFiles(tmpDir, 90);

    expect(result).toHaveLength(0);
  });
});

describe("collectMemoryFiles with dailyLogOptions", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "collect-files-daily-test-"));
    await fs.mkdir(path.join(tmpDir, "daily"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("includes daily log files when indexDailyLogs is true", async () => {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10);
    const logPath = path.join(tmpDir, "daily", `${dateStr}.jsonl`);
    await fs.writeFile(logPath, "{}");

    const result = collectMemoryFiles(tmpDir, [], {
      indexDailyLogs: true,
      dailyLogRetentionDays: 90,
    });

    expect(result).toContain(logPath);
  });

  it("excludes daily log files when indexDailyLogs is false", async () => {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10);
    const logPath = path.join(tmpDir, "daily", `${dateStr}.jsonl`);
    await fs.writeFile(logPath, "{}");

    const result = collectMemoryFiles(tmpDir, [], {
      indexDailyLogs: false,
      dailyLogRetentionDays: 90,
    });

    expect(result).not.toContain(logPath);
  });

  it("excludes daily log files when dailyLogOptions is not provided", async () => {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10);
    const logPath = path.join(tmpDir, "daily", `${dateStr}.jsonl`);
    await fs.writeFile(logPath, "{}");

    const result = collectMemoryFiles(tmpDir, []);

    expect(result).not.toContain(logPath);
  });
});
