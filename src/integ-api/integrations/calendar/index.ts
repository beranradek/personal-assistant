/**
 * Google Calendar Integration Module
 * =====================================
 *
 * Implements IntegrationModule for Google Calendar read-only access.
 * Provides today's events, week view, event details, and free/busy queries.
 *
 * Capabilities: today, week, event, free-busy
 *
 * Google Calendar API v3:
 * https://developers.google.com/calendar/api/v3/reference
 *
 * Auth: OAuth2 via AuthManager with service ID "calendar".
 * Required scope: https://www.googleapis.com/auth/calendar.readonly
 */

import type { AuthManager } from "../../auth/manager.js";
import { AuthFailedError } from "../../auth/manager.js";
import type { SimpleRouter } from "../../server.js";
import type { IntegrationModule, IntegrationManifest } from "../../types.js";
import { CALENDAR_RATE_LIMITS } from "./rate-limits.js";
import { registerCalendarRoutes } from "./routes.js";
import { createLogger } from "../../../core/logger.js";

const log = createLogger("integ-api:calendar");

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const CALENDAR_MANIFEST: IntegrationManifest = {
  id: "calendar",
  name: "Google Calendar",
  status: "active",
  capabilities: ["today", "week", "event", "free-busy"],
  endpoints: [
    {
      method: "GET",
      path: "/calendar/today",
      params: [],
    },
    {
      method: "GET",
      path: "/calendar/week",
      params: [],
    },
    {
      method: "GET",
      path: "/calendar/event/:id",
      params: ["id"],
    },
    {
      method: "GET",
      path: "/calendar/free-busy",
      params: ["timeMin", "timeMax"],
    },
  ],
  rateLimits: CALENDAR_RATE_LIMITS,
};

// ---------------------------------------------------------------------------
// Module factory
// ---------------------------------------------------------------------------

/**
 * Create the Google Calendar integration module.
 *
 * @param authMgr - AuthManager used to obtain Bearer tokens for "calendar" service.
 */
export function createCalendarModule(authMgr: AuthManager): IntegrationModule {
  return {
    id: "calendar",
    manifest: CALENDAR_MANIFEST,

    routes(router: SimpleRouter): void {
      registerCalendarRoutes(router, authMgr);
    },

    async healthCheck(): Promise<boolean> {
      try {
        await authMgr.getAccessToken("calendar");
        return true;
      } catch (err) {
        if (err instanceof AuthFailedError) {
          log.warn({ service: "calendar" }, "Health check failed: no valid auth profile");
          return false;
        }
        log.warn({ err }, "Health check error");
        return false;
      }
    },
  };
}
