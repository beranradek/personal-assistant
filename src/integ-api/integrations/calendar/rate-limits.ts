/**
 * Google Calendar API rate limit configuration.
 *
 * Quota docs: https://developers.google.com/calendar/api/guides/quota
 * - Default: 1,000,000 queries/day (not a practical constraint)
 * - Per-user rate limit: ~60 requests/minute as a safe operating threshold
 *
 * We use 60 req/min as the outbound limit per user to stay comfortably
 * within Google's undocumented per-user throttle and avoid 429 responses.
 */

import type { RateLimits } from "../../types.js";

/** Calendar API quota: 60 requests per minute per user. */
export const CALENDAR_RATE_LIMITS: RateLimits = {
  requestsPerMinute: 60,
};
