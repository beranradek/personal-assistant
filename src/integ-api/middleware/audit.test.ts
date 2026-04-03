/**
 * Tests for the audit middleware.
 *
 * GWT 4: Given a request is made, When audit middleware is active,
 *        Then a JSONL line is written to {dataDir}/integ-api/audit.jsonl
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { createIntegApiServer } from "../server.js";
import { createAuditMiddleware } from "./audit.js";

let portCounter = 19300;
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

describe("createAuditMiddleware", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes a JSONL line per request to {dataDir}/integ-api/audit.jsonl", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    srv.router.use(createAuditMiddleware(tmpDir));
    srv.router.get("/hello", async (_req, res) => res.json({ hi: true }));

    await srv.start();
    try {
      await get(port, "/hello");

      const auditPath = path.join(tmpDir, "integ-api", "audit.jsonl");
      const content = await fs.readFile(auditPath, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      expect(lines.length).toBe(1);

      const record = JSON.parse(lines[0]);
      expect(record.method).toBe("GET");
      expect(record.path).toBe("/hello");
      expect(record.status).toBe(200);
      expect(typeof record.durationMs).toBe("number");
      expect(typeof record.ts).toBe("string");
    } finally {
      await srv.stop();
    }
  });

  it("appends multiple JSONL lines for multiple requests", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    srv.router.use(createAuditMiddleware(tmpDir));
    srv.router.get("/a", async (_req, res) => res.json({}));
    srv.router.get("/b", async (_req, res) => res.json({}));

    await srv.start();
    try {
      await get(port, "/a");
      await get(port, "/b");

      const auditPath = path.join(tmpDir, "integ-api", "audit.jsonl");
      const content = await fs.readFile(auditPath, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      expect(lines.length).toBe(2);
    } finally {
      await srv.stop();
    }
  });

  it("creates the integ-api directory automatically", async () => {
    const port = nextPort();
    const srv = createIntegApiServer({ bind: "127.0.0.1", port });
    srv.router.use(createAuditMiddleware(tmpDir));
    srv.router.get("/x", async (_req, res) => res.json({}));

    await srv.start();
    try {
      await get(port, "/x");

      const auditDir = path.join(tmpDir, "integ-api");
      const stat = await fs.stat(auditDir);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await srv.stop();
    }
  });
});
