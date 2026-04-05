/**
 * Integ-API CLI Facade
 * ====================
 *
 * CLI wrapper around the integ-api HTTP server. Both the user and the
 * assistant invoke this CLI — it wraps HTTP calls so the agent never touches
 * credentials. The assistant discovers these commands via the integrations skill.
 *
 * Commands:
 *   pa integapi serve                 — start the HTTP server
 *   pa integapi list                  — discover available integrations
 *   pa integapi health                — check integration connectivity
 *   pa integapi gmail list [options]  — list Gmail messages
 *   pa integapi gmail read <id>       — read a Gmail message
 *   pa integapi gmail labels          — list Gmail labels
 *   pa integapi gmail unreads         — categorized unread email overview
 *   pa integapi calendar today        — today's events
 *   pa integapi calendar week         — week's events
 *   pa integapi calendar event <id>   — event details
 *   pa integapi slack unreads         — unread message summary across workspaces
 *   pa integapi slack messages <chId> — read unread messages in a channel
 *   pa integapi auth google           — run OAuth2 setup flow
 *   pa integapi auth slack            — add a Slack workspace token
 */

import type { Config } from "../core/types.js";

// Avoid crashing on broken pipes when users pipe output (e.g. into `head`).
// Node will raise EPIPE on writes after the reader closes; treat it as a clean exit.
process.stdout.on("error", (err) => {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EPIPE") process.exit(0);
});

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

/**
 * Make an HTTP GET request to the integ-api server and return parsed JSON.
 * Uses Node 22 built-in fetch.
 */
async function integGet(
  port: number,
  path: string,
  bind = "127.0.0.1",
): Promise<unknown> {
  const url = `http://${bind}:${port}${path}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  const body = await response.json();
  if (!response.ok) {
    const err = body as { error?: string; message?: string };
    throw new Error(err.message ?? `HTTP ${response.status}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Serve command
// ---------------------------------------------------------------------------

async function runServe(config: Config): Promise<void> {
  // Dynamic imports to avoid loading heavy deps at CLI parse time
  const { createIntegApiServer } = await import("./server.js");
  const { createAuthManager } = await import("./auth/manager.js");
  const { createCredentialStore } = await import("./auth/store.js");
  const { createRegistry } = await import("./integrations/registry.js");
  const { createGmailModule } = await import("./integrations/gmail/index.js");
  const { createCalendarModule } = await import("./integrations/calendar/index.js");
  const { createSlackModule } = await import("./integrations/slack/index.js");
  const { loadSlackWorkspaces } = await import("./integrations/slack/client.js");

  const { loadStoredProfiles } = await import("./auth/loader.js");

  const server = createIntegApiServer(config.integApi);
  const credStore = createCredentialStore(config.security.dataDir);
  const authMgr = createAuthManager(credStore);

  // Load persisted OAuth2 credentials into the auth manager
  const enabledServices: string[] = [];
  if (config.integApi.services.gmail.enabled) enabledServices.push("gmail");
  if (config.integApi.services.calendar.enabled) enabledServices.push("calendar");
  await loadStoredProfiles(credStore, authMgr, enabledServices);

  const registry = createRegistry(server.router);

  if (config.integApi.services.gmail.enabled) {
    const gmailUserEmails = config.integApi.services.gmail.userEmails;
    registry.register(createGmailModule(authMgr, gmailUserEmails));
  }
  if (config.integApi.services.calendar.enabled) {
    registry.register(createCalendarModule(authMgr));
  }
  if (config.integApi.services.slack.enabled) {
    const slackWorkspaces = await loadSlackWorkspaces(credStore);
    registry.register(createSlackModule(slackWorkspaces));
  }

  await server.start();
  console.log(`integ-api server listening on ${config.integApi.bind}:${config.integApi.port}`);

  // Graceful shutdown
  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

// ---------------------------------------------------------------------------
// List / health commands
// ---------------------------------------------------------------------------

async function runList(config: Config): Promise<void> {
  const data = (await integGet(config.integApi.port, "/integ-api/integrations", config.integApi.bind)) as {
    integrations: Array<{ id: string; name: string; status: string; capabilities: string[] }>;
  };

  if (data.integrations.length === 0) {
    console.log("No integrations registered.");
    return;
  }

  for (const integ of data.integrations) {
    console.log(`${integ.id} (${integ.name}) — ${integ.status}`);
    console.log(`  Capabilities: ${integ.capabilities.join(", ")}`);
  }
}

async function runHealth(config: Config): Promise<void> {
  const data = (await integGet(config.integApi.port, "/integ-api/health", config.integApi.bind)) as {
    status: string;
    uptime: number;
  };
  console.log(`Status: ${data.status}, uptime: ${data.uptime}s`);
}

// ---------------------------------------------------------------------------
// Gmail commands
// ---------------------------------------------------------------------------

async function runGmailList(config: Config, args: string[]): Promise<void> {
  const params = new URLSearchParams();
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--query" || args[i] === "-q") && args[i + 1]) {
      params.set("query", args[++i]!);
    } else if (args[i] === "--max" && args[i + 1]) {
      params.set("max", args[++i]!);
    } else if (args[i] === "--labels" && args[i + 1]) {
      params.set("labelIds", args[++i]!);
    }
  }

  const qs = params.toString();
  const path = `/gmail/messages${qs ? `?${qs}` : ""}`;
  const data = await integGet(config.integApi.port, path, config.integApi.bind);
  console.log(JSON.stringify(data, null, 2));
}

async function runGmailRead(config: Config, messageId: string): Promise<void> {
  const data = await integGet(
    config.integApi.port,
    `/gmail/messages/${encodeURIComponent(messageId)}`,
    config.integApi.bind,
  );
  console.log(JSON.stringify(data, null, 2));
}

async function runGmailLabels(config: Config): Promise<void> {
  const data = await integGet(config.integApi.port, "/gmail/labels", config.integApi.bind);
  console.log(JSON.stringify(data, null, 2));
}

async function runGmailUnreads(config: Config, args: string[]): Promise<void> {
  const params = new URLSearchParams();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--max" && args[i + 1]) {
      params.set("max", args[++i]!);
    }
  }

  const qs = params.toString();
  const path = `/gmail/unreads${qs ? `?${qs}` : ""}`;
  const data = await integGet(config.integApi.port, path, config.integApi.bind);
  console.log(JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Calendar commands
// ---------------------------------------------------------------------------

type CalendarCliFormat = "json" | "compact" | "compact-json";

type CalendarEventLite = {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  status?: string;
};

function parseCalendarFormat(args: string[]): CalendarCliFormat {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--format" || args[i] === "-f") && args[i + 1]) {
      const v = args[i + 1] as CalendarCliFormat;
      if (v === "json" || v === "compact" || v === "compact-json") return v;
    }
  }
  return "json";
}

function toCompactFields(e: CalendarEventLite): {
  id: string;
  summary: string;
  isAllDay: boolean;
  start: string;
  end: string;
  startLocalDate?: string;
  startLocalTime?: string;
  endLocalDate?: string;
  endLocalTime?: string;
} {
  const startRaw = e.start.dateTime ?? e.start.date ?? "";
  const endRaw = e.end.dateTime ?? e.end.date ?? "";
  const isAllDay = Boolean(e.start.date && !e.start.dateTime);

  const startLocalDate = e.start.dateTime ? e.start.dateTime.slice(0, 10) : e.start.date;
  const startLocalTime = e.start.dateTime ? e.start.dateTime.slice(11, 16) : undefined;
  const endLocalDate = e.end.dateTime ? e.end.dateTime.slice(0, 10) : e.end.date;
  const endLocalTime = e.end.dateTime ? e.end.dateTime.slice(11, 16) : undefined;

  return {
    id: e.id,
    summary: e.summary,
    isAllDay,
    start: startRaw,
    end: endRaw,
    startLocalDate,
    startLocalTime,
    endLocalDate,
    endLocalTime,
  };
}

function printCalendarCompactText(payload: { events: CalendarEventLite[] }): void {
  for (const e of payload.events ?? []) {
    const c = toCompactFields(e);
    if (c.isAllDay) {
      console.log(`${c.startLocalDate ?? ""} (all-day) ${c.summary}`);
      continue;
    }
    const date = c.startLocalDate ?? "";
    const start = c.startLocalTime ?? "";
    const end = c.endLocalTime ?? "";
    console.log(`${date} ${start}–${end} ${c.summary}`);
  }
}

function printCalendarOutput(
  data: unknown,
  format: CalendarCliFormat,
): void {
  if (format === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const payload = data as { timeMin?: string; timeMax?: string; events: CalendarEventLite[] };

  if (format === "compact") {
    printCalendarCompactText(payload);
    return;
  }

  // compact-json
  const compact = {
    timeMin: payload.timeMin,
    timeMax: payload.timeMax,
    events: (payload.events ?? []).map(toCompactFields),
  };
  console.log(JSON.stringify(compact, null, 2));
}

async function runCalendarToday(config: Config, args: string[]): Promise<void> {
  const format = parseCalendarFormat(args);
  const data = await integGet(config.integApi.port, "/calendar/today", config.integApi.bind);
  printCalendarOutput(data, format);
}

async function runCalendarWeek(config: Config, args: string[]): Promise<void> {
  const format = parseCalendarFormat(args);
  const data = await integGet(config.integApi.port, "/calendar/week", config.integApi.bind);
  printCalendarOutput(data, format);
}

async function runCalendarRange(config: Config, args: string[]): Promise<void> {
  const params = new URLSearchParams();
  const format = parseCalendarFormat(args);

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--timeMin" && args[i + 1]) {
      params.set("timeMin", args[++i]!);
    } else if (args[i] === "--timeMax" && args[i + 1]) {
      params.set("timeMax", args[++i]!);
    } else if ((args[i] === "--max" || args[i] === "--maxResults") && args[i + 1]) {
      params.set("maxResults", args[++i]!);
    }
  }

  if (!params.get("timeMin") || !params.get("timeMax")) {
    console.error("calendar range requires --timeMin and --timeMax (RFC 3339).");
    process.exit(1);
  }

  const path = `/calendar/range?${params.toString()}`;
  const data = await integGet(config.integApi.port, path, config.integApi.bind);
  printCalendarOutput(data, format);
}

async function runCalendarEvent(config: Config, eventId: string): Promise<void> {
  const data = await integGet(
    config.integApi.port,
    `/calendar/event/${encodeURIComponent(eventId)}`,
    config.integApi.bind,
  );
  console.log(JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Slack commands
// ---------------------------------------------------------------------------

async function runSlackUnreads(config: Config, args: string[]): Promise<void> {
  const params = new URLSearchParams();
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--workspace" || args[i] === "-w") && args[i + 1]) {
      params.set("workspace", args[++i]!);
    }
  }

  const qs = params.toString();
  const path = `/slack/unreads${qs ? `?${qs}` : ""}`;
  const data = await integGet(config.integApi.port, path, config.integApi.bind);
  console.log(JSON.stringify(data, null, 2));
}

async function runSlackMessages(config: Config, channelId: string, args: string[]): Promise<void> {
  const params = new URLSearchParams();
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--workspace" || args[i] === "-w") && args[i + 1]) {
      params.set("workspace", args[++i]!);
    } else if (args[i] === "--limit" && args[i + 1]) {
      params.set("limit", args[++i]!);
    }
  }

  const qs = params.toString();
  const path = `/slack/messages/${encodeURIComponent(channelId)}${qs ? `?${qs}` : ""}`;
  const data = await integGet(config.integApi.port, path, config.integApi.bind);
  console.log(JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Auth command
// ---------------------------------------------------------------------------

async function runAuthGoogle(config: Config): Promise<void> {
  const { createCredentialStore } = await import("./auth/store.js");
  const { runGoogleOAuthSetup } = await import("./auth/oauth-setup.js");

  const credStore = createCredentialStore(config.security.dataDir);

  // Collect scopes from enabled services
  const scopes: string[] = [];
  if (config.integApi.services.gmail.enabled) {
    const svc = config.integApi.services.gmail;
    scopes.push(...(svc.scopes.length > 0 ? svc.scopes : ["https://www.googleapis.com/auth/gmail.readonly"]));
  }
  if (config.integApi.services.calendar.enabled) {
    const svc = config.integApi.services.calendar;
    scopes.push(...(svc.scopes.length > 0 ? svc.scopes : ["https://www.googleapis.com/auth/calendar.readonly"]));
  }

  if (scopes.length === 0) {
    console.error("No integration services enabled in config. Enable gmail or calendar first.");
    process.exit(1);
  }

  const clientId = process.env["GOOGLE_CLIENT_ID"];
  const clientSecret = process.env["GOOGLE_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.");
    process.exit(1);
  }

  await runGoogleOAuthSetup(
    {
      clientId,
      clientSecret,
      scopes,
      profileId: "google-personal",
    },
    credStore,
  );
}

async function runAuthSlack(config: Config): Promise<void> {
  const { createCredentialStore } = await import("./auth/store.js");
  const { validateSlackToken, saveSlackWorkspace } = await import(
    "./integrations/slack/client.js"
  );
  const readline = await import("node:readline");

  const credStore = createCredentialStore(config.security.dataDir);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  try {
    console.log("Slack workspace setup");
    console.log("=====================");
    console.log("");
    console.log("You need a Slack user token (xoxp-...) with these scopes:");
    console.log("  channels:read, channels:history, groups:read, groups:history,");
    console.log("  im:read, im:history, mpim:read, mpim:history, users:read");
    console.log("");
    console.log("Get one from: https://api.slack.com/apps → your app → OAuth & Permissions");
    console.log("");

    const workspaceId = await ask("Workspace ID (short name, e.g. 'mycompany'): ");
    if (!workspaceId.trim()) {
      console.error("Workspace ID is required.");
      process.exit(1);
    }

    const token = await ask("User token (xoxp-...): ");
    if (!token.trim().startsWith("xoxp-") && !token.trim().startsWith("xoxb-")) {
      console.error("Token must start with xoxp- (user token) or xoxb- (bot token).");
      process.exit(1);
    }

    console.log("\nValidating token...");
    const authInfo = await validateSlackToken(token.trim());
    console.log(`  Team: ${authInfo.teamName} (${authInfo.teamId})`);
    console.log(`  User: ${authInfo.userName} (${authInfo.userId})`);

    const workspaceName = await ask(
      `Workspace display name [${authInfo.teamName}]: `,
    );

    await saveSlackWorkspace(credStore, {
      type: "slack",
      workspaceId: workspaceId.trim(),
      workspaceName: (workspaceName.trim() || authInfo.teamName),
      token: token.trim(),
      userId: authInfo.userId,
      teamId: authInfo.teamId,
    });

    console.log(`\nSlack workspace "${workspaceId.trim()}" saved successfully.`);
    console.log("Restart the integ-api server to pick up the new workspace.");
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

/**
 * Run the integ-api CLI with the given subcommand arguments.
 *
 * @param config - Loaded application config
 * @param args   - Arguments after "pa integapi" (e.g. ["gmail", "list", "--query", "is:unread"])
 */
export async function runIntegApiCli(config: Config, args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printUsage();
    return;
  }

  switch (sub) {
    case "serve":
      await runServe(config);
      break;

    case "list":
      await runList(config);
      break;

    case "health":
      await runHealth(config);
      break;

    case "auth": {
      const provider = args[1];
      if (provider === "google") {
        await runAuthGoogle(config);
      } else if (provider === "slack") {
        await runAuthSlack(config);
      } else {
        console.error(`Unknown auth provider: ${provider}. Supported: google, slack`);
        process.exit(1);
      }
      break;
    }

    case "gmail": {
      const gmailCmd = args[1];
      if (gmailCmd === "list") {
        await runGmailList(config, args.slice(2));
      } else if (gmailCmd === "read" && args[2]) {
        await runGmailRead(config, args[2]);
      } else if (gmailCmd === "labels") {
        await runGmailLabels(config);
      } else if (gmailCmd === "unreads") {
        await runGmailUnreads(config, args.slice(2));
      } else {
        console.error(`Unknown gmail command: ${gmailCmd}. Try: list, read <id>, labels, unreads`);
        process.exit(1);
      }
      break;
    }

    case "calendar": {
      const calCmd = args[1];
      if (calCmd === "today") {
        await runCalendarToday(config, args.slice(2));
      } else if (calCmd === "week") {
        await runCalendarWeek(config, args.slice(2));
      } else if (calCmd === "range") {
        await runCalendarRange(config, args.slice(2));
      } else if (calCmd === "event" && args[2]) {
        await runCalendarEvent(config, args[2]);
      } else {
        console.error(`Unknown calendar command: ${calCmd}. Try: today, week, range, event <id>`);
        process.exit(1);
      }
      break;
    }

    case "slack": {
      const slackCmd = args[1];
      if (slackCmd === "unreads") {
        await runSlackUnreads(config, args.slice(2));
      } else if (slackCmd === "messages" && args[2]) {
        await runSlackMessages(config, args[2], args.slice(3));
      } else {
        console.error(`Unknown slack command: ${slackCmd}. Try: unreads, messages <channelId>`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown integ-api command: ${sub}`);
      printUsage();
      process.exit(1);
  }
}

function printUsage(): void {
  console.log(`Usage: pa integapi <command>

Commands:
  serve                         Start the integ-api HTTP server
  list                          List available integrations
  health                        Check server health
  auth google                   Run Google OAuth2 setup
  auth slack                    Add a Slack workspace token
  gmail list [--query Q] [--max N]  List Gmail messages
  gmail read <id>               Read a Gmail message
  gmail labels                  List Gmail labels
  gmail unreads [--max N]       Categorized unread email overview (aggregated across accounts)
  calendar today [--format F]   Today's calendar events (F: json|compact|compact-json)
  calendar week [--format F]    Events from now through next 7 days (F: json|compact|compact-json)
  calendar range --timeMin A --timeMax B [--max N] [--format F]
                               Events in explicit RFC3339 time range (F: json|compact|compact-json)
  calendar event <id>           Event details
  slack unreads [--workspace W] Unread messages summary across Slack workspaces
  slack messages <channelId> [--workspace W] [--limit N]
                               Read unread messages in a channel (text only)`);
}
