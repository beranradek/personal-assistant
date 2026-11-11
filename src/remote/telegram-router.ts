/**
 * Telegram router for remote session mode
 * =======================================
 *
 * Wraps the Telegram adapter `onMessage` callback. It is only created when remote mode is enabled.
 * - `/attach [n|name] [force]`, `/detach`, `/status`: control commands (answered through `send`).
 * - `/help`, `/start`: list of these commands and the current state (attached or not).
 * - `/pa <text>`: normal PA agent queue with `<text>` as the message text.
 * - Other text (also other slash commands): forwarded to the attached session when the chat is attached, else the normal queue.
 *   Attachment and voice messages arrive as plain text from the adapter ("Received document and saved it to <path>" or the
 *   transcript). They are forwarded as text and never parsed as commands.
 *
 * The bridge gets the chat key `telegram:<chatId>` (see chat-key.ts); `send` keeps the RAW chat id (the Telegram adapter needs it).
 * The adapter checks the sender allowlist before it calls the router.
 */

import type { AdapterMessage } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import { makeChatKey } from "./chat-key.js";
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

/** Parse the argument of `/attach`: `[n|name] [force]`. */
function parseAttachArg(arg: string): { target?: string; force: boolean } {
  const words = arg.split(/\s+/).filter(Boolean);
  const force = words.length > 0 && words[words.length - 1]!.toLowerCase() === "force";
  const target = (force ? words.slice(0, -1) : words).join(" ");
  return { ...(target ? { target } : {}), force };
}

/** A refusal because another chat holds the session tells how to take it over. */
function withForceHint(message: string, target: string | undefined): string {
  return /\bis attached to\b/.test(message) ? `${message} To take it over: /attach ${target ?? "<n>"} force` : message;
}

/** Text of `/help` (and `/start`). */
export function helpText(attached: boolean): string {
  return [
    "Remote Claude Code session commands:",
    "/status - list live sessions",
    "/attach [n|name] - attach this chat to a session",
    "/detach - detach from the session",
    "/pa <text> - send text to the PA assistant",
    "/help - this help",
    "",
    attached
      ? "Now: attached. Other text goes to the session."
      : "Now: not attached. Other text goes to the PA assistant. Use /status and /attach to talk to a session.",
  ].join("\n");
}

export function createTelegramRouter(deps: TelegramRouterDeps): (msg: AdapterMessage) => void {
  const { bridge, enqueue, send } = deps;
  const botUsername = deps.botUsername?.replace(/^@/, "");

  function reply(chatId: string, text: string): void {
    send(chatId, text).catch((err) => log.error({ err, chatId }, "router: telegram reply failed"));
  }

  async function runControl(
    chatId: string,
    action: "attach" | "detach" | "status",
    target?: string,
    force?: boolean,
  ): Promise<void> {
    try {
      const res = await bridge.control({
        action,
        chatId: makeChatKey("telegram", chatId),
        ...(target ? { target } : {}),
        ...(force ? { force } : {}),
      });
      // The bridge itself confirms a successful attach or detach in Telegram. Answer status and failures here.
      if (action === "status") reply(chatId, res.message);
      else if (!res.ok) reply(chatId, action === "attach" && !force ? withForceHint(res.message, target) : res.message);
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
    const chatKey = makeChatKey("telegram", chatId);
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
          {
            const { target, force } = parseAttachArg(arg);
            void runControl(chatId, "attach", target, force);
          }
          return;
        case "detach":
          void runControl(chatId, "detach");
          return;
        case "status":
          void runControl(chatId, "status");
          return;
        case "help":
        case "start": // Telegram sends /start when a user opens the bot for the first time
          reply(chatId, helpText(bridge.isAttached(chatKey)));
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

    if (bridge.isAttached(chatKey)) {
      const result = bridge.forward(chatKey, msg.text);
      if (!result.accepted) reply(chatId, `Not sent to the session: ${result.reason}`);
      return;
    }
    enqueue(msg);
  };
}
