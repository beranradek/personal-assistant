/**
 * Slack API Route Handlers
 * =========================
 *
 * Read-only Slack integration endpoints for unread message awareness.
 * Supports multiple workspaces aggregated into a single view.
 *
 * Endpoints:
 *   GET /slack/unreads                      — unread summary across all workspaces
 *   GET /slack/messages/:channelId          — unread messages for a channel
 *
 * No messages are marked as read. No attachments/images/files are fetched.
 *
 * Slack Web API reference:
 *   https://api.slack.com/methods
 */

import { createLogger } from "../../../core/logger.js";
import type { SimpleRouter } from "../../server.js";
import type { ParsedRequest, JsonResponse, IntegApiError } from "../../types.js";
import type { SlackWorkspace, WorkspaceUnreads } from "./client.js";
import { getWorkspaceUnreads, getChannelMessages } from "./client.js";

const log = createLogger("integ-api:slack:routes");

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function toIntegError(err: unknown): IntegApiError {
  const message = err instanceof Error ? err.message : "Unknown error";

  // Detect auth errors from Slack API
  if (
    message.includes("invalid_auth") ||
    message.includes("token_revoked") ||
    message.includes("not_authed") ||
    message.includes("account_inactive")
  ) {
    return {
      error: "auth_failed",
      message: `Slack authentication failed: ${message}. Run 'pa integapi auth slack' to re-authenticate.`,
      service: "slack",
    };
  }

  if (message.includes("channel_not_found") || message.includes("not_in_channel")) {
    return {
      error: "not_found",
      message: `Slack channel not found or not accessible: ${message}`,
      service: "slack",
    };
  }

  return {
    error: "service_unavailable",
    message: `Slack request failed: ${message}`,
    service: "slack",
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register all Slack routes on the given router.
 *
 * @param router     - SimpleRouter to attach routes to
 * @param workspaces - Loaded Slack workspace configurations
 */
export function registerSlackRoutes(
  router: SimpleRouter,
  workspaces: SlackWorkspace[],
): void {
  // -------------------------------------------------------------------------
  // GET /slack/unreads
  //
  // Returns unread message counts per channel across all configured Slack
  // workspaces. Channels with direct mentions are highlighted.
  // DMs/MPIMs are always marked as "direct" (inherently relevant).
  //
  // Query params:
  //   workspace (optional) — filter to a single workspace by ID
  //
  // Slack API methods used:
  //   users.conversations — list channels user is member of
  //     https://api.slack.com/methods/users.conversations
  //   conversations.info — get unread count and last_read timestamp
  //     https://api.slack.com/methods/conversations.info
  //   conversations.history — scan unread messages for @mentions
  //     https://api.slack.com/methods/conversations.history
  //   users.info — resolve IM partner names
  //     https://api.slack.com/methods/users.info
  // -------------------------------------------------------------------------
  router.get("/slack/unreads", async (req: ParsedRequest, res: JsonResponse) => {
    try {
      if (workspaces.length === 0) {
        res.error({
          error: "auth_failed",
          message: "No Slack workspaces configured. Run 'pa integapi auth slack' to add one.",
          service: "slack",
        });
        return;
      }

      const filterWorkspace = req.query.get("workspace");

      const targets = filterWorkspace
        ? workspaces.filter((w) => w.id === filterWorkspace)
        : workspaces;

      if (targets.length === 0) {
        res.error({
          error: "not_found",
          message: `Workspace "${filterWorkspace}" not found. Available: ${workspaces.map((w) => w.id).join(", ")}`,
          service: "slack",
        });
        return;
      }

      // Fetch unreads from all target workspaces in parallel
      const results = await Promise.allSettled(
        targets.map((ws) => getWorkspaceUnreads(ws)),
      );

      const workspaceResults: WorkspaceUnreads[] = [];
      const errors: string[] = [];

      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        if (result.status === "fulfilled") {
          workspaceResults.push(result.value);
        } else {
          const wsId = targets[i]?.id ?? "unknown";
          const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
          log.warn({ workspaceId: wsId, err: result.reason }, "Failed to fetch unreads for workspace");
          errors.push(`${wsId}: ${errMsg}`);
        }
      }

      const totalUnread = workspaceResults.reduce((sum, w) => sum + w.totalUnread, 0);
      const totalMentions = workspaceResults.reduce((sum, w) => sum + w.totalMentions, 0);
      const totalUnreadChannels = workspaceResults.reduce(
        (sum, w) => sum + w.channels.length,
        0,
      );

      res.json({
        workspaces: workspaceResults.map((w) => ({
          workspaceId: w.workspaceId,
          workspaceName: w.workspaceName,
          channels: w.channels.map((c) => ({
            id: c.channel.id,
            name: c.channel.name,
            type: c.channel.type,
            unreadCount: c.unreadCount,
            mentionCount: c.mentionCount,
            hasMention: c.hasMention,
            isDirect: c.isDirect,
          })),
          totalUnread: w.totalUnread,
          totalMentions: w.totalMentions,
        })),
        summary: {
          totalWorkspaces: workspaceResults.length,
          totalUnreadChannels,
          totalUnread,
          totalMentions,
        },
        ...(errors.length > 0 ? { errors } : {}),
      });
    } catch (err) {
      log.error({ err }, "Slack unreads error");
      res.error(toIntegError(err));
    }
  });

  // -------------------------------------------------------------------------
  // GET /slack/messages/:channelId
  //
  // Returns text of unread messages in a specific channel.
  // No attachments, images, videos, or files are included.
  // Does NOT mark messages as read.
  //
  // Query params:
  //   workspace (optional) — workspace ID (required if multiple workspaces)
  //   limit     (optional) — max messages to return (default: 50, max: 100)
  //
  // Slack API methods used:
  //   conversations.info — get channel metadata and last_read
  //     https://api.slack.com/methods/conversations.info
  //   conversations.history — fetch unread messages
  //     https://api.slack.com/methods/conversations.history
  //   users.info — resolve user display names
  //     https://api.slack.com/methods/users.info
  // -------------------------------------------------------------------------
  router.get(
    "/slack/messages/:channelId",
    async (req: ParsedRequest, res: JsonResponse) => {
      try {
        if (workspaces.length === 0) {
          res.error({
            error: "auth_failed",
            message: "No Slack workspaces configured. Run 'pa integapi auth slack' to add one.",
            service: "slack",
          });
          return;
        }

        const { channelId } = req.params;
        if (!channelId) {
          res.error({
            error: "not_found",
            message: "Channel ID is required.",
            service: "slack",
          });
          return;
        }

        const workspaceId = req.query.get("workspace");
        const limitRaw = req.query.get("limit");
        const limit = Math.max(1, Math.min(100, parseInt(limitRaw ?? "50", 10) || 50));

        // Resolve workspace
        let workspace: SlackWorkspace | undefined;
        if (workspaceId) {
          workspace = workspaces.find((w) => w.id === workspaceId);
          if (!workspace) {
            res.error({
              error: "not_found",
              message: `Workspace "${workspaceId}" not found. Available: ${workspaces.map((w) => w.id).join(", ")}`,
              service: "slack",
            });
            return;
          }
        } else if (workspaces.length === 1) {
          workspace = workspaces[0]!;
        } else {
          res.error({
            error: "not_found",
            message: `Multiple workspaces configured. Specify ?workspace=<id>. Available: ${workspaces.map((w) => w.id).join(", ")}`,
            service: "slack",
          });
          return;
        }

        const result = await getChannelMessages(workspace, channelId, limit);

        res.json({
          workspace: workspace.id,
          channel: {
            id: result.channel.id,
            name: result.channel.name,
            type: result.channel.type,
          },
          messages: result.messages,
          unreadCount: result.unreadCount,
        });
      } catch (err) {
        log.error({ err }, "Slack messages error");
        res.error(toIntegError(err));
      }
    },
  );
}
