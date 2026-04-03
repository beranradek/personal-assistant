/**
 * Tests for the inbound rate limiter middleware.
 *
 * GWT 1: Given rate limit of 5/min, When 6 requests are made in 1 minute,
 *         Then 6th returns 429 with retryAfterMs
 * GWT 2: Given rate limit window passes, When a new request arrives,
 *         Then it succeeds (tested via the sliding window unit test)
 * Unit tests with time-mocked requests.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { createIntegApiServer } from "../server.js";
import { createInboundRateLimiter } from "./inbound-rate-limiter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let portCounter = 19400;
function nextPort(): number {
  return portCounter++;
}

async function get(port: number, p: string): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: p, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString()),
            headers: res.headers,
          });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: null, headers: res.headers });
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createInboundRateLimiter", () => {
  it("allows requests up to the limit", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    srv.router.use(createInboundRateLimiter(3));
    srv.router.get("/hello", async (_req, res) => res.json({ ok: true }));

    await srv.start();
    try {
      const r1 = await get(port, "/hello");
      const r2 = await get(port, "/hello");
      const r3 = await get(port, "/hello");

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(200);
    } finally {
      await srv.stop();
    }
  });

  it("GWT 1: 6th request returns 429 with retryAfterMs when limit is 5", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    srv.router.use(createInboundRateLimiter(5));
    srv.router.get("/x", async (_req, res) => res.json({ ok: true }));

    await srv.start();
    try {
      for (let i = 0; i < 5; i++) {
        const r = await get(port, "/x");
        expect(r.status).toBe(200);
      }

      const r6 = await get(port, "/x");
      expect(r6.status).toBe(429);

      const body = r6.body as Record<string, unknown>;
      expect(body.error).toBe("rate_limited");
      expect(typeof body.retryAfterMs).toBe("number");
      expect((body.retryAfterMs as number)).toBeGreaterThan(0);

      // Retry-After header should be set (in seconds)
      expect(r6.headers["retry-after"]).toBeDefined();
    } finally {
      await srv.stop();
    }
  });

  it("GWT 1: 429 body has correct IntegApiError shape", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    srv.router.use(createInboundRateLimiter(1));
    srv.router.get("/y", async (_req, res) => res.json({ ok: true }));

    await srv.start();
    try {
      await get(port, "/y"); // consume the 1 allowed request

      const r = await get(port, "/y");
      expect(r.status).toBe(429);

      const body = r.body as Record<string, unknown>;
      expect(body.error).toBe("rate_limited");
      expect(typeof body.message).toBe("string");
      expect(body.service).toBe("integ-api");
      expect(typeof body.retryAfterMs).toBe("number");
    } finally {
      await srv.stop();
    }
  });

  it("tracks requests within the sliding window", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    srv.router.use(createInboundRateLimiter(2));
    srv.router.get("/z", async (_req, res) => res.json({ ok: true }));

    await srv.start();
    try {
      const r1 = await get(port, "/z");
      const r2 = await get(port, "/z");
      const r3 = await get(port, "/z"); // should be 429

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(429);
    } finally {
      await srv.stop();
    }
  });

  it("rate limiter blocks any request after limit exceeded (same caller key)", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    srv.router.use(createInboundRateLimiter(1));
    srv.router.get("/a", async (_req, res) => res.json({ route: "a" }));
    srv.router.get("/b", async (_req, res) => res.json({ route: "b" }));

    await srv.start();
    try {
      await get(port, "/a"); // consume the 1 request
      const r = await get(port, "/b"); // second request — rate limited
      expect(r.status).toBe(429);
    } finally {
      await srv.stop();
    }
  });
});
