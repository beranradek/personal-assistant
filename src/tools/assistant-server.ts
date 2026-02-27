import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/**
 * Dependencies injected into the assistant MCP server.
 */
export interface AssistantServerDeps {
  handleCronAction: (
    action: string,
    params: Record<string, unknown>,
  ) => Promise<{ success: boolean; message: string; data?: unknown }>;

  handleExec: (options: {
    command: string;
    background?: boolean;
    yieldMs?: number;
  }) => Promise<{
    success: boolean;
    sessionId?: string;
    output?: string;
    exitCode?: number | null;
    message?: string;
  }>;

  getProcessSession: (id: string) =>
    | {
        pid: number;
        command: string;
        output: string;
        exitCode: number | null;
        startedAt: string;
        exitedAt: string | null;
      }
    | undefined;

  listProcessSessions: () => Array<{
    id: string;
    session: {
      pid: number;
      command: string;
      exitCode: number | null;
      startedAt: string;
      exitedAt: string | null;
    };
  }>;
}

/**
 * Create an MCP server that exposes `cron`, `exec`, and `process` tools.
 *
 * This is the main assistant server that combines scheduling, command execution,
 * and background process management into a single MCP endpoint.
 */
export function createAssistantServer(deps: AssistantServerDeps) {
  return createSdkMcpServer({
    name: "assistant",
    version: "1.0.0",
    tools: [
      tool(
        "cron",
        `Manage scheduled reminders and jobs. Actions:

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
        {
          action: z
            .enum(["add", "list", "update", "remove"])
            .describe("Action to perform"),
          params: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "Action parameters — see tool description for required fields per action",
            ),
        },
        async (args) => {
          const result = await deps.handleCronAction(
            args.action,
            args.params ?? {},
          );
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(result, null, 2) },
            ],
          };
        },
      ),

      tool(
        "exec",
        "Run a command in the background with completion notification",
        {
          command: z.string().describe("Shell command to execute"),
          background: z
            .boolean()
            .optional()
            .describe("Run in background (default: false)"),
          yieldMs: z
            .number()
            .optional()
            .describe("Wait this many ms then return partial output"),
        },
        async (args) => {
          const result = await deps.handleExec(args);
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(result, null, 2) },
            ],
          };
        },
      ),

      tool(
        "process",
        "Check status of background processes",
        {
          action: z
            .enum(["status", "list"])
            .describe("Action to perform"),
          sessionId: z
            .string()
            .optional()
            .describe("Session ID (required for status)"),
        },
        async (args) => {
          if (args.action === "list") {
            const sessions = deps.listProcessSessions();
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(sessions, null, 2),
                },
              ],
            };
          }
          if (args.action === "status" && args.sessionId) {
            const session = deps.getProcessSession(args.sessionId);
            if (!session) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({ error: "Session not found" }),
                  },
                ],
              };
            }
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(session, null, 2),
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "Invalid action or missing sessionId",
                }),
              },
            ],
          };
        },
      ),
    ],
  });
}
