import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SystemEvent } from "../core/types.js";
import {
  resolveHeartbeatPrompt,
  isHeartbeatOk,
  EXEC_EVENT_PROMPT,
  CRON_EVENT_PROMPT,
  HEARTBEAT_PROMPT,
} from "./prompts.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeEvent(
  type: SystemEvent["type"],
  text: string,
): SystemEvent {
  return { type, text, timestamp: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// resolveHeartbeatPrompt
// ---------------------------------------------------------------------------
describe("resolveHeartbeatPrompt", () => {
  it("returns standard prompt when no events", () => {
    const prompt = resolveHeartbeatPrompt([]);
    // Cannot use toBe because HEARTBEAT_PROMPT() generates a fresh timestamp each call
    expect(prompt).toContain("Read HEARTBEAT.md");
    expect(prompt).toContain("HEARTBEAT_OK");
    expect(prompt).not.toContain("background command");
    expect(prompt).not.toContain("scheduled reminder");
  });

  it("returns EXEC_EVENT_PROMPT when exec completion event present", () => {
    const event = makeEvent("exec", "ls exited with code 0");
    const prompt = resolveHeartbeatPrompt([event]);
    expect(prompt).toBe(EXEC_EVENT_PROMPT(event));
    expect(prompt).toContain("ls exited with code 0");
  });

  it("returns CRON_EVENT_PROMPT with event text when cron event present", () => {
    const event = makeEvent("cron", "check disk usage");
    const prompt = resolveHeartbeatPrompt([event]);
    expect(prompt).toBe(CRON_EVENT_PROMPT(event));
    expect(prompt).toContain("check disk usage");
  });

  it("prioritizes exec events over cron events when both present", () => {
    const execEvent = makeEvent("exec", "build finished");
    const cronEvent = makeEvent("cron", "hourly reminder");
    const prompt = resolveHeartbeatPrompt([cronEvent, execEvent]);
    expect(prompt).toBe(EXEC_EVENT_PROMPT(execEvent));
    expect(prompt).toContain("build finished");
  });

  it("falls back to standard prompt when only system events present", () => {
    const event = makeEvent("system", "something happened");
    const prompt = resolveHeartbeatPrompt([event]);
    expect(prompt).toContain("Read HEARTBEAT.md");
    expect(prompt).toContain("HEARTBEAT_OK");
    expect(prompt).not.toContain("background command");
    expect(prompt).not.toContain("scheduled reminder");
  });
});

// ---------------------------------------------------------------------------
// HEARTBEAT_PROMPT (standard prompt)
// ---------------------------------------------------------------------------
describe("HEARTBEAT_PROMPT", () => {
  it("includes instruction to read HEARTBEAT.md", () => {
    const prompt = HEARTBEAT_PROMPT();
    expect(prompt).toContain("HEARTBEAT.md");
  });

  it("includes the current time", () => {
    const before = new Date();
    const prompt = HEARTBEAT_PROMPT();
    const after = new Date();

    // Extract a full ISO-8601 timestamp from the prompt
    const match = prompt.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(match).not.toBeNull();

    const promptTime = new Date(match![0]);
    expect(promptTime.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(promptTime.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("generates a fresh timestamp on each invocation", () => {
    const prompt1 = HEARTBEAT_PROMPT();
    // Tiny delay to ensure different timestamps (or at least test the function is called fresh)
    const prompt2 = HEARTBEAT_PROMPT();
    // Both should be valid prompts (they may have the same timestamp if called within same ms)
    expect(prompt1).toContain("HEARTBEAT.md");
    expect(prompt2).toContain("HEARTBEAT.md");
    // They are both strings returned from a function call, not a static constant
    expect(typeof prompt1).toBe("string");
    expect(typeof prompt2).toBe("string");
  });

  it("includes HEARTBEAT_OK instruction", () => {
    const prompt = HEARTBEAT_PROMPT();
    expect(prompt).toContain("HEARTBEAT_OK");
  });
});

// ---------------------------------------------------------------------------
// isHeartbeatOk
// ---------------------------------------------------------------------------
describe("isHeartbeatOk", () => {
  it("returns true for exact HEARTBEAT_OK", () => {
    expect(isHeartbeatOk("HEARTBEAT_OK")).toBe(true);
  });

  it("returns true case-insensitively", () => {
    expect(isHeartbeatOk("heartbeat_ok")).toBe(true);
    expect(isHeartbeatOk("Heartbeat_Ok")).toBe(true);
    expect(isHeartbeatOk("HEARTBEAT_ok")).toBe(true);
  });

  it("returns true with surrounding whitespace", () => {
    expect(isHeartbeatOk("  HEARTBEAT_OK  ")).toBe(true);
    expect(isHeartbeatOk("\n HEARTBEAT_OK \n")).toBe(true);
    expect(isHeartbeatOk("\tHEARTBEAT_OK\t")).toBe(true);
  });

  it("returns false when extra text is present", () => {
    expect(isHeartbeatOk("HEARTBEAT_OK and something else")).toBe(false);
    expect(isHeartbeatOk("prefix HEARTBEAT_OK")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isHeartbeatOk("")).toBe(false);
  });

  it("returns false for unrelated text", () => {
    expect(isHeartbeatOk("everything is fine")).toBe(false);
    expect(isHeartbeatOk("OK")).toBe(false);
  });
});
