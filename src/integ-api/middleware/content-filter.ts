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
 * Usage:
 *   const filter = createContentFilter({ redactPatterns, maxBodyLength });
 *   const safeData = filter.filter(responseData);
 *
 * Built-in default patterns (exported for re-use in server wiring):
 *   DEFAULT_REDACT_PATTERNS covers API keys, credit card numbers, and
 *   email-like strings in common sensitive field positions.
 */

import type { Middleware } from "../types.js";

// ---------------------------------------------------------------------------
// Default patterns
// ---------------------------------------------------------------------------

/**
 * Built-in redaction patterns.
 * Used by server.ts when wiring the content filter.
 * Tests that need "no redaction" should pass an empty redactPatterns array.
 *
 * Patterns:
 * - API keys: strings starting with "sk-" followed by 6+ alphanumeric chars
 * - Long hex/alphanumeric tokens: 32+ char strings that look like secrets
 * - Credit card numbers: 13–19 digit sequences (with optional separators)
 */
export const DEFAULT_REDACT_PATTERNS: string[] = [
  // API key style: sk-<alphanumeric> (e.g. OpenAI / Anthropic-style keys)
  "sk-[a-zA-Z0-9]{6,}",
  // Generic long alphanumeric token (32+ chars) — catches most bearer tokens
  "[a-zA-Z0-9]{32,}",
  // Credit card numbers: 13–19 digits, optional spaces or dashes as separators
  "\\b(?:\\d[ -]?){13,18}\\d\\b",
];

// ---------------------------------------------------------------------------
// ContentFilter interface
// ---------------------------------------------------------------------------

export interface ContentFilter {
  /**
   * Filter `data` by applying redaction and truncation rules.
   * Always returns a value that can be serialized as valid JSON.
   */
  filter(data: unknown): unknown;
}

// ---------------------------------------------------------------------------
// Implementation helpers
// ---------------------------------------------------------------------------

/** Compile redactPatterns into RegExp objects (global flag for replaceAll). */
function compilePatterns(patterns: string[]): RegExp[] {
  return patterns.map((p) => {
    try {
      return new RegExp(p, "g");
    } catch (err) {
      throw new Error(`content-filter: invalid redactPattern "${p}": ${(err as Error).message}`);
    }
  });
}

/** Recursively redact all string values in an arbitrary JSON value. */
function redactValue(value: unknown, regexps: RegExp[]): unknown {
  if (typeof value === "string") {
    let result = value;
    for (const re of regexps) {
      re.lastIndex = 0; // reset global regex state
      result = result.replace(re, "[REDACTED]");
    }
    return result;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, regexps));
  }

  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, regexps);
    }
    return out;
  }

  // number, boolean, null — return as-is
  return value;
}

// ---------------------------------------------------------------------------
// createContentFilter
// ---------------------------------------------------------------------------

/**
 * Create a ContentFilter instance.
 *
 * @param config.redactPatterns - Regex pattern strings to apply to string values.
 *   Pass DEFAULT_REDACT_PATTERNS (plus any extras) for production use,
 *   or [] to disable redaction.
 * @param config.maxBodyLength - Maximum allowed serialized response length (bytes).
 *   Responses exceeding this are replaced with a truncation envelope.
 */
export function createContentFilter(config: {
  redactPatterns: string[];
  maxBodyLength: number;
}): ContentFilter {
  const regexps = compilePatterns(config.redactPatterns);
  const maxBodyLength = config.maxBodyLength;

  return {
    filter(data: unknown): unknown {
      // Step 1: Redact sensitive strings
      const redacted = regexps.length > 0 ? redactValue(data, regexps) : data;

      // Step 2: Check serialized length
      // JSON.stringify returns undefined for undefined input (not a string),
      // so guard explicitly to avoid a TypeError on .length below.
      const serialized = JSON.stringify(redacted) ?? "";
      if (serialized.length <= maxBodyLength) {
        return redacted;
      }

      // Truncate: return a structured envelope that is always valid JSON
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

/**
 * Wrap a ContentFilter as an integ-api Middleware.
 *
 * Intercepts `res.json` calls so the filter runs on every response body
 * produced by a route handler, transparently and without changing the
 * handler code.
 */
export function createContentFilterMiddleware(filter: ContentFilter): Middleware {
  return async (req, res, next) => {
    // Intercept res.json to filter response data before it is serialised
    const originalJson = res.json.bind(res);
    res.json = (data: unknown, status?: number) => {
      const filtered = filter.filter(data);
      originalJson(filtered, status);
    };

    await next();
  };
}
