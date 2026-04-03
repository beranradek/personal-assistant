/**
 * Integ-API Inbound Rate Limiter Middleware
 * ==========================================
 *
 * Sliding window rate limiter that protects the integ-api server from
 * excessive request rates. Designed for the current single-caller (PA process)
 * but generalised to support future multi-caller scenarios via per-caller tracking.
 *
 * On limit exceeded: returns HTTP 429 with IntegApiError { error: "rate_limited", retryAfterMs }
 * Counter cleanup: a periodic sweep removes idle caller windows to prevent memory leaks.
 */

import type { Middleware, IntegApiError } from "../types.js";

// ---------------------------------------------------------------------------
// Per-caller sliding window state
// ---------------------------------------------------------------------------

interface CallerWindow {
  /** Timestamps of requests within the current window (ms since epoch). */
  timestamps: number[];
  /** Timer handle for idle cleanup — reset on each request. */
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// createInboundRateLimiter
// ---------------------------------------------------------------------------

/**
 * Create an inbound rate-limiting middleware using a per-caller sliding window.
 *
 * @param maxPerMinute - Maximum allowed requests per 60-second sliding window.
 */
export function createInboundRateLimiter(maxPerMinute: number): Middleware {
  const WINDOW_MS = 60_000; // 1 minute
  /** Per-caller state keyed by caller identifier (e.g., socket remote address). */
  const windows = new Map<string, CallerWindow>();

  /**
   * Derive a caller key from the request.
   * Uses the socket's remote address; falls back to "unknown".
   * In production the only caller is the local PA process so this will
   * always resolve to "127.0.0.1".
   */
  function callerKey(req: { socket?: { remoteAddress?: string } }): string {
    return req.socket?.remoteAddress ?? "unknown";
  }

  /** Prune timestamps outside the sliding window and return the current count. */
  function pruneAndCount(window: CallerWindow, now: number): number {
    const cutoff = now - WINDOW_MS;
    window.timestamps = window.timestamps.filter((t) => t > cutoff);
    return window.timestamps.length;
  }

  /** Schedule idle cleanup for a caller window (5 minutes of inactivity). */
  function scheduleCleanup(key: string, window: CallerWindow): void {
    if (window.cleanupTimer !== undefined) {
      clearTimeout(window.cleanupTimer);
    }
    window.cleanupTimer = setTimeout(() => {
      windows.delete(key);
    }, 5 * 60_000);
    // Allow Node.js to exit even if this timer is still pending
    if (typeof window.cleanupTimer === "object" && "unref" in window.cleanupTimer) {
      (window.cleanupTimer as NodeJS.Timeout).unref();
    }
  }

  return async (req, res, next) => {
    const key = callerKey(req);
    const now = Date.now();

    // Get or create the caller window
    let callerWindow = windows.get(key);
    if (!callerWindow) {
      callerWindow = { timestamps: [] };
      windows.set(key, callerWindow);
    }

    const count = pruneAndCount(callerWindow, now);

    if (count >= maxPerMinute) {
      // Find when the oldest timestamp will leave the window
      const oldestTs = callerWindow.timestamps[0] ?? now;
      const retryAfterMs = oldestTs + WINDOW_MS - now;

      const err: IntegApiError = {
        error: "rate_limited",
        message: `Rate limit exceeded: max ${maxPerMinute} requests per minute.`,
        retryAfterMs: Math.max(0, retryAfterMs),
        service: "integ-api",
      };
      res.error(err);
      scheduleCleanup(key, callerWindow);
      return;
    }

    // Record this request
    callerWindow.timestamps.push(now);
    scheduleCleanup(key, callerWindow);

    await next();
  };
}
