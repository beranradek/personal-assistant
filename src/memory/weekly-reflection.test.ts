import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  getISOWeek,
  getISOWeekYear,
  getWeekIdentifier,
  getLastWeekIdentifier,
  getWeekDateRange,
  collectDailyReflectionsForWeek,
  cleanupOldDailyReflections,
  runWeeklyReflection,
  WEEKLY_REFLECTION_PROMPT_PATH,
} from "./weekly-reflection.js";
import type { Config } from "../core/types.js";
import { ConfigSchema } from "../core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Config["reflection"]> = {}): Config {
  return ConfigSchema.parse({
    security: {
      allowedCommands: [],
      commandsNeedingExtraValidation: [],
      workspace: "/tmp/test-workspace",
      dataDir: "/tmp/test-data",
      additionalReadDirs: [],
      additionalWriteDirs: [],
    },
    adapters: {
      telegram: { enabled: false, botToken: "x", allowedUserIds: [] },
      slack: {
        enabled: false,
        botToken: "x",
        appToken: "x",
        allowedUserIds: [],
        socketMode: false,
      },
    },
    heartbeat: {
      enabled: false,
      intervalMinutes: 30,
      activeHours: "8-22",
      deliverTo: "last",
    },
    gateway: { maxQueueSize: 10 },
    agent: { model: null, maxTurns: 5 },
    session: {
      maxHistoryMessages: 50,
      compactionEnabled: false,
      summarizationEnabled: true,
    },
    memory: {
      search: {
        enabled: false,
        hybridWeights: { vector: 0.7, keyword: 0.3 },
        minScore: 0.1,
        maxResults: 10,
        chunkTokens: 200,
        chunkOverlap: 50,
      },
      extraPaths: [],
    },
    mcpServers: {},
    codex: {},
    reflection: {
      enabled: true,
      schedule: "0 7 * * *",
      maxDailyLogEntries: 500,
      weeklyEnabled: true,
      weeklySchedule: "5 7 * * 1",
      ...overrides,
    },
  });
}

// ---------------------------------------------------------------------------
// ISO week helpers
// ---------------------------------------------------------------------------

describe("getISOWeek", () => {
  it("returns correct week for a known date", () => {
    // 2026-01-05 is in week 2 of 2026
    expect(getISOWeek(new Date("2026-01-05"))).toBe(2);
  });

  it("returns week 1 for Jan 4 (always in week 1)", () => {
    expect(getISOWeek(new Date("2026-01-04"))).toBe(1);
  });

  it("handles year-boundary — Dec 28 is in the last week of its year", () => {
    // 2025-12-28 is a Sunday; ISO week 52 of 2025
    const w = getISOWeek(new Date("2025-12-28"));
    expect(w).toBeGreaterThanOrEqual(52);
  });
});

describe("getWeekIdentifier", () => {
  it("returns YYYY-Www formatted string", () => {
    const id = getWeekIdentifier(new Date("2026-04-07")); // Tuesday
    expect(id).toMatch(/^\d{4}-W\d{2}$/);
  });

  it("pads single-digit weeks with a leading zero", () => {
    // 2026-01-05 is week 2 — single digit
    const id = getWeekIdentifier(new Date("2026-01-05"));
    expect(id).toBe("2026-W02");
  });
});

describe("getLastWeekIdentifier", () => {
  it("returns the identifier for the week 7 days before now", () => {
    const now = new Date("2026-04-08"); // Wednesday, week 15
    const last = getLastWeekIdentifier(now);
    // 7 days before → 2026-04-01 → week 14
    expect(last).toBe("2026-W14");
  });
});

describe("getWeekDateRange", () => {
  it("returns Monday and Sunday for a given week ID", () => {
    const { start, end } = getWeekDateRange("2026-W14");
    // Week 14 of 2026: Mon 2026-03-30, Sun 2026-04-05
    expect(start).toBe("2026-03-30");
    expect(end).toBe("2026-04-05");
  });

  it("throws on invalid week ID format", () => {
    expect(() => getWeekDateRange("2026-14")).toThrow();
  });

  it("start is always a Monday (day 1 in getDay)", () => {
    const { start } = getWeekDateRange("2026-W10");
    expect(new Date(start + "T12:00:00Z").getUTCDay()).toBe(1); // Monday
  });

  it("end is always a Sunday (day 0 in getDay)", () => {
    const { end } = getWeekDateRange("2026-W10");
    expect(new Date(end + "T12:00:00Z").getUTCDay()).toBe(0); // Sunday
  });
});

// ---------------------------------------------------------------------------
// collectDailyReflectionsForWeek
// ---------------------------------------------------------------------------

describe("collectDailyReflectionsForWeek", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "weekly-test-"));
    await fs.mkdir(path.join(tmpDir, "memory"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns files whose date falls within the range", async () => {
    await fs.writeFile(path.join(tmpDir, "memory", "reflection-2026-03-30.md"), "# Mon");
    await fs.writeFile(path.join(tmpDir, "memory", "reflection-2026-04-01.md"), "# Wed");
    await fs.writeFile(path.join(tmpDir, "memory", "reflection-2026-04-05.md"), "# Sun");

    const files = await collectDailyReflectionsForWeek(tmpDir, "2026-03-30", "2026-04-05");
    expect(files).toHaveLength(3);
    expect(files.every((f) => f.includes("reflection-2026-0"))).toBe(true);
  });

  it("excludes files outside the range", async () => {
    await fs.writeFile(path.join(tmpDir, "memory", "reflection-2026-03-29.md"), "# before");
    await fs.writeFile(path.join(tmpDir, "memory", "reflection-2026-04-06.md"), "# after");
    await fs.writeFile(path.join(tmpDir, "memory", "reflection-2026-03-31.md"), "# inside");

    const files = await collectDailyReflectionsForWeek(tmpDir, "2026-03-30", "2026-04-05");
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("2026-03-31");
  });

  it("ignores non-reflection md files", async () => {
    await fs.writeFile(path.join(tmpDir, "memory", "weekly-2026-W13.md"), "# weekly");
    await fs.writeFile(path.join(tmpDir, "memory", "MEMORY.md"), "# memory");

    const files = await collectDailyReflectionsForWeek(tmpDir, "2026-03-30", "2026-04-05");
    expect(files).toHaveLength(0);
  });

  it("returns empty array when memory/ directory does not exist", async () => {
    const files = await collectDailyReflectionsForWeek("/nonexistent/path", "2026-03-30", "2026-04-05");
    expect(files).toHaveLength(0);
  });

  it("returns files in chronological order", async () => {
    await fs.writeFile(path.join(tmpDir, "memory", "reflection-2026-04-03.md"), "# Fri");
    await fs.writeFile(path.join(tmpDir, "memory", "reflection-2026-03-31.md"), "# Tue");
    await fs.writeFile(path.join(tmpDir, "memory", "reflection-2026-04-01.md"), "# Wed");

    const files = await collectDailyReflectionsForWeek(tmpDir, "2026-03-30", "2026-04-05");
    const basenames = files.map((f) => path.basename(f));
    expect(basenames).toEqual([
      "reflection-2026-03-31.md",
      "reflection-2026-04-01.md",
      "reflection-2026-04-03.md",
    ]);
  });
});

// ---------------------------------------------------------------------------
// cleanupOldDailyReflections
// ---------------------------------------------------------------------------

describe("cleanupOldDailyReflections", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-test-"));
    await fs.mkdir(path.join(tmpDir, "memory"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("does nothing when retentionDays is 0", async () => {
    await fs.writeFile(path.join(tmpDir, "memory", "reflection-2020-01-01.md"), "old");
    await cleanupOldDailyReflections(tmpDir, 0);
    const files = await fs.readdir(path.join(tmpDir, "memory"));
    expect(files).toHaveLength(1);
  });

  it("deletes files older than retentionDays", async () => {
    const today = new Date();
    const old = new Date(today);
    old.setDate(old.getDate() - 30);
    const oldDate = old.toISOString().slice(0, 10);

    await fs.writeFile(path.join(tmpDir, "memory", `reflection-${oldDate}.md`), "old");
    await cleanupOldDailyReflections(tmpDir, 21);

    const files = await fs.readdir(path.join(tmpDir, "memory"));
    expect(files).toHaveLength(0);
  });

  it("keeps files within retentionDays", async () => {
    const today = new Date();
    const recent = new Date(today);
    recent.setDate(recent.getDate() - 5);
    const recentDate = recent.toISOString().slice(0, 10);

    await fs.writeFile(path.join(tmpDir, "memory", `reflection-${recentDate}.md`), "recent");
    await cleanupOldDailyReflections(tmpDir, 21);

    const files = await fs.readdir(path.join(tmpDir, "memory"));
    expect(files).toHaveLength(1);
  });

  it("does not delete weekly files or MEMORY.md", async () => {
    await fs.writeFile(path.join(tmpDir, "memory", "weekly-2020-W01.md"), "weekly");
    await fs.writeFile(path.join(tmpDir, "memory", "MEMORY.md"), "memory");
    await cleanupOldDailyReflections(tmpDir, 21);
    const files = await fs.readdir(path.join(tmpDir, "memory"));
    expect(files).toHaveLength(2);
  });

  it("silently returns when memory/ directory does not exist", async () => {
    await expect(
      cleanupOldDailyReflections("/nonexistent/path", 21),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runWeeklyReflection
// ---------------------------------------------------------------------------

describe("runWeeklyReflection", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "weekly-run-test-"));
    await fs.mkdir(path.join(tmpDir, "memory"), { recursive: true });
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("skips when reflection.weeklyEnabled is false", async () => {
    const config = makeConfig({ weeklyEnabled: false });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await runWeeklyReflection(config, tmpDir);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips when reflection.enabled is false", async () => {
    const config = makeConfig({ enabled: false });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await runWeeklyReflection(config, tmpDir);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips when no daily reflection files exist for last week", async () => {
    const config = makeConfig();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await runWeeklyReflection(config, tmpDir);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips when weekly file already exists (idempotent)", async () => {
    const config = makeConfig();
    // Determine last week id using same logic as implementation
    const { getLastWeekIdentifier: getLast } = await import("./weekly-reflection.js");
    const weekId = getLast();
    await fs.writeFile(path.join(tmpDir, "memory", `weekly-${weekId}.md`), "# existing");

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await runWeeklyReflection(config, tmpDir);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("writes weekly file when LLM returns content", async () => {
    const config = makeConfig();

    // Create a daily reflection file for last week
    const now = new Date();
    const lastWeek = new Date(now);
    lastWeek.setDate(lastWeek.getDate() - 7);
    const lastWeekDate = lastWeek.toISOString().slice(0, 10);
    await fs.writeFile(
      path.join(tmpDir, "memory", `reflection-${lastWeekDate}.md`),
      "---\ndate: " + lastWeekDate + "\n---\n\n## Decisions\n\n- Used PostgreSQL\n",
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "## Key Decisions\n\n- Used PostgreSQL for the project\n" }],
      }),
    } as Response);

    await runWeeklyReflection(config, tmpDir);

    const weekId = getLastWeekIdentifier();
    const outputPath = path.join(tmpDir, "memory", `weekly-${weekId}.md`);
    const written = await fs.readFile(outputPath, "utf-8");

    expect(written).toContain(`week: ${weekId}`);
    expect(written).toContain("Key Decisions");
    expect(written).toContain("PostgreSQL");
  });

  it("skips writing when LLM returns sentinel '(nothing to extract)'", async () => {
    const config = makeConfig();

    const now = new Date();
    const lastWeek = new Date(now);
    lastWeek.setDate(lastWeek.getDate() - 7);
    const lastWeekDate = lastWeek.toISOString().slice(0, 10);
    await fs.writeFile(
      path.join(tmpDir, "memory", `reflection-${lastWeekDate}.md`),
      "## Decisions\n\n- Something\n",
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "(nothing to extract)" }],
      }),
    } as Response);

    await runWeeklyReflection(config, tmpDir);

    const weekId = getLastWeekIdentifier();
    const files = await fs.readdir(path.join(tmpDir, "memory"));
    expect(files.some((f) => f.startsWith("weekly-"))).toBe(false);
  });

  it("is non-fatal when LLM call fails", async () => {
    const config = makeConfig();

    const now = new Date();
    const lastWeek = new Date(now);
    lastWeek.setDate(lastWeek.getDate() - 7);
    const lastWeekDate = lastWeek.toISOString().slice(0, 10);
    await fs.writeFile(
      path.join(tmpDir, "memory", `reflection-${lastWeekDate}.md`),
      "## Decisions\n\n- Something\n",
    );

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network error"));

    await expect(runWeeklyReflection(config, tmpDir)).resolves.toBeUndefined();
  });
});
