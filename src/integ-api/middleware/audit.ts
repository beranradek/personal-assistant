/**
 * Integ-API Audit Middleware
 * ==========================
 *
 * JSONL request/response logger. Appends one record per request to
 * {dataDir}/integ-api/audit.jsonl with timestamp, method, path, status,
 * and duration.
 *
 * This is the single chokepoint for auditing all external API access made
 * through the integ-api service.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../../core/logger.js";
import type { Middleware } from "../types.js";

const log = createLogger("integ-api:audit");

// ---------------------------------------------------------------------------
// Audit record type
// ---------------------------------------------------------------------------

interface AuditRecord {
  ts: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// createAuditMiddleware
// ---------------------------------------------------------------------------

/**
 * Create a JSONL audit middleware.
 *
 * @param dataDir - The global dataDir from config (e.g., ~/.personal-assistant)
 */
export function createAuditMiddleware(dataDir: string): Middleware {
  const auditDir = path.join(dataDir, "integ-api");
  const auditPath = path.join(auditDir, "audit.jsonl");

  // Ensure the directory exists synchronously on first write.
  // Sync I/O is acceptable here: the audit dir is created once, write is tiny.
  let dirEnsured = false;
  function ensureDir(): void {
    if (dirEnsured) return;
    fs.mkdirSync(auditDir, { recursive: true });
    dirEnsured = true;
  }

  return async (req, res, next) => {
    const start = Date.now();
    await next();
    // Response has been sent by the handler inside next().
    // Use synchronous write so the log entry is persisted before the
    // event loop can process the client's response receipt — eliminates
    // timing races in tests and ensures auditability.
    const durationMs = Date.now() - start;

    const record: AuditRecord = {
      ts: new Date().toISOString(),
      method: req.method ?? "UNKNOWN",
      path: req.url ?? "/",
      status: res.raw.statusCode ?? 0,
      durationMs,
    };

    const line = JSON.stringify(record) + "\n";

    try {
      ensureDir();
      fs.appendFileSync(auditPath, line, "utf8");
    } catch (err) {
      // Audit log failure must never break the request — log and continue
      log.error({ err, record }, "Failed to write audit log entry");
    }
  };
}
