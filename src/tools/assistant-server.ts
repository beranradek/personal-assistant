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

  /** Habits: mark a self-reported pillar as done/undone */
  handleHabitCheck: (pillarLabel: string, done: boolean) => Promise<{ success: boolean; message: string }>;

  /** Habits: return current checklist + pillar list */
  handleHabitStatus: () => Promise<{ pillars: Array<{ label: string; type: string; done: boolean }> } | { error: string }>;
}

/**
 * Create an MCP server that exposes cron read/write, exec, and process tools.
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
        "cron_list",
        "List all scheduled reminders and jobs without changing them.",
        {},
        async () => ({
          content: [
            { type: "text" as const, text: JSON.stringify(await deps.handleCronAction("list", {}), null, 2) },
          ],
        }),
        { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      ),

      tool(
        "cron_create",
        "Create a scheduled reminder or job with a label, schedule, and delivery payload.",
        {
          label: z.string().min(1).describe("Human-readable job name"),
          schedule: z.record(z.string(), z.unknown()).describe("Cron, oneshot, or interval schedule"),
          payload: z.record(z.string(), z.unknown()).describe("Message delivered when the job fires"),
        },
        async (args) => ({
          content: [
            { type: "text" as const, text: JSON.stringify(await deps.handleCronAction("add", args), null, 2) },
          ],
        }),
        { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
      ),

      tool(
        "cron_update",
        "Update an existing scheduled reminder or job by its id.",
        {
          id: z.string().min(1).describe("Job UUID"),
          label: z.string().min(1).optional().describe("Updated job name"),
          schedule: z.record(z.string(), z.unknown()).optional().describe("Replacement schedule"),
          payload: z.record(z.string(), z.unknown()).optional().describe("Replacement delivery message"),
          enabled: z.boolean().optional().describe("Whether the job is enabled"),
        },
        async (args) => ({
          content: [
            { type: "text" as const, text: JSON.stringify(await deps.handleCronAction("update", args), null, 2) },
          ],
        }),
        { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
      ),

      tool(
        "cron_remove",
        "Permanently remove a scheduled reminder or job by its id.",
        { id: z.string().min(1).describe("Job UUID") },
        async (args) => ({
          content: [
            { type: "text" as const, text: JSON.stringify(await deps.handleCronAction("remove", args), null, 2) },
          ],
        }),
        { annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
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

      tool(
        "habit_check",
        `Mark a self-reported habit pillar as done or undone for today.

Use this when the user tells you they completed a habit (e.g. "I went for a run today").
The pillar parameter should match the habit label in HABITS.md (e.g. "Exercise").`,
        {
          pillar: z.string().describe("Habit pillar label (e.g. 'Exercise', 'Reading')"),
          done: z.boolean().describe("true to mark as done, false to unmark"),
        },
        async (args) => {
          const result = await deps.handleHabitCheck(args.pillar, args.done);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        },
      ),

      tool(
        "habit_status",
        "Return the current daily habit checklist with completion status for each pillar.",
        {},
        async () => {
          const result = await deps.handleHabitStatus();
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        },
      ),
    ],
  });
}
