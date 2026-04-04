/**
 * Telegram Adapter
 * ================
 *
 * Implements the Adapter interface using Grammy for Telegram Bot API.
 * Supports polling mode by default with user ID filtering and message chunking.
 */

import { Bot, InputFile } from "grammy";
import { createLogger } from "../core/logger.js";
import { createAdapterMessage } from "./types.js";
import type { Adapter, AdapterMessage } from "./types.js";
import { synthesizeSpeech, transcribeAudio, truncateForTts } from "../openai/audio.js";

const log = createLogger("telegram-adapter");

/** Telegram Bot API message character limit. */
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const INPUT_TYPE_METADATA_KEY = "inputType";

// ---------------------------------------------------------------------------
// Config type (matches TelegramConfigSchema fields we need)
// ---------------------------------------------------------------------------

export interface TelegramAdapterAudioConfig {
  enabled: boolean;
  sttModel: string;
  sttLanguage: string;
  ttsModel: string;
  ttsVoice: string;
  ttsSpeed: number;
  ttsFormat: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
  maxInputSizeMb: number;
  openaiBaseUrl: string | null;
  timeoutMs: number;
}

export interface TelegramAdapterConfig {
  botToken: string;
  allowedUserIds: number[];
  audio?: TelegramAdapterAudioConfig;
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
  if (config.allowedUserIds.length === 0) {
    throw new Error(
      "Telegram adapter requires at least one allowed user ID in allowedUserIds",
    );
  }

  const bot = new Bot(config.botToken);
  const audioCfg: TelegramAdapterAudioConfig = config.audio ?? {
    enabled: false,
    sttModel: "whisper-1",
    sttLanguage: "cs",
    ttsModel: "gpt-4o-mini-tts",
    ttsVoice: "nova",
    ttsSpeed: 1.0,
    ttsFormat: "opus",
    maxInputSizeMb: 20,
    openaiBaseUrl: null,
    timeoutMs: 30_000,
  };

  // Register message handler
  bot.on("message:text", async (ctx) => {
    const msg = ctx.message;
    const text = msg?.text;
    if (!text) {
      return;
    }

    const userId = msg.from?.id;
    const chatId = msg.chat?.id;

    // Filter by allowed user IDs
    if (!config.allowedUserIds.includes(userId)) {
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

  async function safeSendText(chatId: number, text: string): Promise<void> {
    if (!text.trim()) return;
    const chunks = chunkText(text, TELEGRAM_MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      try {
        await bot.api.sendMessage(chatId, chunk);
      } catch (err) {
        log.error({ chatId, err }, "failed to send message chunk");
        throw err;
      }
    }
  }

  async function downloadTelegramFile(fileId: string): Promise<{ buffer: ArrayBuffer; filePath: string }> {
    const file = await bot.api.getFile(fileId);
    const filePath = (file as { file_path?: string }).file_path;
    if (!filePath) throw new Error("Telegram getFile response missing file_path");
    const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${filePath}`;
    const res = await fetch(fileUrl);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Telegram file download failed (${res.status}): ${body}`);
    }
    return { buffer: await res.arrayBuffer(), filePath };
  }

  async function transcribeWithFallback(params: {
    buffer: ArrayBuffer;
    fileName: string;
    mime?: string;
  }): Promise<string> {
    const apiKey = process.env["OPENAI_API_KEY"] ?? "";
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set (required for speech-to-text)");
    try {
      return await transcribeAudio({
        apiKey,
        baseUrl: audioCfg.openaiBaseUrl,
        model: audioCfg.sttModel,
        buffer: params.buffer,
        fileName: params.fileName,
        mime: params.mime,
        language: audioCfg.sttLanguage,
        timeoutMs: audioCfg.timeoutMs,
      });
    } catch (err) {
      // Fallback to whisper-1 if the configured model is unavailable/misconfigured.
      if (audioCfg.sttModel !== "whisper-1") {
        log.warn({ err }, "STT failed, retrying with whisper-1");
        return await transcribeAudio({
          apiKey,
          baseUrl: audioCfg.openaiBaseUrl,
          model: "whisper-1",
          buffer: params.buffer,
          fileName: params.fileName,
          mime: params.mime,
          language: audioCfg.sttLanguage,
          timeoutMs: audioCfg.timeoutMs,
        });
      }
      throw err;
    }
  }

  async function handleInboundAudio(ctx: { message?: any }): Promise<void> {
    const msg = ctx.message;
    if (!msg) return;

    const userId = msg.from?.id;
    const chatId = msg.chat?.id;
    if (typeof chatId !== "number") return;

    if (!config.allowedUserIds.includes(userId)) {
      log.warn({ userId }, "unauthorized user, ignoring audio message");
      return;
    }

    if (!audioCfg.enabled) {
      await safeSendText(chatId, "Audio messages are not enabled.");
      return;
    }

    const voice = msg.voice;
    const audio = msg.audio;
    const fileId: string | undefined = voice?.file_id ?? audio?.file_id;
    if (!fileId) return;

    const fileSize: number | undefined = voice?.file_size ?? audio?.file_size;
    if (fileSize != null) {
      const maxBytes = audioCfg.maxInputSizeMb * 1024 * 1024;
      if (fileSize > maxBytes) {
        await safeSendText(chatId, `Audio message is too large (max ${audioCfg.maxInputSizeMb} MB).`);
        return;
      }
    }

    try {
      const { buffer } = await downloadTelegramFile(fileId);
      const mime = (voice?.mime_type ?? audio?.mime_type ?? "audio/ogg") as string;
      const ext =
        mime === "audio/ogg" ? "ogg" :
          mime === "audio/mpeg" ? "mp3" :
            mime === "audio/mp4" ? "m4a" :
              mime === "audio/wav" ? "wav" :
                mime.includes("/") ? mime.split("/")[1] : "audio";
      const fileName = `telegram-audio-${msg.message_id ?? Date.now()}.${ext}`;

      const transcript = await transcribeWithFallback({ buffer, fileName, mime });
      if (!transcript.trim()) {
        await safeSendText(chatId, "I couldn't transcribe that audio. Could you try again?");
        return;
      }

      const adapterMessage = createAdapterMessage(
        "telegram",
        String(chatId),
        transcript,
        {
          userName: msg.from?.username,
          userId,
          chatId,
          firstName: msg.from?.first_name,
          [INPUT_TYPE_METADATA_KEY]: "audio",
          telegram: {
            messageId: msg.message_id,
            fileId,
            mime,
            duration: voice?.duration ?? audio?.duration,
          },
        },
      );

      try {
        onMessage(adapterMessage);
      } catch (err) {
        log.error({ err }, "onMessage callback failed");
      }
    } catch (err) {
      log.error({ err, userId }, "failed to process inbound audio");
      await safeSendText(chatId, "Sorry, I couldn't process that audio message. Please try again.");
    }
  }

  bot.on("message:voice", (ctx) => handleInboundAudio(ctx).catch((err) => log.error({ err }, "voice handler failed")));
  bot.on("message:audio", (ctx) => handleInboundAudio(ctx).catch((err) => log.error({ err }, "audio handler failed")));

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
      if (!message.text.trim()) {
        log.warn({ chatId }, "skipping empty message");
        return;
      }
      const isAudioInput =
        message.metadata != null &&
        typeof message.metadata === "object" &&
        (message.metadata as Record<string, unknown>)[INPUT_TYPE_METADATA_KEY] === "audio";
      const responseKind =
        message.metadata != null && typeof message.metadata === "object"
          ? (message.metadata as Record<string, unknown>)["responseKind"]
          : undefined;
      const shouldSpeak = responseKind !== "system";

      // Always send text. For audio inputs, also synthesize and send a voice reply.
      await safeSendText(chatId, message.text);

      if (isAudioInput && shouldSpeak && audioCfg.enabled) {
        const apiKey = process.env["OPENAI_API_KEY"] ?? "";
        if (!apiKey) {
          log.warn("OPENAI_API_KEY missing — skipping TTS voice reply");
          return;
        }
        const ttsText = truncateForTts(message.text);
        const tryModels = [audioCfg.ttsModel, "tts-1"].filter(
          (m, idx, arr) => m && arr.indexOf(m) === idx,
        );

        for (const model of tryModels) {
          try {
            const audioBytes = await synthesizeSpeech({
              apiKey,
              baseUrl: audioCfg.openaiBaseUrl,
              model,
              voice: audioCfg.ttsVoice,
              input: ttsText,
              speed: audioCfg.ttsSpeed,
              format: audioCfg.ttsFormat,
              timeoutMs: audioCfg.timeoutMs,
            });
            const filename = `reply.${audioCfg.ttsFormat === "opus" ? "opus" : audioCfg.ttsFormat}`;
            if (audioCfg.ttsFormat === "opus") {
              await bot.api.sendVoice(chatId, new InputFile(audioBytes, filename));
            } else {
              await bot.api.sendAudio(chatId, new InputFile(audioBytes, filename));
            }
            break;
          } catch (err) {
            log.warn({ err, model }, "TTS failed");
          }
        }
      }
    },

    async createProcessingMessage(
      sourceId: string,
      text: string,
    ): Promise<string> {
      const chatId = Number(sourceId);
      if (Number.isNaN(chatId)) {
        const err = new Error(`invalid chat ID: ${sourceId}`);
        log.error({ sourceId }, "invalid chat ID for processing message");
        throw err;
      }
      const result = await bot.api.sendMessage(chatId, text);
      return String(result.message_id);
    },

    async updateProcessingMessage(
      sourceId: string,
      messageId: string,
      text: string,
    ): Promise<void> {
      const chatId = Number(sourceId);
      const msgId = Number(messageId);
      try {
        await bot.api.editMessageText(chatId, msgId, text);
      } catch (err) {
        log.error({ chatId, messageId, err }, "failed to edit processing message");
        throw err;
      }
    },
  };
}
