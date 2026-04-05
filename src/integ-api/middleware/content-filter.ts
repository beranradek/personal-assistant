/**
 * Integ-API Content Filter Middleware
 * =====================================
 *
 * Filters integration API responses before they reach the agent:
 *
 * 1. Redaction  — applies regex patterns to all string values in the JSON tree,
 *                 replacing matches with "[REDACTED]".
 * 2. Truncation — if the serialized response exceeds `maxBodyLength` bytes,
 *                 returns a structured truncation envelope instead (always valid JSON).
 *
 * Pattern definitions live in the shared security module
 * (`src/security/content-redaction.ts`). This module handles middleware
 * wrapping and truncation.
 */

import type { Middleware } from "../types.js";
import { redactDeep } from "../../security/content-redaction.js";
export { AGGRESSIVE_PATTERNS as DEFAULT_REDACT_PATTERNS } from "../../security/content-redaction.js";

// ---------------------------------------------------------------------------
// ContentFilter interface
// ---------------------------------------------------------------------------

export interface ContentFilter {
  filter(data: unknown): unknown;
}

// ---------------------------------------------------------------------------
// createContentFilter
// ---------------------------------------------------------------------------

export function createContentFilter(config: {
  redactPatterns: readonly RegExp[];
  maxBodyLength: number;
}): ContentFilter {
  const patterns = config.redactPatterns;
  const maxBodyLength = config.maxBodyLength;

  return {
    filter(data: unknown): unknown {
      const redacted = patterns.length > 0 ? redactDeep(data, patterns) : data;

      const serialized = JSON.stringify(redacted) ?? "";
      if (serialized.length <= maxBodyLength) {
        return redacted;
      }

      return {
        truncated: true,
        originalLength: serialized.length,
        maxBodyLength,
        data: serialized.substring(0, maxBodyLength) + "[...truncated]",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// createContentFilterMiddleware
// ---------------------------------------------------------------------------

export function createContentFilterMiddleware(filter: ContentFilter): Middleware {
  return async (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (data: unknown, status?: number) => {
      const filtered = filter.filter(data);
      originalJson(filtered, status);
    };

    await next();
  };
}
