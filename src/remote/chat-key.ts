/**
 * Namespaced chat keys for remote sessions: `<channel>:<id>` (see
 * docs/plans/active/2026-11-11-slack-remote-session-communication/spec.md section 5.2 and 5.3).
 */
import { REMOTE_CHANNEL_IDS, type RemoteChannelId, type RemoteChatKey } from "./protocol.js";

export function makeChatKey(channel: RemoteChannelId, id: string): RemoteChatKey {
  return `${channel}:${id}`;
}

/**
 * `telegram:123` -> `{ channel: "telegram", id: "123" }` (split at the FIRST colon). A bare integer string (Telegram ids can
 * be negative) is a legacy Telegram chat id. Returns undefined when the key is invalid.
 */
export function parseChatKey(key: string): { channel: RemoteChannelId; id: string } | undefined {
  if (/^-?\d+$/.test(key)) return { channel: "telegram", id: key };
  const colon = key.indexOf(":");
  if (colon < 0) return undefined;
  const channel = key.slice(0, colon);
  const id = key.slice(colon + 1);
  if (id.length === 0 || !(REMOTE_CHANNEL_IDS as readonly string[]).includes(channel)) return undefined;
  return { channel: channel as RemoteChannelId, id };
}
