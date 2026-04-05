/**
 * Slack Web API Client
 * =====================
 *
 * Lightweight Slack Web API wrapper using Node.js built-in fetch (zero deps).
 * Supports multi-workspace token management via the credential store.
 *
 * Only read-only operations are used — no messages are marked as read.
 *
 * Slack Web API reference:
 *   https://api.slack.com/methods
 */

import { createLogger } from "../../../core/logger.js";
import type { CredentialStore } from "../../auth/store.js";

const log = createLogger("integ-api:slack:client");

/** Slack Web API base URL. */
const SLACK_API_BASE = "https://slack.com/api";

/** Maximum concurrent API calls per workspace. */
const MAX_CONCURRENCY = 8;

/** Maximum unread messages to fetch per channel for mention scanning. */
const MAX_UNREAD_SCAN = 100;

/** Maximum body chars for message text (prevent memory exhaustion). */
const MAX_TEXT_CHARS = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Stored Slack workspace credentials. */
export interface SlackCredentials {
  type: "slack";
  workspaceId: string;
  workspaceName: string;
  token: string;
  userId: string;
  teamId: string;
}

/** Resolved workspace with credentials loaded from the store. */
export interface SlackWorkspace {
  id: string;
  name: string;
  token: string;
  userId: string;
  teamId: string;
}

/** Channel/conversation info returned by the API. */
export interface SlackChannel {
  id: string;
  name: string;
  type: "channel" | "group" | "im" | "mpim";
  isPrivate: boolean;
}

/** Unread summary for a single channel. */
export interface ChannelUnreadInfo {
  channel: SlackChannel;
  unreadCount: number;
  mentionCount: number;
  hasMention: boolean;
  /** Whether this is a direct message (IM or MPIM). */
  isDirect: boolean;
}

/** A single Slack message (text-only, no attachments). */
export interface SlackMessage {
  ts: string;
  userId: string;
  userName: string;
  text: string;
  threadTs?: string;
  replyCount: number;
  time: string;
}

// ---------------------------------------------------------------------------
// Raw Slack API response types (internal)
// ---------------------------------------------------------------------------

interface SlackApiResponse {
  ok: boolean;
  error?: string;
}

interface SlackConversation {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  user?: string; // For IMs: the other user's ID
}

interface SlackConversationsListResponse extends SlackApiResponse {
  channels?: SlackConversation[];
  response_metadata?: { next_cursor?: string };
}

interface SlackConversationInfoResponse extends SlackApiResponse {
  channel?: {
    id: string;
    name?: string;
    last_read?: string;
    unread_count?: number;
    unread_count_display?: number;
    is_im?: boolean;
    is_mpim?: boolean;
    user?: string;
  };
}

interface SlackRawMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  files?: unknown[];
  attachments?: unknown[];
}

interface SlackHistoryResponse extends SlackApiResponse {
  messages?: SlackRawMessage[];
  has_more?: boolean;
}

interface SlackUserInfoResponse extends SlackApiResponse {
  user?: {
    id: string;
    name: string;
    real_name?: string;
    profile?: {
      display_name?: string;
      real_name?: string;
    };
    is_bot?: boolean;
  };
}

interface SlackAuthTestResponse extends SlackApiResponse {
  user_id?: string;
  team_id?: string;
  team?: string;
  user?: string;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

/**
 * Call a Slack Web API method with GET parameters.
 * Returns the parsed JSON response.
 * Throws on network errors; API-level errors are returned in the response.
 */
async function slackGet<T extends SlackApiResponse>(
  method: string,
  token: string,
  params?: Record<string, string>,
): Promise<T> {
  const qs = params ? `?${new URLSearchParams(params).toString()}` : "";
  const url = `${SLACK_API_BASE}/${method}${qs}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Slack API HTTP error: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

/**
 * Run async tasks with a concurrency limit.
 */
async function withConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = [];
  const executing = new Set<Promise<void>>();

  for (const task of tasks) {
    const p = task().then((result) => {
      results.push(result);
    });
    const wrapped = p.then(() => {
      executing.delete(wrapped);
    });
    executing.add(wrapped);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

// ---------------------------------------------------------------------------
// Workspace loading
// ---------------------------------------------------------------------------

/** Credential store profile prefix for Slack workspaces. */
const SLACK_PROFILE_PREFIX = "slack--";

/**
 * Load all Slack workspace credentials from the credential store.
 */
export async function loadSlackWorkspaces(
  store: CredentialStore,
): Promise<SlackWorkspace[]> {
  const profileIds = store.listProfiles();
  const workspaces: SlackWorkspace[] = [];

  for (const profileId of profileIds) {
    if (!profileId.startsWith(SLACK_PROFILE_PREFIX)) continue;

    const raw = await store.loadCredentials(profileId);
    if (!raw) continue;

    const creds = raw as Partial<SlackCredentials>;
    if (creds.type !== "slack" || !creds.token) {
      log.warn({ profileId }, "Skipping invalid Slack credential");
      continue;
    }

    workspaces.push({
      id: creds.workspaceId ?? profileId.replace(SLACK_PROFILE_PREFIX, ""),
      name: creds.workspaceName ?? creds.workspaceId ?? profileId,
      token: creds.token,
      userId: creds.userId ?? "",
      teamId: creds.teamId ?? "",
    });
  }

  log.info({ count: workspaces.length }, "Loaded Slack workspaces");
  return workspaces;
}

/**
 * Save a Slack workspace credential to the store.
 */
export async function saveSlackWorkspace(
  store: CredentialStore,
  creds: SlackCredentials,
): Promise<void> {
  const profileId = `${SLACK_PROFILE_PREFIX}${creds.workspaceId}`;
  await store.saveCredentials(profileId, creds);
  log.info({ profileId, workspace: creds.workspaceName }, "Saved Slack workspace credentials");
}

// ---------------------------------------------------------------------------
// User name cache
// ---------------------------------------------------------------------------

/** In-memory user name cache to avoid repeated API calls. */
const userCache = new Map<string, string>();

/**
 * Resolve a Slack user ID to a display name.
 * Uses an in-memory cache to minimize API calls.
 */
async function resolveUserName(
  userId: string,
  token: string,
): Promise<string> {
  if (!userId) return "unknown";

  const cacheKey = `${token.slice(-6)}:${userId}`;
  const cached = userCache.get(cacheKey);
  if (cached) return cached;

  try {
    const res = await slackGet<SlackUserInfoResponse>("users.info", token, {
      user: userId,
    });
    if (!res.ok || !res.user) return userId;

    const name =
      res.user.profile?.display_name ||
      res.user.real_name ||
      res.user.profile?.real_name ||
      res.user.name ||
      userId;

    userCache.set(cacheKey, name);
    return name;
  } catch (err) {
    log.debug({ err, userId }, "Failed to resolve user name");
    return userId;
  }
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Validate a Slack token by calling auth.test.
 * Returns user info on success, throws on failure.
 *
 * Slack auth.test docs:
 *   https://api.slack.com/methods/auth.test
 */
export async function validateSlackToken(token: string): Promise<{
  userId: string;
  teamId: string;
  teamName: string;
  userName: string;
}> {
  const res = await slackGet<SlackAuthTestResponse>("auth.test", token);
  if (!res.ok) {
    throw new Error(`Slack auth.test failed: ${res.error ?? "unknown error"}`);
  }
  return {
    userId: res.user_id ?? "",
    teamId: res.team_id ?? "",
    teamName: res.team ?? "",
    userName: res.user ?? "",
  };
}

/**
 * List all conversations the user is a member of.
 *
 * Slack users.conversations docs:
 *   https://api.slack.com/methods/users.conversations
 */
async function listUserConversations(
  token: string,
): Promise<SlackConversation[]> {
  const all: SlackConversation[] = [];
  let cursor: string | undefined;

  do {
    const params: Record<string, string> = {
      types: "public_channel,private_channel,mpim,im",
      exclude_archived: "true",
      limit: "200",
    };
    if (cursor) params.cursor = cursor;

    const res = await slackGet<SlackConversationsListResponse>(
      "users.conversations",
      token,
      params,
    );

    if (!res.ok) {
      throw new Error(`Slack users.conversations failed: ${res.error ?? "unknown"}`);
    }

    all.push(...(res.channels ?? []));
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return all;
}

/**
 * Classify a Slack conversation into a channel type.
 */
function classifyChannel(conv: SlackConversation): SlackChannel {
  let type: SlackChannel["type"] = "channel";
  if (conv.is_im) type = "im";
  else if (conv.is_mpim) type = "mpim";
  else if (conv.is_group || conv.is_private) type = "group";

  return {
    id: conv.id,
    name: conv.name ?? conv.user ?? conv.id,
    type,
    isPrivate: conv.is_private ?? conv.is_im ?? conv.is_mpim ?? false,
  };
}

/**
 * Get unread info for a single channel.
 *
 * Slack conversations.info docs:
 *   https://api.slack.com/methods/conversations.info
 */
async function getChannelUnreadInfo(
  channelId: string,
  channel: SlackChannel,
  token: string,
  userId: string,
): Promise<ChannelUnreadInfo | null> {
  const res = await slackGet<SlackConversationInfoResponse>(
    "conversations.info",
    token,
    { channel: channelId },
  );

  if (!res.ok || !res.channel) return null;

  const unreadCount = res.channel.unread_count_display ?? res.channel.unread_count ?? 0;
  if (unreadCount === 0) return null;

  const isDirect = channel.type === "im" || channel.type === "mpim";

  // For IMs/MPIMs, every message is inherently directed at the user
  if (isDirect) {
    return {
      channel,
      unreadCount,
      mentionCount: unreadCount,
      hasMention: true,
      isDirect: true,
    };
  }

  // For channels/groups: scan unread messages for @mentions
  const lastRead = res.channel.last_read ?? "0";
  let mentionCount = 0;

  try {
    const histRes = await slackGet<SlackHistoryResponse>(
      "conversations.history",
      token,
      {
        channel: channelId,
        oldest: lastRead,
        limit: String(MAX_UNREAD_SCAN),
      },
    );

    if (histRes.ok && histRes.messages) {
      const mentionPattern = `<@${userId}>`;
      for (const msg of histRes.messages) {
        if (msg.text?.includes(mentionPattern)) {
          mentionCount++;
        }
      }
    }
  } catch (err) {
    log.debug({ err, channelId }, "Failed to scan channel for mentions");
  }

  return {
    channel,
    unreadCount,
    mentionCount,
    hasMention: mentionCount > 0,
    isDirect: false,
  };
}

/**
 * Resolve IM channel names to the other user's display name.
 */
async function enrichImName(
  channel: SlackChannel,
  conv: SlackConversation,
  token: string,
): Promise<void> {
  if (channel.type === "im" && conv.user) {
    channel.name = await resolveUserName(conv.user, token);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Result of the unreads summary for a single workspace. */
export interface WorkspaceUnreads {
  workspaceId: string;
  workspaceName: string;
  channels: ChannelUnreadInfo[];
  totalUnread: number;
  totalMentions: number;
}

/**
 * Get unread message summary for a Slack workspace.
 *
 * Flow:
 * 1. List all user conversations (users.conversations)
 * 2. For each: get unread count (conversations.info)
 * 3. For channels with unreads: scan for @mentions (conversations.history)
 * 4. For IMs: resolve other user's name (users.info)
 *
 * Does NOT mark any messages as read.
 */
export async function getWorkspaceUnreads(
  workspace: SlackWorkspace,
): Promise<WorkspaceUnreads> {
  const conversations = await listUserConversations(workspace.token);

  // Classify conversations
  const classified = conversations.map((conv) => ({
    conv,
    channel: classifyChannel(conv),
  }));

  // Fetch unread info with concurrency limit
  const unreadResults = await withConcurrency(
    classified.map(({ conv, channel }) => async () => {
      // Enrich IM names in parallel with unread check
      await enrichImName(channel, conv, workspace.token);
      return getChannelUnreadInfo(
        channel.id,
        channel,
        workspace.token,
        workspace.userId,
      );
    }),
    MAX_CONCURRENCY,
  );

  const channels = unreadResults.filter(
    (r): r is ChannelUnreadInfo => r != null,
  );

  // Sort: mentions first, then by unread count descending
  channels.sort((a, b) => {
    if (a.hasMention !== b.hasMention) return a.hasMention ? -1 : 1;
    if (a.isDirect !== b.isDirect) return a.isDirect ? -1 : 1;
    return b.unreadCount - a.unreadCount;
  });

  const totalUnread = channels.reduce((sum, c) => sum + c.unreadCount, 0);
  const totalMentions = channels.reduce((sum, c) => sum + c.mentionCount, 0);

  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    channels,
    totalUnread,
    totalMentions,
  };
}

/**
 * Get unread messages for a specific channel in a workspace.
 *
 * Returns text-only messages (no attachments, images, or files).
 * Does NOT mark messages as read.
 *
 * Slack conversations.history docs:
 *   https://api.slack.com/methods/conversations.history
 * Slack conversations.info docs:
 *   https://api.slack.com/methods/conversations.info
 */
export async function getChannelMessages(
  workspace: SlackWorkspace,
  channelId: string,
  limit = 50,
): Promise<{
  channel: SlackChannel;
  messages: SlackMessage[];
  unreadCount: number;
}> {
  // Get channel info for last_read and metadata
  const infoRes = await slackGet<SlackConversationInfoResponse>(
    "conversations.info",
    workspace.token,
    { channel: channelId },
  );

  if (!infoRes.ok || !infoRes.channel) {
    throw new Error(
      `Failed to get channel info: ${infoRes.error ?? "unknown"}`,
    );
  }

  const channelData = infoRes.channel;
  const lastRead = channelData.last_read ?? "0";
  const unreadCount =
    channelData.unread_count_display ?? channelData.unread_count ?? 0;

  const channel: SlackChannel = {
    id: channelId,
    name: channelData.name ?? channelId,
    type: channelData.is_im
      ? "im"
      : channelData.is_mpim
        ? "mpim"
        : "channel",
    isPrivate: channelData.is_im ?? channelData.is_mpim ?? false,
  };

  // Resolve IM name
  if (channel.type === "im" && channelData.user) {
    channel.name = await resolveUserName(channelData.user, workspace.token);
  }

  // Fetch unread messages (oldest = last_read to get only unread)
  const histParams: Record<string, string> = {
    channel: channelId,
    limit: String(Math.min(limit, MAX_UNREAD_SCAN)),
  };
  // Only use oldest filter if there's a valid last_read
  if (lastRead !== "0") {
    histParams.oldest = lastRead;
  }

  const histRes = await slackGet<SlackHistoryResponse>(
    "conversations.history",
    workspace.token,
    histParams,
  );

  if (!histRes.ok) {
    throw new Error(
      `Failed to get channel history: ${histRes.error ?? "unknown"}`,
    );
  }

  // Resolve user names and map messages (text-only, no attachments)
  const rawMessages = histRes.messages ?? [];
  const messages: SlackMessage[] = await Promise.all(
    rawMessages.map(async (msg) => {
      const msgUserId = msg.user ?? msg.bot_id ?? "";
      const userName = await resolveUserName(msgUserId, workspace.token);
      const ts = parseFloat(msg.ts ?? "0");

      return {
        ts: msg.ts ?? "",
        userId: msgUserId,
        userName,
        text: (msg.text ?? "").slice(0, MAX_TEXT_CHARS),
        threadTs: msg.thread_ts,
        replyCount: msg.reply_count ?? 0,
        time: ts > 0 ? new Date(ts * 1000).toISOString() : "",
      };
    }),
  );

  // Sort oldest first (Slack returns newest first by default)
  messages.sort((a, b) => a.ts.localeCompare(b.ts));

  return { channel, messages, unreadCount };
}
