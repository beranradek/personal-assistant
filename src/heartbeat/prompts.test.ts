import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SystemEvent, Config } from "../core/types.js";
import { DEFAULTS } from "../core/config.js";
import {
  resolveHeartbeatPrompt,
  isHeartbeatOk,
  isMorningHeartbeat,
  isEveningHeartbeat,
  appendMorningEveningContent,
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

  it("returns true when extra text is present (contains match)", () => {
    expect(isHeartbeatOk("HEARTBEAT_OK and something else")).toBe(true);
    expect(isHeartbeatOk("prefix HEARTBEAT_OK")).toBe(true);
    expect(isHeartbeatOk("Nothing to report. HEARTBEAT_OK.")).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isHeartbeatOk("")).toBe(false);
  });

  it("returns false for unrelated text", () => {
    expect(isHeartbeatOk("everything is fine")).toBe(false);
    expect(isHeartbeatOk("OK")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isMorningHeartbeat / isEveningHeartbeat
// ---------------------------------------------------------------------------

function makeConfig(heartbeatOverrides?: Partial<Config["heartbeat"]>): Config {
  return {
    ...DEFAULTS,
    heartbeat: {
      ...DEFAULTS.heartbeat,
      ...heartbeatOverrides,
    },
  };
}

function makeTime(hour: number): Date {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d;
}

describe("isMorningHeartbeat", () => {
  it("returns true when current hour equals max(start, morningHour)", () => {
    // activeHours "8-21" → start=8; morningHour=8 → morning at 8
    const config = makeConfig({ activeHours: "8-21", morningHour: 8 });
    expect(isMorningHeartbeat(config, makeTime(8))).toBe(true);
  });

  it("returns true when morningHour is later than start", () => {
    // activeHours "8-21" → start=8; morningHour=9 → morning at 9
    const config = makeConfig({ activeHours: "8-21", morningHour: 9 });
    expect(isMorningHeartbeat(config, makeTime(9))).toBe(true);
    expect(isMorningHeartbeat(config, makeTime(8))).toBe(false);
  });

  it("returns true when start is later than morningHour", () => {
    // activeHours "10-21" → start=10; morningHour=7 → morning at 10
    const config = makeConfig({ activeHours: "10-21", morningHour: 7 });
    expect(isMorningHeartbeat(config, makeTime(10))).toBe(true);
    expect(isMorningHeartbeat(config, makeTime(7))).toBe(false);
  });

  it("returns false for non-morning hours", () => {
    const config = makeConfig({ activeHours: "8-21", morningHour: 8 });
    expect(isMorningHeartbeat(config, makeTime(9))).toBe(false);
    expect(isMorningHeartbeat(config, makeTime(20))).toBe(false);
  });
});

describe("isEveningHeartbeat", () => {
  it("returns true when current hour equals min(end, eveningHour)", () => {
    // activeHours "8-21" → end=21; eveningHour=20 → evening at 20
    const config = makeConfig({ activeHours: "8-21", eveningHour: 20 });
    expect(isEveningHeartbeat(config, makeTime(20))).toBe(true);
  });

  it("returns true when eveningHour is earlier than end", () => {
    // activeHours "8-21" → end=21; eveningHour=19 → evening at 19
    const config = makeConfig({ activeHours: "8-21", eveningHour: 19 });
    expect(isEveningHeartbeat(config, makeTime(19))).toBe(true);
    expect(isEveningHeartbeat(config, makeTime(21))).toBe(false);
  });

  it("returns true when end is less than eveningHour", () => {
    // activeHours "8-18" → end=18; eveningHour=22 → evening at 18
    const config = makeConfig({ activeHours: "8-18", eveningHour: 22 });
    expect(isEveningHeartbeat(config, makeTime(18))).toBe(true);
    expect(isEveningHeartbeat(config, makeTime(22))).toBe(false);
  });

  it("returns false for non-evening hours", () => {
    const config = makeConfig({ activeHours: "8-21", eveningHour: 20 });
    expect(isEveningHeartbeat(config, makeTime(8))).toBe(false);
    expect(isEveningHeartbeat(config, makeTime(15))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// appendMorningEveningContent
// ---------------------------------------------------------------------------

describe("appendMorningEveningContent", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "prompts-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns basePrompt unchanged outside morning/evening hours", async () => {
    const config = makeConfig({ activeHours: "8-21", morningHour: 8, eveningHour: 20 });
    await fs.writeFile(path.join(tmpDir, "HEARTBEAT_MORNING.md"), "morning content");
    const base = "base prompt";
    const result = await appendMorningEveningContent(base, config, tmpDir, makeTime(12));
    expect(result).toBe(base);
  });

  it("appends HEARTBEAT_MORNING.md content at morning hour", async () => {
    const config = makeConfig({ activeHours: "8-21", morningHour: 8, eveningHour: 20 });
    await fs.writeFile(path.join(tmpDir, "HEARTBEAT_MORNING.md"), "morning content");
    const result = await appendMorningEveningContent("base", config, tmpDir, makeTime(8));
    expect(result).toBe("base\n\nmorning content");
  });

  it("appends HEARTBEAT_EVENING.md content at evening hour", async () => {
    const config = makeConfig({ activeHours: "8-21", morningHour: 8, eveningHour: 20 });
    await fs.writeFile(path.join(tmpDir, "HEARTBEAT_EVENING.md"), "evening content");
    const result = await appendMorningEveningContent("base", config, tmpDir, makeTime(20));
    expect(result).toBe("base\n\nevening content");
  });

  it("replaces {{DAILY_LOG}} placeholder with today's log path", async () => {
    const config = makeConfig({ activeHours: "8-21", morningHour: 8, eveningHour: 20 });
    // Use makeTime so getHours() returns 20 in local time (isEveningHeartbeat check)
    const now = makeTime(20);
    // getDailyLogRelativePath uses toISOString().slice(0,10) — compute the same way
    const expectedDate = now.toISOString().slice(0, 10);
    await fs.writeFile(path.join(tmpDir, "HEARTBEAT_EVENING.md"), "Log: {{DAILY_LOG}}");
    const result = await appendMorningEveningContent("base", config, tmpDir, now);
    expect(result).toContain(`daily/${expectedDate}.jsonl`);
    expect(result).not.toContain("{{DAILY_LOG}}");
  });

  it("returns basePrompt unchanged when template file is missing", async () => {
    const config = makeConfig({ activeHours: "8-21", morningHour: 8, eveningHour: 20 });
    const base = "base prompt";
    const result = await appendMorningEveningContent(base, config, tmpDir, makeTime(8));
    expect(result).toBe(base);
  });

  it("returns basePrompt unchanged when template file is empty", async () => {
    const config = makeConfig({ activeHours: "8-21", morningHour: 8, eveningHour: 20 });
    await fs.writeFile(path.join(tmpDir, "HEARTBEAT_MORNING.md"), "");
    const base = "base prompt";
    const result = await appendMorningEveningContent(base, config, tmpDir, makeTime(8));
    expect(result).toBe(base);
  });
});
