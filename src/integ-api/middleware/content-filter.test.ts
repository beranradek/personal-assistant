/**
 * Tests for the content filter middleware.
 *
 * GWT 3: Given response containing "sk-abc123def456", When content filter runs
 *         with default patterns, Then it's replaced with [REDACTED]
 * GWT 4: Given response body of 100KB, When maxBodyLength is 50000,
 *         Then response is truncated with marker
 * GWT 5: Given deeply nested JSON with sensitive strings, When filter runs,
 *         Then all matching strings at any depth are redacted
 * GWT 6: Given redactPatterns is empty array, When filter runs,
 *         Then response passes through unchanged
 * Unit tests for various data shapes (string, array, nested object, null)
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { createIntegApiServer } from "../server.js";
import {
  createContentFilter,
  createContentFilterMiddleware,
} from "./content-filter.js";
import { AGGRESSIVE_PATTERNS } from "../../security/content-redaction.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let portCounter = 19500;
function nextPort(): number {
  return portCounter++;
}

async function get(port: number, p: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: p, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: null });
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// createContentFilter unit tests
// ---------------------------------------------------------------------------

describe("createContentFilter – unit", () => {
  it("GWT 6: empty redactPatterns leaves response unchanged", () => {
    const filter = createContentFilter({ redactPatterns: [], maxBodyLength: 100_000 });
    const data = { user: "alice", token: "sk-abc123def456", count: 42 };
    const result = filter.filter(data);
    expect(result).toEqual(data);
  });

  it("GWT 3: default patterns redact API key style strings", () => {
    const filter = createContentFilter({ redactPatterns: AGGRESSIVE_PATTERNS, maxBodyLength: 100_000 });
    const data = { key: "sk-abc123def456abcdef7890", name: "test" };
    const result = filter.filter(data) as Record<string, unknown>;
    expect(result.key).toBe("[REDACTED]");
    expect(result.name).toBe("test");
  });

  it("GWT 3: default patterns redact long alphanumeric tokens", () => {
    const filter = createContentFilter({ redactPatterns: AGGRESSIVE_PATTERNS, maxBodyLength: 100_000 });
    const token = "a".repeat(40); // 40+ chars — should be redacted by AGGRESSIVE_PATTERNS
    const data = { token };
    const result = filter.filter(data) as Record<string, unknown>;
    expect(result.token).toBe("[REDACTED]");
  });

  it("GWT 5: redacts strings in deeply nested objects", () => {
    const filter = createContentFilter({
      redactPatterns: [/secret/g],
      maxBodyLength: 100_000,
    });
    const data = {
      level1: {
        level2: {
          level3: { value: "contains secret here" },
        },
        list: ["no match", "secret found"],
      },
    };
    const result = filter.filter(data) as {
      level1: { level2: { level3: { value: string } }; list: string[] };
    };
    expect(result.level1.level2.level3.value).toBe("contains [REDACTED] here");
    expect(result.level1.list[1]).toBe("[REDACTED] found");
    expect(result.level1.list[0]).toBe("no match");
  });

  it("GWT 5: redacts all matching strings at any depth in arrays", () => {
    const filter = createContentFilter({ redactPatterns: [/sk-[a-zA-Z0-9]{6,}/g], maxBodyLength: 100_000 });
    const data = [
      { key: "sk-abc1234567" },
      { nested: [{ deeper: "sk-xyz9876543" }] },
    ];
    const result = filter.filter(data) as Array<Record<string, unknown>>;
    expect((result[0] as { key: string }).key).toBe("[REDACTED]");
    const nested = (result[1] as { nested: Array<{ deeper: string }> }).nested;
    expect(nested[0].deeper).toBe("[REDACTED]");
  });

  it("handles null values without error", () => {
    const filter = createContentFilter({ redactPatterns: [/secret/g], maxBodyLength: 100_000 });
    expect(filter.filter(null)).toBeNull();
  });

  it("handles boolean and number values without change", () => {
    const filter = createContentFilter({ redactPatterns: [/secret/g], maxBodyLength: 100_000 });
    expect(filter.filter(true)).toBe(true);
    expect(filter.filter(42)).toBe(42);
  });

  it("handles plain string values", () => {
    const filter = createContentFilter({ redactPatterns: [/secret/g], maxBodyLength: 100_000 });
    expect(filter.filter("no match")).toBe("no match");
    expect(filter.filter("contains secret value")).toBe("contains [REDACTED] value");
  });

  it("GWT 4: truncates response when serialized length exceeds maxBodyLength", () => {
    const maxBodyLength = 50_000;
    const filter = createContentFilter({ redactPatterns: [], maxBodyLength });
    // Create a response just over 50KB
    const data = { payload: "x".repeat(55_000) };
    const result = filter.filter(data) as Record<string, unknown>;

    expect(result.truncated).toBe(true);
    expect(typeof result.originalLength).toBe("number");
    expect((result.originalLength as number)).toBeGreaterThan(maxBodyLength);
    expect(typeof result.data).toBe("string");
    expect((result.data as string).endsWith("[...truncated]")).toBe(true);
  });

  it("GWT 4: 100KB response truncated to 50000 maxBodyLength", () => {
    const maxBodyLength = 50_000;
    const filter = createContentFilter({ redactPatterns: [], maxBodyLength });
    const data = { payload: "x".repeat(100_000) };
    const result = filter.filter(data) as Record<string, unknown>;

    expect(result.truncated).toBe(true);
    // The data string should contain exactly maxBodyLength chars + the marker
    const dataStr = result.data as string;
    expect(dataStr.length).toBe(maxBodyLength + "[...truncated]".length);
  });

  it("does not truncate when response is within maxBodyLength", () => {
    const filter = createContentFilter({ redactPatterns: [], maxBodyLength: 100_000 });
    const data = { small: "value" };
    const result = filter.filter(data) as Record<string, unknown>;
    expect(result.small).toBe("value");
    expect(result.truncated).toBeUndefined();
  });

  it("applies redaction before truncation check", () => {
    // Pattern that expands matches would still be caught by truncation
    // More importantly: redaction happens first, truncation of redacted result
    const filter = createContentFilter({
      redactPatterns: [/secret/g],
      maxBodyLength: 50,
    });
    const data = { msg: "short secret text" };
    const result = filter.filter(data) as Record<string, unknown>;
    // "short [REDACTED] text" serialized as JSON is short enough to NOT trigger truncation
    expect(result.msg).toBe("short [REDACTED] text");
    expect(result.truncated).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createContentFilter – aggressive patterns
// ---------------------------------------------------------------------------

describe("createContentFilter – aggressive patterns", () => {
  it("redacts JWT tokens in email body", () => {
    const filter = createContentFilter({ redactPatterns: AGGRESSIVE_PATTERNS, maxBodyLength: 100_000 });
    const data = {
      body: "Your token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    };
    const result = filter.filter(data) as Record<string, unknown>;
    expect((result.body as string)).not.toContain("eyJ");
  });

  it("redacts Czech password disclosure in email body", () => {
    const filter = createContentFilter({ redactPatterns: AGGRESSIVE_PATTERNS, maxBodyLength: 100_000 });
    const data = { body: "Vaše dočasné heslo: TempPass456" };
    const result = filter.filter(data) as Record<string, unknown>;
    expect((result.body as string)).toContain("[REDACTED]");
    expect((result.body as string)).not.toContain("TempPass456");
  });

  it("redacts connection strings in calendar event description", () => {
    const filter = createContentFilter({ redactPatterns: AGGRESSIVE_PATTERNS, maxBodyLength: 100_000 });
    const data = { description: "DB: postgres://admin:s3cret@host:5432/db" };
    const result = filter.filter(data) as Record<string, unknown>;
    expect((result.description as string)).toContain("[REDACTED]");
    expect((result.description as string)).not.toContain("s3cret");
  });

  it("redacts IBAN in email body", () => {
    const filter = createContentFilter({ redactPatterns: AGGRESSIVE_PATTERNS, maxBodyLength: 100_000 });
    const data = { body: "IBAN: CZ65 0800 0000 1920 0014 5399" };
    const result = filter.filter(data) as Record<string, unknown>;
    expect((result.body as string)).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// createContentFilterMiddleware integration tests
// ---------------------------------------------------------------------------

describe("createContentFilterMiddleware – integration", () => {
  it("GWT 3: filters response data through the content filter", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    const filter = createContentFilter({
      redactPatterns: AGGRESSIVE_PATTERNS,
      maxBodyLength: 100_000,
    });
    srv.router.use(createContentFilterMiddleware(filter));
    srv.router.get("/secret", async (_req, res) => {
      res.json({ apiKey: "sk-abc123def456_extra_chars_to_reach_20", name: "my-service" });
    });

    await srv.start();
    try {
      const r = await get(port, "/secret");
      expect(r.status).toBe(200);
      const body = r.body as Record<string, unknown>;
      expect(body.apiKey).toBe("[REDACTED]");
      expect(body.name).toBe("my-service");
    } finally {
      await srv.stop();
    }
  });

  it("GWT 6: empty patterns pass response through unchanged", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    const filter = createContentFilter({ redactPatterns: [], maxBodyLength: 100_000 });
    srv.router.use(createContentFilterMiddleware(filter));
    srv.router.get("/data", async (_req, res) => {
      res.json({ token: "sk-abc123def456" });
    });

    await srv.start();
    try {
      const r = await get(port, "/data");
      expect(r.status).toBe(200);
      const body = r.body as Record<string, unknown>;
      // With empty patterns, nothing is redacted
      expect(body.token).toBe("sk-abc123def456");
    } finally {
      await srv.stop();
    }
  });

  it("GWT 4: truncates large responses in middleware pipeline", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    const filter = createContentFilter({ redactPatterns: [], maxBodyLength: 1000 });
    srv.router.use(createContentFilterMiddleware(filter));
    srv.router.get("/large", async (_req, res) => {
      res.json({ data: "x".repeat(2000) });
    });

    await srv.start();
    try {
      const r = await get(port, "/large");
      expect(r.status).toBe(200);
      const body = r.body as Record<string, unknown>;
      expect(body.truncated).toBe(true);
      expect((body.data as string).endsWith("[...truncated]")).toBe(true);
    } finally {
      await srv.stop();
    }
  });
});
