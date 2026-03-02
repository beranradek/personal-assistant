/**
 * Codex Agent Backend
 * ===================
 *
 * Wraps the OpenAI Codex SDK into the AgentBackend interface. Each turn
 * spawns a `codex exec` subprocess via the SDK, maps Codex ThreadEvents
 * to the normalized StreamEvent union, and handles session/audit persistence.
 *
 * PA's built-in MCP tools are injected programmatically via CodexOptions.config
 * so the Codex CLI spawns `pa mcp-server` as a child process.
 *
 * Memory content (MEMORY.md, USER.md) is injected via developer_instructions.
 */

import { Codex } from "@openai/codex-sdk";
import type {
  Thread,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
} from "@openai/codex-sdk";
import type { AgentBackend, StreamEvent, AgentTurnResult } from "./interface.js";
import type { Config, SessionMessage } from "../core/types.js";
import { saveInteraction } from "../session/manager.js";
import { appendAuditEntry } from "../memory/daily-log.js";
import { readMemoryFiles } from "../memory/files.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("codex-backend");

// ---------------------------------------------------------------------------
// Event mapping: Codex ThreadEvent → StreamEvent
// ---------------------------------------------------------------------------

function mapItemStarted(item: ThreadItem): StreamEvent | null {
  switch (item.type) {
    case "command_execution":
      return { type: "tool_start", toolName: "command_execution" };
    case "file_change":
      return { type: "tool_start", toolName: "file_change" };
    case "mcp_tool_call":
      return {
        type: "tool_start",
        toolName: `mcp:${(item as any).server_label ?? "mcp"}/${(item as any).tool_name ?? "unknown"}`,
      };
    case "web_search":
      return { type: "tool_start", toolName: "web_search" };
    default:
      return null;
  }
}

function mapItemCompleted(item: ThreadItem): StreamEvent | null {
  switch (item.type) {
    case "agent_message":
      return { type: "text_delta", text: (item as any).text ?? "" };
    case "command_execution":
      return {
        type: "tool_input",
        toolName: "command_execution",
        input: {
          command: (item as any).command ?? "",
          exit_code: (item as any).exit_code ?? null,
          aggregated_output: (item as any).aggregated_output ?? "",
        },
      };
    case "file_change":
      return {
        type: "tool_input",
        toolName: "file_change",
        input: { changes: (item as any).changes ?? (item as any).file_path ?? "" },
      };
    case "mcp_tool_call": {
      const toolName = `mcp:${(item as any).server_label ?? "mcp"}/${(item as any).tool_name ?? "unknown"}`;
      return {
        type: "tool_input",
        toolName,
        input: {
          arguments: (item as any).arguments ?? {},
          result: (item as any).result ?? (item as any).error ?? null,
        },
      };
    }
    case "web_search":
      return {
        type: "tool_input",
        toolName: "web_search",
        input: { query: (item as any).query ?? "" },
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Extract text from completed items for the final response
// ---------------------------------------------------------------------------

function extractResponseText(items: ThreadItem[]): string {
  return items
    .filter((item): item is ThreadItem & { type: "agent_message" } => item.type === "agent_message")
    .map((item) => (item as any).text ?? "")
    .join("");
}

// ---------------------------------------------------------------------------
// Build ThreadOptions from Config
// ---------------------------------------------------------------------------

function buildThreadOptions(config: Config): ThreadOptions {
  const opts: ThreadOptions = {
    model: config.agent.model ?? undefined,
    sandboxMode: config.codex.sandboxMode,
    workingDirectory: config.security.workspace,
    approvalPolicy: config.codex.approvalPolicy,
    networkAccessEnabled: config.codex.networkAccess,
    skipGitRepoCheck: config.codex.skipGitRepoCheck,
  };

  if (config.codex.reasoningEffort) {
    opts.modelReasoningEffort = config.codex.reasoningEffort;
  }

  // Merge additional directories (read + write → writable_roots in sandbox)
  const additionalDirs = [
    ...config.security.additionalReadDirs,
    ...config.security.additionalWriteDirs,
  ];
  const uniqueDirs = [...new Set(additionalDirs)].filter(Boolean);
  if (uniqueDirs.length > 0) {
    opts.additionalDirectories = uniqueDirs;
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Codex agent backend.
 *
 * Async because it reads memory files for developer_instructions injection.
 */
export async function createCodexBackend(config: Config): Promise<AgentBackend> {
  // Read memory content for developer_instructions injection
  const memoryContent = await readMemoryFiles(config.security.workspace);

  // Build Codex config with MCP server injection + developer_instructions
  const codexConfig: Record<string, unknown> = {
    ...(config.codex.configOverrides ?? {}),
  };

  if (memoryContent) {
    codexConfig.developer_instructions = memoryContent;
  }

  // Inject PA's stdio MCP server
  const userMcpServers = (config.codex.configOverrides?.mcp_servers ?? {}) as Record<string, unknown>;
  codexConfig.mcp_servers = {
    "personal-assistant": {
      command: "pa",
      args: ["mcp-server"],
      startup_timeout_sec: 30,
      tool_timeout_sec: 120,
    },
    ...userMcpServers,
  };

  const codex = new Codex({
    codexPathOverride: config.codex.codexPath ?? undefined,
    apiKey: config.codex.apiKey ?? undefined,
    baseUrl: config.codex.baseUrl ?? undefined,
    config: codexConfig as any,
  });

  const threadOptions = buildThreadOptions(config);
  const threadIds = new Map<string, string>();

  log.info(
    { sandbox: config.codex.sandboxMode, approval: config.codex.approvalPolicy },
    "Codex backend initialized",
  );

  return {
    name: "codex",

    async *runTurn(message: string, sessionKey: string): AsyncGenerator<StreamEvent> {
      const userMsg: SessionMessage = {
        role: "user",
        content: message,
        timestamp: new Date().toISOString(),
      };
      const turnMessages: SessionMessage[] = [userMsg];

      let responseText = "";

      try {
        // Get or create thread
        const existingThreadId = threadIds.get(sessionKey);
        let thread: Thread;

        if (existingThreadId) {
          try {
            thread = codex.resumeThread(existingThreadId, threadOptions);
          } catch (err) {
            log.warn({ err, threadId: existingThreadId }, "failed to resume thread, starting fresh");
            threadIds.delete(sessionKey);
            thread = codex.startThread(threadOptions);
          }
        } else {
          thread = codex.startThread(threadOptions);
        }

        // Stream the turn
        const streamed = await thread.runStreamed(message);

        for await (const event of streamed.events) {
          const te = event as ThreadEvent;

          switch (te.type) {
            case "thread.started":
              if (thread.id) {
                threadIds.set(sessionKey, thread.id);
              }
              break;

            case "item.started": {
              const startEvent = mapItemStarted((te as any).item);
              if (startEvent) yield startEvent;
              break;
            }

            case "item.completed": {
              const completeEvent = mapItemCompleted((te as any).item);
              if (completeEvent) {
                if (completeEvent.type === "text_delta") {
                  responseText += completeEvent.text;
                }
                yield completeEvent;
              }
              break;
            }

            case "turn.failed":
              yield { type: "error", error: (te as any).message ?? "Turn failed" };
              break;

            case "error":
              yield { type: "error", error: (te as any).message ?? "Codex error" };
              break;

            // item.updated, turn.started, turn.completed — no action needed during streaming
            default:
              break;
          }
        }

        // Capture thread ID after the turn
        if (thread.id && !threadIds.has(sessionKey)) {
          threadIds.set(sessionKey, thread.id);
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.error({ err, sessionKey }, "Codex turn failed");
        yield { type: "error", error: errorMessage };
        return;
      }

      // Save session + audit
      turnMessages.push({
        role: "assistant",
        content: responseText,
        timestamp: new Date().toISOString(),
      });

      await saveInteraction(sessionKey, turnMessages, config);
      await appendAuditEntry(config.security.workspace, {
        timestamp: new Date().toISOString(),
        source: sessionKey.split("--")[0],
        sessionKey,
        type: "interaction",
        userMessage: message,
        assistantResponse: responseText,
      });

      yield {
        type: "result",
        response: responseText,
        messages: turnMessages,
        partial: false,
      };
    },

    async runTurnSync(message: string, sessionKey: string): Promise<AgentTurnResult> {
      const userMsg: SessionMessage = {
        role: "user",
        content: message,
        timestamp: new Date().toISOString(),
      };
      const turnMessages: SessionMessage[] = [userMsg];

      try {
        const existingThreadId = threadIds.get(sessionKey);
        let thread: Thread;

        if (existingThreadId) {
          try {
            thread = codex.resumeThread(existingThreadId, threadOptions);
          } catch {
            threadIds.delete(sessionKey);
            thread = codex.startThread(threadOptions);
          }
        } else {
          thread = codex.startThread(threadOptions);
        }

        const result = await thread.run(message);

        if (thread.id) {
          threadIds.set(sessionKey, thread.id);
        }

        const responseText = result.finalResponse ?? extractResponseText(result.items);

        turnMessages.push({
          role: "assistant",
          content: responseText,
          timestamp: new Date().toISOString(),
        });

        await saveInteraction(sessionKey, turnMessages, config);
        await appendAuditEntry(config.security.workspace, {
          timestamp: new Date().toISOString(),
          source: sessionKey.split("--")[0],
          sessionKey,
          type: "interaction",
          userMessage: message,
          assistantResponse: responseText,
        });

        return { response: responseText, messages: turnMessages, partial: false };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.error({ err, sessionKey }, "Codex turn failed (sync)");
        throw new Error(`Codex agent turn failed: ${errorMessage}`);
      }
    },

    clearSession(sessionKey: string): void {
      threadIds.delete(sessionKey);
      log.debug({ sessionKey }, "cleared Codex thread mapping");
    },

    async close(): Promise<void> {
      threadIds.clear();
      log.info("Codex backend closed");
    },
  };
}
