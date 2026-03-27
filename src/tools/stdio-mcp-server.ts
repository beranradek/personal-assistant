/**
 * Standalone Stdio MCP Server
 * ===========================
 *
 * Exposes PA's built-in tools over the standard MCP protocol (JSON-RPC
 * over stdio). Designed to be spawned by Codex CLI as a child process.
 *
 * Registered tools:
 *   - memory_search — hybrid vector + keyword search
 *   - cron — manage scheduled jobs
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

export interface StdioMcpServerDeps {
  search: (query: string, maxResults?: number) => Promise<SearchResult[]>;
  handleCronAction: AssistantServerDeps["handleCronAction"];
  handleExec: AssistantServerDeps["handleExec"];
  getProcessSession: AssistantServerDeps["getProcessSession"];
  listProcessSessions: AssistantServerDeps["listProcessSessions"];
}

const TOOL_DEFINITIONS = [
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
    name: "cron",
    description: `Manage scheduled reminders and jobs. Actions:

ADD — create a new job. Required params:
  - label: string — human-readable name (e.g. "Daily standup reminder")
  - schedule: object — one of three types:
      { "type": "cron", "expression": "<cron expr>" } — standard 5-field cron (e.g. "30 9 * * 1-5" = weekdays 9:30 UTC)
      { "type": "oneshot", "iso": "<ISO 8601 datetime>" } — fires once (e.g. "2026-03-01T14:00:00Z")
      { "type": "interval", "everyMs": <milliseconds> } — repeating interval (e.g. 3600000 = every hour)
  - payload: { "text": "<message>" } — the text delivered when the job fires

LIST — returns all jobs. No params needed.

UPDATE — modify an existing job. Required params:
  - id: string — the job UUID (from add/list response)
  Optional: label, schedule, payload (same format as add), enabled (boolean)

REMOVE — delete a job. Required params:
  - id: string — the job UUID`,
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["add", "list", "update", "remove"],
          description: "Action to perform",
        },
        params: {
          type: "object",
          description: "Action parameters — see tool description for required fields per action",
        },
      },
      required: ["action"],
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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
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
      case "cron": {
        const action = args?.action as string;
        const params = (args?.params as Record<string, unknown>) ?? {};
        const result = await deps.handleCronAction(action, params);
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
