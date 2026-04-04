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
 *   pa integapi calendar today        — today's events
 *   pa integapi calendar week         — week's events
 *   pa integapi calendar event <id>   — event details
 *   pa integapi auth google           — run OAuth2 setup flow
 */

import type { Config } from "../core/types.js";

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

  const server = createIntegApiServer(config.integApi);
  const credStore = createCredentialStore(config.security.dataDir);
  const authMgr = createAuthManager(credStore);
  const registry = createRegistry(server.router);

  if (config.integApi.services.gmail.enabled) {
    registry.register(createGmailModule(authMgr));
  }
  if (config.integApi.services.calendar.enabled) {
    registry.register(createCalendarModule(authMgr));
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

// ---------------------------------------------------------------------------
// Calendar commands
// ---------------------------------------------------------------------------

async function runCalendarToday(config: Config): Promise<void> {
  const data = await integGet(config.integApi.port, "/calendar/today", config.integApi.bind);
  console.log(JSON.stringify(data, null, 2));
}

async function runCalendarWeek(config: Config): Promise<void> {
  const data = await integGet(config.integApi.port, "/calendar/week", config.integApi.bind);
  console.log(JSON.stringify(data, null, 2));
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
      } else {
        console.error(`Unknown auth provider: ${provider}. Supported: google`);
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
      } else {
        console.error(`Unknown gmail command: ${gmailCmd}. Try: list, read <id>, labels`);
        process.exit(1);
      }
      break;
    }

    case "calendar": {
      const calCmd = args[1];
      if (calCmd === "today") {
        await runCalendarToday(config);
      } else if (calCmd === "week") {
        await runCalendarWeek(config);
      } else if (calCmd === "event" && args[2]) {
        await runCalendarEvent(config, args[2]);
      } else {
        console.error(`Unknown calendar command: ${calCmd}. Try: today, week, event <id>`);
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
  gmail list [--query Q] [--max N]  List Gmail messages
  gmail read <id>               Read a Gmail message
  gmail labels                  List Gmail labels
  calendar today                Today's calendar events
  calendar week                 This week's events
  calendar event <id>           Event details`);
}
