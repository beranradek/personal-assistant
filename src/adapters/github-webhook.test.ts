import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createGithubWebhookAdapter } from "./github-webhook.js";

let portCounter = 19300;
function nextPort(): number {
  return portCounter++;
}

function sign(secret: string, body: string): string {
  const h = crypto.createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex");
  return `sha256=${h}`;
}

async function postJson(
  port: number,
  pathName: string,
  headers: Record<string, string>,
  payload: unknown,
): Promise<{ status: number; body: unknown }> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathName,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body).toString(),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = raw;
          try { parsed = raw ? JSON.parse(raw) : raw; } catch { /* ignore */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function postRaw(
  port: number,
  pathName: string,
  headers: Record<string, string>,
  rawBody: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathName,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(rawBody).toString(),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = raw;
          try { parsed = raw ? JSON.parse(raw) : raw; } catch { /* ignore */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });
}

describe("github webhook adapter", () => {
  const secretEnvVar = "PA_TEST_GH_WEBHOOK_SECRET";
  const secret = "test_secret_123";
  let tmpDir: string;

  beforeEach(async () => {
    process.env[secretEnvVar] = secret;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pa-gh-webhook-"));
  });

  afterEach(async () => {
    delete process.env[secretEnvVar];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("enqueues on issue_comment mention and persists idempotency", async () => {
    const port = nextPort();
    const onMessage = vi.fn();
    const createIssueComment = vi.fn(async () => {});

    const adapter = createGithubWebhookAdapter(
      {
        enabled: true,
        bind: "127.0.0.1",
        port,
        path: "/personal-assistant/github/webhook",
        botLogin: "my-bot",
        secretEnvVar,
      },
      {
        dataDir: tmpDir,
        onMessage,
        githubClient: { createIssueComment },
      },
    );

    await adapter.start();

    const payload = {
      action: "created",
      repository: { full_name: "owner/repo" },
      sender: { login: "human" },
      issue: { id: 999, number: 123, state: "open", body: "" },
      comment: { id: 555, body: "@my-bot implement this please" },
    };
    const body = JSON.stringify(payload);

    const r1 = await postJson(port, "/personal-assistant/github/webhook", {
      "X-GitHub-Event": "issue_comment",
      "X-GitHub-Delivery": "d-1",
      "X-Hub-Signature-256": sign(secret, body),
    }, payload);

    expect(r1.status).toBe(202);
    expect(onMessage).toHaveBeenCalledTimes(1);
    const msg = onMessage.mock.calls[0]?.[0];
    expect(msg?.source).toBe("github");
    expect(msg?.metadata?.command).toBe("implement");
    // Ack comment is best-effort (not awaited by handler)
    await new Promise((r) => setTimeout(r, 10));
    expect(createIssueComment).toHaveBeenCalledTimes(1);

    // Repeat same comment id with new delivery should be deduped by persisted state
    const r2 = await postJson(port, "/personal-assistant/github/webhook", {
      "X-GitHub-Event": "issue_comment",
      "X-GitHub-Delivery": "d-2",
      "X-Hub-Signature-256": sign(secret, body),
    }, payload);

    expect(r2.status).toBe(202);
    expect(onMessage).toHaveBeenCalledTimes(1);

    await adapter.stop();
  });

  it("rejects wrong method/path and missing secret/signature", async () => {
    const port = nextPort();
    const onMessage = vi.fn();

    const adapter = createGithubWebhookAdapter(
      {
        enabled: true,
        bind: "127.0.0.1",
        port,
        path: "/personal-assistant/github/webhook",
        botLogin: "my-bot",
        secretEnvVar,
      },
      {
        dataDir: tmpDir,
        onMessage,
        githubClient: { createIssueComment: vi.fn(async () => {}) },
      },
    );

    await adapter.start();

    // Wrong path
    const payload = { ok: true };
    const body = JSON.stringify(payload);
    const r404 = await postJson(port, "/wrong", {
      "X-GitHub-Event": "issue_comment",
      "X-GitHub-Delivery": "d-404",
      "X-Hub-Signature-256": sign(secret, body),
    }, payload);
    expect(r404.status).toBe(404);

    // Missing secret env var -> 503
    delete process.env[secretEnvVar];
    const r503 = await postJson(port, "/personal-assistant/github/webhook", {
      "X-GitHub-Event": "issue_comment",
      "X-GitHub-Delivery": "d-503",
      "X-Hub-Signature-256": sign(secret, body),
    }, payload);
    expect(r503.status).toBe(503);
    process.env[secretEnvVar] = secret;

    // Bad signature -> 401
    const r401 = await postJson(port, "/personal-assistant/github/webhook", {
      "X-GitHub-Event": "issue_comment",
      "X-GitHub-Delivery": "d-401",
      "X-Hub-Signature-256": "sha256=deadbeef",
    }, payload);
    expect(r401.status).toBe(401);

    await adapter.stop();
  });

  it("handles invalid json and invalid payload shapes", async () => {
    const port = nextPort();
    const onMessage = vi.fn();

    const adapter = createGithubWebhookAdapter(
      {
        enabled: true,
        bind: "127.0.0.1",
        port,
        path: "/personal-assistant/github/webhook",
        botLogin: "my-bot",
        secretEnvVar,
      },
      {
        dataDir: tmpDir,
        onMessage,
        githubClient: { createIssueComment: vi.fn(async () => {}) },
      },
    );

    await adapter.start();

    // Invalid JSON (but correctly signed)
    const rawBody = "{not-json";
    const rBadJson = await postRaw(port, "/personal-assistant/github/webhook", {
      "X-GitHub-Event": "issues",
      "X-GitHub-Delivery": "d-bad-json",
      "X-Hub-Signature-256": sign(secret, rawBody),
    }, rawBody);
    expect(rBadJson.status).toBe(400);

    // Valid JSON but missing required repo/issue fields
    const payload = { action: "opened" };
    const body = JSON.stringify(payload);
    const rInvalidPayload = await postJson(port, "/personal-assistant/github/webhook", {
      "X-GitHub-Event": "issues",
      "X-GitHub-Delivery": "d-invalid",
      "X-Hub-Signature-256": sign(secret, body),
    }, payload);
    expect(rInvalidPayload.status).toBe(400);

    await adapter.stop();
  });

  it("ignores closed issues and supports issues assigned/body mention triggers", async () => {
    const port = nextPort();
    const onMessage = vi.fn();
    const createIssueComment = vi.fn(async () => {});

    const adapter = createGithubWebhookAdapter(
      {
        enabled: true,
        bind: "127.0.0.1",
        port,
        path: "/personal-assistant/github/webhook",
        botLogin: "my-bot",
        secretEnvVar,
      },
      {
        dataDir: tmpDir,
        onMessage,
        githubClient: { createIssueComment },
      },
    );

    await adapter.start();

    // Closed issues are ignored
    {
      const payload = {
        action: "opened",
        repository: { full_name: "owner/repo" },
        sender: { login: "human" },
        issue: { id: 1, number: 1, state: "closed", body: "@my-bot implement" },
      };
      const body = JSON.stringify(payload);
      const r = await postJson(port, "/personal-assistant/github/webhook", {
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "d-closed",
        "X-Hub-Signature-256": sign(secret, body),
      }, payload);
      expect(r.status).toBe(202);
      expect(onMessage).toHaveBeenCalledTimes(0);
    }

    // Assigned to bot triggers once; second assignment dedupes as in progress
    {
      const payload = {
        action: "assigned",
        repository: { full_name: "owner/repo" },
        sender: { login: "human" },
        assignee: { login: "my-bot" },
        issue: { id: 42, number: 7, state: "open", body: "" },
      };
      const body = JSON.stringify(payload);
      const r1 = await postJson(port, "/personal-assistant/github/webhook", {
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "d-assigned-1",
        "X-Hub-Signature-256": sign(secret, body),
      }, payload);
      expect(r1.status).toBe(202);
      const r2 = await postJson(port, "/personal-assistant/github/webhook", {
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "d-assigned-2",
        "X-Hub-Signature-256": sign(secret, body),
      }, payload);
      expect(r2.status).toBe(202);
    }

    // Body mention on opened triggers
    {
      const payload = {
        action: "opened",
        repository: { full_name: "owner/repo" },
        sender: { login: "human" },
        issue: { id: 1234, number: 99, state: "open", body: "Hi @my-bot fix this" },
      };
      const body = JSON.stringify(payload);
      const r = await postJson(port, "/personal-assistant/github/webhook", {
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "d-opened",
        "X-Hub-Signature-256": sign(secret, body),
      }, payload);
      expect(r.status).toBe(202);
    }

    expect(onMessage).toHaveBeenCalled();

    await adapter.stop();
  });

  it("accepts mention without a recognized command", async () => {
    const port = nextPort();
    const onMessage = vi.fn();
    const createIssueComment = vi.fn(async () => {});

    const adapter = createGithubWebhookAdapter(
      {
        enabled: true,
        bind: "127.0.0.1",
        port,
        path: "/personal-assistant/github/webhook",
        botLogin: "my-bot",
        secretEnvVar,
      },
      {
        dataDir: tmpDir,
        onMessage,
        githubClient: { createIssueComment },
      },
    );

    await adapter.start();

    const payload = {
      action: "created",
      repository: { full_name: "owner/repo" },
      sender: { login: "human" },
      issue: { id: 999, number: 123, state: "open", body: "" },
      comment: { id: 556, body: "@my-bot do-the-thing pls" },
    };
    const body = JSON.stringify(payload);

    const r = await postJson(port, "/personal-assistant/github/webhook", {
      "X-GitHub-Event": "issue_comment",
      "X-GitHub-Delivery": "d-unknown",
      "X-Hub-Signature-256": sign(secret, body),
    }, payload);

    expect(r.status).toBe(202);
    expect(onMessage).toHaveBeenCalledTimes(1);
    const msg = onMessage.mock.calls[0]?.[0];
    expect(msg?.metadata?.command).toBe(null);

    await adapter.stop();
  });

  it("ignores bot sender comments to avoid loops", async () => {
    const port = nextPort();
    const onMessage = vi.fn();
    const createIssueComment = vi.fn(async () => {});

    const adapter = createGithubWebhookAdapter(
      {
        enabled: true,
        bind: "127.0.0.1",
        port,
        path: "/personal-assistant/github/webhook",
        botLogin: "my-bot",
        secretEnvVar,
      },
      {
        dataDir: tmpDir,
        onMessage,
        githubClient: { createIssueComment },
      },
    );

    await adapter.start();

    const payload = {
      action: "created",
      repository: { full_name: "owner/repo" },
      sender: { login: "my-bot" },
      issue: { id: 999, number: 123, state: "open", body: "" },
      comment: { id: 777, body: "@my-bot continue" },
    };
    const body = JSON.stringify(payload);

    const r = await postJson(port, "/personal-assistant/github/webhook", {
      "X-GitHub-Event": "issue_comment",
      "X-GitHub-Delivery": "d-bot",
      "X-Hub-Signature-256": sign(secret, body),
    }, payload);

    expect(r.status).toBe(202);
    expect(onMessage).toHaveBeenCalledTimes(0);
    expect(createIssueComment).toHaveBeenCalledTimes(0);

    await adapter.stop();
  });
});
