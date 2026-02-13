import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CronJob } from "./types.js";
import { nextRunAt, armTimer } from "./timer.js";

function makeJob(overrides: Partial<CronJob> & Record<string, unknown> = {}): CronJob {
  return {
    id: "job-1",
    label: "Test job",
    schedule: { type: "cron", expression: "0 9 * * *" },
    payload: { text: "Hello!" },
    createdAt: "2025-06-15T10:00:00.000Z",
    lastFiredAt: null,
    enabled: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// nextRunAt
// ---------------------------------------------------------------------------
describe("nextRunAt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T08:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calculates correct next fire time for cron expression", () => {
    const job = makeJob({
      schedule: { type: "cron", expression: "0 9 * * *" }, // daily at 09:00 UTC
    });

    const next = nextRunAt(job);
    expect(next).toBeInstanceOf(Date);
    // Current time is 08:00 UTC on June 15, so next 09:00 is same day
    expect(next!.toISOString()).toBe("2025-06-15T09:00:00.000Z");
  });

  it("for one-shot returns the specified ISO time", () => {
    const job = makeJob({
      schedule: { type: "oneshot", iso: "2025-06-20T12:00:00.000Z" },
    });

    const next = nextRunAt(job);
    expect(next).toBeInstanceOf(Date);
    expect(next!.toISOString()).toBe("2025-06-20T12:00:00.000Z");
  });

  it("for one-shot returns null if time is already past", () => {
    const job = makeJob({
      schedule: { type: "oneshot", iso: "2025-06-10T12:00:00.000Z" }, // in the past
    });

    const next = nextRunAt(job);
    expect(next).toBeNull();
  });

  it("for interval calculates next based on lastFiredAt + everyMs", () => {
    const job = makeJob({
      schedule: { type: "interval", everyMs: 60_000 }, // every 60 seconds
      lastFiredAt: "2025-06-15T07:59:00.000Z",
    });

    const next = nextRunAt(job);
    expect(next).toBeInstanceOf(Date);
    // lastFiredAt + 60s = 08:00:00, which is exactly "now"
    expect(next!.toISOString()).toBe("2025-06-15T08:00:00.000Z");
  });

  it("for interval uses createdAt when lastFiredAt is null", () => {
    const job = makeJob({
      schedule: { type: "interval", everyMs: 3_600_000 }, // every hour
      createdAt: "2025-06-15T07:00:00.000Z",
      lastFiredAt: null,
    });

    const next = nextRunAt(job);
    expect(next).toBeInstanceOf(Date);
    // createdAt + 1 hour = 08:00:00
    expect(next!.toISOString()).toBe("2025-06-15T08:00:00.000Z");
  });

  it("returns null for disabled jobs", () => {
    const job = makeJob({ enabled: false });
    expect(nextRunAt(job)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// armTimer
// ---------------------------------------------------------------------------
describe("armTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T08:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets timeout for next due job", () => {
    const job = makeJob({
      schedule: { type: "oneshot", iso: "2025-06-15T08:05:00.000Z" }, // 5 min from now
    });

    const onFire = vi.fn();
    const handle = armTimer([job], onFire);

    // Should not have fired yet
    expect(onFire).not.toHaveBeenCalled();

    // Advance 5 minutes
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(onFire).toHaveBeenCalledTimes(1);

    handle.disarm();
  });

  it("fires correct job when timer expires", () => {
    const job1 = makeJob({
      id: "job-far",
      schedule: { type: "oneshot", iso: "2025-06-15T10:00:00.000Z" }, // 2 hours away
    });
    const job2 = makeJob({
      id: "job-near",
      schedule: { type: "oneshot", iso: "2025-06-15T08:01:00.000Z" }, // 1 minute away
    });

    const onFire = vi.fn();
    armTimer([job1, job2], onFire);

    // Advance 1 minute - only the nearest job should fire
    vi.advanceTimersByTime(60 * 1000);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith(job2);
  });

  it("one-shot jobs with deleteAfterRun: true flag handled", () => {
    // The onFire callback receives the job; caller can inspect deleteAfterRun
    const job = makeJob({
      id: "oneshot-delete",
      schedule: { type: "oneshot", iso: "2025-06-15T08:01:00.000Z" },
      deleteAfterRun: true,
    } as Partial<CronJob> & Record<string, unknown>);

    const onFire = vi.fn();
    armTimer([job], onFire);

    vi.advanceTimersByTime(60 * 1000);
    expect(onFire).toHaveBeenCalledTimes(1);
    const firedJob = onFire.mock.calls[0][0];
    expect(firedJob.id).toBe("oneshot-delete");
    // The caller can check (firedJob as any).deleteAfterRun
    expect((firedJob as Record<string, unknown>).deleteAfterRun).toBe(true);
  });

  it("disabled jobs are skipped", () => {
    const disabledJob = makeJob({
      id: "disabled",
      enabled: false,
      schedule: { type: "oneshot", iso: "2025-06-15T08:01:00.000Z" },
    });
    const enabledJob = makeJob({
      id: "enabled",
      enabled: true,
      schedule: { type: "oneshot", iso: "2025-06-15T08:05:00.000Z" },
    });

    const onFire = vi.fn();
    armTimer([disabledJob, enabledJob], onFire);

    // Advance 1 minute - disabled job should not fire
    vi.advanceTimersByTime(60 * 1000);
    expect(onFire).not.toHaveBeenCalled();

    // Advance 4 more minutes - enabled job fires
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith(enabledJob);
  });

  it("disarmTimer cancels pending timeout", () => {
    const job = makeJob({
      schedule: { type: "oneshot", iso: "2025-06-15T08:05:00.000Z" },
    });

    const onFire = vi.fn();
    const handle = armTimer([job], onFire);

    // Disarm before the timer fires
    handle.disarm();

    // Advance past the scheduled time
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("empty job list is no-op", () => {
    const onFire = vi.fn();
    const handle = armTimer([], onFire);

    // Advance a lot of time - nothing should happen
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(onFire).not.toHaveBeenCalled();

    // Disarm should be safe on no-op handle
    expect(() => handle.disarm()).not.toThrow();
  });
});
