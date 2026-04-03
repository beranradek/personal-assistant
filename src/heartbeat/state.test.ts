import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadState, saveState, diffState, type HeartbeatState } from "./state.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeState(overrides?: Partial<HeartbeatState>): HeartbeatState {
  return {
    lastRun: new Date().toISOString(),
    snapshot: {},
    notifiedItems: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// loadState / saveState
// ---------------------------------------------------------------------------

describe("loadState / saveState", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hb-state-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when file does not exist", async () => {
    const result = await loadState(tmpDir);
    expect(result).toBeNull();
  });

  it("round-trips a state object correctly", async () => {
    const state = makeState({ notifiedItems: ["task A", "meeting at 3pm"] });
    await saveState(tmpDir, state);
    const loaded = await loadState(tmpDir);
    expect(loaded).toEqual(state);
  });

  it("persists lastRun timestamp", async () => {
    const ts = "2026-01-15T09:00:00.000Z";
    const state = makeState({ lastRun: ts });
    await saveState(tmpDir, state);
    const loaded = await loadState(tmpDir);
    expect(loaded?.lastRun).toBe(ts);
  });

  it("returns null when file contains invalid JSON", async () => {
    await fs.writeFile(path.join(tmpDir, "heartbeat-state.json"), "not json");
    const result = await loadState(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null when file contains non-object JSON", async () => {
    await fs.writeFile(path.join(tmpDir, "heartbeat-state.json"), "42");
    const result = await loadState(tmpDir);
    expect(result).toBeNull();
  });

  it("writes file with 0o600 permissions", async () => {
    const state = makeState();
    await saveState(tmpDir, state);
    const stat = await fs.stat(path.join(tmpDir, "heartbeat-state.json"));
    // 0o600 = 0o777 & ~0o177 — mask to compare only relevant bits
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("overwrites existing state file on successive saves", async () => {
    await saveState(tmpDir, makeState({ notifiedItems: ["old item"] }));
    await saveState(tmpDir, makeState({ notifiedItems: ["new item"] }));
    const loaded = await loadState(tmpDir);
    expect(loaded?.notifiedItems).toEqual(["new item"]);
  });
});

// ---------------------------------------------------------------------------
// diffState
// ---------------------------------------------------------------------------

describe("diffState", () => {
  it("returns all current items as new when previous is null", () => {
    const result = diffState(null, ["item A", "item B"]);
    expect(result.newItems).toEqual(["item A", "item B"]);
    expect(result.resolvedItems).toEqual([]);
    expect(result.unchanged).toEqual([]);
  });

  it("returns empty diff when current items equal previous notifiedItems", () => {
    const prev = makeState({ notifiedItems: ["meeting at 3pm", "new email"] });
    const result = diffState(prev, ["meeting at 3pm", "new email"]);
    expect(result.newItems).toEqual([]);
    expect(result.resolvedItems).toEqual([]);
    expect(result.unchanged).toEqual(["meeting at 3pm", "new email"]);
  });

  it("detects newly added items", () => {
    const prev = makeState({ notifiedItems: ["meeting at 3pm"] });
    const result = diffState(prev, ["meeting at 3pm", "new email"]);
    expect(result.newItems).toEqual(["new email"]);
    expect(result.unchanged).toEqual(["meeting at 3pm"]);
    expect(result.resolvedItems).toEqual([]);
  });

  it("detects resolved items", () => {
    const prev = makeState({ notifiedItems: ["task A", "task B"] });
    const result = diffState(prev, []);
    expect(result.resolvedItems).toEqual(["task A", "task B"]);
    expect(result.newItems).toEqual([]);
    expect(result.unchanged).toEqual([]);
  });

  it("handles mixed additions and resolutions", () => {
    const prev = makeState({ notifiedItems: ["meeting at 3pm", "task A"] });
    const result = diffState(prev, ["task A", "new email"]);
    expect(result.newItems).toEqual(["new email"]);
    expect(result.resolvedItems).toEqual(["meeting at 3pm"]);
    expect(result.unchanged).toEqual(["task A"]);
  });

  it("handles empty previous notifiedItems with empty current", () => {
    const prev = makeState({ notifiedItems: [] });
    const result = diffState(prev, []);
    expect(result.newItems).toEqual([]);
    expect(result.resolvedItems).toEqual([]);
    expect(result.unchanged).toEqual([]);
  });

  it("handles null previous with empty current items", () => {
    const result = diffState(null, []);
    expect(result.newItems).toEqual([]);
    expect(result.resolvedItems).toEqual([]);
    expect(result.unchanged).toEqual([]);
  });
});
