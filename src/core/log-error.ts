import { CONSERVATIVE_PATTERNS, redactString } from "../security/content-redaction.js";

export interface SafeError {
  message: string;
  code?: string;
  /** Slack Web API error name (`err.data.error`). */
  slackError?: string;
}

/**
 * Safe projection of an error for logs. Never log whole Slack/axios errors: they carry the request config with the
 * `Authorization` header (bot token). Only the redacted message, `code` and `data.error` are kept.
 */
export function safeErr(err: unknown): SafeError {
  const e = err as { code?: unknown; data?: { error?: unknown } } | null;
  const out: SafeError = { message: redactString(err instanceof Error ? err.message : String(err), CONSERVATIVE_PATTERNS) };
  if (typeof e?.code === "string") out.code = e.code;
  if (typeof e?.data?.error === "string") out.slackError = e.data.error;
  return out;
}
