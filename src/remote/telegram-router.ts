/**
 * Telegram router for remote session mode
 * =======================================
 *
 * Wraps the Telegram adapter `onMessage` callback. It is only created when remote mode is enabled.
 * - `/attach [n|name]`, `/detach`, `/status`: control commands (answered through `send`).
 * - `/pa <text>`: normal PA agent queue with `<text>` as the message text.
 * - Other text (also other slash commands): forwarded to the attached session when the chat is attached, else the normal queue.
 *   Attachment and voice messages arrive as plain text from the adapter ("Received document and saved it to <path>" or the
 *   transcript). They are forwarded as text and never parsed as commands.
 *
 * The adapter checks the sender allowlist before it calls the router.
 */

import type { AdapterMessage } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import type { RemoteBridge } from "./protocol.js";

const log = createLogger("remote-telegram-router");

export interface TelegramRouterDeps {
  bridge: RemoteBridge;
  /** Normal gateway queue. */
  enqueue: (msg: AdapterMessage) => void;
  /** Send a plain text reply to a Telegram chat. */
  send: (chatId: string, text: string) => Promise<void>;
  /**
   * Username of this bot (without @). When set, a command addressed to another bot is not handled.
   * When unset, any `@name` suffix is accepted (the daemon does not pass it yet).
   */
  botUsername?: string;
}

/** `/cmd`, `/cmd@botname`, optional arguments. */
const COMMAND_RE = /^\/([A-Za-z]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/;

export function createTelegramRouter(deps: TelegramRouterDeps): (msg: AdapterMessage) => void {
  const { bridge, enqueue, send } = deps;
  const botUsername = deps.botUsername?.replace(/^@/, "");

  function reply(chatId: string, text: string): void {
    send(chatId, text).catch((err) => log.error({ err, chatId }, "router: telegram reply failed"));
  }

  async function runControl(chatId: string, action: "attach" | "detach" | "status", target?: string): Promise<void> {
    try {
      const res = await bridge.control({ action, chatId, ...(target ? { target } : {}) });
      // The bridge itself confirms a successful attach or detach in Telegram. Answer status and failures here.
      if (action === "status" || !res.ok) reply(chatId, res.message);
    } catch (err) {
      log.error({ err, chatId, action }, "router: control failed");
      reply(chatId, `Command failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (msg: AdapterMessage): void => {
    if (msg.source !== "telegram") {
      enqueue(msg);
      return;
    }
    const chatId = msg.sourceId;
    // Voice, image and document messages are never commands.
    const inputType = msg.metadata?.["inputType"];
    const isPlainText = inputType === undefined || inputType === "text";
    const match = isPlainText ? COMMAND_RE.exec(msg.text.trim()) : null;
    const addressedElsewhere =
      match?.[2] !== undefined && botUsername !== undefined && match[2].toLowerCase() !== botUsername.toLowerCase();

    if (match && !addressedElsewhere) {
      const command = match[1].toLowerCase();
      const arg = (match[3] ?? "").trim();
      switch (command) {
        case "attach":
          void runControl(chatId, "attach", arg || undefined);
          return;
        case "detach":
          void runControl(chatId, "detach");
          return;
        case "status":
          void runControl(chatId, "status");
          return;
        case "pa":
          if (!arg) {
            reply(chatId, "Usage: /pa <text> - send text to the PA agent.");
            return;
          }
          enqueue({ ...msg, text: arg });
          return;
        default:
          break; // other slash text follows the normal path
      }
    }

    if (bridge.isAttached(chatId)) {
      const result = bridge.forward(chatId, msg.text);
      if (!result.accepted) reply(chatId, `Not sent to the session: ${result.reason}`);
      return;
    }
    enqueue(msg);
  };
}
