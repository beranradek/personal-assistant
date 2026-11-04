import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createIntegMcpProxy } from "../integ-api/mcp-proxy.js";

export interface IntegServerConfig {
  bind?: string;
  port: number;
}

function errorResult(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
  };
}

export function createIntegServer(cfg: IntegServerConfig) {
  const proxy = createIntegMcpProxy(cfg);

  return createSdkMcpServer({
    name: "integrations",
    version: "1.0.0",
    tools: [
      tool("integ_list", "List available integrations and their status.", {}, async () => {
        const data = await proxy.list();
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      }),

      tool(
        "integ_gmail",
        "Gmail integration helper (list, read, labels, search).",
        {
          action: z.enum(["list", "read", "labels", "search"]),
          query: z.string().optional(),
          max: z.number().int().positive().optional(),
          labelIds: z.string().optional(),
          messageId: z.string().optional(),
        },
        async (args) => {
          if (args.action === "labels") {
            const data = await proxy.gmail(args);
            return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
          }

          if (args.action === "read") {
            if (!args.messageId) return errorResult("messageId is required for action=read");
            const data = await proxy.gmail(args);
            return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
          }

          if (args.action === "search") {
            if (!args.query) return errorResult("query is required for action=search");
            const data = await proxy.gmail(args);
            return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
          }

          const data = await proxy.gmail(args);
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
        },
      ),

      tool(
        "integ_calendar",
        "Calendar integration helper (today, week, event, free_busy, rsvp). Obtain explicit user confirmation before rsvp because it changes an external calendar.",
        {
          action: z.enum(["today", "week", "event", "free_busy", "rsvp"]),
          eventId: z.string().optional(),
          timeMin: z.string().optional(),
          timeMax: z.string().optional(),
          responseStatus: z.enum(["accepted", "declined", "tentative"]).optional(),
          sendUpdates: z.enum(["none", "all", "externalOnly"]).optional(),
        },
        async (args) => {
          if (args.action === "today") {
            const data = await proxy.calendar(args);
            return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
          }

          if (args.action === "week") {
            const data = await proxy.calendar(args);
            return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
          }

          if (args.action === "event") {
            if (!args.eventId) return errorResult("eventId is required for action=event");
            const data = await proxy.calendar(args);
            return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
          }

          if (args.action === "rsvp") {
            if (!args.eventId) return errorResult("eventId is required for action=rsvp");
            if (!args.responseStatus) return errorResult("responseStatus is required for action=rsvp");
            const data = await proxy.calendar(args);
            return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
          }

          if (!args.timeMin || !args.timeMax) {
            return errorResult("timeMin and timeMax are required for action=free_busy");
          }
          const data = await proxy.calendar(args);
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
        },
      ),

      tool(
        "integ_slack",
        "Slack integration helper (unreads, messages, channels).",
        {
          action: z.enum(["unreads", "messages", "channels"]),
          workspace: z.string().optional(),
          channelId: z.string().optional(),
          limit: z.number().int().positive().optional(),
        },
        async (args) => {
          if (args.action === "messages" && !args.channelId) return errorResult("channelId is required for action=messages");
          const data = await proxy.slack(args);
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
        },
      ),
    ],
  });
}
