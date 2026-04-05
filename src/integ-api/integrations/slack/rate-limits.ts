/**
 * Slack API rate limit configuration.
 *
 * Slack rate limits by tier:
 * - Tier 1: 1 req/min
 * - Tier 2: 20 req/min (conversations.list, users.conversations)
 * - Tier 3: 50 req/min (conversations.info, conversations.history)
 * - Tier 4: 100 req/min (auth.test, users.info)
 *
 * We use a conservative 40 req/min as a blended limit across all
 * methods to stay within Slack's per-workspace throttle.
 *
 * Docs: https://api.slack.com/docs/rate-limits
 */

import type { RateLimits } from "../../types.js";

/** Slack API quota: 40 requests per minute per workspace (blended). */
export const SLACK_RATE_LIMITS: RateLimits = {
  requestsPerMinute: 40,
};
