/**
 * Telegram Adapter
 * ================
 *
 * Implements the Adapter interface using Grammy for Telegram Bot API.
 * Supports polling mode by default with user ID filtering and message chunking.
 */

import { Bot } from "grammy";
import { createLogger } from "../core/logger.js";
import { createAdapterMessage } from "./types.js";
import type { Adapter, AdapterMessage } from "./types.js";

const log = createLogger("telegram-adapter");

/** Telegram Bot API message character limit. */
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

// ---------------------------------------------------------------------------
// Config type (matches TelegramConfigSchema fields we need)
// ---------------------------------------------------------------------------

export interface TelegramAdapterConfig {
  botToken: string;
  allowedUserIds: number[];
  mode: "polling" | "webhook";
}

// ---------------------------------------------------------------------------
// Chunk utility
// ---------------------------------------------------------------------------

/**
 * Split text into chunks of at most `limit` characters.
 */
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    chunks.push(text.slice(offset, offset + limit));
    offset += limit;
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Telegram adapter backed by Grammy.
 *
 * @param config - Telegram-specific configuration (token, allowed users, mode).
 * @param onMessage - Callback invoked for each valid incoming message
 *                    (typically enqueues to the gateway).
 */
export function createTelegramAdapter(
  config: TelegramAdapterConfig,
  onMessage: (message: AdapterMessage) => void,
): Adapter {
  const bot = new Bot(config.botToken);

  // Register message handler
  bot.on("message:text", async (ctx) => {
    const msg = ctx.message;
    const text = msg?.text;
    if (!text) {
      return;
    }

    const userId = msg.from?.id;
    const chatId = msg.chat?.id;

    // Filter by allowed user IDs (empty list = allow all)
    if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) {
      log.warn({ userId }, "unauthorized user, ignoring message");
      return;
    }

    const adapterMessage = createAdapterMessage(
      "telegram",
      String(chatId),
      text,
      {
        userName: msg.from?.username,
        userId,
        chatId,
        firstName: msg.from?.first_name,
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
    name: "telegram",

    async start(): Promise<void> {
      log.info("starting Telegram adapter (polling mode)");
      // Grammy's bot.start() begins long polling and does not resolve until
      // the bot is stopped, so we launch it without awaiting.
      bot.start();
    },

    async stop(): Promise<void> {
      await bot.stop();
      log.info("stopped Telegram adapter");
    },

    async sendResponse(message: AdapterMessage): Promise<void> {
      const chatId = Number(message.sourceId);
      if (Number.isNaN(chatId)) {
        log.error({ sourceId: message.sourceId }, "invalid chat ID");
        return;
      }
      const chunks = chunkText(message.text, TELEGRAM_MAX_MESSAGE_LENGTH);

      for (const chunk of chunks) {
        try {
          await bot.api.sendMessage(chatId, chunk);
        } catch (err) {
          log.error({ chatId, err }, "failed to send message chunk");
          throw err;
        }
      }
    },
  };
}
