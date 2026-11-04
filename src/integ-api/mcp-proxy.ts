export interface IntegMcpProxyConfig {
  bind?: string;
  port: number;
}

const LOOPBACK_BINDS = new Set(["127.0.0.1", "::1", "localhost"]);
const REQUEST_TIMEOUT_MS = 15_000;

export type GmailRequest = {
  action: "list" | "read" | "labels" | "search" | "unreads";
  query?: string;
  max?: number;
  labelIds?: string;
  messageId?: string;
};

export type CalendarRequest = {
  action: "today" | "week" | "event" | "free_busy" | "rsvp";
  eventId?: string;
  timeMin?: string;
  timeMax?: string;
  responseStatus?: "accepted" | "declined" | "tentative";
  sendUpdates?: "none" | "all" | "externalOnly";
};

export type SlackRequest = {
  action: "unreads" | "messages" | "channels";
  workspace?: string;
  channelId?: string;
  limit?: number;
};

function rootUrl(config: IntegMcpProxyConfig): string {
  const bind = (config.bind ?? "127.0.0.1").trim() || "127.0.0.1";
  if (!LOOPBACK_BINDS.has(bind)) throw new Error("integ MCP proxy requires a loopback bind address");
  return `http://${bind}:${config.port}`;
}

async function request(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, headers: { Accept: "application/json", ...init?.headers }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = body as { message?: unknown } | undefined;
    throw new Error(typeof error?.message === "string" ? error.message : `integ-api request failed (${response.status})`);
  }
  return body;
}

function positiveNumber(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) throw new Error(`${field} must be a positive integer`);
}

export function createIntegMcpProxy(config: IntegMcpProxyConfig) {
  const root = rootUrl(config);
  return {
    list: () => request(`${root}/integ-api/integrations`),
    async gmail(args: GmailRequest): Promise<unknown> {
      if (!["list", "read", "labels", "search", "unreads"].includes(args.action)) throw new Error("Unsupported Gmail action");
      positiveNumber(args.max, "max");
      if (args.action === "labels") return request(`${root}/gmail/labels`);
      if (args.action === "read") {
        if (!args.messageId) throw new Error("messageId is required for action=read");
        return request(`${root}/gmail/messages/${encodeURIComponent(args.messageId)}`);
      }
      const url = new URL(args.action === "search" ? `${root}/gmail/search` : args.action === "unreads" ? `${root}/gmail/unreads` : `${root}/gmail/messages`);
      if (args.action === "search") {
        if (!args.query) throw new Error("query is required for action=search");
        url.searchParams.set("q", args.query);
      } else if (args.action === "list" && args.query) url.searchParams.set("query", args.query);
      if (args.max !== undefined) url.searchParams.set("max", String(args.max));
      if (args.action === "list" && args.labelIds) url.searchParams.set("labelIds", args.labelIds);
      return request(url.toString());
    },
    async calendar(args: CalendarRequest): Promise<unknown> {
      if (!["today", "week", "event", "free_busy", "rsvp"].includes(args.action)) throw new Error("Unsupported calendar action");
      if (args.action === "today" || args.action === "week") return request(`${root}/calendar/${args.action}`);
      if (args.action === "event") {
        if (!args.eventId) throw new Error("eventId is required for action=event");
        return request(`${root}/calendar/event/${encodeURIComponent(args.eventId)}`);
      }
      if (args.action === "free_busy") {
        if (!args.timeMin || !args.timeMax) throw new Error("timeMin and timeMax are required for action=free_busy");
        const url = new URL(`${root}/calendar/free-busy`);
        url.searchParams.set("timeMin", args.timeMin);
        url.searchParams.set("timeMax", args.timeMax);
        return request(url.toString());
      }
      if (!args.eventId) throw new Error("eventId is required for action=rsvp");
      if (!args.responseStatus) throw new Error("responseStatus is required for action=rsvp");
      if (!["accepted", "declined", "tentative"].includes(args.responseStatus)) throw new Error("Unsupported RSVP responseStatus");
      if (args.sendUpdates !== undefined && !["none", "all", "externalOnly"].includes(args.sendUpdates)) throw new Error("Unsupported RSVP sendUpdates");
      return request(`${root}/calendar/event/${encodeURIComponent(args.eventId)}/rsvp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responseStatus: args.responseStatus, sendUpdates: args.sendUpdates ?? "none" }),
      });
    },
    async slack(args: SlackRequest): Promise<unknown> {
      if (!["unreads", "messages", "channels"].includes(args.action)) throw new Error("Unsupported Slack action");
      positiveNumber(args.limit, "limit");
      if (args.action === "messages" && !args.channelId) throw new Error("channelId is required for action=messages");
      const url = new URL(args.action === "messages" ? `${root}/slack/messages/${encodeURIComponent(args.channelId!)}` : `${root}/slack/${args.action}`);
      if (args.workspace) url.searchParams.set("workspace", args.workspace);
      if (args.action === "messages" && args.limit !== undefined) url.searchParams.set("limit", String(args.limit));
      return request(url.toString());
    },
  };
}
