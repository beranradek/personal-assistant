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

// ---------------------------------------------------------------------------
// Config type (matches SlackConfigSchema fields we need)
// ---------------------------------------------------------------------------

export interface SlackAdapterConfig {
  botToken: string;
  appToken: string;
  allowedUserIds: string[];
  socketMode: boolean;
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
 */
export function createSlackAdapter(
  config: SlackAdapterConfig,
  onMessage: (message: AdapterMessage) => void,
): Adapter {
  if (config.allowedUserIds.length === 0) {
    throw new Error(
      "Slack adapter requires at least one allowed user ID in allowedUserIds",
    );
  }

  const app = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: config.socketMode,
  });

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
    };

    // Ignore bot messages (including our own)
    if (msg.bot_id) {
      log.debug({ bot_id: msg.bot_id }, "ignoring bot message");
      return;
    }

    // Filter by allowed user IDs
    if (msg.user && !config.allowedUserIds.includes(msg.user)) {
      log.warn({ userId: msg.user }, "unauthorized user, ignoring message");
      return;
    }

    // Ignore non-standard message events (edits, deletes, file shares, etc.)
    if (msg.subtype) {
      log.debug({ subtype: msg.subtype }, "ignoring message with subtype");
      return;
    }

    // Ignore messages without text
    const text = msg.text;
    if (!text) {
      return;
    }

    const channelId = msg.channel ?? "";
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
        channelId,
        userId: msg.user,
      },
    );

    try {
      onMessage(adapterMessage);
    } catch (err) {
      log.error({ err }, "onMessage callback failed");
    }
  });

  // -------------------------------------------------------------------------
  // Adapter interface
  // -------------------------------------------------------------------------

  return {
    name: "slack",

    async start(): Promise<void> {
      log.info("starting Slack adapter (socket mode)");
      await app.start();
    },

    async stop(): Promise<void> {
      await app.stop();
      log.info("stopped Slack adapter");
    },

    async sendResponse(message: AdapterMessage): Promise<void> {
      // Extract channel and thread from sourceId or metadata
      const { channelId: parsedChannel, threadTs: parsedThread } = decodeSourceId(message.sourceId);
      const channelId = (message.metadata?.channelId as string) ?? parsedChannel;
      const threadTs = (message.metadata?.threadId as string) ?? parsedThread;

      try {
        await app.client.chat.postMessage({
          channel: channelId,
          text: message.text,
          thread_ts: threadTs,
        });
      } catch (err) {
        log.error({ channelId, threadTs, err }, "failed to send message");
        throw err;
      }
    },
  };
}
