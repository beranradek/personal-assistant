/**
 * Default chat for control requests (spec 5.4): shared by the HTTP route (`pa remote`, stdio MCP server) and the in-daemon MCP.
 */
import { makeChatKey } from "./chat-key.js";
import type { RemoteChannelId, RemoteControlRequest } from "./protocol.js";

/** Default chat keys per enabled channel: `telegram:<first allowed id>`, `slack:<first allowed id>`. */
export type RemoteDefaultChatIds = Partial<Record<RemoteChannelId, string>>;

export interface RemoteDefaultChats {
  defaultChatIds?: RemoteDefaultChatIds;
  /** `claudeCode.remote.defaultChannel`. */
  defaultChannel?: RemoteChannelId;
}

/** Build the default chat keys from the first allowed user of each enabled channel. */
export function buildDefaultChatIds(first: Partial<Record<RemoteChannelId, string | number | undefined>>): RemoteDefaultChatIds {
  const ids: RemoteDefaultChatIds = {};
  for (const [channel, id] of Object.entries(first) as [RemoteChannelId, string | number | undefined][]) {
    if (id !== undefined && id !== "") ids[channel] = makeChatKey(channel, String(id));
  }
  return ids;
}

/**
 * Fill `chatId` of a control request.
 * - `chatId` given (key or bare Telegram id): unchanged.
 * - `attach`: channel = `request.channel`, else `defaultChannel` (when it has a default chat), else telegram, else slack.
 * - `detach`/`status`: without `chatId` and `channel` the bridge acts on whichever chat holds the target session.
 */
export function resolveControlChat(
  request: RemoteControlRequest,
  defaults: RemoteDefaultChats,
): { request: RemoteControlRequest } | { error: string } {
  if (request.chatId) return { request };
  const ids = defaults.defaultChatIds ?? {};
  if (request.action !== "attach" && !request.channel) return { request };
  const channel =
    request.channel ??
    (defaults.defaultChannel && ids[defaults.defaultChannel] ? defaults.defaultChannel : undefined) ??
    (ids.telegram ? "telegram" : ids.slack ? "slack" : undefined);
  const chatId = channel ? ids[channel] : undefined;
  if (!chatId) {
    return {
      error: request.channel
        ? `Channel ${request.channel} is not enabled or has no allowed user.`
        : "No default chat configured (set allowedUserIds of an enabled remote channel).",
    };
  }
  return { request: { ...request, chatId } };
}
