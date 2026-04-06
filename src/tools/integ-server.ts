import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export interface IntegServerConfig {
  bind?: string;
  port: number;
}

function baseUrl(cfg: IntegServerConfig): string {
  const bind = (cfg.bind ?? "127.0.0.1").trim() || "127.0.0.1";
  return `http://${bind}:${cfg.port}`;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`integ-api request failed (${res.status}): ${body}`);
  }
  return res.json();
}

function errorResult(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
  };
}

export function createIntegServer(cfg: IntegServerConfig) {
  const root = baseUrl(cfg);

  return createSdkMcpServer({
    name: "integrations",
    version: "1.0.0",
    tools: [
      tool("integ_list", "List available integrations and their status.", {}, async () => {
        const data = await fetchJson(`${root}/integ-api/integrations`);
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
          const u = new URL(`${root}/gmail/messages`);

          if (args.action === "labels") {
            const data = await fetchJson(`${root}/gmail/labels`);
            return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
          }

          if (args.action === "read") {
            if (!args.messageId) return errorResult("messageId is required for action=read");
            const data = await fetchJson(`${root}/gmail/messages/${encodeURIComponent(args.messageId)}`);
            return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
          }

          if (args.action === "search") {
            if (!args.query) return errorResult("query is required for action=search");
            const searchUrl = new URL(`${root}/gmail/search`);
            searchUrl.searchParams.set("q", args.query);
            if (args.max != null) searchUrl.searchParams.set("max", String(args.max));
            const data = await fetchJson(searchUrl.toString());
            return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
          }

          // list
          if (args.query) u.searchParams.set("query", args.query);
          if (args.max != null) u.searchParams.set("max", String(args.max));
          if (args.labelIds) u.searchParams.set("labelIds", args.labelIds);
          const data = await fetchJson(u.toString());
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
        },
      ),

      tool(
        "integ_calendar",
        "Calendar integration helper (today, week, event, free_busy).",
        {
          action: z.enum(["today", "week", "event", "free_busy"]),
          eventId: z.string().optional(),
          timeMin: z.string().optional(),
          timeMax: z.string().optional(),
        },
        async (args) => {
          if (args.action === "today") {
            const data = await fetchJson(`${root}/calendar/today`);
            return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
          }

          if (args.action === "week") {
            const data = await fetchJson(`${root}/calendar/week`);
            return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
          }

          if (args.action === "event") {
            if (!args.eventId) return errorResult("eventId is required for action=event");
            const data = await fetchJson(`${root}/calendar/event/${encodeURIComponent(args.eventId)}`);
            return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
          }

          // free_busy
          if (!args.timeMin || !args.timeMax) {
            return errorResult("timeMin and timeMax are required for action=free_busy");
          }
          const fb = new URL(`${root}/calendar/free-busy`);
          fb.searchParams.set("timeMin", args.timeMin);
          fb.searchParams.set("timeMax", args.timeMax);
          const data = await fetchJson(fb.toString());
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
        },
      ),
    ],
  });
}

