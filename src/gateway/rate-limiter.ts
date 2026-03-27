/**
 * Gateway Rate Limiter
 * ====================
 *
 * Sliding-window rate limiter keyed by sourceId (user). Tracks request
 * timestamps within a configurable window and rejects messages that exceed
 * the per-user limit, protecting against overload and runaway API costs.
 *
 * Heartbeat messages (source === "heartbeat") are exempt from rate limiting.
 */

import type { Config } from "../core/types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("rate-limiter");

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

export interface RateLimiter {
  /** Check whether the given sourceId is within its rate limit. */
  check(sourceId: string): RateLimitResult;
  /** Clear all recorded timestamps for a user (e.g. after /clear). */
  reset(sourceId: string): void;
  /** Return current request count in the window for a user (for tests / metrics). */
  count(sourceId: string): number;
}

/**
 * Create a sliding-window rate limiter from gateway config.
 */
export function createRateLimiter(config: Config): RateLimiter {
  const { enabled, windowMs, maxRequests } = config.gateway.rateLimiter;

  // Per-user sorted timestamp lists. Entries are removed when the list empties
  // to avoid unbounded growth for users who stop sending messages.
  const windows = new Map<string, number[]>();

  function evict(timestamps: number[], now: number): number[] {
    const cutoff = now - windowMs;
    let start = 0;
    while (start < timestamps.length && timestamps[start]! <= cutoff) {
      start++;
    }
    return start === 0 ? timestamps : timestamps.slice(start);
  }

  return {
    check(sourceId: string): RateLimitResult {
      if (!enabled) return { allowed: true };

      const now = Date.now();
      const current = evict(windows.get(sourceId) ?? [], now);

      if (current.length >= maxRequests) {
        const retryAfterMs = current[0]! + windowMs - now;
        windows.set(sourceId, current);
        log.warn(
          { sourceId, count: current.length, maxRequests, retryAfterMs },
          "rate limit exceeded",
        );
        return { allowed: false, retryAfterMs };
      }

      current.push(now);
      windows.set(sourceId, current);
      return { allowed: true };
    },

    reset(sourceId: string): void {
      windows.delete(sourceId);
    },

    count(sourceId: string): number {
      const now = Date.now();
      const current = evict(windows.get(sourceId) ?? [], now);
      if (current.length === 0) {
        windows.delete(sourceId);
      }
      return current.length;
    },
  };
}
