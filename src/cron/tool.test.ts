import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { CronJob } from "./types.js";
import { handleCronAction, createCronToolManager, type CronToolDeps } from "./tool.js";
import { loadCronStore, saveCronStore } from "./store.js";

function makeSchedule() {
  return { type: "cron" as const, expression: "0 9 * * *" };
}

function makePayload() {
  return { text: "Good morning!" };
}

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job-1",
    label: "Test reminder",
    schedule: makeSchedule(),
    payload: makePayload(),
    createdAt: "2025-06-15T10:00:00.000Z",
    lastFiredAt: null,
    enabled: true,
    ...overrides,
  };
}

describe("handleCronAction", () => {
  let tmpDir: string;
  let storePath: string;
  let deps: CronToolDeps;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-tool-test-"));
    storePath = path.join(tmpDir, "data", "cron-jobs.json");
    deps = { storePath };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // add
  // -------------------------------------------------------------------------
  describe("add action", () => {
    it("creates a new job with UUID id and persists it", async () => {
      const result = await handleCronAction(
        "add",
        {
          label: "Morning alarm",
          schedule: { type: "cron", expression: "0 7 * * *" },
          payload: { text: "Wake up!" },
        },
        deps,
      );

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/added|created/i);
      expect(result.data).toBeDefined();

      // The returned data should contain a UUID-style id
      const job = result.data as CronJob;
      expect(job.id).toBeDefined();
      expect(typeof job.id).toBe("string");
      expect(job.id.length).toBeGreaterThan(0);
      expect(job.label).toBe("Morning alarm");
      expect(job.schedule).toEqual({ type: "cron", expression: "0 7 * * *" });
      expect(job.payload).toEqual({ text: "Wake up!" });
      expect(job.enabled).toBe(true);
      expect(job.createdAt).toBeDefined();
      expect(job.lastFiredAt).toBeNull();

      // Verify persisted
      const persisted = await loadCronStore(storePath);
      expect(persisted).toHaveLength(1);
      expect(persisted[0].id).toBe(job.id);
    });

    it("returns error if label is missing", async () => {
      const result = await handleCronAction(
        "add",
        {
          schedule: makeSchedule(),
          payload: makePayload(),
        },
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/label/i);
    });

    it("returns error if schedule is missing", async () => {
      const result = await handleCronAction(
        "add",
        {
          label: "Test",
          payload: makePayload(),
        },
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/schedule/i);
    });

    it("returns error if payload is missing", async () => {
      const result = await handleCronAction(
        "add",
        {
          label: "Test",
          schedule: makeSchedule(),
        },
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/payload/i);
    });
  });

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------
  describe("list action", () => {
    it("returns all jobs", async () => {
      // Pre-populate store
      const jobs = [
        makeJob({ id: "j1", label: "Job 1" }),
        makeJob({ id: "j2", label: "Job 2" }),
      ];
      await saveCronStore(storePath, jobs);

      const result = await handleCronAction("list", {}, deps);

      expect(result.success).toBe(true);
      const data = result.data as CronJob[];
      expect(data).toHaveLength(2);
      expect(data[0].id).toBe("j1");
      expect(data[1].id).toBe("j2");
    });

    it("returns empty array when no jobs exist", async () => {
      const result = await handleCronAction("list", {}, deps);

      expect(result.success).toBe(true);
      const data = result.data as CronJob[];
      expect(data).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------
  describe("update action", () => {
    it("modifies an existing job", async () => {
      const jobs = [makeJob({ id: "u1", label: "Old label" })];
      await saveCronStore(storePath, jobs);

      const result = await handleCronAction(
        "update",
        { id: "u1", label: "New label" },
        deps,
      );

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/updated/i);

      const persisted = await loadCronStore(storePath);
      expect(persisted).toHaveLength(1);
      expect(persisted[0].label).toBe("New label");
      // Unchanged fields remain
      expect(persisted[0].schedule).toEqual(makeSchedule());
    });

    it("can update schedule, payload, and enabled", async () => {
      const jobs = [makeJob({ id: "u2" })];
      await saveCronStore(storePath, jobs);

      const newSchedule = { type: "interval" as const, everyMs: 30000 };
      const newPayload = { text: "Updated text" };

      const result = await handleCronAction(
        "update",
        {
          id: "u2",
          schedule: newSchedule,
          payload: newPayload,
          enabled: false,
        },
        deps,
      );

      expect(result.success).toBe(true);

      const persisted = await loadCronStore(storePath);
      expect(persisted[0].schedule).toEqual(newSchedule);
      expect(persisted[0].payload).toEqual(newPayload);
      expect(persisted[0].enabled).toBe(false);
    });

    it("returns error if id is missing", async () => {
      const result = await handleCronAction(
        "update",
        { label: "No id provided" },
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/id/i);
    });

    it("returns error for unknown job ID", async () => {
      const jobs = [makeJob({ id: "exists" })];
      await saveCronStore(storePath, jobs);

      const result = await handleCronAction(
        "update",
        { id: "nonexistent", label: "Won't work" },
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not found/i);
    });
  });

  // -------------------------------------------------------------------------
  // remove
  // -------------------------------------------------------------------------
  describe("remove action", () => {
    it("deletes a job", async () => {
      const jobs = [
        makeJob({ id: "r1", label: "Keep" }),
        makeJob({ id: "r2", label: "Delete" }),
      ];
      await saveCronStore(storePath, jobs);

      const result = await handleCronAction("remove", { id: "r2" }, deps);

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/removed|deleted/i);

      const persisted = await loadCronStore(storePath);
      expect(persisted).toHaveLength(1);
      expect(persisted[0].id).toBe("r1");
    });

    it("returns error if id is missing", async () => {
      const result = await handleCronAction("remove", {}, deps);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/id/i);
    });

    it("returns error for unknown job ID", async () => {
      const jobs = [makeJob({ id: "exists" })];
      await saveCronStore(storePath, jobs);

      const result = await handleCronAction(
        "remove",
        { id: "nonexistent" },
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not found/i);
    });
  });

  // -------------------------------------------------------------------------
  // invalid action
  // -------------------------------------------------------------------------
  describe("invalid action", () => {
    it("returns error for unknown action", async () => {
      const result = await handleCronAction("bogus", {}, deps);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/unknown action|invalid action|unsupported/i);
    });
  });
});

// ---------------------------------------------------------------------------
// createCronToolManager
// ---------------------------------------------------------------------------
describe("createCronToolManager", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T08:00:00.000Z"));
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-mgr-test-"));
    storePath = path.join(tmpDir, "data", "cron-jobs.json");
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("handleAction delegates to handleCronAction", async () => {
    const mgr = createCronToolManager({ storePath });

    const result = await mgr.handleAction("add", {
      label: "Test",
      schedule: { type: "cron", expression: "0 9 * * *" },
      payload: { text: "Hi" },
    });

    expect(result.success).toBe(true);

    const listResult = await mgr.handleAction("list", {});
    expect(listResult.success).toBe(true);
    expect((listResult.data as CronJob[]).length).toBe(1);

    mgr.stop();
  });

  it("stop disarms the timer", async () => {
    const mgr = createCronToolManager({ storePath });
    await mgr.rearmTimer();
    // Calling stop should not throw
    expect(() => mgr.stop()).not.toThrow();
  });

  it("rearmTimer loads jobs and arms the timer", async () => {
    // Use real timers for this test since the callback involves real file I/O.
    vi.useRealTimers();

    // Use a oneshot job very slightly in the future so armTimer picks it up.
    // After it fires, nextRunAt will return null (past), preventing re-fire loop.
    const futureIso = new Date(Date.now() + 50).toISOString();
    const job = makeJob({
      id: "timer-test",
      schedule: { type: "oneshot", iso: futureIso },
    });
    await saveCronStore(storePath, [job]);

    const onJobFired = vi.fn();
    const mgr = createCronToolManager({ storePath, onJobFired });
    await mgr.rearmTimer();

    // Wait for the callback chain to complete (real timer + real I/O)
    await vi.waitFor(() => {
      expect(onJobFired).toHaveBeenCalledTimes(1);
    }, { timeout: 3000, interval: 50 });

    expect(onJobFired.mock.calls[0][0].id).toBe("timer-test");

    mgr.stop();
  });
});
