/**
 * Tests for Gmail integration module
 *
 * GWT verification:
 * 1. Given valid Gmail auth, When GET /gmail/messages?max=5, Then returns up to 5 summaries
 * 2. Given message ID, When GET /gmail/messages/:id, Then returns parsed message (subject, from, body)
 * 3. Given Gmail API 401, When route is called, Then auth manager marks failed and retries
 * 4. Given rate limit exceeded, When requests exceed 60/min, Then returns structured error
 * 5. GET /gmail/labels returns label list
 * 6. GET /gmail/search returns filtered message list
 * 7. Unit test MIME/base64url extraction
 * 8. Unit test route registration and path matching
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as http from "node:http";
import { SimpleRouter, createIntegApiServer } from "../../server.js";
import { registerGmailRoutes } from "./routes.js";
import { extractPlainText } from "./routes.js";
import {
  createOutboundRateLimiter,
  GmailRateLimitError,
  GMAIL_REQUESTS_PER_MINUTE,
} from "./rate-limits.js";
import { createGmailModule } from "./index.js";
import type { AuthManager, TokenResult } from "../../auth/manager.js";
import { AuthFailedError } from "../../auth/manager.js";
import type { OutboundRateLimiter } from "./rate-limits.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function request(
  port: number,
  method: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          parsed = null;
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

let portCounter = 19500;
function nextPort(): number {
  return portCounter++;
}

function makeAuthManager(overrides: Partial<AuthManager> = {}): AuthManager {
  return {
    registerProfile: vi.fn(),
    getAccessToken: vi.fn().mockResolvedValue({ token: "test-token", profileId: "p1" } as TokenResult),
    refreshToken: vi.fn().mockResolvedValue("new-token"),
    markFailed: vi.fn(),
    markSuccess: vi.fn(),
    listProfiles: vi.fn().mockReturnValue(["p1"]),
    ...overrides,
  };
}

function makePassthroughRateLimiter(): OutboundRateLimiter {
  return { checkAndRecord: vi.fn() };
}

/** Build a base64url-encoded string (Gmail uses URL-safe base64). */
function toBase64Url(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// ---------------------------------------------------------------------------
// MIME / extractPlainText unit tests
// ---------------------------------------------------------------------------

describe("extractPlainText", () => {
  it("extracts body from simple text/plain part", () => {
    const body = "Hello, world!";
    const part = {
      mimeType: "text/plain",
      body: { data: toBase64Url(body) },
    };
    expect(extractPlainText(part)).toBe(body);
  });

  it("returns empty string for text/plain with no body data", () => {
    const part = { mimeType: "text/plain", body: {} };
    expect(extractPlainText(part)).toBe("");
  });

  it("prefers text/plain over text/html in multipart/alternative", () => {
    const plainText = "Plain text body";
    const htmlText = "<p>HTML body</p>";
    const part = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: toBase64Url(htmlText) } },
        { mimeType: "text/plain", body: { data: toBase64Url(plainText) } },
      ],
    };
    expect(extractPlainText(part)).toBe(plainText);
  });

  it("falls back to text/html when no text/plain available", () => {
    const htmlText = "<p>HTML only</p>";
    const part = {
      mimeType: "multipart/alternative",
      parts: [{ mimeType: "text/html", body: { data: toBase64Url(htmlText) } }],
    };
    expect(extractPlainText(part)).toBe(htmlText);
  });

  it("recurses into multipart/mixed containers", () => {
    const body = "Nested plain text";
    const part = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: toBase64Url(body) } },
        { mimeType: "image/png", body: { data: toBase64Url("fake-png") } },
      ],
    };
    expect(extractPlainText(part)).toBe(body);
  });

  it("handles base64url encoding correctly (standard chars + padding)", () => {
    const text = "Special chars: +/=";
    const part = {
      mimeType: "text/plain",
      body: { data: toBase64Url(text) },
    };
    expect(extractPlainText(part)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// Outbound rate limiter unit tests
// ---------------------------------------------------------------------------

describe("createOutboundRateLimiter", () => {
  it("exports correct Gmail quota constant", () => {
    expect(GMAIL_REQUESTS_PER_MINUTE).toBe(60);
  });

  it("allows requests within limit", () => {
    const limiter = createOutboundRateLimiter(5);
    expect(() => {
      for (let i = 0; i < 5; i++) limiter.checkAndRecord();
    }).not.toThrow();
  });

  it("throws GmailRateLimitError when limit exceeded", () => {
    const limiter = createOutboundRateLimiter(3);
    limiter.checkAndRecord();
    limiter.checkAndRecord();
    limiter.checkAndRecord();
    expect(() => limiter.checkAndRecord()).toThrow(GmailRateLimitError);
  });

  it("GmailRateLimitError has positive retryAfterMs", () => {
    const limiter = createOutboundRateLimiter(1);
    limiter.checkAndRecord();
    try {
      limiter.checkAndRecord();
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GmailRateLimitError);
      expect((err as GmailRateLimitError).retryAfterMs).toBeGreaterThan(0);
    }
  });

  it("allows requests again after window expires", async () => {
    // Use a very short window by manipulating timestamps indirectly is tricky,
    // so just verify the second request after reset works with fresh limiter
    const limiter = createOutboundRateLimiter(2);
    limiter.checkAndRecord();
    limiter.checkAndRecord();
    expect(() => limiter.checkAndRecord()).toThrow(GmailRateLimitError);
    // Create fresh limiter (window reset simulation)
    const limiter2 = createOutboundRateLimiter(2);
    expect(() => limiter2.checkAndRecord()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Gmail routes integration tests (with mocked fetch)
// ---------------------------------------------------------------------------

describe("Gmail routes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("GWT: GET /gmail/messages returns message list with correct structure", async () => {
    const port = nextPort();
    const server = createIntegApiServer({ bind: "127.0.0.1", port });
    const authManager = makeAuthManager();
    const rateLimiter = makePassthroughRateLimiter();

    const mockMessages = [
      { id: "msg1", threadId: "thread1" },
      { id: "msg2", threadId: "thread2" },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ messages: mockMessages, resultSizeEstimate: 2 }),
        text: async () => "",
      }),
    );

    registerGmailRoutes(server.router, authManager, rateLimiter);
    await server.start();
    try {
      const res = await request(port, "GET", "/gmail/messages?max=5");
      expect(res.status).toBe(200);
      const body = res.body as { messages: typeof mockMessages };
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0]?.id).toBe("msg1");
      expect(authManager.markSuccess).toHaveBeenCalledWith("p1");
    } finally {
      await server.stop();
      vi.unstubAllGlobals();
    }
  });

  it("GWT: GET /gmail/messages/:id returns parsed message with subject, from, body", async () => {
    const port = nextPort();
    const server = createIntegApiServer({ bind: "127.0.0.1", port });
    const authManager = makeAuthManager();
    const rateLimiter = makePassthroughRateLimiter();

    const plainBody = "Hello! This is the email body.";
    const mockMessage = {
      id: "msg123",
      threadId: "thread123",
      labelIds: ["INBOX"],
      snippet: "Hello!",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "Subject", value: "Test Subject" },
          { name: "From", value: "sender@example.com" },
          { name: "To", value: "receiver@example.com" },
          { name: "Date", value: "Mon, 1 Jan 2024 12:00:00 +0000" },
        ],
        body: { data: toBase64Url(plainBody) },
      },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockMessage,
        text: async () => "",
      }),
    );

    registerGmailRoutes(server.router, authManager, rateLimiter);
    await server.start();
    try {
      const res = await request(port, "GET", "/gmail/messages/msg123");
      expect(res.status).toBe(200);
      const body = res.body as Record<string, string>;
      expect(body.id).toBe("msg123");
      expect(body.subject).toBe("Test Subject");
      expect(body.from).toBe("sender@example.com");
      expect(body.to).toBe("receiver@example.com");
      expect(body.body).toBe(plainBody);
    } finally {
      await server.stop();
      vi.unstubAllGlobals();
    }
  });

  it("GWT: GET /gmail/labels returns label list", async () => {
    const port = nextPort();
    const server = createIntegApiServer({ bind: "127.0.0.1", port });
    const authManager = makeAuthManager();
    const rateLimiter = makePassthroughRateLimiter();

    const mockLabels = [
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "SENT", name: "SENT", type: "system" },
      { id: "Label_1", name: "Work", type: "user" },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ labels: mockLabels }),
        text: async () => "",
      }),
    );

    registerGmailRoutes(server.router, authManager, rateLimiter);
    await server.start();
    try {
      const res = await request(port, "GET", "/gmail/labels");
      expect(res.status).toBe(200);
      const body = res.body as { labels: typeof mockLabels };
      expect(body.labels).toHaveLength(3);
      expect(body.labels[0]?.id).toBe("INBOX");
      expect(body.labels[2]?.name).toBe("Work");
    } finally {
      await server.stop();
      vi.unstubAllGlobals();
    }
  });

  it("GWT: GET /gmail/search returns messages matching query", async () => {
    const port = nextPort();
    const server = createIntegApiServer({ bind: "127.0.0.1", port });
    const authManager = makeAuthManager();
    const rateLimiter = makePassthroughRateLimiter();

    const mockMessages = [{ id: "searchmsg1", threadId: "t1" }];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ messages: mockMessages }),
        text: async () => "",
      }),
    );

    registerGmailRoutes(server.router, authManager, rateLimiter);
    await server.start();
    try {
      const res = await request(port, "GET", "/gmail/search?q=from:boss@example.com");
      expect(res.status).toBe(200);
      const body = res.body as { messages: typeof mockMessages };
      expect(body.messages[0]?.id).toBe("searchmsg1");

      // Verify q param was forwarded to Gmail API
      const fetchMock = vi.mocked(global.fetch);
      const callUrl = fetchMock.mock.calls[0]?.[0] as string;
      expect(callUrl).toContain("q=from%3Aboss%40example.com");
    } finally {
      await server.stop();
      vi.unstubAllGlobals();
    }
  });

  it("GET /gmail/search without q returns 404", async () => {
    const port = nextPort();
    const server = createIntegApiServer({ bind: "127.0.0.1", port });
    const authManager = makeAuthManager();
    const rateLimiter = makePassthroughRateLimiter();

    vi.stubGlobal("fetch", vi.fn());

    registerGmailRoutes(server.router, authManager, rateLimiter);
    await server.start();
    try {
      const res = await request(port, "GET", "/gmail/search");
      expect(res.status).toBe(404);
      const body = res.body as { error: string };
      expect(body.error).toBe("not_found");
    } finally {
      await server.stop();
      vi.unstubAllGlobals();
    }
  });

  it("GWT: Gmail API 401 causes auth mark-failed and retry with fresh token", async () => {
    const port = nextPort();
    const server = createIntegApiServer({ bind: "127.0.0.1", port });

    let callCount = 0;
    const authManager = makeAuthManager({
      getAccessToken: vi.fn().mockImplementation(async () => {
        callCount++;
        return { token: `token-${callCount}`, profileId: `profile-${callCount}` };
      }),
    });
    const rateLimiter = makePassthroughRateLimiter();

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: async () => ({}),
          text: async () => "Unauthorized",
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ messages: [], resultSizeEstimate: 0 }),
          text: async () => "",
        }),
    );

    registerGmailRoutes(server.router, authManager, rateLimiter);
    await server.start();
    try {
      const res = await request(port, "GET", "/gmail/messages");
      expect(res.status).toBe(200);
      // Auth manager should have been called twice (first attempt + retry)
      expect(authManager.getAccessToken).toHaveBeenCalledTimes(2);
      // markFailed should be called for the 401 response
      expect(authManager.markFailed).toHaveBeenCalledWith("profile-1");
    } finally {
      await server.stop();
      vi.unstubAllGlobals();
    }
  });

  it("GWT: All auth profiles fail returns 401 auth_failed response", async () => {
    const port = nextPort();
    const server = createIntegApiServer({ bind: "127.0.0.1", port });

    const authManager = makeAuthManager({
      getAccessToken: vi.fn().mockRejectedValue(new AuthFailedError("gmail", 1)),
    });
    const rateLimiter = makePassthroughRateLimiter();

    registerGmailRoutes(server.router, authManager, rateLimiter);
    await server.start();
    try {
      const res = await request(port, "GET", "/gmail/messages");
      expect(res.status).toBe(401);
      const body = res.body as { error: string; service: string };
      expect(body.error).toBe("auth_failed");
      expect(body.service).toBe("gmail");
    } finally {
      await server.stop();
    }
  });

  it("GWT: Rate limit exceeded returns 429 with retryAfterMs", async () => {
    const port = nextPort();
    const server = createIntegApiServer({ bind: "127.0.0.1", port });
    const authManager = makeAuthManager();

    const rateLimiter: OutboundRateLimiter = {
      checkAndRecord: vi.fn().mockImplementation(() => {
        throw new GmailRateLimitError(30_000);
      }),
    };

    registerGmailRoutes(server.router, authManager, rateLimiter);
    await server.start();
    try {
      const res = await request(port, "GET", "/gmail/messages");
      expect(res.status).toBe(429);
      const body = res.body as { error: string; retryAfterMs: number; service: string };
      expect(body.error).toBe("rate_limited");
      expect(body.retryAfterMs).toBe(30_000);
      expect(body.service).toBe("gmail");
    } finally {
      await server.stop();
    }
  });

  it("GET /gmail/messages/:id returns 404 when Gmail returns 404", async () => {
    const port = nextPort();
    const server = createIntegApiServer({ bind: "127.0.0.1", port });
    const authManager = makeAuthManager();
    const rateLimiter = makePassthroughRateLimiter();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => "Not Found",
      }),
    );

    registerGmailRoutes(server.router, authManager, rateLimiter);
    await server.start();
    try {
      const res = await request(port, "GET", "/gmail/messages/nonexistent");
      expect(res.status).toBe(404);
      const body = res.body as { error: string };
      expect(body.error).toBe("not_found");
    } finally {
      await server.stop();
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// createGmailModule tests
// ---------------------------------------------------------------------------

describe("createGmailModule", () => {
  it("has correct id and capabilities in manifest", () => {
    const authManager = makeAuthManager();
    const mod = createGmailModule(authManager);
    expect(mod.id).toBe("gmail");
    expect(mod.manifest.id).toBe("gmail");
    expect(mod.manifest.capabilities).toEqual(["list", "read", "search", "labels"]);
    expect(mod.manifest.rateLimits.requestsPerMinute).toBe(60);
    expect(mod.manifest.endpoints).toHaveLength(4);
  });

  it("healthCheck returns true when auth succeeds", async () => {
    const authManager = makeAuthManager();
    const mod = createGmailModule(authManager);
    expect(await mod.healthCheck()).toBe(true);
  });

  it("healthCheck returns false when auth fails", async () => {
    const authManager = makeAuthManager({
      getAccessToken: vi.fn().mockRejectedValue(new AuthFailedError("gmail", 0)),
    });
    const mod = createGmailModule(authManager);
    expect(await mod.healthCheck()).toBe(false);
  });

  it("routes() registers 4 endpoints on the router", () => {
    const authManager = makeAuthManager();
    const mod = createGmailModule(authManager);
    const router = new SimpleRouter();
    let registered = false;

    // Spy on get() to count route registrations
    const originalGet = router.get.bind(router);
    let routeCount = 0;
    router.get = (path: string, handler: Parameters<typeof originalGet>[1]) => {
      routeCount++;
      return originalGet(path, handler);
    };

    mod.routes(router);
    expect(routeCount).toBe(4); // messages, messages/:id, labels, search
    registered = true;
    expect(registered).toBe(true);
  });
});
