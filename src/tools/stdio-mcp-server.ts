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
import { z } from "zod";
import type { SearchResult } from "../core/types.js";
import type { AssistantServerDeps } from "./assistant-server.js";
import {
  EPISODE_TOOL_DEFINITIONS,
  handleEpisodeRecent,
  handleEpisodeSearch,
  handleEpisodeStats,
  handleEpisodeWrite,
  type EpisodeMcpDeps,
} from "./episode-mcp-tools.js";

export interface StdioMcpServerDeps {
  search: (query: string, maxResults?: number) => Promise<SearchResult[]>;
  handleCronAction: AssistantServerDeps["handleCronAction"];
  handleExec: AssistantServerDeps["handleExec"];
  getProcessSession: AssistantServerDeps["getProcessSession"];
  listProcessSessions: AssistantServerDeps["listProcessSessions"];
  episodeDeps?: EpisodeMcpDeps;
}

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
      },
      required: ["query"],
    },
  },
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

  const toolDefinitions = deps.episodeDeps
    ? [...BASE_TOOL_DEFINITIONS, ...EPISODE_TOOL_DEFINITIONS]
    : BASE_TOOL_DEFINITIONS;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "memory_search": {
        const query = args?.query as string;
        const maxResults = args?.maxResults as number | undefined;
        const results = await deps.search(query, maxResults);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(results, null, 2) },
          ],
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

/**
 * Connect the server to stdio and start serving.
 * This is the main entry point for `pa mcp-server`.
 */
export async function runStdioServer(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
