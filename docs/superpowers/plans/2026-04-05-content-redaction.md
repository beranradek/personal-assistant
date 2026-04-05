# Content Redaction Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared content redaction module that sanitizes sensitive data (tokens, passwords, credentials, Czech-language disclosures) across both the gateway layer and integ-api.

**Architecture:** A new `src/security/content-redaction.ts` module exports two pattern presets (conservative for gateway, aggressive for integ-api) and core redaction functions. The gateway integrates redaction at 5 insertion points via an optional `redact` function parameter. The integ-api's `content-filter.ts` delegates to the shared module, replacing its internal `redactValue` and `DEFAULT_REDACT_PATTERNS`.

**Tech Stack:** TypeScript, Vitest, RegExp

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/security/content-redaction.ts` | Create | Pattern definitions, `redactString()`, `createRedactor()`, `redactDeep()` |
| `src/security/content-redaction.test.ts` | Create | Unit tests for all pattern categories and functions |
| `src/integ-api/middleware/content-filter.ts` | Modify | Import from shared module, remove internal `redactValue`/`compilePatterns`/`DEFAULT_REDACT_PATTERNS` |
| `src/integ-api/middleware/content-filter.test.ts` | Modify | Add tests for aggressive patterns (JWT, Czech, connection strings) |
| `src/integ-api/server.ts` | Modify | Import `DEFAULT_REDACT_PATTERNS` from new location |
| `src/core/agent-runner.ts` | Modify | Accept `redact` param, apply to error events and audit entries |
| `src/session/store.ts` | Modify | Accept `redact` param, apply before JSONL write |
| `src/memory/daily-log.ts` | Modify | Accept `redact` param, apply to audit entry fields |
| `src/gateway/processing-message.ts` | Modify | Accept `redact` param, apply before flush to adapter |
| `src/session/compactor.ts` | Modify | Apply redaction to API error bodies before throwing |
| `src/daemon.ts` | Modify | Create redactor, pass to queue/backend wiring |
| `src/terminal/session.ts` | Modify | Create redactor for terminal backend |
| `src/backends/interface.ts` | Modify | Add optional `redact` to backend options |
| `src/backends/claude.ts` | Modify | Thread `redact` to `streamAgentTurn`/`runAgentTurn` |

---

### Task 1: Create shared content-redaction module

**Files:**
- Create: `src/security/content-redaction.ts`
- Test: `src/security/content-redaction.test.ts`

- [ ] **Step 1: Write the failing test for conservative patterns**

Create `src/security/content-redaction.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  CONSERVATIVE_PATTERNS,
  AGGRESSIVE_PATTERNS,
  redactString,
  createRedactor,
  redactDeep,
} from "./content-redaction.js";

describe("redactString", () => {
  it("returns input unchanged when no patterns match", () => {
    expect(redactString("hello world", CONSERVATIVE_PATTERNS)).toBe("hello world");
  });

  it("redacts Anthropic/OpenAI API keys", () => {
    expect(redactString("key: sk-ant-api03-abcdefghijklmnopqrst", CONSERVATIVE_PATTERNS))
      .toBe("key: [REDACTED]");
  });

  it("redacts publishable keys", () => {
    expect(redactString("pk-live-abcdefghijklmnopqrst", CONSERVATIVE_PATTERNS))
      .toBe("[REDACTED]");
  });

  it("redacts AWS access keys", () => {
    expect(redactString("aws key AKIAIOSFODNN7EXAMPLE", CONSERVATIVE_PATTERNS))
      .toBe("aws key [REDACTED]");
  });

  it("redacts Google API keys", () => {
    expect(redactString("AIzaSyD-abc123_def456-ghi789_jkl012_mnop", CONSERVATIVE_PATTERNS))
      .toBe("[REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    expect(redactString("Authorization: Bearer ya29.a0AfH6SMBx123", CONSERVATIVE_PATTERNS))
      .toMatch(/Authorization: \[REDACTED\]/);
  });

  it("redacts Google access tokens", () => {
    expect(redactString("token ya29.a0AfH6SMBxyz123_456", CONSERVATIVE_PATTERNS))
      .toMatch(/token \[REDACTED\]/);
  });

  it("redacts Google refresh tokens", () => {
    expect(redactString("refresh 1//0dx3AbCdEfGhIjKlMn", CONSERVATIVE_PATTERNS))
      .toMatch(/refresh \[REDACTED\]/);
  });

  it("redacts long alphanumeric tokens (40+ chars)", () => {
    const token = "a1b2c3d4e5f6g7h8i9j0".repeat(2); // 40 chars
    expect(redactString(`token=${token}`, CONSERVATIVE_PATTERNS))
      .toBe("token=[REDACTED]");
  });

  it("does not redact short strings", () => {
    expect(redactString("hello123", CONSERVATIVE_PATTERNS)).toBe("hello123");
  });

  it("redacts password=value patterns", () => {
    expect(redactString("password=MySecret123!", CONSERVATIVE_PATTERNS))
      .toBe("[REDACTED]");
  });

  it("redacts secret: value patterns", () => {
    expect(redactString("secret: hunter2", CONSERVATIVE_PATTERNS))
      .toBe("[REDACTED]");
  });

  it("redacts credit card numbers", () => {
    expect(redactString("card: 4111 1111 1111 1111", CONSERVATIVE_PATTERNS))
      .toMatch(/card: \[REDACTED\]/);
  });

  it("redacts JWT tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(redactString(`Bearer ${jwt}`, CONSERVATIVE_PATTERNS))
      .not.toContain("eyJ");
  });
});

describe("aggressive patterns", () => {
  it("redacts SSH private key blocks", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQ...\n-----END RSA PRIVATE KEY-----";
    expect(redactString(key, AGGRESSIVE_PATTERNS))
      .toBe("[REDACTED]");
  });

  it("redacts URLs with token query params", () => {
    expect(redactString("https://example.com/callback?token=abc123&next=/home", AGGRESSIVE_PATTERNS))
      .toMatch(/\?token=\[REDACTED\]/);
  });

  it("redacts URLs with password query params", () => {
    expect(redactString("https://example.com?password=secret123", AGGRESSIVE_PATTERNS))
      .toMatch(/\?password=\[REDACTED\]/);
  });

  it("redacts connection strings with credentials", () => {
    expect(redactString("postgres://admin:s3cret@db.host.com:5432/mydb", AGGRESSIVE_PATTERNS))
      .toBe("[REDACTED]");
  });

  it("redacts Basic auth headers", () => {
    expect(redactString("Basic dXNlcjpwYXNzd29yZA==", AGGRESSIVE_PATTERNS))
      .toBe("[REDACTED]");
  });

  it("redacts Azure connection strings", () => {
    expect(redactString("AccountKey=abc123def456ghi789==", AGGRESSIVE_PATTERNS))
      .toBe("[REDACTED]");
  });

  it("redacts GitHub tokens", () => {
    expect(redactString("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl", AGGRESSIVE_PATTERNS))
      .toBe("[REDACTED]");
  });

  // Czech patterns
  it("redacts 'heslo: value'", () => {
    expect(redactString("Vaše heslo: MojeTajneHeslo123", AGGRESSIVE_PATTERNS))
      .toMatch(/\[REDACTED\]/);
  });

  it("redacts 'dočasné heslo: value'", () => {
    expect(redactString("dočasné heslo: TempPass456", AGGRESSIVE_PATTERNS))
      .toMatch(/\[REDACTED\]/);
  });

  it("redacts 'nové heslo: value'", () => {
    expect(redactString("Vaše nové heslo: NewPass789", AGGRESSIVE_PATTERNS))
      .toMatch(/\[REDACTED\]/);
  });

  it("redacts 'PIN: value'", () => {
    expect(redactString("Váš PIN: 1234", AGGRESSIVE_PATTERNS))
      .toMatch(/\[REDACTED\]/);
  });

  it("redacts 'přístupový kód: value'", () => {
    expect(redactString("přístupový kód: 987654", AGGRESSIVE_PATTERNS))
      .toMatch(/\[REDACTED\]/);
  });

  it("redacts 'API klíč: value'", () => {
    expect(redactString("Váš API klíč: abcdef123456", AGGRESSIVE_PATTERNS))
      .toMatch(/\[REDACTED\]/);
  });

  it("redacts Czech card number", () => {
    expect(redactString("číslo karty: 4111 1111 1111 1111", AGGRESSIVE_PATTERNS))
      .toMatch(/\[REDACTED\]/);
  });

  it("redacts Czech bank account number", () => {
    expect(redactString("číslo účtu: 123456/0100", AGGRESSIVE_PATTERNS))
      .toMatch(/\[REDACTED\]/);
  });

  it("redacts IBAN", () => {
    expect(redactString("IBAN: CZ65 0800 0000 1920 0014 5399", AGGRESSIVE_PATTERNS))
      .toMatch(/\[REDACTED\]/);
  });

  it("does not redact normal Czech text", () => {
    const text = "Dobrý den, posílám vám fakturu za služby. Děkuji.";
    expect(redactString(text, AGGRESSIVE_PATTERNS)).toBe(text);
  });
});

describe("createRedactor", () => {
  it("returns a reusable closure", () => {
    const redact = createRedactor(CONSERVATIVE_PATTERNS);
    expect(redact("key: sk-ant-api03-abcdefghijklmnopqrst")).toBe("key: [REDACTED]");
    expect(redact("hello world")).toBe("hello world");
  });

  it("identity function when called with empty patterns", () => {
    const redact = createRedactor([]);
    expect(redact("sk-ant-api03-abcdefghijklmnopqrst")).toBe("sk-ant-api03-abcdefghijklmnopqrst");
  });
});

describe("redactDeep", () => {
  it("redacts strings in nested objects", () => {
    const data = {
      level1: { level2: { secret: "password=hunter2" } },
      list: ["safe text", "sk-ant-api03-abcdefghijklmnopqrst"],
    };
    const result = redactDeep(data, CONSERVATIVE_PATTERNS) as typeof data;
    expect(result.level1.level2.secret).toBe("[REDACTED]");
    expect(result.list[0]).toBe("safe text");
    expect(result.list[1]).toBe("[REDACTED]");
  });

  it("handles null, boolean, number unchanged", () => {
    expect(redactDeep(null, CONSERVATIVE_PATTERNS)).toBeNull();
    expect(redactDeep(true, CONSERVATIVE_PATTERNS)).toBe(true);
    expect(redactDeep(42, CONSERVATIVE_PATTERNS)).toBe(42);
  });

  it("redacts plain string values", () => {
    expect(redactDeep("token ya29.abc123xyz", CONSERVATIVE_PATTERNS))
      .toMatch(/\[REDACTED\]/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/security/content-redaction.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `src/security/content-redaction.ts`:

```typescript
/**
 * Content Redaction Module
 * ========================
 *
 * Shared sensitive-data redaction used by both the gateway layer (conservative
 * patterns for internal errors/tool output) and the integ-api (aggressive
 * patterns for email/calendar content from external sources).
 *
 * Two pattern presets:
 * - CONSERVATIVE_PATTERNS: API keys, tokens, passwords in key=value form, credit cards, JWTs
 * - AGGRESSIVE_PATTERNS: superset — adds private keys, URL secrets, connection strings,
 *   Czech-language disclosures, bank accounts, IBANs
 */

const REDACTED = "[REDACTED]";

// ---------------------------------------------------------------------------
// Conservative patterns (gateway — internal errors, tool output)
// ---------------------------------------------------------------------------

const CONSERVATIVE_PATTERN_SOURCES: Array<[string, string]> = [
  // API keys (Anthropic/OpenAI style)
  ["sk-[a-zA-Z0-9_-]{20,}", "g"],
  // Publishable keys
  ["pk-[a-zA-Z0-9_-]{20,}", "g"],
  // AWS access key IDs
  ["AKIA[0-9A-Z]{16}", "g"],
  // Google API keys
  ["AIza[0-9A-Za-z_-]{35}", "g"],
  // Bearer tokens (must come before Google token patterns)
  ["Bearer\\s+\\S+", "g"],
  // Google access tokens
  ["ya29\\.[0-9A-Za-z_.-]+", "g"],
  // Google refresh tokens
  ["1\\/\\/[0-9A-Za-z_-]+", "g"],
  // JWT tokens
  ["eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_.-]+", "g"],
  // Password/secret/token/key/credential in key=value or key: value
  ["(?:password|passwd|secret|token|key|credential|api_key|apikey)\\s*[=:]\\s*\\S+", "gi"],
  // Credit card numbers: 13–19 digits with optional spaces/dashes
  ["\\b(?:\\d[ -]?){13,18}\\d\\b", "g"],
  // Generic long alphanumeric tokens (40+ chars)
  ["[a-zA-Z0-9]{40,}", "g"],
];

// ---------------------------------------------------------------------------
// Aggressive-only patterns (integ-api — email/calendar bodies)
// ---------------------------------------------------------------------------

const AGGRESSIVE_ONLY_SOURCES: Array<[string, string]> = [
  // SSH/PGP private key blocks
  ["-----BEGIN[\\s\\w]*PRIVATE KEY-----[\\s\\S]*?-----END[\\s\\w]*PRIVATE KEY-----", "g"],
  // URLs with secret query params
  ["[?&](?:token|code|secret|password|key|access_token|api_key|apiKey)=[^&\\s]+", "gi"],
  // Connection strings with credentials
  ["(?:mongodb|postgres|postgresql|mysql|redis|amqp|mssql):\\/\\/[^\\s]+@[^\\s]+", "gi"],
  // Basic auth headers
  ["Basic\\s+[A-Za-z0-9+/=]{10,}", "g"],
  // Azure connection strings
  ["(?:AccountKey|SharedAccessKey)\\s*=\\s*[A-Za-z0-9+/=]+", "g"],
  // GitHub tokens
  ["gh[ps]_[A-Za-z0-9_]{36,}", "g"],
  // Czech password disclosure patterns
  ["(?:heslo|dočasné heslo|nové heslo|vaše heslo|heslo je|aktuální heslo)\\s*[=:]\\s*\\S+", "gi"],
  // Czech PIN / access code
  ["(?:PIN|přístupový kód|ověřovací kód|aktivační kód)\\s*[=:]\\s*\\S+", "gi"],
  // Czech API key / token
  ["(?:API klíč|přístupový token|autorizační token)\\s*[=:]\\s*\\S+", "gi"],
  // Czech card number
  ["číslo karty\\s*[=:]\\s*[\\d\\s-]+", "gi"],
  // Czech bank account (format NNNNNN/NNNN)
  ["číslo účtu\\s*[=:]\\s*\\d+\\/\\d{4}", "gi"],
  // IBAN
  ["\\b[A-Z]{2}\\d{2}\\s?\\d{4}\\s?\\d{4}\\s?\\d{4}\\s?\\d{4}\\s?\\d{0,4}\\b", "g"],
];

// ---------------------------------------------------------------------------
// Compile patterns into RegExp arrays
// ---------------------------------------------------------------------------

function compile(sources: Array<[string, string]>): RegExp[] {
  return sources.map(([pattern, flags]) => new RegExp(pattern, flags));
}

export const CONSERVATIVE_PATTERNS: RegExp[] = compile(CONSERVATIVE_PATTERN_SOURCES);
export const AGGRESSIVE_PATTERNS: RegExp[] = compile([
  ...CONSERVATIVE_PATTERN_SOURCES,
  ...AGGRESSIVE_ONLY_SOURCES,
]);

// ---------------------------------------------------------------------------
// Core redaction functions
// ---------------------------------------------------------------------------

/**
 * Apply redaction patterns to a single string.
 */
export function redactString(text: string, patterns: RegExp[]): string {
  let result = text;
  for (const re of patterns) {
    re.lastIndex = 0;
    result = result.replace(re, REDACTED);
  }
  return result;
}

/**
 * Create a reusable redaction closure with pre-selected patterns.
 * Returns an identity function if patterns array is empty.
 */
export function createRedactor(patterns: RegExp[]): (text: string) => string {
  if (patterns.length === 0) return (text) => text;
  return (text) => redactString(text, patterns);
}

/**
 * Recursively redact all string values in an arbitrary JSON-compatible value.
 * Objects and arrays are traversed; numbers, booleans, and null pass through.
 */
export function redactDeep(value: unknown, patterns: RegExp[]): unknown {
  if (typeof value === "string") {
    return redactString(value, patterns);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, patterns));
  }

  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, patterns);
    }
    return out;
  }

  return value;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/security/content-redaction.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/security/content-redaction.ts src/security/content-redaction.test.ts
git commit -m "feat: add shared content redaction module with conservative and aggressive pattern sets"
```

---

### Task 2: Integrate shared module into integ-api content-filter

**Files:**
- Modify: `src/integ-api/middleware/content-filter.ts`
- Modify: `src/integ-api/server.ts:29,290-295`
- Modify: `src/integ-api/middleware/content-filter.test.ts`

- [ ] **Step 1: Write failing tests for aggressive patterns in content-filter**

Add to `src/integ-api/middleware/content-filter.test.ts` a new describe block:

```typescript
import {
  AGGRESSIVE_PATTERNS,
} from "../../security/content-redaction.js";

describe("createContentFilter – aggressive patterns", () => {
  it("redacts JWT tokens in email body", () => {
    const filter = createContentFilter({ redactPatterns: AGGRESSIVE_PATTERNS, maxBodyLength: 100_000 });
    const data = {
      body: "Your token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    };
    const result = filter.filter(data) as Record<string, unknown>;
    expect((result.body as string)).not.toContain("eyJ");
  });

  it("redacts Czech password disclosure in email body", () => {
    const filter = createContentFilter({ redactPatterns: AGGRESSIVE_PATTERNS, maxBodyLength: 100_000 });
    const data = { body: "Vaše dočasné heslo: TempPass456" };
    const result = filter.filter(data) as Record<string, unknown>;
    expect((result.body as string)).toContain("[REDACTED]");
    expect((result.body as string)).not.toContain("TempPass456");
  });

  it("redacts connection strings in calendar event description", () => {
    const filter = createContentFilter({ redactPatterns: AGGRESSIVE_PATTERNS, maxBodyLength: 100_000 });
    const data = { description: "DB: postgres://admin:s3cret@host:5432/db" };
    const result = filter.filter(data) as Record<string, unknown>;
    expect((result.description as string)).toContain("[REDACTED]");
    expect((result.description as string)).not.toContain("s3cret");
  });

  it("redacts IBAN in email body", () => {
    const filter = createContentFilter({ redactPatterns: AGGRESSIVE_PATTERNS, maxBodyLength: 100_000 });
    const data = { body: "IBAN: CZ65 0800 0000 1920 0014 5399" };
    const result = filter.filter(data) as Record<string, unknown>;
    expect((result.body as string)).toContain("[REDACTED]");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/integ-api/middleware/content-filter.test.ts`
Expected: FAIL — cannot import from `../../security/content-redaction.js` (the filter currently uses string patterns, not RegExp[])

- [ ] **Step 3: Update content-filter.ts to use shared module**

Replace the content of `src/integ-api/middleware/content-filter.ts`. The key changes:
1. Remove `DEFAULT_REDACT_PATTERNS`, `compilePatterns`, `redactValue` — replaced by shared module
2. `createContentFilter` now accepts `redactPatterns: RegExp[]` (pre-compiled) instead of `string[]`
3. Re-export `AGGRESSIVE_PATTERNS` as `DEFAULT_REDACT_PATTERNS` for backward compatibility with `server.ts`

```typescript
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
  redactPatterns: RegExp[];
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
```

- [ ] **Step 4: Update server.ts to use RegExp patterns**

In `src/integ-api/server.ts`, change the import and wiring:

Replace the import line:
```typescript
// Old:
import { createContentFilter, createContentFilterMiddleware, DEFAULT_REDACT_PATTERNS } from "./middleware/content-filter.js";
// New:
import { createContentFilter, createContentFilterMiddleware } from "./middleware/content-filter.js";
import { AGGRESSIVE_PATTERNS } from "../security/content-redaction.js";
```

Replace the content filter wiring (lines ~290-298):
```typescript
  if (config.contentFilter != null) {
    // User-provided patterns are regex strings — compile them, then merge
    // with the built-in aggressive patterns for email/calendar content.
    const extraRegexps = config.contentFilter.redactPatterns.map(
      (p: string) => new RegExp(p, "g"),
    );
    const filter = createContentFilter({
      redactPatterns: [...AGGRESSIVE_PATTERNS, ...extraRegexps],
      maxBodyLength: config.contentFilter.maxBodyLength,
    });
    router.use(createContentFilterMiddleware(filter));
  }
```

- [ ] **Step 5: Update existing content-filter tests**

The existing tests pass `redactPatterns` as `string[]`. Update them to pass `RegExp[]`:

In `src/integ-api/middleware/content-filter.test.ts`, update existing tests:
- Change all `redactPatterns: ["secret"]` to `redactPatterns: [/secret/g]`
- Change all `redactPatterns: ["sk-[a-zA-Z0-9]{6,}"]` to `redactPatterns: [/sk-[a-zA-Z0-9]{6,}/g]`
- Change all `redactPatterns: DEFAULT_REDACT_PATTERNS` to `redactPatterns: AGGRESSIVE_PATTERNS`
- Update the import to get `AGGRESSIVE_PATTERNS` from shared module
- Remove the import of `DEFAULT_REDACT_PATTERNS` from content-filter

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/integ-api/middleware/content-filter.test.ts`
Expected: All tests PASS (old and new)

- [ ] **Step 7: Commit**

```bash
git add src/integ-api/middleware/content-filter.ts src/integ-api/middleware/content-filter.test.ts src/integ-api/server.ts
git commit -m "refactor: delegate integ-api content filter to shared redaction module with aggressive patterns"
```

---

### Task 3: Add redaction to agent-runner error events and audit entries

**Files:**
- Modify: `src/core/agent-runner.ts:466,616-631,654-667` (streamAgentTurn)
- Modify: `src/core/agent-runner.ts:319` (runAgentTurn — similar changes)

- [ ] **Step 1: Add optional `redact` parameter to `streamAgentTurn` and `runAgentTurn`**

In `src/core/agent-runner.ts`, update the `streamAgentTurn` signature (line 466):

```typescript
// Old:
export async function* streamAgentTurn(
  message: string,
  sessionKey: string,
  agentOptions: AgentOptions,
  config: Config,
): AsyncGenerator<StreamEvent> {
// New:
export async function* streamAgentTurn(
  message: string,
  sessionKey: string,
  agentOptions: AgentOptions,
  config: Config,
  redact?: (text: string) => string,
): AsyncGenerator<StreamEvent> {
```

- [ ] **Step 2: Apply redaction to error yield (line 631)**

Replace line 631:
```typescript
// Old:
        yield { type: "error", error: errorMessage };
// New:
        yield { type: "error", error: redact ? redact(errorMessage) : errorMessage };
```

- [ ] **Step 3: Apply redaction to audit entry (lines 660-667)**

Replace the audit entry block:
```typescript
// Old:
  await appendAuditEntry(config.security.workspace, {
    timestamp: new Date().toISOString(),
    source: sessionKey.split("--")[0],
    sessionKey,
    type: "interaction",
    userMessage: message,
    assistantResponse: responseText,
  });
// New:
  await appendAuditEntry(config.security.workspace, {
    timestamp: new Date().toISOString(),
    source: sessionKey.split("--")[0],
    sessionKey,
    type: "interaction",
    userMessage: message,
    assistantResponse: redact ? redact(responseText) : responseText,
  });
```

- [ ] **Step 4: Apply the same changes to `runAgentTurn` (non-streaming variant)**

In `runAgentTurn` (starts ~line 319), add `redact?: (text: string) => string` parameter and apply to:
- The error message thrown/returned (~line 398-410)
- The audit entry (~line 441-448)

- [ ] **Step 5: Run existing tests**

Run: `npx vitest run src/core/`
Expected: All existing tests PASS (redact param is optional, defaults to no-op)

- [ ] **Step 6: Commit**

```bash
git add src/core/agent-runner.ts
git commit -m "feat: add optional redaction to agent-runner error events and audit entries"
```

---

### Task 4: Add redaction to session store persistence

**Files:**
- Modify: `src/session/store.ts:36-47,79-89`

- [ ] **Step 1: Add `redact` parameter to `appendMessage` and `appendMessages`**

In `src/session/store.ts`:

Update `appendMessage` (line 36):
```typescript
// Old:
export async function appendMessage(
  sessionPath: string,
  message: SessionMessage,
): Promise<void> {
  return withLock(sessionPath, async () => {
    await fs.mkdir(path.dirname(sessionPath), { recursive: true, mode: 0o700 });
    await fs.appendFile(sessionPath, JSON.stringify(message) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
  });
}
// New:
export async function appendMessage(
  sessionPath: string,
  message: SessionMessage,
  redact?: (text: string) => string,
): Promise<void> {
  return withLock(sessionPath, async () => {
    await fs.mkdir(path.dirname(sessionPath), { recursive: true, mode: 0o700 });
    const safe = redact ? redactSessionMessage(message, redact) : message;
    await fs.appendFile(sessionPath, JSON.stringify(safe) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
  });
}
```

Update `appendMessages` (line 79):
```typescript
// Old:
export async function appendMessages(
  sessionPath: string,
  messages: SessionMessage[],
): Promise<void> {
  if (messages.length === 0) return;
  return withLock(sessionPath, async () => {
    await fs.mkdir(path.dirname(sessionPath), { recursive: true, mode: 0o700 });
    const data = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await fs.appendFile(sessionPath, data, { encoding: "utf-8", mode: 0o600 });
  });
}
// New:
export async function appendMessages(
  sessionPath: string,
  messages: SessionMessage[],
  redact?: (text: string) => string,
): Promise<void> {
  if (messages.length === 0) return;
  return withLock(sessionPath, async () => {
    await fs.mkdir(path.dirname(sessionPath), { recursive: true, mode: 0o700 });
    const safeMessages = redact ? messages.map((m) => redactSessionMessage(m, redact)) : messages;
    const data = safeMessages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await fs.appendFile(sessionPath, data, { encoding: "utf-8", mode: 0o600 });
  });
}
```

Add the helper function (before `appendMessage`):
```typescript
function redactSessionMessage(
  message: SessionMessage,
  redact: (text: string) => string,
): SessionMessage {
  return {
    ...message,
    content: redact(message.content),
    ...(message.error ? { error: redact(message.error) } : {}),
  };
}
```

- [ ] **Step 2: Run existing tests**

Run: `npx vitest run src/session/`
Expected: All tests PASS (redact is optional)

- [ ] **Step 3: Commit**

```bash
git add src/session/store.ts
git commit -m "feat: add optional redaction to session store persistence"
```

---

### Task 5: Add redaction to daily audit log

**Files:**
- Modify: `src/memory/daily-log.ts:30-44`

- [ ] **Step 1: Add `redact` parameter to `appendAuditEntry`**

In `src/memory/daily-log.ts`:

```typescript
// Old:
export async function appendAuditEntry(
  workspaceDir: string,
  entry: AuditEntry,
): Promise<void> {
  const date = dateFromTimestamp(entry.timestamp);
  const dailyDir = path.join(workspaceDir, "daily");

  await fs.mkdir(dailyDir, { recursive: true, mode: 0o700 });

  const filePath = path.join(dailyDir, `${date}.jsonl`);
  await fs.appendFile(filePath, JSON.stringify(entry) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}
// New:
export async function appendAuditEntry(
  workspaceDir: string,
  entry: AuditEntry,
  redact?: (text: string) => string,
): Promise<void> {
  const date = dateFromTimestamp(entry.timestamp);
  const dailyDir = path.join(workspaceDir, "daily");

  await fs.mkdir(dailyDir, { recursive: true, mode: 0o700 });

  const safeEntry = redact ? redactAuditEntry(entry, redact) : entry;
  const filePath = path.join(dailyDir, `${date}.jsonl`);
  await fs.appendFile(filePath, JSON.stringify(safeEntry) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}
```

Add helper before `appendAuditEntry`:
```typescript
function redactAuditEntry(
  entry: AuditEntry,
  redact: (text: string) => string,
): AuditEntry {
  return {
    ...entry,
    ...(entry.errorMessage ? { errorMessage: redact(entry.errorMessage) } : {}),
    ...(entry.assistantResponse ? { assistantResponse: redact(entry.assistantResponse) } : {}),
    ...(entry.toolResult && typeof entry.toolResult === "string"
      ? { toolResult: redact(entry.toolResult) }
      : {}),
  };
}
```

- [ ] **Step 2: Run existing tests**

Run: `npx vitest run src/memory/`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/memory/daily-log.ts
git commit -m "feat: add optional redaction to daily audit log entries"
```

---

### Task 6: Add redaction to processing message accumulator

**Files:**
- Modify: `src/gateway/processing-message.ts:135-140,159-202`

- [ ] **Step 1: Add `redact` parameter to `createProcessingAccumulator`**

In `src/gateway/processing-message.ts`, update the factory signature (line 135):

```typescript
// Old:
export function createProcessingAccumulator(
  adapter: AdapterProcessingMethods,
  sourceId: string,
  metadata: Record<string, unknown> | undefined,
  intervalMs: number,
): ProcessingMessageAccumulator {
// New:
export function createProcessingAccumulator(
  adapter: AdapterProcessingMethods,
  sourceId: string,
  metadata: Record<string, unknown> | undefined,
  intervalMs: number,
  redact?: (text: string) => string,
): ProcessingMessageAccumulator {
```

- [ ] **Step 2: Apply redaction in flush() before sending to adapter**

In the `flush()` function, apply redaction to `displayContent` before sending:

```typescript
// In flush(), after truncateContent, before the adapter calls:
      displayContent = truncateContent(displayContent);
      // Add this line:
      if (redact) displayContent = redact(displayContent);
```

Also apply to `trimSuffixFromProcessingMessage` — the truncated content sent to the adapter:

```typescript
// In trimSuffixFromProcessingMessage, before updateProcessingMessage call:
        const display = truncateContent(trimmed);
        await adapter.updateProcessingMessage(
          sourceId,
          messageId,
          redact ? redact(display) : display,
          metadata,
        );
```

- [ ] **Step 3: Run existing tests**

Run: `npx vitest run src/gateway/`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/gateway/processing-message.ts
git commit -m "feat: add optional redaction to processing message accumulator"
```

---

### Task 7: Add redaction to session compactor API errors

**Files:**
- Modify: `src/session/compactor.ts:108-111,157-160`

- [ ] **Step 1: Import createRedactor and apply to error bodies**

At the top of `src/session/compactor.ts`, add import:
```typescript
import { createRedactor, CONSERVATIVE_PATTERNS } from "../security/content-redaction.js";
```

Add module-level redactor (after imports):
```typescript
const redactError = createRedactor(CONSERVATIVE_PATTERNS);
```

Update the Anthropic API error (line 110):
```typescript
// Old:
    throw new Error(`Anthropic API error (${response.status}): ${body}`);
// New:
    throw new Error(`Anthropic API error (${response.status}): ${redactError(body)}`);
```

Update the OpenAI API error (line 159):
```typescript
// Old:
    throw new Error(`OpenAI API error (${response.status}): ${body}`);
// New:
    throw new Error(`OpenAI API error (${response.status}): ${redactError(body)}`);
```

- [ ] **Step 2: Run existing tests**

Run: `npx vitest run src/session/`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/session/compactor.ts
git commit -m "feat: redact API error bodies in session compactor"
```

---

### Task 8: Wire redactor through backend and daemon/terminal entry points

**Files:**
- Modify: `src/backends/interface.ts`
- Modify: `src/backends/claude.ts` (or whatever the claude backend file is)
- Modify: `src/daemon.ts`
- Modify: `src/terminal/session.ts`
- Modify: `src/gateway/queue.ts`

This task threads the `redact` function from entry points through to all 5 insertion points.

- [ ] **Step 1: Explore the claude backend to understand how it calls agent-runner**

Read `src/backends/claude.ts` to see how `streamAgentTurn` and `runAgentTurn` are called, and how to add the `redact` parameter.

- [ ] **Step 2: Add `redact` to AgentBackend construction**

The exact approach depends on what the backend factory looks like. The pattern is:
1. `createBackend()` in `src/backends/factory.ts` accepts a `redact` function
2. The Claude backend stores it and passes it to `streamAgentTurn`/`runAgentTurn`
3. `createMessageQueue` or `processNext` receives the redactor for processing-message accumulator

In `src/daemon.ts`, after loading config, create the redactor:
```typescript
import { createRedactor, CONSERVATIVE_PATTERNS } from "./security/content-redaction.js";

// After loadConfig:
const redact = createRedactor(CONSERVATIVE_PATTERNS);
```

Pass it to `createBackend` and `createMessageQueue` (or to `createProcessingAccumulator` through the queue).

In `src/terminal/session.ts`, same pattern:
```typescript
import { createRedactor, CONSERVATIVE_PATTERNS } from "../security/content-redaction.js";

// Inside createTerminalSession:
const redact = createRedactor(CONSERVATIVE_PATTERNS);
// Pass to createBackend
```

- [ ] **Step 3: Thread redact through queue → processing accumulator**

In `src/gateway/queue.ts`, add `redact` to `createMessageQueue` options or pass it as a parameter. Then pass it to `createProcessingAccumulator` calls (lines 189-197):

```typescript
// Old:
          const accumulator = createProcessingAccumulator(
            targetAdapter as {...},
            routeTarget.sourceId,
            message.metadata,
            config.gateway.processingUpdateIntervalMs,
          );
// New:
          const accumulator = createProcessingAccumulator(
            targetAdapter as {...},
            routeTarget.sourceId,
            message.metadata,
            config.gateway.processingUpdateIntervalMs,
            redact,
          );
```

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/backends/ src/daemon.ts src/terminal/session.ts src/gateway/queue.ts
git commit -m "feat: wire content redactor through daemon, terminal, backend, and queue"
```

---

### Task 9: Run full test suite and verify build

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Verify TypeScript compilation**

Run: `npm run build`
Expected: Clean compilation, no errors

- [ ] **Step 3: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address any test/build issues from content redaction integration"
```
