import pino from "pino";

/**
 * Paths that pino will replace with "[REDACTED]" in every log record.
 * Uses wildcard prefix so the fields are caught at any nesting depth
 * (e.g. `err.config.botToken`, `adapter.appToken`, etc.).
 */
export const REDACT_PATHS = [
  "*.botToken",
  "*.appToken",
  "*.token",
  "*.password",
  "*.secret",
  "*.apiKey",
  "*.api_key",
  "*.authorization",
  "*.Authorization",
];

export const logger = pino({
  redact: {
    paths: REDACT_PATHS,
    censor: "[REDACTED]",
  },
  transport: {
    target: "pino-pretty",
    options: { colorize: true },
  },
});

export function createLogger(name: string) {
  return logger.child({ module: name });
}
