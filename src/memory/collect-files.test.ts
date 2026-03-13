import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { collectMemoryFiles } from "./collect-files.js";

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
