/**
 * Content Redaction Module
 * ========================
 *
 * Provides pattern-based redaction of sensitive data from strings and
 * structured values. Two pattern sets are exported:
 *
 * - **CONSERVATIVE_PATTERNS** — for gateway (internal errors/tool output)
 * - **AGGRESSIVE_PATTERNS** — superset, for integ-api (email/calendar bodies)
 *
 * All matches are replaced with `[REDACTED]`.
 */

export const REDACTED = "[REDACTED]";

// ---------------------------------------------------------------------------
// Pattern sources — Array<[pattern, flags]>, compiled once into RegExp[]
// ---------------------------------------------------------------------------

const CONSERVATIVE_SOURCES: Array<[string, string]> = [
  // API keys
  [`sk-[a-zA-Z0-9_-]{20,}`, "g"],
  [`pk-[a-zA-Z0-9_-]{20,}`, "g"],
  // AWS access keys
  [`AKIA[0-9A-Z]{16}`, "g"],
  // Google API keys
  [`AIza[0-9A-Za-z_-]{35}`, "g"],
  // Bearer tokens
  [`Bearer\\s+\\S+`, "g"],
  // Google access tokens
  [`ya29\\.[0-9A-Za-z_.-]+`, "g"],
  // Google refresh tokens
  [`1//[0-9A-Za-z_-]{20,}`, "g"],
  // JWT tokens
  [`eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_.-]+`, "g"],
  // Password/secret in key=value or key: value
  [
    `(?:password|passwd|secret|token|key|credential|api_key|apikey)\\s*[=:]\\s*\\S+`,
    "gi",
  ],
  // Credit card numbers
  [`\\b(?:\\d[ -]?){13,18}\\d\\b`, "g"],
  // Generic long alphanumeric tokens (40+ chars)
  [`[a-zA-Z0-9]{40,}`, "g"],
];

const AGGRESSIVE_ONLY_SOURCES: Array<[string, string]> = [
  // SSH/PGP private key blocks
  [
    `-----BEGIN[\\s\\w]*PRIVATE KEY-----[\\s\\S]*?-----END[\\s\\w]*PRIVATE KEY-----`,
    "g",
  ],
  // URLs with secret query params
  [
    `[?&](?:token|code|secret|password|key|access_token|api_key|apiKey)=[^&\\s]+`,
    "gi",
  ],
  // Connection strings with credentials
  [
    `(?:mongodb|postgres|postgresql|mysql|redis|amqp|mssql)://[^\\s]+@[^\\s]+`,
    "gi",
  ],
  // Basic auth headers
  [`Basic\\s+[A-Za-z0-9+/=]{10,}`, "g"],
  // Azure connection strings
  [`(?:AccountKey|SharedAccessKey)\\s*=\\s*[A-Za-z0-9+/=]+`, "g"],
  // GitHub tokens
  [`gh[ps]_[A-Za-z0-9_]{36,}`, "g"],
  // Czech password disclosure
  [
    `(?:heslo k certifikátu je|heslo k certifikátu|dočasné heslo|nové heslo|vaše heslo|heslo je|aktuální heslo|heslo)\\s*[=:]\\s*\\S+`,
    "gi",
  ],
  // English enrollment/certificate code disclosure
  [
    `(?:enrollment code|activation code|certificate password|temporary password)\\s*[=:]\\s*\\S+`,
    "gi",
  ],
  // Czech PIN/access code
  [
    `(?:PIN|přístupový kód|ověřovací kód|aktivační kód)\\s*[=:]\\s*\\S+`,
    "gi",
  ],
  // Czech API key/token
  [
    `(?:API klíč|přístupový token|autorizační token)\\s*[=:]\\s*\\S+`,
    "gi",
  ],
  // Czech card number
  [`číslo karty\\s*[=:]\\s*[\\d\\s-]+`, "gi"],
  // Czech bank account
  [`číslo účtu\\s*[=:]\\s*\\d+/\\d{4}`, "gi"],
  // IBAN (with or without spaces between groups)
  [`\\b[A-Z]{2}\\d{2}\\s?\\d{4}\\s?\\d{4}\\s?\\d{4}\\s?\\d{4}\\s?\\d{0,4}\\b`, "g"],
];

// ---------------------------------------------------------------------------
// Compile patterns
// ---------------------------------------------------------------------------

function compileSources(sources: Array<[string, string]>): RegExp[] {
  return sources.map(([pattern, flags]) => new RegExp(pattern, flags));
}

// NOTE: These arrays are frozen to prevent accidental mutation of shared RegExp
// state (lastIndex). Do NOT use pattern.exec() or pattern.test() directly on
// these patterns — always use redactString() which resets lastIndex before use.
export const CONSERVATIVE_PATTERNS: readonly RegExp[] = Object.freeze(
  compileSources(CONSERVATIVE_SOURCES),
);

export const AGGRESSIVE_PATTERNS: readonly RegExp[] = Object.freeze(
  compileSources([...CONSERVATIVE_SOURCES, ...AGGRESSIVE_ONLY_SOURCES]),
);

// ---------------------------------------------------------------------------
// Redaction functions
// ---------------------------------------------------------------------------

/**
 * Apply patterns to a single string. All matches are replaced with [REDACTED].
 */
export function redactString(text: string, patterns: readonly RegExp[]): string {
  let result = text;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

/**
 * Factory returning a closure that redacts strings using the given patterns.
 * With empty patterns returns an identity function.
 */
export function createRedactor(
  patterns: readonly RegExp[],
): (text: string) => string {
  if (patterns.length === 0) {
    return (text: string) => text;
  }
  return (text: string) => redactString(text, patterns);
}

/**
 * Recursively walk JSON values, redacting all strings.
 * Passes through null, boolean, and number unchanged.
 */
export function redactDeep(value: unknown, patterns: readonly RegExp[]): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return redactString(value, patterns);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, patterns));
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (key === "__proto__") continue;
      result[key] = redactDeep(val, patterns);
    }
    return result;
  }
  return value;
}
