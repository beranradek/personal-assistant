import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createMemoryWatcher, type MemoryWatcher } from "./watcher.js";

vi.mock("../core/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const DEBOUNCE_MS = 50;
const WAIT_MS = 200;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createMemoryWatcher", () => {
  let tmpDir: string;
  let watcher: MemoryWatcher | null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-watcher-"));
    watcher = null;
  });

  afterEach(() => {
    watcher?.close();
    watcher = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("calls onChanged when MEMORY.md is modified", async () => {
    const memoryMdPath = path.join(tmpDir, "MEMORY.md");
    fs.writeFileSync(memoryMdPath, "initial content", "utf-8");

    const onChanged = vi.fn();
    watcher = createMemoryWatcher(tmpDir, onChanged, { debounceMs: DEBOUNCE_MS });

    fs.writeFileSync(memoryMdPath, "updated content", "utf-8");

    await wait(WAIT_MS);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("calls onChanged when a .md file in memory/ directory changes", async () => {
    const memoryDir = path.join(tmpDir, "memory");
    fs.mkdirSync(memoryDir);
    const notesPath = path.join(memoryDir, "notes.md");
    fs.writeFileSync(notesPath, "initial notes", "utf-8");

    const onChanged = vi.fn();
    watcher = createMemoryWatcher(tmpDir, onChanged, { debounceMs: DEBOUNCE_MS });

    fs.writeFileSync(notesPath, "updated notes", "utf-8");

    await wait(WAIT_MS);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("does not call onChanged for non-.md files in memory/ directory", async () => {
    const memoryDir = path.join(tmpDir, "memory");
    fs.mkdirSync(memoryDir);
    const txtPath = path.join(memoryDir, "data.txt");
    fs.writeFileSync(txtPath, "some data", "utf-8");

    const onChanged = vi.fn();
    watcher = createMemoryWatcher(tmpDir, onChanged, { debounceMs: DEBOUNCE_MS });

    fs.writeFileSync(txtPath, "updated data", "utf-8");

    await wait(WAIT_MS);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("debounces rapid changes (multiple writes → single callback)", async () => {
    const memoryMdPath = path.join(tmpDir, "MEMORY.md");
    fs.writeFileSync(memoryMdPath, "v0", "utf-8");

    const onChanged = vi.fn();
    watcher = createMemoryWatcher(tmpDir, onChanged, { debounceMs: DEBOUNCE_MS });

    // Rapid writes within the debounce window
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(memoryMdPath, `v${i}`, "utf-8");
      await wait(10);
    }

    await wait(WAIT_MS);
    // Should have been called fewer times than the number of writes
    expect(onChanged.mock.calls.length).toBeLessThan(5);
    expect(onChanged).toHaveBeenCalled();
  });

  it("close() stops watching — callback not called after close", async () => {
    const memoryMdPath = path.join(tmpDir, "MEMORY.md");
    fs.writeFileSync(memoryMdPath, "initial", "utf-8");

    const onChanged = vi.fn();
    watcher = createMemoryWatcher(tmpDir, onChanged, { debounceMs: DEBOUNCE_MS });

    watcher.close();
    watcher = null; // prevent double-close in afterEach

    fs.writeFileSync(memoryMdPath, "after close", "utf-8");

    await wait(WAIT_MS);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("handles missing MEMORY.md gracefully (no throw)", () => {
    const onChanged = vi.fn();
    // MEMORY.md does not exist in tmpDir
    expect(() => {
      watcher = createMemoryWatcher(tmpDir, onChanged, { debounceMs: DEBOUNCE_MS });
    }).not.toThrow();
  });

  it("handles missing memory/ directory gracefully (no throw)", () => {
    const memoryMdPath = path.join(tmpDir, "MEMORY.md");
    fs.writeFileSync(memoryMdPath, "content", "utf-8");

    const onChanged = vi.fn();
    // memory/ dir does not exist
    expect(() => {
      watcher = createMemoryWatcher(tmpDir, onChanged, { debounceMs: DEBOUNCE_MS });
    }).not.toThrow();
  });
});
