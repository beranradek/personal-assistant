/**
 * Slack router for remote session mode (see docs/plans/active/2026-11-11-slack-remote-session-communication/spec.md 5.5).
 *
 * `onMessage` wraps the Slack adapter message callback. ONLY direct messages (`channelType === "im"`) can reach the bridge;
 * channel messages always take the old queue path. `onCommand` handles `/cc [help|status|attach [n|name] [force]|detach|pa <text>]`
 * and returns the ephemeral answer text (empty on success: the bridge confirms attach and detach in the DM itself).
 * The bridge gets the chat key `slack:<userId>`. The adapter checks the sender allowlist before it calls the router.
 */
import type { AdapterMessage } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import { createAdapterMessage } from "../adapters/types.js";
import { makeChatKey } from "./chat-key.js";
import { decodeSlackInbound } from "./channels/slack-format.js";
import type { RemoteBridge } from "./protocol.js";

const log = createLogger("remote-slack-router");

export interface SlackRouterDeps {
  bridge: RemoteBridge;
  /** Normal gateway queue. */
  enqueue: (msg: AdapterMessage) => void;
  /** Send a DM text to a Slack user id (the Slack channel's `sendText`). Without it notices are only logged. */
  send?: (userId: string, text: string) => Promise<void>;
}

export interface SlackRouter {
  onMessage(msg: AdapterMessage): void;
  /** Returns the ephemeral answer text, or undefined for an empty ack. */
  onCommand(command: { userId: string; text: string; channelId?: string }): Promise<string | undefined>;
}

/** Text of `/cc help`. */
export function slackHelpText(attached: boolean): string {
  return [
    "Remote Claude Code session commands:",
    "/cc status - list live sessions",
    "/cc attach [n|name] [force] - attach this chat to a session",
    "/cc detach - detach from the session",
    "/cc pa <text> - send text to the PA assistant",
    "/cc help - this help",
    "",
    attached
      ? "Now: attached. Direct messages go to the session."
      : "Now: not attached. Direct messages go to the PA assistant. Use /cc status and /cc attach to talk to a session.",
  ].join("\n");
}

/** Parse the argument of `attach`: `[n|name] [force]`. */
function parseAttachArg(arg: string): { target?: string; force: boolean } {
  const words = arg.split(/\s+/).filter(Boolean);
  const force = words.length > 0 && words[words.length - 1]!.toLowerCase() === "force";
  const target = (force ? words.slice(0, -1) : words).join(" ");
  return { ...(target ? { target } : {}), force };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

export function createSlackRouter(deps: SlackRouterDeps): SlackRouter {
  const { bridge, enqueue } = deps;

  function notify(userId: string, text: string): void {
    if (!deps.send) {
      log.warn({ userId }, "router: no send function, notice dropped");
      return;
    }
    deps.send(userId, text).catch((err) => log.error({ err: String(err), userId }, "router: slack notice failed"));
  }

  async function runControl(
    userId: string,
    action: "attach" | "detach" | "status",
    target?: string,
    force?: boolean,
  ): Promise<string | undefined> {
    try {
      const res = await bridge.control({
        action,
        chatId: makeChatKey("slack", userId),
        ...(target ? { target } : {}),
        ...(force ? { force } : {}),
      });
      if (action === "status") return res.message;
      if (res.ok) return undefined; // the bridge confirms in the DM
      const hint = action === "attach" && !force && /\bis attached to\b/.test(res.message);
      return hint ? `${res.message} To take it over: /cc attach ${target ?? "<n>"} force` : res.message;
    } catch (err) {
      log.error({ err: String(err), action }, "router: control failed");
      return `Command failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async function onCommand(command: { userId: string; text: string; channelId?: string }): Promise<string | undefined> {
    const { userId } = command;
    const trimmed = command.text.trim();
    const space = trimmed.search(/\s/);
    const sub = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
    const arg = space < 0 ? "" : trimmed.slice(space).trim();
    switch (sub) {
      case "status":
        return runControl(userId, "status");
      case "attach": {
        const { target, force } = parseAttachArg(arg);
        return runControl(userId, "attach", target, force);
      }
      case "detach":
        return runControl(userId, "detach");
      case "pa": {
        if (!arg) return "Usage: /cc pa <text> - send text to the PA agent.";
        // An answer goes to the DM only. A command has no message ts, so the answer is a top level DM message.
        const dm = command.channelId;
        if (!dm || !dm.startsWith("D")) return "Use /cc pa in the direct message with this app.";
        enqueue(createAdapterMessage("slack", `${dm}--`, arg, { channelId: dm, threadId: "", userId, channelType: "im" }));
        return undefined;
      }
      default:
        return slackHelpText(bridge.isAttached(makeChatKey("slack", userId)));
    }
  }

  function onMessage(msg: AdapterMessage): void {
    const userId = str(msg.metadata?.["userId"]);
    if (msg.source !== "slack" || msg.metadata?.["channelType"] !== "im" || !userId) {
      enqueue(msg);
      return;
    }
    const chatKey = makeChatKey("slack", userId);
    if (!bridge.isAttached(chatKey)) {
      enqueue(msg);
      return;
    }
    const channelId = str(msg.metadata?.["channelId"]);
    const ts = str(msg.metadata?.["messageTs"]) ?? str(msg.metadata?.["threadId"]);
    const ref = channelId && ts ? `${channelId}:${ts}` : undefined;
    const result = bridge.forward(chatKey, decodeSlackInbound(msg.text), ref);
    if (!result.accepted) notify(userId, `Not sent to the session: ${result.reason}`);
  }

  return { onMessage, onCommand };
}
