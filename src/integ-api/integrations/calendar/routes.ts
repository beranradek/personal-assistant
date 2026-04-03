/**
 * Google Calendar API route handlers
 * =====================================
 *
 * Google Calendar API v3 reference:
 * https://developers.google.com/calendar/api/v3/reference
 *
 * All routes authenticate via AuthManager.getAccessToken("calendar") and send
 * a Bearer token in the Authorization header.
 *
 * Routes:
 *   GET /calendar/today        — today's events (00:00–23:59 local day)
 *   GET /calendar/week         — events from now through next 7 days
 *   GET /calendar/event/:id    — full details of a single event
 *   GET /calendar/free-busy    — busy intervals for a time range
 *
 * All responses are plain objects (no raw Google API types leak to the agent).
 */

import { createLogger } from "../../../core/logger.js";
import type { AuthManager } from "../../auth/manager.js";
import { AuthFailedError } from "../../auth/manager.js";
import type { SimpleRouter } from "../../server.js";
import type { ParsedRequest, JsonResponse } from "../../types.js";

const log = createLogger("integ-api:calendar:routes");

// ---------------------------------------------------------------------------
// Google Calendar API base URL
// https://developers.google.com/calendar/api/v3/reference
// ---------------------------------------------------------------------------

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

// ---------------------------------------------------------------------------
// Simplified response types (agent-facing, no raw Google API shapes)
// ---------------------------------------------------------------------------

/** A single calendar event returned to the agent. */
export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  status: string;
  htmlLink?: string;
  attendees?: Array<{ email: string; displayName?: string; responseStatus?: string }>;
  organizer?: { email: string; displayName?: string };
  conferenceData?: { entryPoints?: Array<{ entryPointType: string; uri: string }> };
}

/** Busy interval for free/busy queries. */
export interface BusyInterval {
  start: string;
  end: string;
}

/** Response shape for free/busy endpoint. */
export interface FreeBusyResponse {
  timeMin: string;
  timeMax: string;
  busy: BusyInterval[];
}

// ---------------------------------------------------------------------------
// Raw Google API types (internal — never exposed to agent)
// ---------------------------------------------------------------------------

interface GoogleEventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

interface GoogleAttendee {
  email: string;
  displayName?: string;
  responseStatus?: string;
}

interface GoogleConferenceEntryPoint {
  entryPointType: string;
  uri: string;
}

interface GoogleEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start: GoogleEventDateTime;
  end: GoogleEventDateTime;
  status?: string;
  htmlLink?: string;
  attendees?: GoogleAttendee[];
  organizer?: { email: string; displayName?: string };
  conferenceData?: { entryPoints?: GoogleConferenceEntryPoint[] };
}

interface GoogleEventsListResponse {
  items?: GoogleEvent[];
  nextPageToken?: string;
}

interface GoogleFreeBusyCalendar {
  busy?: Array<{ start: string; end: string }>;
}

interface GoogleFreeBusyResponse {
  timeMin: string;
  timeMax: string;
  calendars?: Record<string, GoogleFreeBusyCalendar>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a raw Google event to the agent-facing CalendarEvent shape.
 * Provides safe fallbacks for optional fields.
 */
function mapEvent(raw: GoogleEvent): CalendarEvent {
  return {
    id: raw.id,
    summary: raw.summary ?? "(no title)",
    description: raw.description,
    location: raw.location,
    start: raw.start,
    end: raw.end,
    status: raw.status ?? "confirmed",
    htmlLink: raw.htmlLink,
    attendees: raw.attendees,
    organizer: raw.organizer,
    conferenceData: raw.conferenceData,
  };
}

/** Sort events by start time (dateTime takes priority over date). */
function sortEventsByStart(events: CalendarEvent[]): CalendarEvent[] {
  return [...events].sort((a, b) => {
    const aTime = a.start.dateTime ?? a.start.date ?? "";
    const bTime = b.start.dateTime ?? b.start.date ?? "";
    return aTime.localeCompare(bTime);
  });
}

/**
 * Return RFC 3339 timestamps for the start and end of "today" in UTC.
 *
 * We use ISO 8601 midnight-to-midnight in UTC as a consistent reference.
 * The Google Calendar API applies the calendar's own timezone when no
 * explicit timezone is specified, so UTC boundaries are a safe default.
 */
function todayBoundaries(): { timeMin: string; timeMax: string } {
  const now = new Date();
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setUTCHours(23, 59, 59, 999);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

/**
 * Return RFC 3339 timestamps for "now" through "now + 7 days".
 */
function weekBoundaries(): { timeMin: string; timeMax: string } {
  const now = new Date();
  const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { timeMin: now.toISOString(), timeMax: end.toISOString() };
}

/**
 * Perform a GET request to the Google Calendar API with Bearer auth.
 * Returns the parsed JSON body.
 * Throws on non-2xx responses with a descriptive message.
 *
 * https://developers.google.com/calendar/api/v3/reference
 */
async function calendarGet<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "(unreadable)");
    const err = new Error(`Calendar API error: HTTP ${response.status} — ${errorText}`);
    (err as NodeJS.ErrnoException).code = String(response.status);
    throw err;
  }

  return (await response.json()) as T;
}

/**
 * Perform a POST request to the Google Calendar API with Bearer auth.
 *
 * https://developers.google.com/calendar/api/v3/reference/freebusy/query
 */
async function calendarPost<T>(url: string, token: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "(unreadable)");
    const err = new Error(`Calendar API error: HTTP ${response.status} — ${errorText}`);
    (err as NodeJS.ErrnoException).code = String(response.status);
    throw err;
  }

  return (await response.json()) as T;
}

/**
 * Fetch events list from Google Calendar API.
 * https://developers.google.com/calendar/api/v3/reference/events/list
 *
 * GET /calendars/{calendarId}/events
 * Required query params: timeMin (RFC 3339), timeMax (RFC 3339)
 * Optional: singleEvents=true, orderBy=startTime, maxResults
 */
async function fetchEvents(
  token: string,
  timeMin: string,
  timeMax: string,
  maxResults = 50,
): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(maxResults),
  });

  const url = `${CALENDAR_API_BASE}/calendars/primary/events?${params.toString()}`;
  const data = await calendarGet<GoogleEventsListResponse>(url, token);
  return sortEventsByStart((data.items ?? []).map(mapEvent));
}

// ---------------------------------------------------------------------------
// Route handler factories
// ---------------------------------------------------------------------------

/**
 * Handle auth errors from the auth manager, translating them to structured
 * IntegApiError responses. Rethrows non-auth errors.
 */
function handleRouteError(
  err: unknown,
  res: JsonResponse,
  routeName: string,
): void {
  if (err instanceof AuthFailedError) {
    log.warn({ service: err.service, profilesTried: err.profilesTried }, `${routeName}: auth failed`);
    res.error({
      error: "auth_failed",
      message: `Google Calendar authentication failed after trying ${err.profilesTried} profile(s). Run 'pa integapi auth google' to re-authenticate.`,
      service: "calendar",
      profilesTried: err.profilesTried,
    });
    return;
  }

  // Check for upstream 401/403 (token expired mid-request)
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "401" || code === "403") {
    log.warn({ code }, `${routeName}: upstream auth error`);
    res.error({
      error: "auth_failed",
      message: "Google Calendar returned an authentication error. Token may have expired.",
      service: "calendar",
    });
    return;
  }

  log.error({ err }, `${routeName}: unexpected error`);
  res.error({
    error: "service_unavailable",
    message: "Google Calendar request failed. See integ-api logs for details.",
    service: "calendar",
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register all calendar routes on the given router.
 *
 * @param router   - SimpleRouter to attach routes to
 * @param authMgr  - AuthManager for obtaining Bearer tokens
 */
export function registerCalendarRoutes(
  router: SimpleRouter,
  authMgr: AuthManager,
): void {
  // -------------------------------------------------------------------------
  // GET /calendar/today
  // Returns events for the current UTC day (00:00–23:59).
  //
  // Calendar Events list:
  // https://developers.google.com/calendar/api/v3/reference/events/list
  // -------------------------------------------------------------------------
  router.get("/calendar/today", async (_req: ParsedRequest, res: JsonResponse) => {
    try {
      const { token } = await authMgr.getAccessToken("calendar");
      const { timeMin, timeMax } = todayBoundaries();
      const events = await fetchEvents(token, timeMin, timeMax);
      res.json({ date: new Date().toISOString().slice(0, 10), events });
    } catch (err) {
      handleRouteError(err, res, "GET /calendar/today");
    }
  });

  // -------------------------------------------------------------------------
  // GET /calendar/week
  // Returns events from now through next 7 days.
  //
  // Calendar Events list:
  // https://developers.google.com/calendar/api/v3/reference/events/list
  // -------------------------------------------------------------------------
  router.get("/calendar/week", async (_req: ParsedRequest, res: JsonResponse) => {
    try {
      const { token } = await authMgr.getAccessToken("calendar");
      const { timeMin, timeMax } = weekBoundaries();
      const events = await fetchEvents(token, timeMin, timeMax, 100);
      res.json({ timeMin, timeMax, events });
    } catch (err) {
      handleRouteError(err, res, "GET /calendar/week");
    }
  });

  // -------------------------------------------------------------------------
  // GET /calendar/event/:id
  // Returns full event details for a single event by ID.
  //
  // Calendar Events get:
  // https://developers.google.com/calendar/api/v3/reference/events/get
  // GET /calendars/{calendarId}/events/{eventId}
  // -------------------------------------------------------------------------
  router.get("/calendar/event/:id", async (req: ParsedRequest, res: JsonResponse) => {
    const eventId = req.params.id;
    if (!eventId) {
      res.error({ error: "not_found", message: "Event ID is required.", service: "calendar" });
      return;
    }
    try {
      const { token } = await authMgr.getAccessToken("calendar");
      const url = `${CALENDAR_API_BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`;
      const raw = await calendarGet<GoogleEvent>(url, token);
      res.json(mapEvent(raw));
    } catch (err) {
      handleRouteError(err, res, "GET /calendar/event/:id");
    }
  });

  // -------------------------------------------------------------------------
  // GET /calendar/free-busy?timeMin=<RFC3339>&timeMax=<RFC3339>
  // Returns busy intervals for the primary calendar in the given range.
  //
  // Calendar FreeBusy query:
  // https://developers.google.com/calendar/api/v3/reference/freebusy/query
  // POST /freeBusy
  // Body: { timeMin, timeMax, items: [{ id: "primary" }] }
  // -------------------------------------------------------------------------
  router.get("/calendar/free-busy", async (req: ParsedRequest, res: JsonResponse) => {
    const timeMin = req.query.get("timeMin");
    const timeMax = req.query.get("timeMax");

    if (!timeMin || !timeMax) {
      res.error({
        error: "not_found",
        message: "Query parameters 'timeMin' and 'timeMax' are required (RFC 3339 format).",
        service: "calendar",
      });
      return;
    }

    try {
      const { token } = await authMgr.getAccessToken("calendar");
      const url = `${CALENDAR_API_BASE}/freeBusy`;
      const body = {
        timeMin,
        timeMax,
        items: [{ id: "primary" }],
      };
      const data = await calendarPost<GoogleFreeBusyResponse>(url, token, body);
      const busy: BusyInterval[] = data.calendars?.["primary"]?.busy ?? [];
      const result: FreeBusyResponse = { timeMin, timeMax, busy };
      res.json(result);
    } catch (err) {
      handleRouteError(err, res, "GET /calendar/free-busy");
    }
  });
}
