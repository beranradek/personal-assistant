/**
 * Integ-API MCP Server
 * ====================
 *
 * MCP server that exposes integration tools (Gmail, Calendar) to the agent.
 * Under the hood, each tool makes HTTP calls to the integ-api server running
 * on localhost. The agent never sees credentials — only filtered responses.
 *
 * Tools:
 *   integ_list        — Discover available integrations
 *   integ_gmail       — Query Gmail (list, read, labels, search)
 *   integ_calendar    — Query Google Calendar (today, week, event, free-busy)
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface IntegResult {
  data: unknown;
  ok: boolean;
}

async function integGet(port: number, path: string, bind = "127.0.0.1"): Promise<IntegResult> {
  const url = `http://${bind}:${port}${path}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  const data = await response.json();
  return { data, ok: response.ok };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface IntegServerDeps {
  /** integ-api HTTP port (default 19100). */
  port: number;
  /** integ-api bind address (default "127.0.0.1"). */
  bind?: string;
}

/**
 * Create an MCP server that proxies integration requests to the integ-api HTTP server.
 */
export function createIntegServer(deps: IntegServerDeps) {
  const { port, bind = "127.0.0.1" } = deps;

  return createSdkMcpServer({
    name: "integrations",
    version: "1.0.0",
    tools: [
      // -------------------------------------------------------------------
      // integ_list — Discover available integrations
      // -------------------------------------------------------------------
      tool(
        "integ_list",
        "List available integrations and their capabilities. Call this to discover what services are accessible (Gmail, Calendar, etc.).",
        {},
        async () => {
          const { data, ok } = await integGet(port, "/integ-api/integrations", bind);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
            isError: !ok,
          };
        },
      ),

      // -------------------------------------------------------------------
      // integ_gmail — Gmail operations
      // -------------------------------------------------------------------
      tool(
        "integ_gmail",
        `Query Gmail via the integ-api proxy. Actions:

list — list messages. Optional params: query (Gmail search syntax), max (number, default 10), labelIds (comma-separated)
read — get full message text. Required: messageId
labels — list all labels
search — search messages. Required: query. Optional: max`,
        {
          action: z.enum(["list", "read", "labels", "search"]).describe("Gmail action"),
          query: z.string().optional().describe("Search query (for list/search actions)"),
          messageId: z.string().optional().describe("Message ID (for read action)"),
          max: z.number().optional().describe("Max results (default 10, max 100)"),
          labelIds: z.string().optional().describe("Comma-separated label IDs (for list action)"),
        },
        async (args) => {
          let path: string;

          switch (args.action) {
            case "list": {
              const params = new URLSearchParams();
              if (args.query) params.set("query", args.query);
              if (args.max) params.set("max", String(args.max));
              if (args.labelIds) params.set("labelIds", args.labelIds);
              const qs = params.toString();
              path = `/gmail/messages${qs ? `?${qs}` : ""}`;
              break;
            }
            case "read": {
              if (!args.messageId) {
                return {
                  content: [{ type: "text" as const, text: JSON.stringify({ error: "messageId is required for read action" }) }],
                  isError: true,
                };
              }
              path = `/gmail/messages/${encodeURIComponent(args.messageId)}`;
              break;
            }
            case "labels":
              path = "/gmail/labels";
              break;
            case "search": {
              if (!args.query) {
                return {
                  content: [{ type: "text" as const, text: JSON.stringify({ error: "query is required for search action" }) }],
                  isError: true,
                };
              }
              const params = new URLSearchParams({ q: args.query });
              if (args.max) params.set("max", String(args.max));
              path = `/gmail/search?${params.toString()}`;
              break;
            }
          }

          const { data, ok } = await integGet(port, path, bind);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
            isError: !ok,
          };
        },
      ),

      // -------------------------------------------------------------------
      // integ_calendar — Google Calendar operations
      // -------------------------------------------------------------------
      tool(
        "integ_calendar",
        `Query Google Calendar via the integ-api proxy. Actions:

today — today's events
week — events for the next 7 days
event — get full details of a single event. Required: eventId
free_busy — check busy intervals. Required: timeMin, timeMax (RFC 3339 timestamps)`,
        {
          action: z.enum(["today", "week", "event", "free_busy"]).describe("Calendar action"),
          eventId: z.string().optional().describe("Event ID (for event action)"),
          timeMin: z.string().optional().describe("Start time RFC 3339 (for free_busy action)"),
          timeMax: z.string().optional().describe("End time RFC 3339 (for free_busy action)"),
        },
        async (args) => {
          let path: string;

          switch (args.action) {
            case "today":
              path = "/calendar/today";
              break;
            case "week":
              path = "/calendar/week";
              break;
            case "event": {
              if (!args.eventId) {
                return {
                  content: [{ type: "text" as const, text: JSON.stringify({ error: "eventId is required for event action" }) }],
                  isError: true,
                };
              }
              path = `/calendar/event/${encodeURIComponent(args.eventId)}`;
              break;
            }
            case "free_busy": {
              if (!args.timeMin || !args.timeMax) {
                return {
                  content: [{ type: "text" as const, text: JSON.stringify({ error: "timeMin and timeMax are required for free_busy action" }) }],
                  isError: true,
                };
              }
              const params = new URLSearchParams({ timeMin: args.timeMin, timeMax: args.timeMax });
              path = `/calendar/free-busy?${params.toString()}`;
              break;
            }
          }

          const { data, ok } = await integGet(port, path, bind);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
            isError: !ok,
          };
        },
      ),
    ],
  });
}
