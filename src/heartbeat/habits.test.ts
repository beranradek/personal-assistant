import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  loadHabits,
  checkAutoHabits,
  resetDaily,
  markHabit,
  formatHabitStatus,
  parseDetectionCommand,
  type Pillar,
} from "./habits.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLE_HABITS_MD = `---
pillars:
  - id: code-commit
    label: "Code Commit"
    type: auto
    detection_command: "git log --since=today --oneline"
    description: "Committed code today"
  - id: exercise
    label: "Exercise"
    type: manual
    description: "Physical exercise (30+ minutes)"
  - id: reading
    label: "Reading"
    type: manual
    description: "Read a book or long-form article"
---

## Today's Habits — 2026-04-03

- [ ] Code Commit
- [ ] Exercise
- [ ] Reading

## History

`;

const SAMPLE_HABITS_CHECKED = `---
pillars:
  - id: code-commit
    label: "Code Commit"
    type: auto
    detection_command: "git log --since=today --oneline"
    description: "Committed code today"
  - id: exercise
    label: "Exercise"
    type: manual
    description: "Physical exercise (30+ minutes)"
  - id: reading
    label: "Reading"
    type: manual
    description: "Read a book or long-form article"
---

## Today's Habits — 2026-04-03

- [x] Code Commit
- [ ] Exercise
- [x] Reading

## History

`;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "habits-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseDetectionCommand — safe whitelist validation
// ---------------------------------------------------------------------------

describe("parseDetectionCommand", () => {
  it("allows git commands", () => {
    const result = parseDetectionCommand("git log --since=today --oneline");
    expect(result).toEqual({ binary: "git", args: ["log", "--since=today", "--oneline"] });
  });

  it("allows wc, ls, cat, grep, date, stat", () => {
    for (const cmd of ["wc -l file.txt", "ls -la", "cat file", "grep pattern file", "date", "stat file"]) {
      expect(parseDetectionCommand(cmd)).not.toBeNull();
    }
  });

  it("rejects rm command", () => {
    expect(parseDetectionCommand("rm -rf /")).toBeNull();
  });

  it("rejects curl command", () => {
    expect(parseDetectionCommand("curl http://example.com")).toBeNull();
  });

  it("rejects arbitrary shell commands", () => {
    expect(parseDetectionCommand("bash -c 'echo hello'")).toBeNull();
    expect(parseDetectionCommand("sh -c 'cat /etc/passwd'")).toBeNull();
    expect(parseDetectionCommand("python script.py")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(parseDetectionCommand("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadHabits
// ---------------------------------------------------------------------------

describe("loadHabits", () => {
  it("GWT: Given HABITS.md with 3 pillars, When loadHabits is called, Then all pillars and checklist state are returned", async () => {
    await fs.writeFile(path.join(tmpDir, "HABITS.md"), SAMPLE_HABITS_MD, "utf-8");

    const data = await loadHabits(tmpDir);
    expect(data).not.toBeNull();
    expect(data!.pillars).toHaveLength(3);
    expect(data!.pillars[0]).toMatchObject({
      id: "code-commit",
      label: "Code Commit",
      type: "auto",
      detectionCommand: "git log --since=today --oneline",
    });
    expect(data!.pillars[1]).toMatchObject({ id: "exercise", label: "Exercise", type: "manual" });
    expect(data!.pillars[2]).toMatchObject({ id: "reading", label: "Reading", type: "manual" });
    expect(data!.checklist).toEqual({
      "Code Commit": false,
      "Exercise": false,
      "Reading": false,
    });
  });

  it("returns null when HABITS.md does not exist", async () => {
    const result = await loadHabits(tmpDir);
    expect(result).toBeNull();
  });

  it("parses checked items correctly", async () => {
    await fs.writeFile(path.join(tmpDir, "HABITS.md"), SAMPLE_HABITS_CHECKED, "utf-8");
    const data = await loadHabits(tmpDir);
    expect(data!.checklist).toEqual({
      "Code Commit": true,
      "Exercise": false,
      "Reading": true,
    });
  });

  it("returns history section content", async () => {
    const content = SAMPLE_HABITS_MD.replace(
      "## History\n\n",
      "## History\n\n### 2026-04-02\n- [x] Code Commit\n- [ ] Exercise\n- [x] Reading\n\n",
    );
    await fs.writeFile(path.join(tmpDir, "HABITS.md"), content, "utf-8");
    const data = await loadHabits(tmpDir);
    expect(data!.historySection).toContain("2026-04-02");
  });
});

// ---------------------------------------------------------------------------
// checkAutoHabits
// ---------------------------------------------------------------------------

describe("checkAutoHabits", () => {
  const autoPillar: Pillar = {
    id: "code-commit",
    label: "Code Commit",
    type: "auto",
    detectionCommand: "git log --since=today --oneline",
    description: "Committed code today",
  };

  it("GWT: Given a detection command containing rm, When checkAutoHabits validates it, Then command is rejected", async () => {
    const badPillar: Pillar = {
      id: "bad",
      label: "Bad",
      type: "auto",
      detectionCommand: "rm -rf /tmp/test",
      description: "Bad command",
    };
    const results = await checkAutoHabits(tmpDir, [badPillar]);
    // Should return false (rejected, not executed)
    expect(results["bad"]).toBe(false);
  });

  it("GWT: Given a detection command containing curl, When checkAutoHabits validates it, Then command is rejected", async () => {
    const curlPillar: Pillar = {
      id: "curl",
      label: "Curl",
      type: "auto",
      detectionCommand: "curl http://example.com",
      description: "Network check",
    };
    const results = await checkAutoHabits(tmpDir, [curlPillar]);
    expect(results["curl"]).toBe(false);
  });

  it("skips manual pillars", async () => {
    const manualPillar: Pillar = {
      id: "exercise",
      label: "Exercise",
      type: "manual",
      description: "Exercise",
    };
    const results = await checkAutoHabits(tmpDir, [manualPillar]);
    expect(results["exercise"]).toBeUndefined();
  });

  it("GWT: Given date command, When checkAutoHabits runs, Then result reflects non-empty output", async () => {
    const datePillar: Pillar = {
      id: "date-check",
      label: "Date Check",
      type: "auto",
      detectionCommand: "date",
      description: "Date always prints output",
    };
    const results = await checkAutoHabits(tmpDir, [datePillar]);
    expect(results["date-check"]).toBe(true);
  });

  it("returns false when command exits with non-zero (no output)", async () => {
    const failPillar: Pillar = {
      id: "ls-nonexistent",
      label: "LS Nonexistent",
      type: "auto",
      detectionCommand: "ls /nonexistent-path-that-does-not-exist-in-filesystem",
      description: "Ls of non-existent path",
    };
    const results = await checkAutoHabits(tmpDir, [failPillar]);
    expect(results["ls-nonexistent"]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resetDaily
// ---------------------------------------------------------------------------

describe("resetDaily", () => {
  it("GWT: Given yesterday's checklist has entries, When resetDaily runs, Then yesterday is archived and fresh unchecked checklist is created", async () => {
    const yesterday = "2026-04-02";
    const today = "2026-04-03";
    const oldContent = SAMPLE_HABITS_MD.replace("2026-04-03", yesterday);
    const withChecked = oldContent.replace("- [ ] Code Commit", "- [x] Code Commit");
    await fs.writeFile(path.join(tmpDir, "HABITS.md"), withChecked, "utf-8");

    await resetDaily(tmpDir, new Date("2026-04-03T10:00:00Z"));

    const newContent = await fs.readFile(path.join(tmpDir, "HABITS.md"), "utf-8");

    // Today's section has today's date
    expect(newContent).toContain(`## Today's Habits — ${today}`);
    // All pillars are unchecked
    expect(newContent).toContain("- [ ] Code Commit");
    expect(newContent).toContain("- [ ] Exercise");
    expect(newContent).toContain("- [ ] Reading");
    // Yesterday is in history
    expect(newContent).toContain(`### ${yesterday}`);
    expect(newContent).toContain("- [x] Code Commit");
  });

  it("is idempotent — calling twice with the same date does not double-archive", async () => {
    await fs.writeFile(path.join(tmpDir, "HABITS.md"), SAMPLE_HABITS_MD, "utf-8");
    const today = new Date("2026-04-03T10:00:00Z");

    await resetDaily(tmpDir, today);
    const afterFirst = await fs.readFile(path.join(tmpDir, "HABITS.md"), "utf-8");

    await resetDaily(tmpDir, today);
    const afterSecond = await fs.readFile(path.join(tmpDir, "HABITS.md"), "utf-8");

    expect(afterFirst).toBe(afterSecond);
  });

  it("handles placeholder {{DATE}} by replacing with real date", async () => {
    const templateContent = SAMPLE_HABITS_MD.replace("2026-04-03", "{{DATE}}");
    await fs.writeFile(path.join(tmpDir, "HABITS.md"), templateContent, "utf-8");

    await resetDaily(tmpDir, new Date("2026-04-03T10:00:00Z"));

    const content = await fs.readFile(path.join(tmpDir, "HABITS.md"), "utf-8");
    expect(content).toContain("## Today's Habits — 2026-04-03");
    expect(content).not.toContain("{{DATE}}");
  });

  it("does nothing when HABITS.md does not exist", async () => {
    // Should not throw
    await expect(resetDaily(tmpDir, new Date("2026-04-03T10:00:00Z"))).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// markHabit
// ---------------------------------------------------------------------------

describe("markHabit", () => {
  it("GWT: Given habit_check is called with pillar=Exercise done=true, When HABITS.md is read, Then Exercise is checked", async () => {
    await fs.writeFile(path.join(tmpDir, "HABITS.md"), SAMPLE_HABITS_MD, "utf-8");

    await markHabit(tmpDir, "Exercise", true);

    const content = await fs.readFile(path.join(tmpDir, "HABITS.md"), "utf-8");
    expect(content).toContain("- [x] Exercise");
    // Other pillars unchanged
    expect(content).toContain("- [ ] Code Commit");
    expect(content).toContain("- [ ] Reading");
  });

  it("marks a habit as undone", async () => {
    await fs.writeFile(path.join(tmpDir, "HABITS.md"), SAMPLE_HABITS_CHECKED, "utf-8");

    await markHabit(tmpDir, "Code Commit", false);

    const content = await fs.readFile(path.join(tmpDir, "HABITS.md"), "utf-8");
    expect(content).toContain("- [ ] Code Commit");
    // Reading still checked
    expect(content).toContain("- [x] Reading");
  });

  it("does nothing when HABITS.md does not exist", async () => {
    await expect(markHabit(tmpDir, "Exercise", true)).resolves.toBeUndefined();
  });

  it("does nothing when pillar label is not found", async () => {
    await fs.writeFile(path.join(tmpDir, "HABITS.md"), SAMPLE_HABITS_MD, "utf-8");
    const before = await fs.readFile(path.join(tmpDir, "HABITS.md"), "utf-8");

    await markHabit(tmpDir, "NonExistentPillar", true);

    const after = await fs.readFile(path.join(tmpDir, "HABITS.md"), "utf-8");
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// formatHabitStatus
// ---------------------------------------------------------------------------

describe("formatHabitStatus", () => {
  const pillars: Pillar[] = [
    { id: "code-commit", label: "Code Commit", type: "auto", description: "Committed" },
    { id: "exercise", label: "Exercise", type: "manual", description: "Exercise" },
    { id: "reading", label: "Reading", type: "manual", description: "Reading" },
  ];

  it("GWT: Unit test formatHabitStatus output format", () => {
    const checklist = { "Code Commit": true, "Exercise": false, "Reading": true };
    const status = formatHabitStatus(checklist, pillars);
    expect(status).toBe("[x] Code Commit  [ ] Exercise  [x] Reading");
  });

  it("returns all unchecked when checklist is empty", () => {
    const status = formatHabitStatus({}, pillars);
    expect(status).toBe("[ ] Code Commit  [ ] Exercise  [ ] Reading");
  });

  it("returns all checked when all done", () => {
    const checklist = { "Code Commit": true, "Exercise": true, "Reading": true };
    const status = formatHabitStatus(checklist, pillars);
    expect(status).toBe("[x] Code Commit  [x] Exercise  [x] Reading");
  });

  it("returns empty string for no pillars", () => {
    const status = formatHabitStatus({}, []);
    expect(status).toBe("");
  });
});

// ---------------------------------------------------------------------------
// config.habits.enabled=false gate (integration level)
// ---------------------------------------------------------------------------

describe("habits enabled guard", () => {
  it("GWT: Given config.habits.enabled is false, When heartbeat fires, the habits functions still work independently (guard is in the caller)", async () => {
    // habits.ts functions are pure utilities — the enabled guard is in the caller (prompts.ts / daemon.ts)
    // This test verifies that the functions work correctly in isolation
    await fs.writeFile(path.join(tmpDir, "HABITS.md"), SAMPLE_HABITS_MD, "utf-8");
    const data = await loadHabits(tmpDir);
    expect(data).not.toBeNull();
  });
});
