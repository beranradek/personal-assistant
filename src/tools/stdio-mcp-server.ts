/**
 * Standalone Stdio MCP Server
 * ===========================
 *
 * Exposes PA's built-in tools over the standard MCP protocol (JSON-RPC
 * over stdio). Designed to be spawned by Codex CLI as a child process.
 *
 * Registered tools:
 *   - memory_search — hybrid vector + keyword search
 *   - cron_list — read scheduled jobs
 *   - cron_create / cron_update / cron_remove — mutate scheduled jobs
 *   - exec — run background commands
 *   - process — check background process status
 *
 * Usage: pa mcp-server [--config <path>]
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { SearchResult } from "../core/types.js";
import { MemorySearchInputSchema, type MemorySearchFilters } from "../memory/metadata.js";
import type { MemoryLintResult } from "../memory/linter.js";
import type { AssistantServerDeps } from "./assistant-server.js";
import {
  EPISODE_TOOL_DEFINITIONS,
  handleEpisodeRecent,
  handleEpisodeSearch,
  handleEpisodeStats,
  handleEpisodeWrite,
  type EpisodeMcpDeps,
} from "./episode-mcp-tools.js";
import type { CalendarRequest, GmailRequest, SlackRequest } from "../integ-api/mcp-proxy.js";

export interface StdioMcpServerDeps {
  search: (query: string, maxResults?: number, filters?: MemorySearchFilters) => Promise<SearchResult[]>;
  lintMemory?: () => Promise<MemoryLintResult>;
  handleCronAction: AssistantServerDeps["handleCronAction"];
  handleExec: AssistantServerDeps["handleExec"];
  getProcessSession: AssistantServerDeps["getProcessSession"];
  listProcessSessions: AssistantServerDeps["listProcessSessions"];
  handleHabitCheck?: AssistantServerDeps["handleHabitCheck"];
  handleHabitStatus?: AssistantServerDeps["handleHabitStatus"];
  episodeDeps?: EpisodeMcpDeps;
  handleIntegList?: () => Promise<unknown>;
  handleIntegGmail?: (args: GmailRequest) => Promise<unknown>;
  handleIntegCalendar?: (args: CalendarRequest) => Promise<unknown>;
  handleIntegSlack?: (args: SlackRequest) => Promise<unknown>;
}

const MEMORY_LINT_TOOL_DEFINITION = {
  name: "memory_lint",
  description: "Check Markdown memory pages for invalid YAML frontmatter, broken relative links and anchors, and duplicate typed entities.",
  inputSchema: { type: "object" as const, properties: {} },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const BASE_TOOL_DEFINITIONS = [
  {
    name: "memory_search",
    description:
      "Search long-term memory for past decisions, preferences, and context. Tip: overly broad multi-word queries can yield no results; try shortening to 1–3 key terms.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        maxResults: {
          type: "number",
          description: "Max results (default 6)",
        },
        type: { type: "string", description: "Exact OKF page type filter, case-insensitive" },
        tags: { type: "array", items: { type: "string" }, description: "Require every listed OKF tag, case-insensitive" },
      },
      required: ["query"],
    },
  },
  MEMORY_LINT_TOOL_DEFINITION,
  {
    name: "cron_list",
    description: "List all scheduled reminders and jobs without changing them.",
    inputSchema: { type: "object" as const, properties: {} },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "cron_create",
    description: `Create a scheduled reminder or job. Required fields: label, schedule, and payload.
Schedule is one of:
  { "type": "cron", "expression": "<cron expr>", "timezone": "<IANA timezone, optional>" }
  { "type": "oneshot", "iso": "<ISO 8601 datetime>" }
  { "type": "interval", "everyMs": <milliseconds> }`,
    inputSchema: {
      type: "object" as const,
      properties: {
        label: { type: "string", description: "Human-readable job name" },
        schedule: { type: "object", description: "Cron, oneshot, or interval schedule" },
        payload: { type: "object", description: "Message delivered when the job fires" },
      },
      required: ["label", "schedule", "payload"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "cron_update",
    description: "Update an existing scheduled reminder or job by its id.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Job UUID" },
        label: { type: "string", description: "Updated human-readable job name" },
        schedule: { type: "object", description: "Replacement schedule" },
        payload: { type: "object", description: "Replacement delivery message" },
        enabled: { type: "boolean", description: "Whether the job is enabled" },
      },
      required: ["id"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "cron_remove",
    description: "Permanently remove a scheduled reminder or job by its id.",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string", description: "Job UUID" } },
      required: ["id"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "exec",
    description: "Run a command with optional background execution. Returns output, exit code, and session ID for background processes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        background: {
          type: "boolean",
          description: "Run in background (default: false). Returns a sessionId to check status later via the process tool.",
        },
        yieldMs: {
          type: "number",
          description: "Wait this many ms then return partial output (useful for long-running foreground commands)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "process",
    description: "Check status of background processes started via the exec tool.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["status", "list"],
          description: "Action: 'list' returns all sessions, 'status' returns details for a specific session (requires sessionId)",
        },
        sessionId: {
          type: "string",
          description: "Session ID (required for 'status' action, returned by exec when background=true)",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "habit_check",
    description: "Mark a named habit done or undone. This changes HABITS.md.",
    inputSchema: {
      type: "object" as const,
      properties: {
        label: { type: "string", description: "Habit label" },
        done: { type: "boolean", description: "Whether the habit is done" },
      },
      required: ["label", "done"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "habit_status",
    description: "Read the current habit checklist status.",
    inputSchema: { type: "object" as const, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

const INTEG_TOOL_DEFINITIONS = [
  {
    name: "integ_list",
    description: "List configured PA integrations and their status. Credentials remain inside PA.",
    inputSchema: { type: "object" as const, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "integ_gmail",
    description: "Read Gmail through PA's local credential proxy.",
    inputSchema: { type: "object" as const, properties: { action: { type: "string", enum: ["list", "read", "labels", "search", "unreads"] }, query: { type: "string" }, max: { type: "number" }, labelIds: { type: "string" }, messageId: { type: "string" } }, required: ["action"] },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "integ_calendar",
    description: "Read calendar data through PA's local credential proxy.",
    inputSchema: { type: "object" as const, properties: { action: { type: "string", enum: ["today", "week", "event", "free_busy"] }, eventId: { type: "string" }, timeMin: { type: "string" }, timeMax: { type: "string" } }, required: ["action"] },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "integ_calendar_rsvp",
    description: "Change a calendar RSVP through PA's local credential proxy. This notifies or changes an external service and requires explicit user confirmation.",
    inputSchema: { type: "object" as const, properties: { eventId: { type: "string" }, responseStatus: { type: "string", enum: ["accepted", "declined", "tentative"] }, sendUpdates: { type: "string", enum: ["none", "all", "externalOnly"] } }, required: ["eventId", "responseStatus"] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "integ_slack",
    description: "Read Slack messages through PA's local credential proxy.",
    inputSchema: { type: "object" as const, properties: { action: { type: "string", enum: ["unreads", "messages", "channels"] }, workspace: { type: "string" }, channelId: { type: "string" }, limit: { type: "number" } }, required: ["action"] },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

/**
 * Create a standalone MCP server exposing PA tools.
 * Connect to a StdioServerTransport to serve over stdio.
 */
export function createStdioMcpServer(deps: StdioMcpServerDeps): Server {
  const server = new Server(
    { name: "personal-assistant", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  const toolDefinitions = [
    ...BASE_TOOL_DEFINITIONS.filter((definition) => {
      if (definition.name === "memory_lint") return Boolean(deps.lintMemory);
      if (definition.name === "habit_check" || definition.name === "habit_status") {
        return Boolean(deps.handleHabitCheck && deps.handleHabitStatus);
      }
      return true;
    }),
    ...(deps.episodeDeps ? EPISODE_TOOL_DEFINITIONS : []),
    ...(deps.handleIntegList && deps.handleIntegGmail && deps.handleIntegCalendar && deps.handleIntegSlack ? INTEG_TOOL_DEFINITIONS : []),
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "memory_search": {
        const input = MemorySearchInputSchema.safeParse(args ?? {});
        if (!input.success) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "Invalid memory_search input" }) }],
            isError: true,
          };
        }
        const results = await deps.search(input.data.query, input.data.maxResults, {
          ...(input.data.type ? { type: input.data.type } : {}),
          ...(input.data.tags?.length ? { tags: input.data.tags } : {}),
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(results, null, 2) },
          ],
        };
      }
      case "memory_lint": {
        if (!deps.lintMemory) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "Memory linter is unavailable" }) }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(await deps.lintMemory(), null, 2) }],
        };
      }
      case "cron_list": {
        const result = await deps.handleCronAction("list", {});
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      }
      case "cron_create": {
        const result = await deps.handleCronAction("add", (args ?? {}) as Record<string, unknown>);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      }
      case "cron_update": {
        const result = await deps.handleCronAction("update", (args ?? {}) as Record<string, unknown>);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      }
      case "cron_remove": {
        const result = await deps.handleCronAction("remove", (args ?? {}) as Record<string, unknown>);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      }
      case "exec": {
        const result = await deps.handleExec({
          command: args?.command as string,
          background: args?.background as boolean | undefined,
          yieldMs: args?.yieldMs as number | undefined,
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      }
      case "process": {
        const action = args?.action as string;
        if (action === "list") {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(deps.listProcessSessions(), null, 2),
              },
            ],
          };
        }
        const sessionId = args?.sessionId as string | undefined;
        if (sessionId) {
          const session = deps.getProcessSession(sessionId);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  session ?? { error: "Not found" },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "Missing sessionId" }),
            },
          ],
        };
      }
      case "habit_check": {
        if (!deps.handleHabitCheck || typeof args?.label !== "string" || typeof args?.done !== "boolean") {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Invalid habit_check input" }) }], isError: true };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(await deps.handleHabitCheck(args.label, args.done), null, 2) }] };
      }
      case "habit_status": {
        if (!deps.handleHabitStatus) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Habit tracking is unavailable" }) }], isError: true };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(await deps.handleHabitStatus(), null, 2) }] };
      }
      case "integ_list": {
        if (!deps.handleIntegList) return unavailable("Integration proxy");
        return success(await deps.handleIntegList());
      }
      case "integ_gmail": {
        if (!deps.handleIntegGmail) return unavailable("Gmail integration");
        const handler = deps.handleIntegGmail;
        return proxyResult(() => handler((args ?? {}) as GmailRequest));
      }
      case "integ_calendar": {
        if (!deps.handleIntegCalendar) return unavailable("Calendar integration");
        const handler = deps.handleIntegCalendar;
        if ((args ?? {}).action === "rsvp") return unavailable("Calendar RSVP requires integ_calendar_rsvp");
        return proxyResult(() => handler((args ?? {}) as CalendarRequest));
      }
      case "integ_calendar_rsvp": {
        if (!deps.handleIntegCalendar) return unavailable("Calendar integration");
        const handler = deps.handleIntegCalendar;
        const responseStatus = args?.responseStatus;
        const eventId = args?.eventId;
        if (typeof eventId !== "string" || (responseStatus !== "accepted" && responseStatus !== "declined" && responseStatus !== "tentative")) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Invalid integ_calendar_rsvp input" }) }], isError: true };
        }
        return proxyResult(() => handler({ action: "rsvp", eventId, responseStatus, ...(typeof args?.sendUpdates === "string" ? { sendUpdates: args.sendUpdates as CalendarRequest["sendUpdates"] } : {}) }));
      }
      case "integ_slack": {
        if (!deps.handleIntegSlack) return unavailable("Slack integration");
        const handler = deps.handleIntegSlack;
        return proxyResult(() => handler((args ?? {}) as SlackRequest));
      }
      case "episode_recent":
        return handleEpisodeRecent(args as Record<string, unknown>, deps.episodeDeps!);
      case "episode_search":
        return handleEpisodeSearch(args as Record<string, unknown>, deps.episodeDeps!);
      case "episode_stats":
        return handleEpisodeStats(args as Record<string, unknown>, deps.episodeDeps!);
      case "episode_write":
        return handleEpisodeWrite(args as Record<string, unknown>, deps.episodeDeps!);
      default:
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Unknown tool: ${name}` }),
            },
          ],
          isError: true,
        };
    }
  });

  return server;
}

function success(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function unavailable(name: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: `${name} is unavailable` }) }], isError: true };
}

async function proxyResult(operation: () => Promise<unknown>) {
  try {
    return success(await operation());
  } catch (error) {
    return { content: [{ type: "text" as const, text: JSON.stringify({ error: error instanceof Error ? error.message : "Integration proxy failed" }) }], isError: true };
  }
}

/**
 * Connect the server to stdio and start serving.
 * This is the main entry point for `pa mcp-server`.
 */
export async function runStdioServer(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
