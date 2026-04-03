/**
 * Integ-API HTTP Server
 * =====================
 *
 * Lightweight HTTP server using Node.js built-in `http` module (zero new deps).
 *
 * Provides:
 * - SimpleRouter: method+path matching with :param extraction, JSON helpers
 * - createIntegApiServer: factory that wires router into an http.Server
 *
 * Binds to localhost (127.0.0.1) only — non-loopback bind addresses are
 * rejected to enforce the security boundary between assistant and integ-api.
 */

import * as http from "node:http";
import { createLogger } from "../core/logger.js";
import type {
  ParsedRequest,
  JsonResponse,
  RouteHandler,
  Middleware,
  IntegApiError,
} from "./types.js";
import type { IntegApiConfig } from "../core/types.js";

const log = createLogger("integ-api:server");

// ---------------------------------------------------------------------------
// Loopback validation
// ---------------------------------------------------------------------------

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "localhost"]);

function assertLoopbackBind(bind: string): void {
  if (!LOOPBACK_ADDRESSES.has(bind)) {
    throw new Error(
      `integ-api: bind address "${bind}" is not a loopback address. ` +
        `Only 127.0.0.1 / ::1 / localhost are allowed to prevent external exposure.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Route matching helpers
// ---------------------------------------------------------------------------

interface CompiledRoute {
  method: string;
  /** Original path pattern, e.g. "/gmail/messages/:id" */
  pattern: string;
  /** Ordered list of param names from the pattern. */
  paramNames: string[];
  /** Regex to match the URL pathname. */
  regex: RegExp;
  handler: RouteHandler;
}

function compileRoute(method: string, pattern: string, handler: RouteHandler): CompiledRoute {
  const paramNames: string[] = [];
  // Convert :param segments to named capture groups
  const regexSource = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&") // escape regex metacharacters except *
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name: string) => {
      paramNames.push(name);
      return "([^/]+)";
    });
  const regex = new RegExp(`^${regexSource}$`);
  return { method: method.toUpperCase(), pattern, paramNames, regex, handler };
}

function matchRoute(
  routes: CompiledRoute[],
  method: string,
  pathname: string,
): { route: CompiledRoute; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method.toUpperCase()) continue;
    const m = pathname.match(route.regex);
    if (!m) continue;
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(m[i + 1] ?? "");
    });
    return { route, params };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

async function parseBody(req: http.IncomingMessage): Promise<unknown> {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.includes("application/json")) return undefined;

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined); // invalid JSON → treat as no body
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// JsonResponse factory
// ---------------------------------------------------------------------------

function makeJsonResponse(raw: http.ServerResponse): JsonResponse {
  return {
    raw,
    json(data: unknown, status = 200): void {
      const body = JSON.stringify(data);
      raw.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
      raw.end(body);
    },
    error(err: IntegApiError): void {
      const statusMap: Record<string, number> = {
        rate_limited: 429,
        auth_failed: 401,
        service_unavailable: 503,
        not_found: 404,
      };
      const status = statusMap[err.error] ?? 500;
      const body = JSON.stringify(err);
      const headers: Record<string, string | number> = {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      };
      if (err.retryAfterMs != null) {
        headers["Retry-After"] = Math.ceil(err.retryAfterMs / 1000).toString();
      }
      raw.writeHead(status, headers);
      raw.end(body);
    },
  };
}

// ---------------------------------------------------------------------------
// SimpleRouter
// ---------------------------------------------------------------------------

/**
 * Minimal HTTP router (~80 lines of logic).
 *
 * Supports:
 * - Method+path routing with :param extraction
 * - Middleware (run in registration order before handlers)
 * - JSON request/response helpers
 */
export class SimpleRouter {
  private readonly routes: CompiledRoute[] = [];
  private readonly middlewares: Middleware[] = [];

  get(path: string, handler: RouteHandler): this {
    this.routes.push(compileRoute("GET", path, handler));
    return this;
  }

  post(path: string, handler: RouteHandler): this {
    this.routes.push(compileRoute("POST", path, handler));
    return this;
  }

  put(path: string, handler: RouteHandler): this {
    this.routes.push(compileRoute("PUT", path, handler));
    return this;
  }

  delete(path: string, handler: RouteHandler): this {
    this.routes.push(compileRoute("DELETE", path, handler));
    return this;
  }

  patch(path: string, handler: RouteHandler): this {
    this.routes.push(compileRoute("PATCH", path, handler));
    return this;
  }

  /** Register a middleware that runs before every route handler. */
  use(middleware: Middleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  /**
   * Handle an incoming request. Called by the http.Server request listener.
   * Returns true if a route was matched, false if 404.
   */
  async handle(req: http.IncomingMessage, rawRes: http.ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    // Parse body
    const body = await parseBody(req);

    // Build enriched request
    const parsedReq = req as ParsedRequest;
    parsedReq.params = {};
    parsedReq.query = url.searchParams;
    parsedReq.body = body;

    const res = makeJsonResponse(rawRes);

    // Match route
    const matched = matchRoute(this.routes, method, pathname);
    if (!matched) return false;

    parsedReq.params = matched.params;

    // Run middleware chain → handler
    const middlewares = this.middlewares;
    const handler = matched.route.handler;

    let idx = 0;
    const next = async (): Promise<void> => {
      if (idx < middlewares.length) {
        const mw = middlewares[idx++];
        await mw(parsedReq, res, next);
      } else {
        await handler(parsedReq, res);
      }
    };

    await next();
    return true;
  }
}

// ---------------------------------------------------------------------------
// createIntegApiServer
// ---------------------------------------------------------------------------

export interface IntegApiServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  router: SimpleRouter;
}

/**
 * Create the integ-api HTTP server.
 *
 * Validates that bind address is loopback-only, wires the SimpleRouter into
 * Node's http.Server, and registers the built-in /integ-api/health endpoint.
 *
 * @param config - The integApi section of the global config (or compatible subset)
 */
export function createIntegApiServer(config: Pick<IntegApiConfig, "bind" | "port">): IntegApiServer {
  assertLoopbackBind(config.bind);

  const router = new SimpleRouter();
  const startedAt = Date.now();

  // Built-in health endpoint
  router.get("/integ-api/health", async (_req, res) => {
    res.json({ status: "ok", uptime: Math.floor((Date.now() - startedAt) / 1000) });
  });

  const server = http.createServer(async (req, res) => {
    try {
      const handled = await router.handle(req, res);
      if (!handled) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found", message: "Route not found", service: "integ-api" }));
      }
    } catch (err) {
      log.error({ err }, "Unhandled error in request handler");
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "service_unavailable", message: "Internal server error", service: "integ-api" }));
      }
    }
  });

  return {
    router,

    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.bind, () => {
          server.removeListener("error", reject);
          log.info({ bind: config.bind, port: config.port }, "integ-api server started");
          resolve();
        });
      });
    },

    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            log.info("integ-api server stopped");
            resolve();
          }
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Config type alias (avoids circular import for consumers)
// ---------------------------------------------------------------------------

/** Subset of the global Config used by the integ-api server. */
export type { IntegApiConfig } from "../core/types.js";
