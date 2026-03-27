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
 * Memory content (MEMORY.md, USER.md) is injected via developer_instructions
 * and refreshed at the start of each turn.
 */

import { Codex } from "@openai/codex-sdk";
import type {
  Thread,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  AgentMessageItem,
  ReasoningItem,
  WebSearchItem,
  TodoListItem,
  TurnFailedEvent,
  ThreadErrorEvent,
  ItemStartedEvent,
  ItemCompletedEvent,
} from "@openai/codex-sdk";
import type { AgentBackend, StreamEvent, AgentTurnResult } from "./interface.js";
import type { Config, SessionMessage } from "../core/types.js";
import { saveInteraction } from "../session/manager.js";
import { appendAuditEntry } from "../memory/daily-log.js";
import { readMemoryFiles } from "../memory/files.js";
import { createLogger } from "../core/logger.js";
import { sessionKeyToPath } from "../session/types.js";
import {
  loadConversationHistory,
  summarizeConversation,
  appendCompactionEntry,
  loadLatestSummary,
} from "../session/compactor.js";

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
    case "mcp_tool_call": {
      // C1 fix: use correct SDK field names (server, tool)
      const mcp = item as McpToolCallItem;
      return {
        type: "tool_start",
        toolName: `mcp:${mcp.server}/${mcp.tool}`,
      };
    }
    case "web_search":
      return { type: "tool_start", toolName: "web_search" };
    // S4: Surface reasoning and todo_list as tool starts
    case "reasoning":
      return { type: "tool_start", toolName: "reasoning" };
    case "todo_list":
      return { type: "tool_start", toolName: "todo_list" };
    default:
      return null;
  }
}

function mapItemCompleted(item: ThreadItem): StreamEvent | null {
  switch (item.type) {
    case "agent_message": {
      const msg = item as AgentMessageItem;
      return { type: "text_delta", text: msg.text };
    }
    case "command_execution": {
      const cmd = item as CommandExecutionItem;
      return {
        type: "tool_input",
        toolName: "command_execution",
        input: {
          command: cmd.command,
          exit_code: cmd.exit_code ?? null,
          aggregated_output: cmd.aggregated_output,
        },
      };
    }
    case "file_change": {
      const fc = item as FileChangeItem;
      const summary = fc.changes
        .map((c) => `${c.kind} ${c.path}`)
        .join(", ");
      return {
        type: "tool_input",
        toolName: "file_change",
        input: { changes: summary },
      };
    }
    case "mcp_tool_call": {
      // C1 fix: use correct SDK field names (server, tool)
      const mcp = item as McpToolCallItem;
      const toolName = `mcp:${mcp.server}/${mcp.tool}`;
      return {
        type: "tool_input",
        toolName,
        input: {
          arguments: mcp.arguments ?? {},
          result: mcp.result?.structured_content ?? mcp.error?.message ?? null,
        },
      };
    }
    case "web_search": {
      const ws = item as WebSearchItem;
      return {
        type: "tool_input",
        toolName: "web_search",
        input: { query: ws.query },
      };
    }
    // S4: Surface reasoning text as text_delta
    case "reasoning": {
      const r = item as ReasoningItem;
      return { type: "text_delta", text: r.text };
    }
    // S4: Surface todo list as tool_input
    case "todo_list": {
      const tl = item as TodoListItem;
      return {
        type: "tool_input",
        toolName: "todo_list",
        input: {
          items: tl.items.map((i) => `${i.completed ? "[x]" : "[ ]"} ${i.text}`).join("\n"),
        },
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Extract text from completed items for the final response
// ---------------------------------------------------------------------------

// I6 fix: join with double newline separator
function extractResponseText(items: ThreadItem[]): string {
  return items
    .filter((item): item is AgentMessageItem => item.type === "agent_message")
    .map((item) => item.text)
    .join("\n\n");
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
// C2: Synthetic tool_progress timer
// ---------------------------------------------------------------------------

/** Start a timer that emits tool_progress events periodically. Returns a stop function. */
function startProgressTimer(
  toolName: string,
  emit: (event: StreamEvent) => void,
  intervalMs = 1000,
): () => void {
  const start = Date.now();
  const timer = setInterval(() => {
    emit({
      type: "tool_progress",
      toolName,
      elapsedSeconds: Math.round((Date.now() - start) / 1000),
    });
  }, intervalMs);
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CodexBackendOptions {
  /** Config directory path for passing --config to the MCP server subprocess. */
  configDir?: string;
}

/**
 * Create a Codex agent backend.
 *
 * Async because it initializes the Codex SDK and reads initial memory files.
 */
export async function createCodexBackend(
  config: Config,
  options?: CodexBackendOptions,
): Promise<AgentBackend> {
  // Build Codex config with MCP server injection
  const codexConfig: Record<string, unknown> = {
    ...(config.codex.configOverrides ?? {}),
  };

  // I5: Read memory initially for startup; will refresh per-turn below
  const initialMemory = await readMemoryFiles(config.security.workspace);
  if (initialMemory) {
    codexConfig.developer_instructions = initialMemory;
  }

  // I3 fix: Pass --config to the MCP server subprocess if a config dir is known
  const mcpArgs = ["mcp-server"];
  if (options?.configDir) {
    mcpArgs.push("--config", options.configDir);
  }

  // Enable multi_agent feature flag (allows spawn_agent with default/explorer/worker roles,
  // plus custom roles defined in ~/.codex/config.toml [agents.*] sections)
  const userFeatures = (config.codex.configOverrides?.features ?? {}) as Record<string, unknown>;
  codexConfig.features = { multi_agent: true, ...userFeatures };

  // Inject PA's stdio MCP server
  const userMcpServers = (config.codex.configOverrides?.mcp_servers ?? {}) as Record<string, unknown>;
  codexConfig.mcp_servers = {
    "personal-assistant": {
      command: "pa",
      args: mcpArgs,
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
  const turnCounts = new Map<string, number>();
  const summaries = new Map<string, string>();

  log.info(
    { sandbox: config.codex.sandboxMode, approval: config.codex.approvalPolicy },
    "Codex backend initialized",
  );

  /**
   * Trigger context pruning for a Codex session.
   * On first turn: load any persisted summary from the JSONL.
   * After every `maxHistoryMessages / 2` turns: summarise via OpenAI API,
   * persist the summary, reset the thread ID so the next turn is fresh.
   */
  async function compactIfNeeded(sessionKey: string): Promise<void> {
    if (!config.session.compactionEnabled) return;

    const turnCount = turnCounts.get(sessionKey) ?? 0;
    const threshold = Math.floor(config.session.maxHistoryMessages / 2);

    if (turnCount === 0) {
      const sessionPath = sessionKeyToPath(config.security.dataDir, sessionKey);
      const existing = await loadLatestSummary(sessionPath);
      if (existing) summaries.set(sessionKey, existing);
      return;
    }

    if (turnCount % threshold !== 0) return;

    const sessionPath = sessionKeyToPath(config.security.dataDir, sessionKey);
    try {
      const messages = await loadConversationHistory(sessionPath);
      if (messages.length < 4) return;

      let summary: string;
      if (config.session.summarizationEnabled) {
        // Use OpenAI API — Codex backend has an OpenAI-compatible key
        const openaiApiKey =
          config.codex.apiKey ?? process.env["OPENAI_API_KEY"] ?? "";
        summary = await summarizeConversation(
          messages,
          "gpt-4o-mini",
          "openai",
          openaiApiKey,
          config.codex.baseUrl ?? undefined,
        );
      } else {
        const last = messages.slice(-2);
        summary = last
          .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
          .join("\n\n");
      }

      await appendCompactionEntry(sessionPath, summary);
      summaries.set(sessionKey, summary);
      threadIds.delete(sessionKey);
    } catch (err) {
      log.warn(
        { err, sessionKey },
        "Codex session compaction failed — continuing without summary",
      );
    }
  }

  /** I5: Refresh developer_instructions with latest memory content. */
  async function refreshMemory(): Promise<void> {
    try {
      const content = await readMemoryFiles(config.security.workspace);
      if (content) {
        codexConfig.developer_instructions = content;
      }
    } catch (err) {
      log.warn({ err }, "Failed to refresh memory files for Codex turn");
    }
  }

  return {
    name: "codex",

    async *runTurn(message: string, sessionKey: string): AsyncGenerator<StreamEvent> {
      // I5: Refresh memory at the start of each turn
      await refreshMemory();
      // Context pruning: compact if threshold reached, load existing summary
      await compactIfNeeded(sessionKey);

      const userMsg: SessionMessage = {
        role: "user",
        content: message,
        timestamp: new Date().toISOString(),
      };
      const turnMessages: SessionMessage[] = [userMsg];

      // Inject compaction summary into developer_instructions (if any)
      const summary = summaries.get(sessionKey);
      if (summary) {
        codexConfig.developer_instructions =
          `## Previous Conversation Summary\n\n${summary}\n\n` +
          (codexConfig.developer_instructions ?? "");
      }

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

        // C2: Track active tool for synthetic tool_progress events
        let stopProgress: (() => void) | null = null;
        const pendingProgressEvents: StreamEvent[] = [];

        for await (const event of streamed.events) {
          const te = event as ThreadEvent;

          switch (te.type) {
            case "thread.started":
              if (thread.id) {
                threadIds.set(sessionKey, thread.id);
              }
              break;

            case "item.started": {
              const startEvent = mapItemStarted((te as ItemStartedEvent).item);
              if (startEvent) {
                // Stop any existing progress timer
                if (stopProgress) stopProgress();
                // Start synthetic tool_progress for this tool
                stopProgress = startProgressTimer(
                  startEvent.type === "tool_start" ? startEvent.toolName : "",
                  (evt) => pendingProgressEvents.push(evt),
                );
                yield startEvent;
              }
              break;
            }

            case "item.completed": {
              // Stop progress timer when item completes
              if (stopProgress) {
                stopProgress();
                stopProgress = null;
              }
              // Yield any pending progress events
              for (const pe of pendingProgressEvents) {
                yield pe;
              }
              pendingProgressEvents.length = 0;

              const completeEvent = mapItemCompleted((te as ItemCompletedEvent).item);
              if (completeEvent) {
                if (completeEvent.type === "text_delta") {
                  responseText += completeEvent.text;
                }
                yield completeEvent;
              }
              break;
            }

            // I1 fix: extract error from te.error.message, not te.message
            case "turn.failed": {
              if (stopProgress) { stopProgress(); stopProgress = null; }
              const tf = te as TurnFailedEvent;
              yield { type: "error", error: tf.error?.message ?? "Turn failed" };
              break;
            }

            case "error": {
              if (stopProgress) { stopProgress(); stopProgress = null; }
              const err = te as ThreadErrorEvent;
              yield { type: "error", error: err.message ?? "Codex error" };
              break;
            }

            // item.updated, turn.started, turn.completed — no action needed during streaming
            default:
              break;
          }
        }

        // Clean up any lingering progress timer
        if (stopProgress) stopProgress();

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
      turnCounts.set(sessionKey, (turnCounts.get(sessionKey) ?? 0) + 1);
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
      // I5: Refresh memory at the start of each turn
      await refreshMemory();
      // Context pruning: compact if threshold reached, load existing summary
      await compactIfNeeded(sessionKey);

      const userMsg: SessionMessage = {
        role: "user",
        content: message,
        timestamp: new Date().toISOString(),
      };
      const turnMessages: SessionMessage[] = [userMsg];

      // Inject compaction summary into developer_instructions (if any)
      const summary = summaries.get(sessionKey);
      if (summary) {
        codexConfig.developer_instructions =
          `## Previous Conversation Summary\n\n${summary}\n\n` +
          (codexConfig.developer_instructions ?? "");
      }

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
        turnCounts.set(sessionKey, (turnCounts.get(sessionKey) ?? 0) + 1);
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
      turnCounts.delete(sessionKey);
      summaries.delete(sessionKey);
      log.debug({ sessionKey }, "cleared Codex thread mapping");
    },

    // I4 fix: properly clean up Codex resources
    async close(): Promise<void> {
      threadIds.clear();
      // The Codex SDK doesn't expose a close() method on the Codex class,
      // but clearing thread mappings ensures no stale references remain.
      // Any child processes spawned by the SDK are tied to individual turns
      // and terminate when the turn completes.
      log.info("Codex backend closed");
    },
  };
}
