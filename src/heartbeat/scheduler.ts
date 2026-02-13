import cron from "node-cron";
import { createLogger } from "../core/logger.js";
import type { Config } from "../core/types.js";

const log = createLogger("heartbeat");

export function parseActiveHours(spec: string): { start: number; end: number } {
  const [start, end] = spec.split("-").map(Number);
  return { start, end };
}

export function isWithinActiveHours(spec: string, now?: Date): boolean {
  const { start, end } = parseActiveHours(spec);
  const hour = (now ?? new Date()).getHours();
  return hour >= start && hour < end;
}

export interface HeartbeatScheduler {
  stop(): void;
}

export function createHeartbeatScheduler(
  config: Config,
  onHeartbeat: () => void | Promise<void>,
): HeartbeatScheduler {
  if (!config.heartbeat.enabled) {
    return { stop: () => {} };
  }

  const intervalMinutes = config.heartbeat.intervalMinutes;
  // Run every N minutes
  const cronExpression = `*/${intervalMinutes} * * * *`;

  const task = cron.schedule(cronExpression, () => {
    if (!isWithinActiveHours(config.heartbeat.activeHours)) {
      log.debug("Outside active hours, skipping heartbeat");
      return;
    }
    log.info("Heartbeat firing");
    Promise.resolve(onHeartbeat()).catch((err) => {
      log.error({ err }, "Heartbeat callback failed");
    });
  });

  return {
    stop() {
      task.stop();
    },
  };
}
