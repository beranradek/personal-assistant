/**
 * Telegram as a remote bridge channel: wraps the Telegram adapter (see
 * docs/plans/active/2026-11-11-slack-remote-session-communication/spec.md section 5.2).
 * Chat ids given to the functions are raw Telegram chat ids (the id part of the chat key `telegram:<id>`).
 */
import type { Adapter } from "../../core/types.js";
import type { RemoteChannel } from "../protocol.js";

/** Upper limit for a `retry_after` hint of Telegram (ms). */
const MAX_RETRY_AFTER_MS = 30_000;

/** Telegram "retry after N seconds" hint (grammY GrammyError has `parameters.retry_after`). */
function retryAfterMs(err: unknown): number | undefined {
  const sec = (err as { parameters?: { retry_after?: unknown } } | null)?.parameters?.retry_after;
  return typeof sec === "number" && sec > 0 ? Math.min(sec * 1000, MAX_RETRY_AFTER_MS) : undefined;
}

export function createTelegramChannel(telegram: Adapter): RemoteChannel {
  const { createProcessingMessage, updateProcessingMessage } = telegram;
  return {
    id: "telegram",
    label: "Telegram",
    detachCommand: "/detach",
    deliveryFailedText: "Answer could not be delivered (Telegram error).",
    sendText: (chat, text) =>
      telegram.sendResponse({ source: "telegram", sourceId: chat, text, metadata: { responseKind: "system" } }),
    ...(createProcessingMessage && updateProcessingMessage
      ? {
          progress: {
            create: (chat: string, text: string) => createProcessingMessage.call(telegram, chat, text),
            update: (chat: string, messageId: string, text: string) =>
              updateProcessingMessage.call(telegram, chat, messageId, text),
          },
        }
      : {}),
    retryAfterMs,
  };
}
