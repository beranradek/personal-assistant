/**
 * Tests for integ-api SimpleRouter and createIntegApiServer.
 *
 * GWT verification:
 * 1. GET /integ-api/health returns 200 with { status: "ok" }
 * 2. GET /test/:id routes with params.id extraction
 * 3. Non-loopback bind addresses are rejected
 * 4. JSON body parsing (valid JSON, invalid JSON, empty body)
 * 5. Server closes gracefully (stop())
 * 6. SimpleRouter path matching with various patterns
 * 7. 404 for unmatched routes
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import { SimpleRouter, createIntegApiServer } from "./server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make an HTTP request to localhost and return { status, body }. */
async function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(payload !== undefined ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// Use a unique port range to avoid conflicts
let portCounter = 19200;
function nextPort(): number {
  return portCounter++;
}

// ---------------------------------------------------------------------------
// SimpleRouter unit tests (no HTTP server)
// ---------------------------------------------------------------------------

describe("SimpleRouter path matching", () => {
  it("matches exact paths", async () => {
    const router = new SimpleRouter();
    let called = false;
    router.get("/foo/bar", async (_req, res) => {
      called = true;
      res.json({ ok: true });
    });
    const handled = await router.handle(
      { method: "GET", url: "/foo/bar", headers: {} } as http.IncomingMessage,
      { writeHead: () => {}, end: () => {}, setHeader: () => {}, headersSent: false } as unknown as http.ServerResponse,
    );
    expect(handled).toBe(true);
    expect(called).toBe(true);
  });

  it("extracts :param segments", async () => {
    const router = new SimpleRouter();
    let capturedId: string | undefined;
    router.get("/items/:id", async (req, res) => {
      capturedId = req.params.id;
      res.json({ id: req.params.id });
    });
    const handled = await router.handle(
      { method: "GET", url: "/items/abc-123", headers: {} } as http.IncomingMessage,
      { writeHead: () => {}, end: () => {}, setHeader: () => {}, headersSent: false } as unknown as http.ServerResponse,
    );
    expect(handled).toBe(true);
    expect(capturedId).toBe("abc-123");
  });

  it("extracts multiple :param segments", async () => {
    const router = new SimpleRouter();
    let captured: Record<string, string> = {};
    router.get("/users/:userId/posts/:postId", async (req, res) => {
      captured = req.params;
      res.json(req.params);
    });
    await router.handle(
      { method: "GET", url: "/users/u1/posts/p2", headers: {} } as http.IncomingMessage,
      { writeHead: () => {}, end: () => {}, setHeader: () => {}, headersSent: false } as unknown as http.ServerResponse,
    );
    expect(captured).toEqual({ userId: "u1", postId: "p2" });
  });

  it("returns false for unmatched routes", async () => {
    const router = new SimpleRouter();
    router.get("/exists", async (_req, res) => res.json({}));
    const handled = await router.handle(
      { method: "GET", url: "/does-not-exist", headers: {} } as http.IncomingMessage,
      { writeHead: () => {}, end: () => {}, setHeader: () => {}, headersSent: false } as unknown as http.ServerResponse,
    );
    expect(handled).toBe(false);
  });

  it("does not match across method boundaries", async () => {
    const router = new SimpleRouter();
    router.post("/resource", async (_req, res) => res.json({}));
    const handled = await router.handle(
      { method: "GET", url: "/resource", headers: {} } as http.IncomingMessage,
      { writeHead: () => {}, end: () => {}, setHeader: () => {}, headersSent: false } as unknown as http.ServerResponse,
    );
    expect(handled).toBe(false);
  });

  it("runs middleware in registration order before handler", async () => {
    const router = new SimpleRouter();
    const order: string[] = [];
    router.use(async (_req, _res, next) => {
      order.push("mw1");
      await next();
    });
    router.use(async (_req, _res, next) => {
      order.push("mw2");
      await next();
    });
    router.get("/mw-test", async (_req, res) => {
      order.push("handler");
      res.json({});
    });
    await router.handle(
      { method: "GET", url: "/mw-test", headers: {} } as http.IncomingMessage,
      { writeHead: () => {}, end: () => {}, setHeader: () => {}, headersSent: false } as unknown as http.ServerResponse,
    );
    expect(order).toEqual(["mw1", "mw2", "handler"]);
  });

  it("parses query parameters", async () => {
    const router = new SimpleRouter();
    let capturedQuery: URLSearchParams | undefined;
    router.get("/search", async (req, res) => {
      capturedQuery = req.query;
      res.json({});
    });
    await router.handle(
      { method: "GET", url: "/search?q=hello&max=10", headers: {} } as http.IncomingMessage,
      { writeHead: () => {}, end: () => {}, setHeader: () => {}, headersSent: false } as unknown as http.ServerResponse,
    );
    expect(capturedQuery?.get("q")).toBe("hello");
    expect(capturedQuery?.get("max")).toBe("10");
  });
});

// ---------------------------------------------------------------------------
// JSON body parsing tests
// ---------------------------------------------------------------------------

describe("JSON body parsing", () => {
  it("parses valid JSON body", async () => {
    const router = new SimpleRouter();
    let capturedBody: unknown;
    router.post("/echo", async (req, res) => {
      capturedBody = req.body;
      res.json({ received: true });
    });

    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    srv.router.post("/echo", async (req, res) => {
      capturedBody = req.body;
      res.json({ received: true });
    });
    await srv.start();
    try {
      await request(port, "POST", "/echo", { hello: "world" });
      expect(capturedBody).toEqual({ hello: "world" });
    } finally {
      await srv.stop();
    }
  });

  it("returns undefined body for invalid JSON", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    let capturedBody: unknown = "sentinel";
    srv.router.post("/bad-json", async (req, res) => {
      capturedBody = req.body;
      res.json({ ok: true });
    });
    await srv.start();
    try {
      await new Promise<void>((resolve, reject) => {
        const payload = "not valid json{{{";
        const options: http.RequestOptions = {
          hostname: "127.0.0.1",
          port,
          path: "/bad-json",
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        };
        const req = http.request(options, (res) => {
          res.resume();
          res.on("end", resolve);
        });
        req.on("error", reject);
        req.write(payload);
        req.end();
      });
      expect(capturedBody).toBeUndefined();
    } finally {
      await srv.stop();
    }
  });

  it("returns undefined body for empty body", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    let capturedBody: unknown = "sentinel";
    srv.router.post("/empty", async (req, res) => {
      capturedBody = req.body;
      res.json({ ok: true });
    });
    await srv.start();
    try {
      await new Promise<void>((resolve, reject) => {
        const options: http.RequestOptions = {
          hostname: "127.0.0.1",
          port,
          path: "/empty",
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": "0" },
        };
        const req = http.request(options, (res) => {
          res.resume();
          res.on("end", resolve);
        });
        req.on("error", reject);
        req.end();
      });
      expect(capturedBody).toBeUndefined();
    } finally {
      await srv.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// createIntegApiServer integration tests
// ---------------------------------------------------------------------------

describe("createIntegApiServer", () => {
  // GWT 1: health endpoint
  it("GET /integ-api/health returns 200 with status ok", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    await srv.start();
    try {
      const { status, body } = await request(port, "GET", "/integ-api/health");
      expect(status).toBe(200);
      expect((body as { status: string }).status).toBe("ok");
      expect(typeof (body as { uptime: number }).uptime).toBe("number");
    } finally {
      await srv.stop();
    }
  });

  // GWT 2: :param extraction over HTTP
  it("GET /test/:id passes params.id to handler", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    srv.router.get("/test/:id", async (req, res) => {
      res.json({ id: req.params.id });
    });
    await srv.start();
    try {
      const { status, body } = await request(port, "GET", "/test/123");
      expect(status).toBe(200);
      expect((body as { id: string }).id).toBe("123");
    } finally {
      await srv.stop();
    }
  });

  // GWT 3: non-loopback bind rejected
  it("rejects non-loopback bind addresses", () => {
    expect(() => createIntegApiServer({ bind: "0.0.0.0", port: 19100 })).toThrow(
      /not a loopback address/,
    );
    expect(() => createIntegApiServer({ bind: "192.168.1.1", port: 19100 })).toThrow(
      /not a loopback address/,
    );
  });

  it("accepts localhost and ::1 as valid bind addresses", () => {
    expect(() => createIntegApiServer({ bind: "localhost", port: 19100 })).not.toThrow();
    expect(() => createIntegApiServer({ bind: "::1", port: 19100 })).not.toThrow();
  });

  // GWT 5: graceful stop
  it("stop() resolves after server closes", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    await srv.start();
    await expect(srv.stop()).resolves.toBeUndefined();
  });

  // 404 for unmatched routes
  it("returns 404 for unregistered routes", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    await srv.start();
    try {
      const { status } = await request(port, "GET", "/nonexistent");
      expect(status).toBe(404);
    } finally {
      await srv.stop();
    }
  });
});
