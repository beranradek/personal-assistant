import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { loadCronStore, saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job-1",
    label: "Test reminder",
    schedule: { type: "cron", expression: "0 9 * * *" },
    payload: { text: "Good morning!" },
    createdAt: "2025-06-15T10:00:00.000Z",
    lastFiredAt: null,
    enabled: true,
    ...overrides,
  };
}

describe("cron store", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-store-test-"));
    storePath = path.join(tmpDir, "data", "cron-jobs.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // loadCronStore
  // -----------------------------------------------------------------------
  describe("loadCronStore", () => {
    it("reads and parses cron-jobs.json", async () => {
      const jobs = [makeJob(), makeJob({ id: "job-2", label: "Second job" })];
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(jobs), "utf-8");

      const loaded = await loadCronStore(storePath);
      expect(loaded).toHaveLength(2);
      expect(loaded[0].id).toBe("job-1");
      expect(loaded[1].id).toBe("job-2");
      expect(loaded[0]).toEqual(jobs[0]);
    });

    it("returns empty jobs array if file doesn't exist", async () => {
      const result = await loadCronStore(
        path.join(tmpDir, "nonexistent", "cron-jobs.json"),
      );
      expect(result).toEqual([]);
    });

    it("handles corrupt file gracefully (returns empty)", async () => {
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, "this is not valid json{{{", "utf-8");

      const result = await loadCronStore(storePath);
      expect(result).toEqual([]);
    });

    it("handles empty file gracefully (returns empty)", async () => {
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, "", "utf-8");

      const result = await loadCronStore(storePath);
      expect(result).toEqual([]);
    });

    it("handles file with non-array JSON gracefully (returns empty)", async () => {
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify({ not: "an array" }), "utf-8");

      const result = await loadCronStore(storePath);
      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // saveCronStore
  // -----------------------------------------------------------------------
  describe("saveCronStore", () => {
    it("writes atomically (tmp + rename)", async () => {
      const jobs = [makeJob()];
      await saveCronStore(storePath, jobs);

      // The file should exist with correct content
      const raw = await fs.readFile(storePath, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual(jobs);

      // No .tmp file should remain
      await expect(fs.stat(storePath + ".tmp")).rejects.toThrow();
    });

    it("creates parent directory if needed", async () => {
      const deepPath = path.join(tmpDir, "a", "b", "c", "cron-jobs.json");
      await saveCronStore(deepPath, [makeJob()]);

      const stat = await fs.stat(deepPath);
      expect(stat.isFile()).toBe(true);
    });

    it("overwrites existing file", async () => {
      const initialJobs = [makeJob({ id: "old" })];
      await saveCronStore(storePath, initialJobs);

      const updatedJobs = [makeJob({ id: "new-1" }), makeJob({ id: "new-2" })];
      await saveCronStore(storePath, updatedJobs);

      const raw = await fs.readFile(storePath, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].id).toBe("new-1");
      expect(parsed[1].id).toBe("new-2");
    });

    it("can save empty array", async () => {
      await saveCronStore(storePath, []);

      const raw = await fs.readFile(storePath, "utf-8");
      expect(JSON.parse(raw)).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Round-trip
  // -----------------------------------------------------------------------
  describe("round-trip", () => {
    it("save then load returns identical data", async () => {
      const jobs: CronJob[] = [
        makeJob({
          id: "rt-1",
          label: "Morning alarm",
          schedule: { type: "cron", expression: "0 7 * * *" },
          payload: { text: "Wake up!" },
        }),
        makeJob({
          id: "rt-2",
          label: "One-shot reminder",
          schedule: { type: "oneshot", iso: "2025-12-25T00:00:00.000Z" },
          payload: { text: "Merry Christmas!" },
          lastFiredAt: "2025-06-15T09:00:00.000Z",
          enabled: false,
        }),
        makeJob({
          id: "rt-3",
          label: "Interval check",
          schedule: { type: "interval", everyMs: 60000 },
          payload: { text: "Check server" },
        }),
      ];

      await saveCronStore(storePath, jobs);
      const loaded = await loadCronStore(storePath);

      expect(loaded).toEqual(jobs);
    });

    it("round-trips empty array", async () => {
      await saveCronStore(storePath, []);
      const loaded = await loadCronStore(storePath);
      expect(loaded).toEqual([]);
    });
  });
});
