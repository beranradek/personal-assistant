/**
 * Integ-API Core Types
 * ====================
 *
 * Shared types used across the integ-api service: structured errors,
 * integration manifests, and module contracts.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type IntegApiErrorCode =
  | "rate_limited"
  | "auth_failed"
  | "service_unavailable"
  | "not_found";

/** Structured error response — never raw upstream API errors. */
export interface IntegApiError {
  error: IntegApiErrorCode;
  /** Human-readable message for the agent. */
  message: string;
  /** When to retry (rate limit / cooldown). */
  retryAfterMs?: number;
  /** Which integration failed. */
  service: string;
  /** Auth rotation context — how many profiles were tried. */
  profilesTried?: number;
}

// ---------------------------------------------------------------------------
// Discovery / manifest types
// ---------------------------------------------------------------------------

export interface EndpointDef {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;
  params?: string[];
}

export interface RateLimits {
  requestsPerMinute: number;
}

export interface IntegrationManifest {
  id: string;
  name: string;
  /** "active" | "disabled" | "error" */
  status: string;
  capabilities: string[];
  endpoints: EndpointDef[];
  rateLimits: RateLimits;
}

// ---------------------------------------------------------------------------
// Router types
// ---------------------------------------------------------------------------

/** Incoming request enriched with parsed params, query, and body. */
export interface ParsedRequest extends IncomingMessage {
  /** Path parameters extracted by the router (e.g., { id: "123" }). */
  params: Record<string, string>;
  /** Parsed URL query string. */
  query: URLSearchParams;
  /** Parsed JSON body (undefined if no body or non-JSON content-type). */
  body: unknown;
}

/** Response wrapper with JSON helpers. */
export interface JsonResponse {
  /** Send a JSON response with optional HTTP status (default 200). */
  json(data: unknown, status?: number): void;
  /** Send a structured IntegApiError response (always 4xx/5xx). */
  error(err: IntegApiError): void;
  /** Underlying ServerResponse for low-level access. */
  raw: ServerResponse;
}

/** Route handler signature. */
export type RouteHandler = (req: ParsedRequest, res: JsonResponse) => Promise<void>;

/** Middleware signature — call next() to continue the pipeline. */
export type Middleware = (
  req: ParsedRequest,
  res: JsonResponse,
  next: () => Promise<void>,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Integration module contract
// ---------------------------------------------------------------------------

/** Every integration implements this interface and self-registers its routes. */
export interface IntegrationModule {
  id: string;
  manifest: IntegrationManifest;
  /** Register HTTP routes on the provided router. */
  routes(router: import("./server.js").SimpleRouter): void;
  /** Return true if the integration is reachable/configured. */
  healthCheck(): Promise<boolean>;
}
