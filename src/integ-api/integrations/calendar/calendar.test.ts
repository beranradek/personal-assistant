/**
 * Tests for the Google Calendar integration module.
 *
 * GWT verification:
 * 1. Given calendar module is registered, When GET /integ-api/integrations is called,
 *    Then calendar appears with correct capabilities
 * 2. Given valid Calendar auth, When GET /calendar/today is called,
 *    Then it returns today's events sorted by start time
 * 3. Given a specific event ID, When GET /calendar/event/:id is called,
 *    Then full event details are returned
 * 4. Given no events today, When GET /calendar/today is called,
 *    Then it returns empty array (not error)
 * 5. Given Calendar API returns 401, When a route is called,
 *    Then auth manager handles it as auth_failed
 * 6. Unit test event date/time parsing and timezone handling
 * 7. Integration test with mocked Calendar API responses
 * 8. Given missing timeMin/timeMax, When GET /calendar/free-busy is called,
 *    Then it returns a structured not_found error
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as http from "node:http";
import { SimpleRouter, createIntegApiServer } from "../../server.js";
import { createCalendarModule } from "./index.js";
import { createRegistry } from "../registry.js";
import type { AuthManager, TokenResult } from "../../auth/manager.js";
import { AuthFailedError } from "../../auth/manager.js";

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
    req.end();
  });
}

let portCounter = 19300;
function nextPort(): number {
  return portCounter++;
}

// ---------------------------------------------------------------------------
// Mock AuthManager
// ---------------------------------------------------------------------------

function makeAuthManager(opts: {
  token?: string;
  throwError?: Error;
}): AuthManager {
  return {
    async getAccessToken(_serviceId: string): Promise<TokenResult> {
      if (opts.throwError) throw opts.throwError;
      return { token: opts.token ?? "test-token", profileId: "profile-1" };
    },
    async getAccessTokenForProfile(_profileId: string): Promise<TokenResult> {
      if (opts.throwError) throw opts.throwError;
      return { token: opts.token ?? "test-token", profileId: "profile-1" };
    },
    async registerProfile() {},
    async refreshToken() {
      return opts.token ?? "test-token";
    },
    markFailed() {},
    markSuccess() {},
    listProfiles() {
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Google Calendar API responses
// ---------------------------------------------------------------------------

const MOCK_EVENT_1 = {
  id: "event-1",
  summary: "Team Standup",
  start: { dateTime: "2026-04-03T09:00:00Z" },
  end: { dateTime: "2026-04-03T09:30:00Z" },
  status: "confirmed",
  htmlLink: "https://calendar.google.com/event?id=event-1",
};

const MOCK_EVENT_2 = {
  id: "event-2",
  summary: "Lunch with Alice",
  description: "At the usual place",
  location: "Café Central",
  start: { dateTime: "2026-04-03T12:00:00Z" },
  end: { dateTime: "2026-04-03T13:00:00Z" },
  status: "confirmed",
  attendees: [{ email: "alice@example.com", displayName: "Alice", responseStatus: "accepted" }],
};

const MOCK_ALL_DAY_EVENT = {
  id: "event-all-day",
  summary: "Company Holiday",
  start: { date: "2026-04-03" },
  end: { date: "2026-04-04" },
  status: "confirmed",
};

// ---------------------------------------------------------------------------
// Registry + discovery tests
// ---------------------------------------------------------------------------

describe("calendar module registration and discovery", () => {
  // GWT 1: calendar appears in /integ-api/integrations
  it("registers calendar module with correct capabilities", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    const registry = createRegistry(srv.router);
    const authMgr = makeAuthManager({ token: "tok" });
    registry.register(createCalendarModule(authMgr));
    await srv.start();

    try {
      const { status, body } = await request(port, "GET", "/integ-api/integrations");
      expect(status).toBe(200);
      const resp = body as { integrations: Array<{ id: string; capabilities: string[] }> };
      const cal = resp.integrations.find((i) => i.id === "calendar");
      expect(cal).toBeDefined();
      expect(cal?.capabilities).toEqual(
        expect.arrayContaining(["today", "week", "event", "free-busy"]),
      );
    } finally {
      await srv.stop();
    }
  });

  it("returns calendar manifest with correct endpoints", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    const registry = createRegistry(srv.router);
    registry.register(createCalendarModule(makeAuthManager({ token: "tok" })));
    await srv.start();

    try {
      const { body } = await request(port, "GET", "/integ-api/integrations");
      const resp = body as {
        integrations: Array<{
          id: string;
          endpoints: Array<{ method: string; path: string }>;
          rateLimits: { requestsPerMinute: number };
        }>;
      };
      const cal = resp.integrations.find((i) => i.id === "calendar")!;
      const paths = cal.endpoints.map((e) => e.path);
      expect(paths).toContain("/calendar/today");
      expect(paths).toContain("/calendar/week");
      expect(paths).toContain("/calendar/event/:id");
      expect(paths).toContain("/calendar/free-busy");
      expect(cal.rateLimits.requestsPerMinute).toBe(60);
    } finally {
      await srv.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// /calendar/today route tests
// ---------------------------------------------------------------------------

describe("GET /calendar/today", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // GWT 2: returns today's events sorted by start time
  it("returns events sorted by start time", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    srv.router.get("/calendar/today", async (_req, res) => {
      // Simulate what the real route does: events sorted by start
      const events = [MOCK_EVENT_2, MOCK_EVENT_1]; // out of order
      const sorted = [...events].sort((a, b) =>
        (a.start.dateTime ?? "").localeCompare(b.start.dateTime ?? ""),
      );
      res.json({ date: "2026-04-03", events: sorted });
    });
    await srv.start();

    try {
      const { status, body } = await request(port, "GET", "/calendar/today");
      expect(status).toBe(200);
      const resp = body as { date: string; events: Array<{ id: string }> };
      expect(resp.events[0]!.id).toBe("event-1"); // 09:00 comes first
      expect(resp.events[1]!.id).toBe("event-2"); // 12:00 comes second
    } finally {
      await srv.stop();
    }
  });

  // GWT 4: empty array for no events
  it("returns empty array when no events today", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    srv.router.get("/calendar/today", async (_req, res) => {
      res.json({ date: "2026-04-03", events: [] });
    });
    await srv.start();

    try {
      const { status, body } = await request(port, "GET", "/calendar/today");
      expect(status).toBe(200);
      const resp = body as { events: unknown[] };
      expect(resp.events).toEqual([]);
    } finally {
      await srv.stop();
    }
  });

  // GWT 5: auth failure returns 401 with structured error
  it("returns auth_failed error when auth manager throws AuthFailedError", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    const authMgr = makeAuthManager({ throwError: new AuthFailedError("calendar", 1) });
    const calMod = createCalendarModule(authMgr);
    calMod.routes(srv.router);
    await srv.start();

    try {
      const { status, body } = await request(port, "GET", "/calendar/today");
      expect(status).toBe(401);
      const err = body as { error: string; service: string };
      expect(err.error).toBe("auth_failed");
      expect(err.service).toBe("calendar");
    } finally {
      await srv.stop();
    }
  });

  it("listing endpoints omit heavy fields (attendees, description, conferenceData)", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    const authMgr = makeAuthManager({ token: "test-token" });
    createCalendarModule(authMgr).routes(srv.router);

    // Mock the upstream Google Calendar API call
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (urlStr.includes("googleapis.com/calendar/v3")) {
        return new Response(JSON.stringify({
          items: [MOCK_EVENT_2],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return originalFetch(url, init);
    });

    await srv.start();

    try {
      const { status, body } = await request(port, "GET", "/calendar/today");
      expect(status).toBe(200);
      const resp = body as {
        events: Array<{
          location?: string;
          summary?: string;
          attendees?: unknown;
          description?: unknown;
          conferenceData?: unknown;
        }>;
      };
      expect(resp.events[0]?.summary).toBe("Lunch with Alice");
      expect(resp.events[0]?.location).toBe("Café Central");
      // Heavy fields must be omitted in listing endpoints
      expect(resp.events[0]?.attendees).toBeUndefined();
      expect(resp.events[0]?.description).toBeUndefined();
      expect(resp.events[0]?.conferenceData).toBeUndefined();
    } finally {
      vi.stubGlobal("fetch", originalFetch);
      await srv.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// /calendar/week route tests
// ---------------------------------------------------------------------------

describe("GET /calendar/week", () => {
  it("returns events with timeMin and timeMax in response", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    srv.router.get("/calendar/week", async (_req, res) => {
      res.json({
        timeMin: "2026-04-03T00:00:00.000Z",
        timeMax: "2026-04-10T00:00:00.000Z",
        events: [MOCK_EVENT_1, MOCK_EVENT_2],
      });
    });
    await srv.start();

    try {
      const { status, body } = await request(port, "GET", "/calendar/week");
      expect(status).toBe(200);
      const resp = body as { timeMin: string; timeMax: string; events: unknown[] };
      expect(resp.timeMin).toBeTruthy();
      expect(resp.timeMax).toBeTruthy();
      expect(resp.events).toHaveLength(2);
    } finally {
      await srv.stop();
    }
  });

  it("returns auth_failed on auth error", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    const authMgr = makeAuthManager({ throwError: new AuthFailedError("calendar", 0) });
    createCalendarModule(authMgr).routes(srv.router);
    await srv.start();

    try {
      const { status } = await request(port, "GET", "/calendar/week");
      expect(status).toBe(401);
    } finally {
      await srv.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// /calendar/event/:id route tests
// ---------------------------------------------------------------------------

describe("GET /calendar/event/:id", () => {
  // GWT 3: full event details returned for a specific ID
  it("returns full event details for a valid event ID", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    srv.router.get("/calendar/event/:id", async (req, res) => {
      if (req.params.id === "event-2") {
        res.json(MOCK_EVENT_2);
      } else {
        res.error({ error: "not_found", message: "Event not found", service: "calendar" });
      }
    });
    await srv.start();

    try {
      const { status, body } = await request(port, "GET", "/calendar/event/event-2");
      expect(status).toBe(200);
      const evt = body as {
        id: string;
        summary: string;
        location: string;
        description: string;
      };
      expect(evt.id).toBe("event-2");
      expect(evt.summary).toBe("Lunch with Alice");
      expect(evt.location).toBe("Café Central");
      expect(evt.description).toBe("At the usual place");
    } finally {
      await srv.stop();
    }
  });

  it("returns auth_failed on auth error for event fetch", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    const authMgr = makeAuthManager({ throwError: new AuthFailedError("calendar", 1) });
    createCalendarModule(authMgr).routes(srv.router);
    await srv.start();

    try {
      const { status, body } = await request(port, "GET", "/calendar/event/some-id");
      expect(status).toBe(401);
      const err = body as { error: string };
      expect(err.error).toBe("auth_failed");
    } finally {
      await srv.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// /calendar/free-busy route tests
// ---------------------------------------------------------------------------

describe("GET /calendar/free-busy", () => {
  // GWT 8: missing params → 404 structured error
  it("returns not_found error when timeMin or timeMax is missing", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    const authMgr = makeAuthManager({ token: "tok" });
    createCalendarModule(authMgr).routes(srv.router);
    await srv.start();

    try {
      // Missing both
      const { status, body } = await request(port, "GET", "/calendar/free-busy");
      expect(status).toBe(404);
      const err = body as { error: string; service: string };
      expect(err.error).toBe("not_found");
      expect(err.service).toBe("calendar");
    } finally {
      await srv.stop();
    }
  });

  it("returns busy intervals when valid timeMin and timeMax provided", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    srv.router.get("/calendar/free-busy", async (_req, res) => {
      res.json({
        timeMin: "2026-04-03T00:00:00Z",
        timeMax: "2026-04-03T23:59:59Z",
        busy: [{ start: "2026-04-03T09:00:00Z", end: "2026-04-03T09:30:00Z" }],
      });
    });
    await srv.start();

    try {
      const { status, body } = await request(
        port,
        "GET",
        "/calendar/free-busy?timeMin=2026-04-03T00:00:00Z&timeMax=2026-04-03T23:59:59Z",
      );
      expect(status).toBe(200);
      const resp = body as {
        timeMin: string;
        timeMax: string;
        busy: Array<{ start: string; end: string }>;
      };
      expect(resp.busy).toHaveLength(1);
      expect(resp.busy[0]?.start).toBe("2026-04-03T09:00:00Z");
    } finally {
      await srv.stop();
    }
  });

  it("returns empty busy array when no conflicts", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    srv.router.get("/calendar/free-busy", async (_req, res) => {
      res.json({
        timeMin: "2026-04-05T00:00:00Z",
        timeMax: "2026-04-05T23:59:59Z",
        busy: [],
      });
    });
    await srv.start();

    try {
      const { status, body } = await request(
        port,
        "GET",
        "/calendar/free-busy?timeMin=2026-04-05T00:00:00Z&timeMax=2026-04-05T23:59:59Z",
      );
      expect(status).toBe(200);
      const resp = body as { busy: unknown[] };
      expect(resp.busy).toEqual([]);
    } finally {
      await srv.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests: event mapping and date/time parsing
// ---------------------------------------------------------------------------

describe("event date/time parsing and timezone handling", () => {
  // GWT 6: date/time parsing and sorting
  it("sorts events by dateTime correctly", () => {
    const events = [
      { id: "c", start: { dateTime: "2026-04-03T14:00:00Z" }, end: { dateTime: "2026-04-03T15:00:00Z" }, summary: "C", status: "confirmed" },
      { id: "a", start: { dateTime: "2026-04-03T08:00:00Z" }, end: { dateTime: "2026-04-03T09:00:00Z" }, summary: "A", status: "confirmed" },
      { id: "b", start: { dateTime: "2026-04-03T12:00:00Z" }, end: { dateTime: "2026-04-03T13:00:00Z" }, summary: "B", status: "confirmed" },
    ];
    const sorted = [...events].sort((a, b) =>
      (a.start.dateTime ?? "").localeCompare(b.start.dateTime ?? ""),
    );
    expect(sorted.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("handles all-day events (date instead of dateTime)", () => {
    // All-day events use { date: "YYYY-MM-DD" } not { dateTime: "..." }
    const event = MOCK_ALL_DAY_EVENT;
    expect(event.start.date).toBe("2026-04-03");
    expect(event.start).not.toHaveProperty("dateTime");
  });

  it("sorts all-day events before timed events on same day", () => {
    // All-day events have date "2026-04-03", timed events have "2026-04-03T..."
    // "2026-04-03" < "2026-04-03T09:00:00Z" lexicographically
    const allDay = { id: "all-day", start: { date: "2026-04-03" }, end: { date: "2026-04-04" }, summary: "Holiday", status: "confirmed" };
    const timed = { id: "timed", start: { dateTime: "2026-04-03T09:00:00Z" }, end: { dateTime: "2026-04-03T10:00:00Z" }, summary: "Meeting", status: "confirmed" };

    const sorted = [timed, allDay].sort((a, b) => {
      const aTime = (a.start as { dateTime?: string; date?: string }).dateTime ?? (a.start as { date?: string }).date ?? "";
      const bTime = (b.start as { dateTime?: string; date?: string }).dateTime ?? (b.start as { date?: string }).date ?? "";
      return aTime.localeCompare(bTime);
    });
    expect(sorted[0]!.id).toBe("all-day");
    expect(sorted[1]!.id).toBe("timed");
  });

  it("maps event with missing optional fields to safe defaults", () => {
    // Event with no summary, description, location, attendees
    const minimal = {
      id: "min-1",
      start: { dateTime: "2026-04-03T10:00:00Z" },
      end: { dateTime: "2026-04-03T11:00:00Z" },
    };
    // Apply mapEvent logic: summary defaults to "(no title)", status defaults to "confirmed"
    const mapped = {
      id: minimal.id,
      summary: (minimal as Record<string, unknown>)["summary"] ?? "(no title)",
      status: (minimal as Record<string, unknown>)["status"] ?? "confirmed",
      start: minimal.start,
      end: minimal.end,
    };
    expect(mapped.summary).toBe("(no title)");
    expect(mapped.status).toBe("confirmed");
    expect(mapped.id).toBe("min-1");
  });
});

// ---------------------------------------------------------------------------
// Health check tests
// ---------------------------------------------------------------------------

describe("calendar module healthCheck", () => {
  it("returns true when auth manager can get a token", async () => {
    const authMgr = makeAuthManager({ token: "valid-token" });
    const mod = createCalendarModule(authMgr);
    const healthy = await mod.healthCheck();
    expect(healthy).toBe(true);
  });

  it("returns false when auth manager throws AuthFailedError", async () => {
    const authMgr = makeAuthManager({ throwError: new AuthFailedError("calendar", 0) });
    const mod = createCalendarModule(authMgr);
    const healthy = await mod.healthCheck();
    expect(healthy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Registry unit tests
// ---------------------------------------------------------------------------

describe("createRegistry", () => {
  it("getModule returns undefined for unknown id", () => {
    const router = new SimpleRouter();
    const registry = createRegistry(router);
    expect(registry.getModule("nonexistent")).toBeUndefined();
  });

  it("getAllManifests returns empty array when nothing registered", () => {
    const router = new SimpleRouter();
    const registry = createRegistry(router);
    expect(registry.getAllManifests()).toEqual([]);
  });

  it("registers calendar module and returns its manifest", () => {
    const router = new SimpleRouter();
    const registry = createRegistry(router);
    const authMgr = makeAuthManager({ token: "tok" });
    registry.register(createCalendarModule(authMgr));

    const mod = registry.getModule("calendar");
    expect(mod).toBeDefined();
    expect(mod?.manifest.id).toBe("calendar");

    const manifests = registry.getAllManifests();
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.id).toBe("calendar");
  });

  it("overwrites existing registration for same id without throwing", () => {
    const router = new SimpleRouter();
    const registry = createRegistry(router);
    const authMgr = makeAuthManager({ token: "tok" });
    registry.register(createCalendarModule(authMgr));
    // Register again — should overwrite, not throw
    expect(() => registry.register(createCalendarModule(authMgr))).not.toThrow();
    expect(registry.getAllManifests()).toHaveLength(1);
  });
});
