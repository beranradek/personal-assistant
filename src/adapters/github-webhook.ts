import * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import type { Adapter, AdapterMessage } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import { createAdapterMessage } from "./types.js";
import { TtlMap, DAY_MS } from "../core/ttl-map.js";

const log = createLogger("adapter:github-webhook");

// ---------------------------------------------------------------------------
// Config / deps
// ---------------------------------------------------------------------------

export interface GithubWebhookAdapterConfig {
  enabled: boolean;
  bind: string;
  port: number;
  path: string;
  botLogin: string;
  secretEnvVar: string;
}

export interface GithubWebhookAdapterDeps {
  /** Base directory for persisted state. Typically config.security.dataDir. */
  dataDir: string;
  /** Called when a webhook should trigger a new agent run. */
  onMessage: (msg: AdapterMessage) => void;
  /** GitHub API client used to post issue comments (ack + routed responses). */
  githubClient?: GithubClient;
  /** Override state file path (useful for tests). */
  stateFilePath?: string;
}

export interface GithubClient {
  createIssueComment(input: { repo: string; issueNumber: number; body: string }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Persistent idempotency / progress state
// ---------------------------------------------------------------------------

const IssueStateSchema = z.object({
  inProgress: z.boolean().default(false),
  lastProcessedCommentId: z.number().int().positive().nullable().default(null),
  updatedAt: z.string(),
});

type IssueState = z.infer<typeof IssueStateSchema>;

const WebhookStateSchema = z.object({
  version: z.number().int().default(1),
  issues: z.record(z.string(), IssueStateSchema).default({}),
});

type WebhookState = z.infer<typeof WebhookStateSchema>;

async function loadState(filePath: string): Promise<WebhookState> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return WebhookStateSchema.parse({ version: 1, issues: {} });
    }
    throw err;
  }

  if (raw.trim() === "") {
    return WebhookStateSchema.parse({ version: 1, issues: {} });
  }

  try {
    return WebhookStateSchema.parse(JSON.parse(raw) as unknown);
  } catch (err) {
    log.warn({ err, filePath }, "Corrupt GitHub webhook state file, starting fresh");
    return WebhookStateSchema.parse({ version: 1, issues: {} });
  }
}

async function saveState(filePath: string, state: WebhookState): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = filePath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tmp, filePath);
}

function issueKey(repo: string, issueId: number): string {
  return `${repo}#${issueId}`;
}

// ---------------------------------------------------------------------------
// GitHub client (gh CLI)
// ---------------------------------------------------------------------------

function runGh(args: string[], stdin?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { stderr += String(d); });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`gh ${args.join(" ")} failed (code ${code}): ${stderr.trim()}`));
    });

    if (stdin != null) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

function createDefaultGithubClient(): GithubClient {
  return {
    async createIssueComment({ repo, issueNumber, body }) {
      await runGh(
        ["issue", "comment", String(issueNumber), "--repo", repo, "--body-file", "-"],
        body,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Webhook parsing
// ---------------------------------------------------------------------------

type Trigger =
  | { type: "assigned" }
  | { type: "comment_mention"; commentId: number; command: string | null; commentBody: string }
  | { type: "body_mention"; command: string | null };

function extractMentionCommand(text: string, botLogin: string): { mentioned: boolean; command: string | null } {
  const re = new RegExp(`@${botLogin}\\b([^\\n\\r]*)`, "i");
  const m = text.match(re);
  if (!m) return { mentioned: false, command: null };
  const tail = (m[1] ?? "").trim();
  if (!tail) return { mentioned: true, command: null };
  const first = tail.split(/\s+/)[0] ?? "";
  const cmd = first.toLowerCase();
  const allowed = new Set(["implement", "fix", "rebase", "continue"]);
  return { mentioned: true, command: allowed.has(cmd) ? cmd : null };
}

function readHeader(req: http.IncomingMessage, name: string): string | null {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  if (!signatureHeader.startsWith("sha256=")) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  const a = Buffer.from(signatureHeader, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export function createGithubWebhookAdapter(
  config: GithubWebhookAdapterConfig,
  deps: GithubWebhookAdapterDeps,
): Adapter {
  const github = deps.githubClient ?? createDefaultGithubClient();
  const stateFilePath =
    deps.stateFilePath ?? path.join(deps.dataDir, "github-webhook-state.json");

  const seenDeliveries = new TtlMap<string, true>(DAY_MS);

  let server: http.Server | null = null;

  async function handleWebhook(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== config.path) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    const secret = process.env[config.secretEnvVar];
    if (!secret) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "service_unavailable", message: "Webhook secret not configured" }));
      return;
    }

    // Read raw body (needed for signature verification)
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX_BODY_BYTES = 1_000_000;

    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          reject(new Error("payload_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve());
      req.on("error", reject);
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "payload_too_large") {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "payload_too_large" }));
        return;
      }
      throw err;
    });

    const rawBody = Buffer.concat(chunks);

    const signature = readHeader(req, "x-hub-signature-256");
    if (!verifySignature(rawBody, signature, secret)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "auth_failed" }));
      return;
    }

    const event = readHeader(req, "x-github-event") ?? "";
    const delivery = readHeader(req, "x-github-delivery") ?? "";
    if (delivery && seenDeliveries.has(delivery)) {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, deduped: true }));
      return;
    }
    if (delivery) seenDeliveries.set(delivery, true);

    let payload: any;
    try {
      payload = rawBody.length ? JSON.parse(rawBody.toString("utf8")) : {};
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_json" }));
      return;
    }

    // Ping is a one-time health check when the webhook is created; respond early
    // before issue-specific field validation.
    if (event === "ping") {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ignored: "ping" }));
      return;
    }

    // Basic validation (keep permissive, GitHub payloads are large)
    const repo = payload?.repository?.full_name;
    const issueNumber = payload?.issue?.number;
    const issueId = payload?.issue?.id;
    const sender = payload?.sender?.login;
    const issueState = payload?.issue?.state;

    if (!repo || !issueNumber || !issueId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_payload" }));
      return;
    }

    if (!config.botLogin.trim()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "service_unavailable", message: "botLogin not configured" }));
      return;
    }

    // Avoid bot loops + ignore closed issues
    if (sender && sender.toLowerCase() === config.botLogin.toLowerCase()) {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ignored: "bot_sender" }));
      return;
    }
    if (issueState === "closed") {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ignored: "closed" }));
      return;
    }

    let trigger: Trigger | null = null;

    if (event === "issues") {
      const action = payload?.action;
      if (action === "assigned") {
        const assignee = payload?.assignee?.login;
        if (assignee && assignee.toLowerCase() === config.botLogin.toLowerCase()) {
          trigger = { type: "assigned" };
        }
      } else if (action === "opened" || action === "edited") {
        const body = String(payload?.issue?.body ?? "");
        const { mentioned, command } = extractMentionCommand(body, config.botLogin);
        if (mentioned) {
          trigger = { type: "body_mention", command };
        }
      }
    }

    if (event === "issue_comment") {
      const action = payload?.action;
      if (action === "created") {
        const body = String(payload?.comment?.body ?? "");
        const commentId = Number(payload?.comment?.id);
        const { mentioned, command } = extractMentionCommand(body, config.botLogin);
        if (mentioned && Number.isFinite(commentId) && commentId > 0) {
          trigger = { type: "comment_mention", commentId, command, commentBody: body };
        }
      }
    }

    if (!trigger) {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ignored: "not_applicable" }));
      return;
    }

    // Idempotency + in-progress marker
    const key = issueKey(repo, issueId);
    const nowIso = new Date().toISOString();
    const state = await loadState(stateFilePath);
    const existing: IssueState = state.issues[key] ?? { inProgress: false, lastProcessedCommentId: null, updatedAt: nowIso };

    // Do not re-trigger assigned events while already in progress
    if (trigger.type === "assigned" && existing.inProgress) {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, deduped: "already_in_progress" }));
      return;
    }

    if (trigger.type === "comment_mention") {
      const last = existing.lastProcessedCommentId ?? 0;
      if (trigger.commentId <= last) {
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, deduped: "comment_already_processed" }));
        return;
      }
    }

    // Mark in progress and persist before enqueue to reduce double-runs
    const updated: IssueState = {
      inProgress: true,
      lastProcessedCommentId:
        trigger.type === "comment_mention" ? trigger.commentId : existing.lastProcessedCommentId,
      updatedAt: nowIso,
    };
    state.issues[key] = updated;
    await saveState(stateFilePath, state);

    // Acknowledge in the issue (best-effort). This creates a comment webhook,
    // but loop prevention ignores bot sender.
    github.createIssueComment({
      repo,
      issueNumber,
      body: `Acknowledged. Marking this issue as in progress.\n\nTrigger: ${trigger.type}${trigger.type === "comment_mention" ? ` (command: ${trigger.command ?? "n/a"})` : ""}`,
    }).catch((err) => {
      log.warn({ err, repo, issueNumber }, "Failed to post in-progress ack comment (non-fatal)");
    });

    const sourceId = `${repo}#${issueNumber}`;
    const cmd =
      trigger.type === "comment_mention" || trigger.type === "body_mention"
        ? trigger.command
        : null;

    const issueUrl = `https://github.com/${repo}/issues/${issueNumber}`;
    const repoName = String(repo).split("/")[1] ?? String(repo).replaceAll("/", "-");
    const suggestedCheckoutDir = `~/.personal-assistant/workspace/dev/${repoName}`;

    const jobText =
      [
        "GitHub webhook task:",
        `- Repo: ${repo}`,
        `- Issue: #${issueNumber}`,
        `- Issue URL: ${issueUrl}`,
        `- Trigger: ${trigger.type}`,
        cmd ? `- Command: ${cmd}` : null,
        sender ? `- Sender: ${sender}` : null,
        "",
        "Workspace convention (recommended):",
        `- Repo checkout: ${suggestedCheckoutDir}`,
        "",
        "Suggested commands (if needed):",
        `- View issue: gh issue view ${issueNumber} --repo ${repo}`,
        `- Clone: (cd ~/.personal-assistant/workspace/dev && gh repo clone ${repo})`,
        `- Workdir: cd ${suggestedCheckoutDir}`,
        "",
        "Please implement the requested change in a feature branch, spawn subagent to review the correctness, completeness and security of the code, fix the findings, push the result and open a pull request.",
        "Post a brief status update as new issue comment with a PR link when done, or just post a new issue comment with the response if PR is not needed.",
        "Respond only with professional status of issue resolution since your response will be posted to public issue comment. Take care that no personal data, no salutation, no names, no secrets are part of this response.",
      ].filter(Boolean).join("\n");

    deps.onMessage(createAdapterMessage("github", sourceId, jobText, {
      repo,
      issueNumber,
      issueId,
      sender,
      delivery,
      trigger: trigger.type,
      command: cmd,
    }));

    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, enqueued: true }));
  }

  return {
    name: "github",

    async start(): Promise<void> {
      if (!config.enabled) return;
      server = http.createServer((req, res) => {
        handleWebhook(req, res).catch((err) => {
          log.error({ err }, "Unhandled error in GitHub webhook handler");
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "service_unavailable" }));
          }
        });
      });

      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(config.port, config.bind, () => {
          server!.removeListener("error", reject);
          resolve();
        });
      });

      log.info(
        { bind: config.bind, port: config.port, path: config.path, secretEnvVar: config.secretEnvVar },
        "GitHub webhook adapter started",
      );
    },

    async stop(): Promise<void> {
      if (!server) return;
      const s = server;
      server = null;
      await new Promise<void>((resolve, reject) => {
        s.close((err) => (err ? reject(err) : resolve()));
      });
      log.info("GitHub webhook adapter stopped");
    },

    async sendResponse(message: AdapterMessage): Promise<void> {
      // Route agent responses back to the originating issue via comment.
      // sourceId format: "owner/repo#123"
      const m = message.sourceId.match(/^(.+?)#(\d+)$/);
      if (!m) {
        log.warn({ sourceId: message.sourceId }, "Invalid github sourceId, dropping response");
        return;
      }
      const repo = m[1]!;
      const issueNumber = Number(m[2]!);
      if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
        log.warn({ sourceId: message.sourceId }, "Invalid issue number in github sourceId");
        return;
      }

      const body = message.text.trim();
      if (!body) return;

      await github.createIssueComment({ repo, issueNumber, body });
    },
  };
}
