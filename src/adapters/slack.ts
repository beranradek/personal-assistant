/**
 * Slack Adapter
 * =============
 *
 * Implements the Adapter interface using @slack/bolt in Socket Mode.
 * Supports thread-based conversations where each thread maps to a session.
 *
 * Session key format: slack--{channelId}--{threadTs}
 * sourceId format:    {channelId}--{threadTs}
 */

import { App } from "@slack/bolt";
import { createLogger } from "../core/logger.js";
import { createAdapterMessage } from "./types.js";
import type { Adapter, AdapterMessage } from "./types.js";

const log = createLogger("slack-adapter");

/** Bolt/WebClient limits so a Slack outage or 429 never blocks a turn (Slack docs: default is 10 retries in ~30 min). */
const SLACK_CLIENT_OPTIONS = {
  rejectRateLimitedCalls: true,
  retryConfig: { retries: 2 },
  timeout: 15_000,
};

/** Duplicate event guard (Socket Mode may deliver an event more than once). */
const DEDUPE_TTL_MS = 10 * 60 * 1000;
const DEDUPE_MAX_ENTRIES = 1000;

/** Short ephemeral text when the /cc handler throws (no internals leaked). */
const COMMAND_ERROR_TEXT = "Command failed. Please try again.";

// ---------------------------------------------------------------------------
// Config type (matches SlackConfigSchema fields we need)
// ---------------------------------------------------------------------------

export interface SlackAdapterConfig {
  botToken: string;
  appToken: string;
  allowedUserIds: string[];
  socketMode: boolean;
}

/** Payload of a slash command passed to the command handler. */
export interface SlackCommand {
  userId: string;
  text: string;
  channelId: string;
}

/** Returns ephemeral reply text (shown only to the caller) or nothing for an empty ack. */
export type SlackCommandHandler = (
  command: SlackCommand,
) => Promise<string | void | undefined> | string | void | undefined;

export interface SlackAdapterOptions {
  onCommand?: SlackCommandHandler;
}

/** Thin, token-free facade over the Slack Web API for the remote-session channel. */
export interface SlackRemoteApi {
  /** Open (or return cached) DM channel id `D...` for a user. Failures are not cached. */
  openDm(userId: string): Promise<string>;
  postMessage(channel: string, text: string, opts?: { mrkdwn?: boolean }): Promise<string>;
  updateMessage(channel: string, ts: string, text: string): Promise<void>;
  addReaction(channel: string, ts: string, name: string): Promise<void>;
  removeReaction(channel: string, ts: string, name: string): Promise<void>;
}

/** Bounded "seen" set with per-entry expiry (insertion ordered Map). */
function createSeenSet(ttlMs: number, maxEntries: number, now: () => number = Date.now) {
  const seen = new Map<string, number>();
  return {
    /** Returns true if the key was already seen (and still fresh); otherwise records it. */
    checkAndAdd(key: string): boolean {
      const t = now();
      for (const [k, expiresAt] of seen) {
        if (expiresAt > t) break; // insertion order == expiry order
        seen.delete(k);
      }
      if (seen.has(key)) return true;
      seen.set(key, t + ttlMs);
      while (seen.size > maxEntries) {
        seen.delete(seen.keys().next().value as string);
      }
      return false;
    },
  };
}

// ---------------------------------------------------------------------------
// sourceId helpers
// ---------------------------------------------------------------------------

/**
 * Encode channel + thread into a sourceId.
 * Format: {channelId}--{threadTs}
 */
function encodeSourceId(channelId: string, threadTs: string): string {
  return `${channelId}--${threadTs}`;
}

/**
 * Decode a sourceId back into channel + thread.
 */
function decodeSourceId(sourceId: string): { channelId: string; threadTs: string } {
  const separatorIndex = sourceId.indexOf("--");
  if (separatorIndex === -1) {
    return { channelId: sourceId, threadTs: "" };
  }
  return {
    channelId: sourceId.slice(0, separatorIndex),
    threadTs: sourceId.slice(separatorIndex + 2),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Slack adapter backed by Bolt.js in Socket Mode.
 *
 * @param config - Slack-specific configuration (tokens, socket mode).
 * @param onMessage - Callback invoked for each valid incoming message
 *                    (typically enqueues to the gateway).
 * @param options - Optional `/cc` slash command handler.
 */
export function createSlackAdapter(
  config: SlackAdapterConfig,
  onMessage: (message: AdapterMessage) => void,
  options: SlackAdapterOptions = {},
): Adapter & { remote: SlackRemoteApi } {
  if (config.allowedUserIds.length === 0) {
    throw new Error(
      "Slack adapter requires at least one allowed user ID in allowedUserIds",
    );
  }

  const app = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: config.socketMode,
    clientOptions: SLACK_CLIENT_OPTIONS,
  });
  const seen = createSeenSet(DEDUPE_TTL_MS, DEDUPE_MAX_ENTRIES);
  const isAllowed = (userId: string | undefined): userId is string =>
    !!userId && config.allowedUserIds.includes(userId);

  // Register message handler
  app.message(async ({ message }) => {
    // Slack message events have different shapes; we need the "GenericMessageEvent" fields.
    const msg = message as {
      text?: string;
      user?: string;
      channel?: string;
      ts?: string;
      thread_ts?: string;
      bot_id?: string;
      subtype?: string;
      channel_type?: string;
    };

    // Filter order: 1) drop bot messages (incl. our own) and subtype events (edits, deletes, file shares, ...),
    // 2) then allowlist check, which also rejects events without a user
    if (msg.bot_id || msg.subtype) {
      log.debug({ bot_id: msg.bot_id, subtype: msg.subtype }, "ignoring bot or subtype message");
      return;
    }

    if (!isAllowed(msg.user)) {
      log.warn({ userId: msg.user }, "unauthorized or missing user, ignoring message");
      return;
    }

    // Ignore messages without text
    const text = msg.text;
    if (!text) {
      return;
    }

    const channelId = msg.channel ?? "";
    if (msg.ts && seen.checkAndAdd(`${channelId}:${msg.ts}`)) {
      log.debug({ channelId, ts: msg.ts }, "ignoring duplicate event");
      return;
    }
    // Use thread_ts if present (threaded reply), otherwise use the message ts
    // to start a new thread from this message
    const threadTs = msg.thread_ts ?? msg.ts ?? "";

    const sourceId = encodeSourceId(channelId, threadTs);

    const adapterMessage = createAdapterMessage(
      "slack",
      sourceId,
      text,
      {
        threadId: threadTs,
        messageTs: msg.ts,
        channelId,
        userId: msg.user,
        channelType: msg.channel_type,
      },
    );

    try {
      onMessage(adapterMessage);
    } catch (err) {
      log.error({ err }, "onMessage callback failed");
    }
  });

  // /cc slash command: allowlist first, ack exactly once within the handler (Slack requires ack within 3 s)
  app.command("/cc", async ({ command, ack }) => {
    if (!isAllowed(command.user_id)) {
      log.warn({ userId: command.user_id }, "unauthorized user, ignoring command");
      await ack();
      return;
    }
    let reply: string | void | undefined;
    try {
      reply = await options.onCommand?.({
        userId: command.user_id,
        text: command.text ?? "",
        channelId: command.channel_id,
      });
    } catch (err) {
      log.error({ err }, "command handler failed");
      await ack({ response_type: "ephemeral", text: COMMAND_ERROR_TEXT });
      return;
    }
    if (reply) {
      await ack({ response_type: "ephemeral", text: reply });
    } else {
      await ack();
    }
  });

  // -------------------------------------------------------------------------
  // Remote API
  // -------------------------------------------------------------------------

  const dmCache = new Map<string, string>();
  const dmInFlight = new Map<string, Promise<string>>();

  const requireNonEmpty = (name: string, value: string): void => {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Slack remote API: ${name} must be a non-empty string`);
    }
  };

  /** Resolve channel/thread, preferring metadata over values decoded from sourceId. */
  const resolveTarget = (sourceId: string, metadata?: Record<string, unknown>) => {
    const parsed = decodeSourceId(sourceId);
    return {
      channelId: (metadata?.channelId as string) ?? parsed.channelId,
      threadTs: (metadata?.threadId as string) ?? parsed.threadTs,
    };
  };

  const remote: SlackRemoteApi = {
    async openDm(userId) {
      const cached = dmCache.get(userId);
      if (cached) return cached;
      let pending = dmInFlight.get(userId);
      if (!pending) {
        pending = app.client.conversations
          .open({ users: userId })
          .then((res) => {
            const id = res.channel?.id;
            if (!id) throw new Error("conversations.open returned no channel id");
            dmCache.set(userId, id);
            return id;
          })
          .finally(() => dmInFlight.delete(userId));
        dmInFlight.set(userId, pending);
      }
      return pending;
    },
    async postMessage(channel, text, opts) {
      requireNonEmpty("channel", channel);
      const res = await app.client.chat.postMessage({
        channel,
        text,
        ...(opts?.mrkdwn !== undefined ? { mrkdwn: opts.mrkdwn } : {}),
      });
      return res.ts as string;
    },
    async updateMessage(channel, ts, text) {
      requireNonEmpty("channel", channel);
      requireNonEmpty("ts", ts);
      await app.client.chat.update({ channel, ts, text });
    },
    async addReaction(channel, ts, name) {
      requireNonEmpty("channel", channel);
      requireNonEmpty("ts", ts);
      requireNonEmpty("name", name);
      await app.client.reactions.add({ channel, timestamp: ts, name });
    },
    async removeReaction(channel, ts, name) {
      requireNonEmpty("channel", channel);
      requireNonEmpty("ts", ts);
      requireNonEmpty("name", name);
      await app.client.reactions.remove({ channel, timestamp: ts, name });
    },
  };

  // -------------------------------------------------------------------------
  // Adapter interface
  // -------------------------------------------------------------------------

  return {
    name: "slack",
    remote,

    async start(): Promise<void> {
      log.info("starting Slack adapter (socket mode)");
      await app.start();
    },

    async stop(): Promise<void> {
      await app.stop();
      log.info("stopped Slack adapter");
    },

    async sendResponse(message: AdapterMessage): Promise<void> {
      const { channelId, threadTs } = resolveTarget(message.sourceId, message.metadata);

      try {
        await app.client.chat.postMessage({
          channel: channelId,
          text: message.text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
      } catch (err) {
        log.error({ channelId, threadTs, err }, "failed to send message");
        throw err;
      }
    },

    async createProcessingMessage(
      sourceId: string,
      text: string,
      metadata?: Record<string, unknown>,
    ): Promise<string> {
      const { channelId, threadTs } = resolveTarget(sourceId, metadata);

      try {
        const result = await app.client.chat.postMessage({
          channel: channelId,
          text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
        return result.ts as string;
      } catch (err) {
        log.error({ channelId, threadTs, err }, "failed to create processing message");
        throw err;
      }
    },

    async updateProcessingMessage(
      sourceId: string,
      messageId: string,
      text: string,
      metadata?: Record<string, unknown>,
    ): Promise<void> {
      const { channelId } = resolveTarget(sourceId, metadata);

      try {
        await app.client.chat.update({
          channel: channelId,
          ts: messageId,
          text,
        });
      } catch (err) {
        log.error({ channelId, messageId, err }, "failed to update processing message");
        throw err;
      }
    },
  };
}
