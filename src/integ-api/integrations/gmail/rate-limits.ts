/**
 * Gmail API Outbound Rate Limiter
 * ================================
 *
 * Sliding window rate limiter for outbound Gmail API calls.
 *
 * Gmail API quota (per user):
 *   - 60 requests per minute (read quota)
 * Docs: https://developers.google.com/gmail/api/reference/quota
 *
 * On limit exceeded: throws GmailRateLimitError with retryAfterMs.
 */

// ---------------------------------------------------------------------------
// Gmail API rate limit config
// ---------------------------------------------------------------------------

/** Gmail API quota: 60 read requests per minute per user. */
export const GMAIL_REQUESTS_PER_MINUTE = 60;

// ---------------------------------------------------------------------------
// GmailRateLimitError
// ---------------------------------------------------------------------------

export class GmailRateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`Gmail API rate limit exceeded. Retry after ${retryAfterMs}ms.`);
    this.name = "GmailRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

// ---------------------------------------------------------------------------
// OutboundRateLimiter
// ---------------------------------------------------------------------------

export interface OutboundRateLimiter {
  /**
   * Check if a request is allowed. Throws GmailRateLimitError if the limit
   * is exceeded. Otherwise records the request and returns.
   */
  checkAndRecord(): void;
}

/**
 * Create an outbound sliding window rate limiter.
 *
 * @param maxPerMinute - Maximum allowed outbound requests per 60-second window.
 */
export function createOutboundRateLimiter(
  maxPerMinute: number = GMAIL_REQUESTS_PER_MINUTE,
): OutboundRateLimiter {
  const WINDOW_MS = 60_000;
  const timestamps: number[] = [];

  return {
    checkAndRecord(): void {
      const now = Date.now();
      const cutoff = now - WINDOW_MS;

      // Prune timestamps outside the window
      while (timestamps.length > 0 && (timestamps[0] ?? 0) <= cutoff) {
        timestamps.shift();
      }

      if (timestamps.length >= maxPerMinute) {
        const oldestTs = timestamps[0] ?? now;
        const retryAfterMs = Math.max(0, oldestTs + WINDOW_MS - now);
        throw new GmailRateLimitError(retryAfterMs);
      }

      timestamps.push(now);
    },
  };
}
