/**
 * Slack as a remote bridge channel (see docs/plans/completed/2026-11-11-slack-remote-session-communication/spec.md 5.2, 5.5).
 * Chat ids given to the functions are Slack user ids (the id part of the chat key `slack:<userId>`). Text goes to the DM
 * channel `D...` opened with `conversations.open` (never to the user id: the Slack docs disagree on that).
 * Slack docs: chat.postMessage is limited to about 1 message per second per channel; 429 carries `Retry-After` seconds
 * (WebClient error code `slack_webapi_rate_limited_error`, field `retryAfter`). Reactions: reactions.add / reactions.remove.
 */
import { createLogger } from "../../core/logger.js";
import { CONSERVATIVE_PATTERNS, redactString } from "../../security/content-redaction.js";
import type { ClaudeCodeRemoteConfig } from "../../core/types.js";
import type { SlackRemoteApi } from "../../adapters/slack.js";
import { RemotePartialSendError, type RemoteChannel, type RemoteTurnStatus } from "../protocol.js";
import { chunkSlackText, escapeSlack, toSlackMrkdwn } from "./slack-format.js";

const log = createLogger("remote-slack-channel");

const MAX_RETRY_AFTER_MS = 30_000;
const CHUNK_PACING_MS = 1000;
const CHUNK_TRIES = 3;
const MAX_CHUNKS = 20;
/** Reactions: eyes = accepted, white_check_mark = done, x = failed. */
const REACTION = { accepted: "eyes", done: "white_check_mark", failed: "x" } as const;
/** Slack errors of reactions that mean "nothing to do" (name is in `err.data.error`). */
const IGNORED_REACTION_ERRORS = new Set([
  "already_reacted",
  "no_reaction",
  "message_not_found",
  "too_many_reactions",
  "thread_locked",
]);

export type SlackChannelConfig = Pick<ClaudeCodeRemoteConfig["slack"], "progress" | "reactions" | "format">;

export interface SlackChannelOptions {
  /** Test seam for pacing and backoff waits. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Slack Web API rate limit error -> wait in ms (seconds capped), else undefined. */
function retryAfterMs(err: unknown): number | undefined {
  const e = err as { code?: unknown; retryAfter?: unknown } | null;
  if (e?.code !== "slack_webapi_rate_limited_error") return undefined;
  return typeof e.retryAfter === "number" && e.retryAfter > 0 ? Math.min(e.retryAfter * 1000, MAX_RETRY_AFTER_MS) : undefined;
}

/** Slack API error names that mean "try again later" (all other `err.data.error` names are permanent: auth, scope, channel...). */
const TRANSIENT_SLACK_ERRORS = new Set([
  "platform_error",
  "service_unavailable",
  "internal_error",
  "fatal_error",
  "request_timeout",
  "ratelimited",
  "rate_limited",
]);
/** Node/axios network error codes: the request did not complete, so a retry is safe. */
const NETWORK_ERROR_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "EAI_AGAIN", "ENOTFOUND", "ENETUNREACH"]);
const TIMEOUT_ERROR_CODES = new Set(["ECONNABORTED", "ETIMEDOUT", "ESOCKETTIMEDOUT"]);

type ErrorClass = "rate_limit" | "timeout" | "transient" | "permanent";

/**
 * Classify a Slack Web API error for the per-chunk retry. Permanent: any Slack error name that is not in the transient list
 * (`invalid_auth`, `channel_not_found`, `not_in_channel`, `token_revoked`, `missing_scope`, `is_archived`, `msg_too_long`...)
 * and every unknown error. A timeout may have delivered the message already, so the caller retries it only once.
 */
function classifyError(err: unknown): ErrorClass {
  if (retryAfterMs(err) !== undefined) return "rate_limit";
  const e = err as {
    code?: unknown;
    statusCode?: unknown;
    data?: { error?: unknown };
    original?: { code?: unknown; response?: { status?: unknown } };
    message?: unknown;
  } | null;
  const named = e?.data?.error;
  if (typeof named === "string") return TRANSIENT_SLACK_ERRORS.has(named) ? "transient" : "permanent";
  const codes = [e?.code, e?.original?.code].filter((c): c is string => typeof c === "string");
  if (codes.some((c) => TIMEOUT_ERROR_CODES.has(c)) || /timeout|timed out/i.test(String(e?.message ?? ""))) return "timeout";
  if (codes.some((c) => NETWORK_ERROR_CODES.has(c) || c === "slack_webapi_request_error")) return "transient";
  const status = e?.statusCode ?? e?.original?.response?.status;
  if (typeof status === "number" && status >= 500) return "transient";
  return "permanent";
}

/** Slack error name (`err.data.error`) or a redacted message, safe to log (no token). */
function errorName(err: unknown): string {
  const named = (err as { data?: { error?: unknown } } | null)?.data?.error;
  if (typeof named === "string") return named;
  return redactString(err instanceof Error ? err.message : String(err), CONSERVATIVE_PATTERNS);
}

export function createSlackChannel(
  api: SlackRemoteApi,
  config: SlackChannelConfig,
  options: SlackChannelOptions = {},
): RemoteChannel {
  const sleep = options.sleep ?? defaultSleep;
  const dmCache = new Map<string, string>();
  const statusTails = new Map<string, Promise<void>>();

  /** DM channel of a user, resolved once. A failure is not cached. */
  async function dmOf(userId: string): Promise<string> {
    const cached = dmCache.get(userId);
    if (cached) return cached;
    const dm = await api.openDm(userId);
    dmCache.set(userId, dm);
    return dm;
  }

  async function postChunk(dm: string, chunk: string): Promise<void> {
    let timeouts = 0;
    for (let attempt = 1; ; attempt++) {
      try {
        await api.postMessage(dm, chunk, config.format === "plain" ? { mrkdwn: false } : undefined);
        return;
      } catch (err) {
        const kind = classifyError(err);
        if (kind === "timeout") timeouts++;
        // A timed-out post may be delivered already: retry it once only.
        if (attempt >= CHUNK_TRIES || kind === "permanent" || timeouts > 1) throw err;
        await sleep(retryAfterMs(err) ?? CHUNK_PACING_MS);
      }
    }
  }

  async function sendText(userId: string, text: string): Promise<void> {
    const dm = await dmOf(userId);
    const formatted = config.format === "plain" ? escapeSlack(text) : toSlackMrkdwn(text);
    let chunks = chunkSlackText(formatted);
    if (chunks.length > MAX_CHUNKS) {
      const dropped = chunks.length - MAX_CHUNKS;
      chunks = chunks.slice(0, MAX_CHUNKS);
      chunks[MAX_CHUNKS - 1] += `\n... (answer truncated, ${dropped} more parts not sent)`;
    }
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await sleep(CHUNK_PACING_MS);
      try {
        await postChunk(dm, chunks[i]!);
      } catch (err) {
        if (i === 0) throw err;
        throw new RemotePartialSendError(`Slack: part ${i + 1} of ${chunks.length} failed after ${i} sent`, err);
      }
    }
  }

  /** One reaction call: expected "nothing to do" errors are ignored, others are logged (no token) and swallowed. */
  async function react(op: "add" | "remove", dm: string, ts: string, name: string): Promise<void> {
    try {
      await (op === "add" ? api.addReaction(dm, ts, name) : api.removeReaction(dm, ts, name));
    } catch (err) {
      const reason = errorName(err);
      if (!IGNORED_REACTION_ERRORS.has(reason)) log.warn({ op, name, reason }, "slack reaction failed");
    }
  }

  async function applyStatus(ref: string, status: RemoteTurnStatus): Promise<void> {
    const colon = ref.indexOf(":");
    const dm = ref.slice(0, colon);
    const ts = ref.slice(colon + 1);
    if (colon <= 0 || !ts) return;
    if (status === "accepted") return react("add", dm, ts, REACTION.accepted);
    await react("remove", dm, ts, REACTION.accepted);
    if (status === "done") await react("add", dm, ts, REACTION.done);
    else if (status === "failed") await react("add", dm, ts, REACTION.failed);
  }

  /** Calls of one `ref` run one after another (a slow `accepted` finishes before `done` starts). */
  function setTurnStatus(_userId: string, ref: string, status: RemoteTurnStatus): Promise<void> {
    if (!config.reactions) return Promise.resolve();
    const run = (statusTails.get(ref) ?? Promise.resolve()).then(() => applyStatus(ref, status));
    const tail = run.catch(() => undefined);
    statusTails.set(ref, tail);
    void tail.then(() => {
      if (statusTails.get(ref) === tail) statusTails.delete(ref);
    });
    return run;
  }

  return {
    id: "slack",
    label: "Slack",
    detachCommand: "/cc detach",
    deliveryFailedText: "Answer could not be delivered (Slack error).",
    sendText,
    ...(config.progress
      ? {
          progress: {
            create: async (userId: string, text: string) => api.postMessage(await dmOf(userId), escapeSlack(text)),
            update: async (userId: string, messageId: string, text: string) =>
              api.updateMessage(await dmOf(userId), messageId, escapeSlack(text)),
          },
        }
      : {}),
    setTurnStatus,
    retryAfterMs,
  };
}
