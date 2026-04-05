# Content Redaction Layer

**Date:** 2026-04-05
**Status:** Approved

## Problem

Sensitive data (API keys, tokens, passwords, credit card numbers) can leak through multiple paths in the personal assistant:

1. **Gateway layer** — SDK/API errors yielded to adapters, session transcripts persisted as plaintext JSONL, audit log entries, processing message updates streamed to Telegram/Slack, compactor API error bodies.
2. **Integ-API layer** — Email bodies and calendar event descriptions fetched from Gmail/Calendar may contain credentials, passwords (including Czech-language disclosures), tokens, and financial data that flow through to the agent.

The existing `content-filter.ts` in integ-api handles basic redaction (API keys, long tokens, credit cards) but lacks coverage for OAuth tokens, JWT, connection strings, private keys, Czech-language patterns, and URL-embedded secrets. The gateway has no redaction at all.

## Design

### Shared Module: `src/security/content-redaction.ts`

Core redaction logic shared by both gateway and integ-api.

**Exports:**

```typescript
// Pre-compiled pattern sets
export const CONSERVATIVE_PATTERNS: RegExp[];
export const AGGRESSIVE_PATTERNS: RegExp[];  // superset of conservative

// Core function — applies patterns to a single string
export function redactSensitiveContent(text: string, patterns: RegExp[]): string;

// Factory — returns a closure with pre-selected patterns
export function createRedactor(patterns: RegExp[]): (text: string) => string;

// Deep redaction — recursively walks JSON values (replaces redactValue in content-filter.ts)
export function redactDeep(value: unknown, patterns: RegExp[]): unknown;
```

### Pattern Sets

**CONSERVATIVE_PATTERNS** (gateway — internal errors, tool output):

| Category | Pattern | Example Match |
|----------|---------|---------------|
| Anthropic/OpenAI API keys | `sk-[a-zA-Z0-9]{20,}` | `sk-ant-abc123...` |
| Publishable keys | `pk-[a-zA-Z0-9]{20,}` | `pk-live-abc123...` |
| AWS access keys | `AKIA[0-9A-Z]{16}` | `AKIAIOSFODNN7EXAMPLE` |
| Google API keys | `AIza[0-9A-Za-z_-]{35}` | `AIzaSyD-abc123...` |
| Bearer tokens | `Bearer\s+\S+` | `Bearer ya29.a0AfH6...` |
| Google access tokens | `ya29\.[0-9A-Za-z_.-]+` | `ya29.a0AfH6SMB...` |
| Google refresh tokens | `1//[0-9A-Za-z_-]+` | `1//0dx3...` |
| Generic long tokens | `[a-zA-Z0-9]{40,}` | 40+ char alphanumeric strings |
| Password in key=value | `(password\|passwd\|secret\|token\|key\|credential)[\s]*[=:]\s*\S+` | `password=abc123` |
| Credit card numbers | `\b(?:\d[ -]?){13,18}\d\b` | `4111 1111 1111 1111` |
| JWT tokens | `eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+` | `eyJhbGci...` |

**AGGRESSIVE_PATTERNS** (integ-api — email/calendar bodies, superset of conservative):

All conservative patterns plus:

| Category | Pattern | Example Match |
|----------|---------|---------------|
| SSH/PGP private keys | `-----BEGIN\s[\w\s]*PRIVATE KEY-----[\s\S]*?-----END` | PEM blocks |
| URLs with secrets | `[?&](token\|code\|secret\|password\|key\|access_token\|api_key)=[^&\s]+` | `?token=abc123` |
| Connection strings | `(mongodb\|postgres\|mysql\|redis\|amqp)://[^\s]+@[^\s]+` | `postgres://user:pass@host` |
| Basic auth headers | `Basic\s+[A-Za-z0-9+/=]{10,}` | `Basic dXNlcjpwYXNz` |
| Azure connection strings | `(AccountKey\|SharedAccessKey)\s*=\s*[A-Za-z0-9+/=]+` | `AccountKey=abc123==` |
| GitHub tokens | `gh[ps]_[A-Za-z0-9_]{36,}` | `ghp_abc123...` |
| Czech: password disclosure | `(heslo\|dočasné heslo\|nové heslo\|vaše heslo\|heslo je)\s*[:=]\s*\S+` | `heslo: MojeTajne123` |
| Czech: PIN/access code | `(PIN\|přístupový kód\|ověřovací kód\|aktivační kód)\s*[:=]\s*\S+` | `PIN: 1234` |
| Czech: API key/token | `(API klíč\|přístupový token\|autorizační token)\s*[:=]\s*\S+` | `API klíč: abc123` |
| Czech: card number | `číslo karty\s*[:=]\s*[\d\s-]+` | `číslo karty: 4111 1111 1111 1111` |
| Czech: bank account | `číslo účtu\s*[:=]\s*\d+/\d{4}` | `číslo účtu: 123456/0100` |
| IBAN | `\b[A-Z]{2}\d{2}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{0,4}\b` | `CZ65 0800 0000 1920 0014 5399` |

All patterns are case-insensitive where appropriate (Czech patterns, password/secret keywords).

### Integ-API Integration

`content-filter.ts` changes:
- Import `AGGRESSIVE_PATTERNS` and `redactDeep` from `src/security/content-redaction.ts`
- Replace `DEFAULT_REDACT_PATTERNS` (string array) with patterns derived from `AGGRESSIVE_PATTERNS`
- Replace internal `redactValue()` with imported `redactDeep()`
- Middleware wrapping and truncation logic unchanged

### Gateway Integration (5 insertion points)

A `redactor` function created at startup (`daemon.ts` / `terminal.ts`) with `CONSERVATIVE_PATTERNS`, threaded through via dependency injection:

1. **`agent-runner.ts` — stream error events**: Redact `errorMessage` before `yield { type: "error", error: redactor(errorMessage) }` (~line 631)
2. **`session/store.ts` — transcript persistence**: Redact `content` and `error` fields in each `SessionMessage` before writing to JSONL (~line 86)
3. **`memory/daily-log.ts` — audit entries**: Redact `errorMessage`, `assistantResponse`, `toolResult` fields before writing (~line 40)
4. **`processing-message.ts` — adapter updates**: Redact accumulated content before `createProcessingMessage()` / `updateProcessingMessage()` calls (~line 189)
5. **`session/compactor.ts` — API error bodies**: Redact the `body` variable before constructing the thrown Error (~lines 110, 159)

**Dependency injection approach**: Functions that need redaction accept an optional `redact?: (text: string) => string` parameter. When not provided (e.g., in tests), no redaction is applied. This avoids global state and keeps testability.

### Testing

- `src/security/content-redaction.test.ts`: Unit tests for each pattern category (positive matches, negative/no-false-positive cases), Czech patterns, `redactDeep` on nested objects
- Update `content-filter.test.ts`: Verify new patterns work through the middleware
- Gateway integration tests: Verify redaction at each of the 5 insertion points with mocked redactor

### Files Changed

| File | Change |
|------|--------|
| `src/security/content-redaction.ts` | **New** — shared redaction module |
| `src/security/content-redaction.test.ts` | **New** — unit tests |
| `src/integ-api/middleware/content-filter.ts` | Import from shared module, replace internal patterns/redactValue |
| `src/integ-api/middleware/content-filter.test.ts` | Update for new patterns |
| `src/core/agent-runner.ts` | Accept redactor, apply to error events |
| `src/session/store.ts` | Accept redactor, apply before JSONL write |
| `src/memory/daily-log.ts` | Accept redactor, apply before audit write |
| `src/gateway/processing-message.ts` | Accept redactor, apply before flush |
| `src/session/compactor.ts` | Accept redactor, apply to API error bodies |
| `src/daemon.ts` | Create redactor, pass to subsystems |
| `src/terminal.ts` | Create redactor, pass to subsystems |
