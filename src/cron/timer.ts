import { CronExpressionParser } from "cron-parser";
import { createLogger } from "../core/logger.js";
import type { CronJob } from "./types.js";

const log = createLogger("cron-timer");

/** Max safe setTimeout delay (~24.8 days). Values above this overflow to 1ms in Node. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Calculate the next fire time for a cron job.
 * Returns null if the job is disabled or has no valid next run time.
 */
export function nextRunAt(job: CronJob): Date | null {
  if (!job.enabled) return null;

  const schedule = job.schedule;
  switch (schedule.type) {
    case "cron": {
      try {
        const expr = CronExpressionParser.parse(schedule.expression, {
          currentDate: new Date(),
          tz: "UTC",
        });
        return expr.next().toDate();
      } catch {
        // Invalid cron expression
        return null;
      }
    }
    case "oneshot": {
      const target = new Date(schedule.iso);
      if (target <= new Date()) return null;
      return target;
    }
    case "interval": {
      const lastFired = job.lastFiredAt
        ? new Date(job.lastFiredAt)
        : new Date(job.createdAt);
      return new Date(lastFired.getTime() + schedule.everyMs);
    }
  }
}

/**
 * Handle returned by armTimer, allowing the caller to cancel the pending timeout.
 */
export interface CronTimerHandle {
  disarm(): void;
}

/**
 * Arm a timer that fires the onFire callback for the next due job.
 * Only the single nearest job is scheduled; after it fires the caller
 * should re-arm for the next cycle.
 */
export function armTimer(
  jobs: CronJob[],
  onFire: (job: CronJob) => void | Promise<void>,
): CronTimerHandle {
  // Find the job with the earliest nextRunAt
  let earliest: { job: CronJob; runAt: Date } | null = null;

  for (const job of jobs) {
    const runAt = nextRunAt(job);
    if (runAt && (!earliest || runAt < earliest.runAt)) {
      earliest = { job, runAt };
    }
  }

  if (!earliest) {
    return { disarm() {} };
  }

  const rawDelay = Math.max(0, earliest.runAt.getTime() - Date.now());
  const delay = Math.min(rawDelay, MAX_TIMEOUT_MS);
  const { job } = earliest;

  const timer = setTimeout(() => {
    Promise.resolve(onFire(job)).catch((err) => {
      log.error({ err, jobId: job.id, label: job.label }, "Cron job onFire callback failed");
    });
  }, delay);

  return {
    disarm() {
      clearTimeout(timer);
    },
  };
}
