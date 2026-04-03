/**
 * Gmail Integration Module
 * =========================
 *
 * Implements the IntegrationModule contract for Gmail read-only access.
 *
 * Capabilities: list, read, search, labels
 * Rate limit: 60 requests/minute (Gmail API quota per user)
 *
 * Gmail API reference:
 *   https://developers.google.com/gmail/api/reference/rest
 */

import type { IntegrationModule, IntegrationManifest } from "../../types.js";
import type { AuthManager } from "../../auth/manager.js";
import type { SimpleRouter } from "../../server.js";
import { registerGmailRoutes } from "./routes.js";
import { createOutboundRateLimiter, GMAIL_REQUESTS_PER_MINUTE } from "./rate-limits.js";

// ---------------------------------------------------------------------------
// Gmail manifest
// ---------------------------------------------------------------------------

const GMAIL_MANIFEST: IntegrationManifest = {
  id: "gmail",
  name: "Gmail",
  status: "active",
  capabilities: ["list", "read", "search", "labels"],
  endpoints: [
    {
      method: "GET",
      path: "/gmail/messages",
      params: ["query", "max", "labelIds"],
    },
    {
      method: "GET",
      path: "/gmail/messages/:id",
      params: ["id"],
    },
    {
      method: "GET",
      path: "/gmail/labels",
    },
    {
      method: "GET",
      path: "/gmail/search",
      params: ["q", "max"],
    },
  ],
  rateLimits: {
    requestsPerMinute: GMAIL_REQUESTS_PER_MINUTE,
  },
};

// ---------------------------------------------------------------------------
// createGmailModule
// ---------------------------------------------------------------------------

/**
 * Create the Gmail integration module.
 *
 * @param authManager - Auth manager used to obtain access tokens for "gmail" service.
 */
export function createGmailModule(authManager: AuthManager): IntegrationModule {
  const rateLimiter = createOutboundRateLimiter();

  return {
    id: "gmail",
    manifest: GMAIL_MANIFEST,

    routes(router: SimpleRouter): void {
      registerGmailRoutes(router, authManager, rateLimiter);
    },

    async healthCheck(): Promise<boolean> {
      try {
        // Attempt to get a token — if auth is configured, consider healthy
        await authManager.getAccessToken("gmail");
        return true;
      } catch {
        return false;
      }
    },
  };
}
