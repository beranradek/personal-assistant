/**
 * Slack Integration Module
 * =========================
 *
 * Implements IntegrationModule for Slack read-only unread message awareness.
 * Supports multiple workspaces for aggregated unread overviews.
 *
 * Capabilities: unreads, messages
 *
 * This is a data integration — distinct from the Slack adapter which handles
 * bidirectional communication with the assistant. This module provides the
 * agent with awareness of pending Slack activity across workspaces.
 *
 * Auth: Slack user tokens (xoxp-) stored in the credential store.
 * Required scopes: channels:read, channels:history, groups:read, groups:history,
 *                  im:read, im:history, mpim:read, mpim:history, users:read
 *
 * Slack Web API reference:
 *   https://api.slack.com/methods
 */

import type { SimpleRouter } from "../../server.js";
import type { IntegrationModule, IntegrationManifest } from "../../types.js";
import type { SlackWorkspace } from "./client.js";
import { SLACK_RATE_LIMITS } from "./rate-limits.js";
import { registerSlackRoutes } from "./routes.js";
import { createLogger } from "../../../core/logger.js";

const log = createLogger("integ-api:slack");

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const SLACK_MANIFEST: IntegrationManifest = {
  id: "slack",
  name: "Slack",
  status: "active",
  capabilities: ["unreads", "messages"],
  endpoints: [
    {
      method: "GET",
      path: "/slack/unreads",
      params: ["workspace"],
    },
    {
      method: "GET",
      path: "/slack/messages/:channelId",
      params: ["channelId", "workspace", "limit"],
    },
  ],
  rateLimits: SLACK_RATE_LIMITS,
};

// ---------------------------------------------------------------------------
// Module factory
// ---------------------------------------------------------------------------

/**
 * Create the Slack integration module.
 *
 * @param workspaces - Loaded Slack workspace configurations (tokens + metadata).
 */
export function createSlackModule(
  workspaces: SlackWorkspace[],
): IntegrationModule {
  return {
    id: "slack",
    manifest: {
      ...SLACK_MANIFEST,
      status: workspaces.length > 0 ? "active" : "disabled",
    },

    routes(router: SimpleRouter): void {
      registerSlackRoutes(router, workspaces);
    },

    async healthCheck(): Promise<boolean> {
      if (workspaces.length === 0) {
        log.warn("Health check failed: no Slack workspaces configured");
        return false;
      }
      // A basic check — if we have at least one workspace with a token, consider healthy.
      // Full validation (auth.test) happens on actual API calls.
      return workspaces.some((w) => w.token.length > 0);
    },
  };
}
