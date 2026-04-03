/**
 * Gmail API Route Handlers
 * =========================
 *
 * Implements read-only Gmail integration endpoints:
 *   GET /gmail/messages          — list messages (query, max, labelIds)
 *   GET /gmail/messages/:id      — get full message (parsed MIME to plain text)
 *   GET /gmail/labels            — list all labels
 *   GET /gmail/search            — alias for messages with query param
 *
 * All routes:
 *   - Use AuthManager.getAccessToken("gmail") for Bearer token
 *   - Retry once on 401 (mark failed, get fresh token, retry)
 *   - Apply outbound rate limiter (60 req/min)
 *
 * Gmail API reference:
 *   https://developers.google.com/gmail/api/reference/rest
 */

import { createLogger } from "../../../core/logger.js";
import type { AuthManager } from "../../auth/manager.js";
import { AuthFailedError } from "../../auth/manager.js";
import type { SimpleRouter } from "../../server.js";
import type { IntegApiError } from "../../types.js";
import {
  createOutboundRateLimiter,
  GmailRateLimitError,
  type OutboundRateLimiter,
} from "./rate-limits.js";

const log = createLogger("integ-api:gmail");

// ---------------------------------------------------------------------------
// Gmail API base URL
// ---------------------------------------------------------------------------

/** Gmail REST API v1 base URL. https://developers.google.com/gmail/api/reference/rest */
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

// ---------------------------------------------------------------------------
// Gmail API response types (minimal surface for our use)
// ---------------------------------------------------------------------------

interface GmailMessageRef {
  id: string;
  threadId: string;
}

interface GmailListResponse {
  messages?: GmailMessageRef[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailMessagePart {
  mimeType: string;
  headers?: GmailHeader[];
  body?: {
    data?: string;
    size?: number;
  };
  parts?: GmailMessagePart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailMessagePart;
  internalDate?: string;
}

interface GmailLabel {
  id: string;
  name: string;
  type?: string;
  messageListVisibility?: string;
  labelListVisibility?: string;
}

interface GmailLabelsResponse {
  labels?: GmailLabel[];
}

// ---------------------------------------------------------------------------
// MIME parsing helpers
// ---------------------------------------------------------------------------

/**
 * Decode a base64url-encoded string to UTF-8 text.
 * Gmail API uses URL-safe base64 (RFC 4648 §5).
 */
function decodeBase64Url(encoded: string): string {
  // Convert base64url → standard base64
  const standard = encoded.replace(/-/g, "+").replace(/_/g, "/");
  // Pad to multiple of 4
  const padded = standard.padEnd(standard.length + ((4 - (standard.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

/**
 * Extract a header value by name (case-insensitive) from a list of headers.
 */
function getHeader(headers: GmailHeader[], name: string): string {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value ?? "";
}

/**
 * Recursively extract plain text body from a MIME message part tree.
 *
 * Priority:
 * 1. text/plain parts
 * 2. text/html parts (fallback — returned as-is, agent can strip tags)
 *
 * For multipart/* containers, recurse into parts.
 */
export function extractPlainText(part: GmailMessagePart): string {
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }

  // Recurse into multipart containers
  if (part.mimeType.startsWith("multipart/") && part.parts) {
    // For multipart/alternative, prefer text/plain over text/html
    const textPart = part.parts.find((p) => p.mimeType === "text/plain");
    if (textPart) {
      const text = extractPlainText(textPart);
      if (text) return text;
    }
    // Try each part in order
    for (const child of part.parts) {
      const text = extractPlainText(child);
      if (text) return text;
    }
  }

  // Fallback: text/html body
  if (part.mimeType === "text/html" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }

  return "";
}

// ---------------------------------------------------------------------------
// Gmail API fetch helper
// ---------------------------------------------------------------------------

/**
 * Fetch from the Gmail API with auth token.
 * Throws AuthFailedError or a generic Error on auth failure.
 *
 * On 401 from Gmail, marks the profile as failed and throws so the caller
 * can retry with a fresh token.
 * On 403 from Gmail (scope/permission error), throws AuthFailedError immediately
 * (non-retryable — refreshing the token will not fix a scope misconfiguration).
 */
async function gmailFetch(
  url: string,
  token: string,
  profileId: string,
  authManager: AuthManager,
): Promise<Response> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (response.status === 401) {
    authManager.markFailed(profileId);
    throw new Error(`Gmail API auth error: HTTP ${response.status}`);
  }

  if (response.status === 403) {
    // 403 = valid token but insufficient scope — retrying with a different token
    // will not help; this is a configuration error.
    throw new AuthFailedError("gmail", 1);
  }

  return response;
}

/**
 * Call Gmail API with automatic token refresh on 401.
 * Rate limit is checked once per logical request (not per retry attempt).
 * Tries getAccessToken → fetch; if 401, marks failed, retries once with fresh token.
 */
async function callGmailApi(
  url: string,
  authManager: AuthManager,
  rateLimiter: OutboundRateLimiter,
): Promise<Response> {
  // Check outbound rate limit once for the logical request (not per retry attempt)
  rateLimiter.checkAndRecord();

  let tokenResult = await authManager.getAccessToken("gmail");

  try {
    const response = await gmailFetch(url, tokenResult.token, tokenResult.profileId, authManager);
    authManager.markSuccess(tokenResult.profileId);
    return response;
  } catch (err) {
    if (err instanceof GmailRateLimitError) throw err;
    // AuthFailedError from 403 (scope error) — non-retryable
    if (err instanceof AuthFailedError) throw err;
    // Generic auth error (401) — retry with next available token
    log.warn({ url }, "Gmail API auth error on first attempt, retrying with fresh token");
    try {
      tokenResult = await authManager.getAccessToken("gmail");
      const response = await gmailFetch(url, tokenResult.token, tokenResult.profileId, authManager);
      authManager.markSuccess(tokenResult.profileId);
      return response;
    } catch (retryErr) {
      if (retryErr instanceof GmailRateLimitError) throw retryErr;
      if (retryErr instanceof AuthFailedError) throw retryErr;
      throw new AuthFailedError("gmail", 2);
    }
  }
}

// ---------------------------------------------------------------------------
// Route handler factory
// ---------------------------------------------------------------------------

/**
 * Build a structured IntegApiError from a caught error.
 */
function toIntegError(err: unknown, service = "gmail"): IntegApiError {
  if (err instanceof AuthFailedError) {
    return {
      error: "auth_failed",
      message: err.message,
      service,
      profilesTried: err.profilesTried,
    };
  }
  if (err instanceof GmailRateLimitError) {
    return {
      error: "rate_limited",
      message: err.message,
      retryAfterMs: err.retryAfterMs,
      service,
    };
  }
  return {
    error: "service_unavailable",
    message: err instanceof Error ? err.message : "Unknown error",
    service,
  };
}

// ---------------------------------------------------------------------------
// registerGmailRoutes
// ---------------------------------------------------------------------------

/**
 * Register all Gmail API routes on the provided router.
 *
 * @param router    - SimpleRouter instance
 * @param authManager - Auth manager for token retrieval and rotation
 * @param rateLimiter - Outbound rate limiter (default: 60 req/min)
 */
export function registerGmailRoutes(
  router: SimpleRouter,
  authManager: AuthManager,
  rateLimiter: OutboundRateLimiter = createOutboundRateLimiter(),
): void {
  // -------------------------------------------------------------------------
  // GET /gmail/messages — list messages
  // Query params: query (string), max (number, default 10), labelIds (comma-separated)
  // Gmail API: GET /users/me/messages
  // Docs: https://developers.google.com/gmail/api/reference/rest/v1/users.messages/list
  // -------------------------------------------------------------------------
  router.get("/gmail/messages", async (req, res) => {
    try {
      const query = req.query.get("query") ?? req.query.get("q") ?? "";
      const max = Math.min(parseInt(req.query.get("max") ?? "10", 10) || 10, 100);
      const labelIds = req.query.get("labelIds") ?? "";

      const params = new URLSearchParams({ maxResults: String(max) });
      if (query) params.set("q", query);
      if (labelIds) params.set("labelIds", labelIds);

      const url = `${GMAIL_API_BASE}/users/me/messages?${params.toString()}`;
      const apiRes = await callGmailApi(url, authManager, rateLimiter);

      if (!apiRes.ok) {
        const errText = await apiRes.text().catch(() => "(unreadable)");
        log.warn({ status: apiRes.status, errText }, "Gmail list messages failed");
        res.error({
          error: "service_unavailable",
          message: `Gmail API error: HTTP ${apiRes.status}`,
          service: "gmail",
        });
        return;
      }

      const data = (await apiRes.json()) as GmailListResponse;
      res.json({
        messages: data.messages ?? [],
        nextPageToken: data.nextPageToken,
        resultSizeEstimate: data.resultSizeEstimate,
      });
    } catch (err) {
      log.error({ err }, "Gmail list messages error");
      res.error(toIntegError(err));
    }
  });

  // -------------------------------------------------------------------------
  // GET /gmail/messages/:id — get full message
  // Gmail API: GET /users/me/messages/{id}?format=full
  // Docs: https://developers.google.com/gmail/api/reference/rest/v1/users.messages/get
  // -------------------------------------------------------------------------
  router.get("/gmail/messages/:id", async (req, res) => {
    try {
      const { id } = req.params;
      if (!id) {
        res.error({ error: "not_found", message: "Message ID is required", service: "gmail" });
        return;
      }

      const url = `${GMAIL_API_BASE}/users/me/messages/${encodeURIComponent(id)}?format=full`;
      const apiRes = await callGmailApi(url, authManager, rateLimiter);

      if (!apiRes.ok) {
        if (apiRes.status === 404) {
          res.error({ error: "not_found", message: `Message not found: ${id}`, service: "gmail" });
          return;
        }
        const errText = await apiRes.text().catch(() => "(unreadable)");
        log.warn({ status: apiRes.status, errText, id }, "Gmail get message failed");
        res.error({
          error: "service_unavailable",
          message: `Gmail API error: HTTP ${apiRes.status}`,
          service: "gmail",
        });
        return;
      }

      const msg = (await apiRes.json()) as GmailMessage;
      const headers = msg.payload?.headers ?? [];

      const subject = getHeader(headers, "Subject");
      const from = getHeader(headers, "From");
      const to = getHeader(headers, "To");
      const date = getHeader(headers, "Date");
      // Truncate body to prevent memory exhaustion from large emails (newsletters, etc.)
      const MAX_BODY_CHARS = 50_000;
      const body = msg.payload ? extractPlainText(msg.payload).slice(0, MAX_BODY_CHARS) : "";

      res.json({
        id: msg.id,
        threadId: msg.threadId,
        labelIds: msg.labelIds ?? [],
        snippet: msg.snippet ?? "",
        subject,
        from,
        to,
        date,
        body,
      });
    } catch (err) {
      log.error({ err }, "Gmail get message error");
      res.error(toIntegError(err));
    }
  });

  // -------------------------------------------------------------------------
  // GET /gmail/labels — list all labels
  // Gmail API: GET /users/me/labels
  // Docs: https://developers.google.com/gmail/api/reference/rest/v1/users.labels/list
  // -------------------------------------------------------------------------
  router.get("/gmail/labels", async (_req, res) => {
    try {
      const url = `${GMAIL_API_BASE}/users/me/labels`;
      const apiRes = await callGmailApi(url, authManager, rateLimiter);

      if (!apiRes.ok) {
        const errText = await apiRes.text().catch(() => "(unreadable)");
        log.warn({ status: apiRes.status, errText }, "Gmail list labels failed");
        res.error({
          error: "service_unavailable",
          message: `Gmail API error: HTTP ${apiRes.status}`,
          service: "gmail",
        });
        return;
      }

      const data = (await apiRes.json()) as GmailLabelsResponse;
      res.json({ labels: data.labels ?? [] });
    } catch (err) {
      log.error({ err }, "Gmail list labels error");
      res.error(toIntegError(err));
    }
  });

  // -------------------------------------------------------------------------
  // GET /gmail/search — alias for messages with query param
  // Docs: https://developers.google.com/gmail/api/reference/rest/v1/users.messages/list
  // -------------------------------------------------------------------------
  router.get("/gmail/search", async (req, res) => {
    try {
      const q = req.query.get("q") ?? req.query.get("query") ?? "";
      const max = Math.min(parseInt(req.query.get("max") ?? "10", 10) || 10, 100);

      if (!q) {
        res.error({
          error: "not_found",
          message: "Query parameter 'q' is required for search",
          service: "gmail",
        });
        return;
      }

      const params = new URLSearchParams({ q, maxResults: String(max) });
      const url = `${GMAIL_API_BASE}/users/me/messages?${params.toString()}`;
      const apiRes = await callGmailApi(url, authManager, rateLimiter);

      if (!apiRes.ok) {
        const errText = await apiRes.text().catch(() => "(unreadable)");
        log.warn({ status: apiRes.status, errText }, "Gmail search failed");
        res.error({
          error: "service_unavailable",
          message: `Gmail API error: HTTP ${apiRes.status}`,
          service: "gmail",
        });
        return;
      }

      const data = (await apiRes.json()) as GmailListResponse;
      res.json({
        messages: data.messages ?? [],
        nextPageToken: data.nextPageToken,
        resultSizeEstimate: data.resultSizeEstimate,
      });
    } catch (err) {
      log.error({ err }, "Gmail search error");
      res.error(toIntegError(err));
    }
  });
}
