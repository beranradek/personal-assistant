import { describe, it, expect } from "vitest";
import pino from "pino";
import { Writable } from "node:stream";
import { REDACT_PATHS } from "./logger.js";

function createTestLogger() {
  const lines: string[] = [];

  const stream = new Writable({
    write(chunk, _encoding, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });

  const log = pino(
    { redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } },
    stream,
  );

  return { log, parse: () => JSON.parse(lines[lines.length - 1]) };
}

describe("logger redaction", () => {
  it("redacts botToken in a nested object", () => {
    const { log, parse } = createTestLogger();
    log.info({ adapter: { botToken: "secret-token-123" } }, "test");
    const entry = parse();
    expect(entry.adapter.botToken).toBe("[REDACTED]");
  });

  it("redacts appToken in a nested object", () => {
    const { log, parse } = createTestLogger();
    log.info({ config: { appToken: "xapp-secret" } }, "test");
    const entry = parse();
    expect(entry.config.appToken).toBe("[REDACTED]");
  });

  it("redacts password field", () => {
    const { log, parse } = createTestLogger();
    log.info({ db: { password: "hunter2" } }, "test");
    const entry = parse();
    expect(entry.db.password).toBe("[REDACTED]");
  });

  it("redacts apiKey and api_key", () => {
    const { log, parse } = createTestLogger();
    log.info({ svc: { apiKey: "sk-123", api_key: "sk-456" } }, "test");
    const entry = parse();
    expect(entry.svc.apiKey).toBe("[REDACTED]");
    expect(entry.svc.api_key).toBe("[REDACTED]");
  });

  it("redacts authorization header", () => {
    const { log, parse } = createTestLogger();
    log.info(
      { req: { authorization: "Bearer xyz", Authorization: "Bearer abc" } },
      "test",
    );
    const entry = parse();
    expect(entry.req.authorization).toBe("[REDACTED]");
    expect(entry.req.Authorization).toBe("[REDACTED]");
  });

  it("redacts secret field", () => {
    const { log, parse } = createTestLogger();
    log.info({ webhook: { secret: "whsec_abc" } }, "test");
    const entry = parse();
    expect(entry.webhook.secret).toBe("[REDACTED]");
  });

  it("redacts token field", () => {
    const { log, parse } = createTestLogger();
    log.info({ session: { token: "jwt-token-value" } }, "test");
    const entry = parse();
    expect(entry.session.token).toBe("[REDACTED]");
  });

  it("does not redact non-sensitive fields", () => {
    const { log, parse } = createTestLogger();
    log.info({ adapter: { name: "telegram", enabled: true } }, "test");
    const entry = parse();
    expect(entry.adapter.name).toBe("telegram");
    expect(entry.adapter.enabled).toBe(true);
  });
});
