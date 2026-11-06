import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AUDIT_MAX_BYTES, createAuditLog, toAuditLine } from "./audit.js";

describe("audit", () => {
  let dir: string;
  const fixedNow = () => new Date("2026-11-06T10:00:00.000Z");

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("appends one JSON line with mode 0600", async () => {
    const audit = createAuditLog({ dir, caller: "daemon", now: fixedNow });
    await audit.record({ action: "start", session: "pa-x-1a2b", project: "x", kind: "claude", permissionMode: "default", ok: true });
    await audit.record({ action: "stop", session: "pa-x-1a2b", ok: false, code: "BUSY" });
    const file = path.join(dir, "audit.jsonl");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ ts: "2026-11-06T10:00:00.000Z", action: "start", ok: true, caller: "daemon", project: "x" });
    expect(lines[1]).toMatchObject({ action: "stop", ok: false, code: "BUSY" });
  });

  it("never stores the input text, only its length and a short hash", async () => {
    const audit = createAuditLog({ dir, caller: "daemon", now: fixedNow });
    await audit.record({ action: "send", session: "pa-x-1a2b", ok: true, input: "my secret task text" });
    const raw = fs.readFileSync(path.join(dir, "audit.jsonl"), "utf-8");
    expect(raw).not.toContain("secret");
    const line = JSON.parse(raw) as Record<string, unknown>;
    expect(line["inputLen"]).toBe(19);
    expect(line["inputSha12"]).toMatch(/^[0-9a-f]{12}$/);
    expect(line).not.toHaveProperty("input");
  });

  it("toAuditLine hashes deterministically", () => {
    const a = toAuditLine({ action: "send", ok: true, input: "x" }, "c", fixedNow());
    const b = toAuditLine({ action: "send", ok: true, input: "x" }, "c", fixedNow());
    expect(a["inputSha12"]).toBe(b["inputSha12"]);
  });

  it("rotates to one backup file when the audit file is too large", async () => {
    const file = path.join(dir, "audit.jsonl");
    fs.writeFileSync(file, "x".repeat(AUDIT_MAX_BYTES + 1));
    const audit = createAuditLog({ dir, caller: "daemon", now: fixedNow });
    await audit.record({ action: "list", ok: true });
    expect(fs.statSync(`${file}.1`).size).toBe(AUDIT_MAX_BYTES + 1);
    expect(fs.readFileSync(file, "utf-8").trim().split("\n")).toHaveLength(1);
  });

  it("does not throw when the audit file cannot be written", async () => {
    const blocked = path.join(dir, "file-not-dir");
    fs.writeFileSync(blocked, "");
    const audit = createAuditLog({ dir: path.join(blocked, "sub"), caller: "daemon", now: fixedNow });
    await expect(audit.record({ action: "list", ok: true })).resolves.toBeUndefined();
  });
});
