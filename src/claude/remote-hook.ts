/**
 * `pa claude-remote-hook <event>` - hook command for the remote interactive session feature.
 *
 * Claude Code runs this command as an async hook. Events:
 * - `listen-start` (SessionStart, asyncRewake) and `listen-stop` (Stop, asyncRewake): long poll the PA daemon. When a
 *   Telegram message arrives, print the framed text to stderr and return exit code 2 (this wakes the idle session).
 *   `listen-stop` first posts the Stop payload to the daemon.
 * - Plain events (UserPromptSubmit, PreToolUse, MessageDisplay, Notification, StopFailure, SessionEnd): post and return 0.
 * - `PA_REMOTE_HOOKS=off` in the environment: every mode returns 0 at once, with no I/O.
 * - No claude ancestor process found: return 0 without any call to the daemon.
 * - Listen loop: no token file at start = return 0. Token lost or 401/403 later = retry up to 5 minutes. Connection
 *   errors = retry up to 30 minutes of continuous failure. The next Stop hook re-arms the listener.
 *
 * Rules: keep it light (no heavy imports), never write to stdout, never throw, return 0 on any error.
 * The function returns the exit code. The caller (cli.ts) calls process.exit.
 * See docs/plans/active/2026-11-08-remote-interactive-session-communication/spec.md (5.1 to 5.3).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  REMOTE_FRAME_HEADER_PREFIX,
  REMOTE_HOOKS_DISABLE_ENV,
  REMOTE_REPLACED_HEADER,
  REMOTE_TOKEN_FILE,
} from "../remote/protocol.js";
import type { RemotePollResponse, RemoteQueuedMessage } from "../remote/protocol.js";
import { findClaudePid, isPidAlive } from "./process-tree.js";

export const DEFAULT_REMOTE_PORT = 47392;
const POST_TIMEOUT_MS = 1000;
/** Client side limit of one long poll. The daemon answers after 55 s. */
const POLL_TIMEOUT_MS = 70_000;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 15_000;
const MAX_FRAME_TEXT_CHARS = 8000;
/** Retry windows of the listen loop (can be changed with deps). */
const DEFAULT_TOKEN_RETRY_MS = 5 * 60_000;
const DEFAULT_CONNECTION_RETRY_MS = 30 * 60_000;
/** The daemon answers 413 above its body limit. Stay under it. */
const MAX_POST_BODY_BYTES = 200 * 1024;
const MAX_PAYLOAD_STRING_CHARS = 8 * 1024;
/**
 * Control chars except tab and newline, C1 controls, line and paragraph separators, zero width and bidi controls,
 * BOM. Unicode tag characters (U+E0000 to U+E007F) are removed too.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp(
  "[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200b-\\u200f\\u202a-\\u202e" +
    "\\u2066-\\u2069\\ufeff]|[\\u{E0000}-\\u{E007F}]",
  "gu",
);

export const PLAIN_EVENTS = ["UserPromptSubmit", "PreToolUse", "MessageDisplay", "Notification", "StopFailure", "SessionEnd"] as const;

export type RemoteHookMode =
  | { kind: "listen"; postStop: boolean }
  | { kind: "plain"; event: (typeof PLAIN_EVENTS)[number] };

export interface RemoteHookDeps {
  /** Read all of stdin (hook JSON). */
  readStdin: () => Promise<string>;
  env: NodeJS.ProcessEnv;
  /** Config dir. Default: `PA_CONFIG` env, else `~/.personal-assistant`. */
  configDir?: string;
  /** Read a text file. Return undefined when it is missing or unreadable. */
  readFile: (filePath: string) => string | undefined;
  fetch: typeof fetch;
  /** Find the pid of the claude process that owns this hook. */
  findClaudePid: () => number | undefined;
  isPidAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  /** Write text to stderr. */
  stderr: (text: string) => void;
  cwd: () => string;
  /** Abort (for example on SIGTERM): the listen loop returns 0. */
  signal?: AbortSignal;
  /** Clock in ms. Default: the system clock. */
  now?: () => number;
  /** How long the listen loop retries after a lost token or 401/403. Default 5 minutes. */
  tokenRetryMs?: number;
  /** How long the listen loop retries after continuous connection errors. Default 30 minutes. */
  connectionRetryMs?: number;
}

/** Parse the CLI args after `claude-remote-hook`. Returns undefined for an unknown event. */
export function parseRemoteHookArgs(args: string[]): RemoteHookMode | undefined {
  const event = args[0];
  if (event === "listen-start") return { kind: "listen", postStop: false };
  if (event === "listen-stop") return { kind: "listen", postStop: true };
  const plain = PLAIN_EVENTS.find((e) => e === event);
  return plain ? { kind: "plain", event: plain } : undefined;
}

/**
 * Remove control, invisible and bidi characters (keep newline and tab). Make text that imitates the frame or system
 * tags harmless. Limit the length.
 */
export function sanitizeFrameText(text: string): string {
  const clean = text
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS, "")
    .replace(/^\[(?=Telegram message from the user)/gm, "(")
    .replace(/<(?=\/?(?:system-reminder|task-notification))/gi, "< ");
  return clean.length > MAX_FRAME_TEXT_CHARS ? `${clean.slice(0, MAX_FRAME_TEXT_CHARS)}\n[truncated]` : clean;
}

/** Build the text printed to stderr for the model (spec 5.3). */
export function buildFrame(messages: RemoteQueuedMessage[]): string {
  const parts = messages.map((m) => `${REMOTE_FRAME_HEADER_PREFIX}${Number(m.msgId) || 0}]\n${sanitizeFrameText(String(m.text))}`);
  parts.push(
    "(Treat as a normal user prompt. Your final answer is sent to Telegram by the PA daemon. " +
      "Do not call tools only to reply. Keep it short.)",
  );
  return `${parts.join("\n\n")}\n`;
}

function defaultConfigDir(env: NodeJS.ProcessEnv): string {
  const fromEnv = env["PA_CONFIG"];
  return fromEnv ? fromEnv : path.join(os.homedir(), ".personal-assistant");
}

/** Read only `codex.httpMcpPort` from settings.json (cheap, no schema). */
function readPort(deps: RemoteHookDeps, configDir: string): number {
  try {
    const raw = deps.readFile(path.join(configDir, "settings.json"));
    if (!raw) return DEFAULT_REMOTE_PORT;
    const port = (JSON.parse(raw) as { codex?: { httpMcpPort?: unknown } }).codex?.httpMcpPort;
    return typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_REMOTE_PORT;
  } catch {
    return DEFAULT_REMOTE_PORT;
  }
}

async function readPayload(deps: RemoteHookDeps): Promise<unknown> {
  try {
    const raw = (await deps.readStdin()).trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function payloadCwd(payload: unknown, fallback: string): string {
  const cwd = (payload as { cwd?: unknown } | null)?.cwd;
  return typeof cwd === "string" && cwd ? cwd : fallback;
}

function truncateStrings(value: unknown, depth: number): unknown {
  if (typeof value === "string") return value.length > MAX_PAYLOAD_STRING_CHARS ? value.slice(0, MAX_PAYLOAD_STRING_CHARS) : value;
  if (depth <= 0 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => truncateStrings(v, depth - 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateStrings(v, depth - 1)]));
}

/** Make the JSON body small enough for the daemon (no 413). Drop tool_input first, then cut long strings. */
export function buildPostBody(body: { event: string; pid: number; cwd: string; payload: unknown }): string {
  let json = JSON.stringify(body);
  if (Buffer.byteLength(json) <= MAX_POST_BODY_BYTES) return json;
  const payload: Record<string, unknown> =
    body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? { ...body.payload } : {};
  if ("tool_input" in payload) payload["tool_input"] = {};
  json = JSON.stringify({ ...body, payload });
  if (Buffer.byteLength(json) <= MAX_POST_BODY_BYTES) return json;
  json = JSON.stringify({ ...body, payload: truncateStrings(payload, 6) });
  if (Buffer.byteLength(json) <= MAX_POST_BODY_BYTES) return json;
  return JSON.stringify({ ...body, payload: {} });
}

async function postHook(
  deps: RemoteHookDeps,
  base: string,
  token: string,
  body: { event: string; pid: number; cwd: string; payload: unknown },
): Promise<void> {
  try {
    const res = await deps.fetch(`${base}/remote/hook`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: buildPostBody(body),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => undefined);
  } catch {
    // Best effort: the daemon may be down.
  }
}

function sessionName(cwd: string, pid: number): string {
  return `${path.basename(cwd) || "session"}-${pid}`;
}

async function listen(deps: RemoteHookDeps, base: string, tokenPath: string, pid: number, cwd: string): Promise<number> {
  let backoff = BACKOFF_START_MS;
  const now = deps.now ?? (() => Date.now());
  const tokenRetryMs = deps.tokenRetryMs ?? DEFAULT_TOKEN_RETRY_MS;
  const connectionRetryMs = deps.connectionRetryMs ?? DEFAULT_CONNECTION_RETRY_MS;
  /** Start of the current token problem or connection problem. Cleared after a good poll. */
  let tokenFailSince: number | undefined;
  let connFailSince: number | undefined;
  const name = sessionName(cwd, pid);
  const url = `${base}/remote/poll?pid=${pid}&cwd=${encodeURIComponent(cwd)}&name=${encodeURIComponent(name)}`;
  while (!deps.signal?.aborted) {
    if (!deps.isPidAlive(pid)) return 0;
    const token = deps.readFile(tokenPath)?.trim();
    let res: Response | undefined;
    let tokenProblem = !token;
    if (token) {
      try {
        const signals = [AbortSignal.timeout(POLL_TIMEOUT_MS), ...(deps.signal ? [deps.signal] : [])];
        res = await deps.fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.any(signals) });
      } catch {
        res = undefined;
      }
      if (deps.signal?.aborted) return 0;
      if (res && res.status === 200) {
        try {
          const body = (await res.json()) as RemotePollResponse;
          const messages = Array.isArray(body.messages) ? body.messages.filter((m) => m && typeof m.text === "string") : [];
          if (messages.length > 0) {
            deps.stderr(buildFrame(messages));
            return 2;
          }
          backoff = BACKOFF_START_MS;
          tokenFailSince = connFailSince = undefined;
          continue;
        } catch {
          res = undefined;
        }
      } else if (res && res.status === 204) {
        await res.body?.cancel().catch(() => undefined);
        if (res.headers.get(REMOTE_REPLACED_HEADER)) return 0;
        backoff = BACKOFF_START_MS;
        tokenFailSince = connFailSince = undefined;
        continue;
      } else if (res && (res.status === 401 || res.status === 403)) {
        tokenProblem = true;
      }
    }
    // Lost or rejected token (daemon restart): read it again and retry for a limited time.
    // Network error, 503 (bridge not ready) or other status: retry for a longer time.
    await res?.body?.cancel().catch(() => undefined);
    const t = now();
    if (tokenProblem) {
      tokenFailSince ??= t;
      if (t - tokenFailSince >= tokenRetryMs) return 0;
    } else {
      connFailSince ??= t;
      if (t - connFailSince >= connectionRetryMs) return 0;
    }
    await deps.sleep(backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }
  return 0;
}

/** Run the hook command. Returns the process exit code (0 = quiet, 2 = wake the session with stderr text). */
export async function runClaudeRemoteHook(args: string[], deps: RemoteHookDeps): Promise<number> {
  try {
    if (deps.env[REMOTE_HOOKS_DISABLE_ENV] === "off") return 0;
    const mode = parseRemoteHookArgs(args);
    if (!mode) return 0;
    const configDir = deps.configDir ?? defaultConfigDir(deps.env);
    const tokenPath = path.join(configDir, REMOTE_TOKEN_FILE);
    const token = deps.readFile(tokenPath)?.trim();
    if (!token) return 0;
    const pid = deps.findClaudePid();
    if (!pid) return 0;
    const payload = await readPayload(deps);
    const cwd = payloadCwd(payload, deps.cwd());
    const base = `http://127.0.0.1:${readPort(deps, configDir)}`;
    if (mode.kind === "plain") {
      await postHook(deps, base, token, { event: mode.event, pid, cwd, payload });
      return 0;
    }
    if (mode.postStop) await postHook(deps, base, token, { event: "Stop", pid, cwd, payload });
    return await listen(deps, base, tokenPath, pid, cwd);
  } catch {
    return 0;
  }
}

/** Production deps (real stdin, fs, fetch, /proc). */
export function createDefaultRemoteHookDeps(signal?: AbortSignal): RemoteHookDeps {
  return {
    readStdin: async () => {
      if (process.stdin.isTTY) return "";
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    },
    env: process.env,
    readFile: (filePath) => {
      try {
        return fs.readFileSync(filePath, "utf8");
      } catch {
        return undefined;
      }
    },
    fetch: globalThis.fetch,
    findClaudePid: () => findClaudePid(process.ppid),
    isPidAlive,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    stderr: (text) => {
      process.stderr.write(text);
    },
    cwd: () => process.cwd(),
    signal,
  };
}
