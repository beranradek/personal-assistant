/**
 * Session-Aware Agent Runner
 * ===========================
 *
 * Orchestrates the lifecycle of a single agent turn:
 *   1. Build SDK options from config + memory + MCP servers
 *   2. Resume the SDK session if a previous session ID exists
 *   3. Call the Claude Agent SDK `query()` function
 *   4. Capture the SDK session ID for future resumption
 *   5. Collect the response from the async generator
 *   6. Save the interaction to the session transcript (audit)
 *   7. Append an audit entry to the daily log
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  HookCallbackMatcher,
  SDKMessage,
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Config, SessionMessage } from "./types.js";
import { saveInteraction } from "../session/manager.js";
import { appendAuditEntry } from "../memory/daily-log.js";
import { bashSecurityHook } from "../security/bash-hook.js";
import { fileToolSecurityHook } from "../security/file-tool-hook.js";
import { sessionKeyToPath } from "../session/types.js";
import {
  loadConversationHistory,
  summarizeConversation,
  appendCompactionEntry,
  loadLatestSummary,
} from "../session/compactor.js";
import { TtlMap, DAY_MS } from "./ttl-map.js";

// ---------------------------------------------------------------------------
// SDK session ID cache
// ---------------------------------------------------------------------------

/**
 * In-memory cache mapping session keys (e.g. "terminal--default",
 * "telegram--123456") to SDK session IDs. When a session ID exists for a
 * given key, the next `runAgentTurn` call will use the SDK's `resume` option
 * so the model sees the full conversation history.
 */
const sdkSessionIds = new TtlMap<string, string>(DAY_MS);

/**
 * Number of turns (user+assistant pairs) completed for each session key
 * since the last compaction. Used to trigger periodic context pruning.
 * Expires after one day of inactivity — the turn counter resets and the
 * latest summary is reloaded from the JSONL on the next access.
 */
const sessionTurnCounts = new TtlMap<string, number>(DAY_MS);

/**
 * Most recent compaction summary for each session key, cached in memory.
 * Injected into `systemPrompt.append` so the agent has context about prior
 * conversation even after the SDK session was reset.
 * Expires after one day of inactivity — reloaded from JSONL on next use.
 */
const sessionSummaries = new TtlMap<string, string>(DAY_MS);

/**
 * Clear the SDK session ID cache. Exposed for testing and daemon restart.
 */
export function clearSdkSessionIds(): void {
  sdkSessionIds.clear();
  sessionTurnCounts.clear();
  sessionSummaries.clear();
}

/**
 * Clear a single SDK session by its session key.
 * The next `runAgentTurn` call for this key will start a fresh conversation.
 * Used by the `/clear` command.
 */
export function clearSdkSession(sessionKey: string): void {
  sdkSessionIds.delete(sessionKey);
  sessionTurnCounts.delete(sessionKey);
  sessionSummaries.delete(sessionKey);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentOptions {
  systemPrompt: { type: "preset"; preset: "claude_code"; append: string };
  cwd: string;
  tools: { type: "preset"; preset: "claude_code" };
  allowedTools: string[];
  sandbox: { enabled: boolean; autoAllowBashIfSandboxed: boolean };
  hooks: Partial<Record<string, HookCallbackMatcher[]>>;
  mcpServers: Record<string, unknown>;
  settingSources: string[];
  model?: string;
  maxTurns: number;
}

export interface AgentTurnResult {
  response: string;
  messages: SessionMessage[];
  /** True when the SDK subprocess exited mid-response (transport race). */
  partial: boolean;
}

// ---------------------------------------------------------------------------
// Stream events (for terminal streaming)
// ---------------------------------------------------------------------------

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; toolName: string }
  | { type: "tool_input"; toolName: string; input: Record<string, unknown> }
  | { type: "tool_progress"; toolName: string; elapsedSeconds: number }
  | { type: "result"; response: string; messages: SessionMessage[]; partial: boolean }
  | { type: "error"; error: string };

// ---------------------------------------------------------------------------
// buildAgentOptions
// ---------------------------------------------------------------------------

/**
 * Build the options object that will be passed to the Claude Agent SDK
 * `query()` function.
 *
 * Combines the project config, workspace directory, loaded memory content
 * (appended to the system prompt), and MCP server configurations.
 */
export function buildAgentOptions(
  config: Config,
  workspaceDir: string,
  memoryContent: string,
  mcpServers: Record<string, unknown>,
): AgentOptions {
  // Auto-allow all tools from every registered MCP server
  const mcpToolPatterns = Object.keys(mcpServers).map(
    (name) => `mcp__${name}__*`,
  );

  return {
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: memoryContent,
    },
    cwd: workspaceDir,
    tools: { type: "preset", preset: "claude_code" },
    allowedTools: [
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Bash",
      "WebFetch",
      "WebSearch",
      ...mcpToolPatterns,
    ],
    sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            async (input, toolUseId) =>
              bashSecurityHook(
                input as any,
                toolUseId,
                { workspaceDir, config },
              ) as any,
          ],
        },
        ...["Read", "Write", "Edit", "Glob", "Grep"].map((toolName) => ({
          matcher: toolName,
          hooks: [
            async (input: any, toolUseId: string | undefined) =>
              fileToolSecurityHook(
                input as any,
                toolUseId,
                { workspaceDir, config },
              ) as any,
          ],
        })),
      ],
    },
    mcpServers,
    settingSources: ["user", "project", "local"],
    model: config.agent.model ?? undefined,
    maxTurns: config.agent.maxTurns,
  };
}

// ---------------------------------------------------------------------------
// Context pruning helpers
// ---------------------------------------------------------------------------

/**
 * Trigger context pruning for a session when its turn count has reached
 * the compaction threshold (`maxHistoryMessages / 2`).
 *
 * Steps:
 *   1. Read user/assistant messages from the JSONL audit trail
 *   2. Call the Anthropic API to summarise them
 *   3. Persist the summary as a `compaction` entry in the JSONL
 *   4. Clear the SDK session ID so the next turn starts a fresh session
 *   5. Cache the summary for injection into `systemPrompt.append`
 *
 * Failures are swallowed with a warning — the agent turn proceeds normally.
 */
async function compactSessionIfNeeded(
  sessionKey: string,
  config: Config,
): Promise<void> {
  if (!config.session.compactionEnabled) return;

  const turnCount = sessionTurnCounts.get(sessionKey) ?? 0;
  const compactionThreshold = Math.floor(config.session.maxHistoryMessages / 2);

  // On first turn: load any existing summary persisted from a previous run
  if (turnCount === 0) {
    const sessionPath = sessionKeyToPath(config.security.dataDir, sessionKey);
    const existing = await loadLatestSummary(sessionPath);
    if (existing) {
      sessionSummaries.set(sessionKey, existing);
    }
    return;
  }

  // Compact when we've completed exactly `compactionThreshold` turns
  if (turnCount % compactionThreshold !== 0) return;

  const sessionPath = sessionKeyToPath(config.security.dataDir, sessionKey);

  try {
    const messages = await loadConversationHistory(sessionPath);
    // Need at least a few turns to produce a meaningful summary
    if (messages.length < 4) return;

    let summary: string;
    if (config.session.summarizationEnabled) {
      summary = await summarizeConversation(
        messages,
        config.session.summarizationModel,
        "anthropic",
      );
    } else {
      // Compaction without summarization: keep only the last exchange as context
      const last = messages.slice(-2);
      summary = last
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n\n");
    }

    await appendCompactionEntry(sessionPath, summary);
    sessionSummaries.set(sessionKey, summary);
    // Reset the SDK session so the next turn starts fresh with only the summary
    sdkSessionIds.delete(sessionKey);
  } catch (err) {
    // Non-fatal — log and continue without compacting
    console.error(
      `[agent-runner] Session compaction failed for ${sessionKey}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Build effective agent options for a turn, injecting the compaction summary
 * into `systemPrompt.append` when one exists for this session.
 */
function buildEffectiveOptions(
  agentOptions: AgentOptions,
  sessionKey: string,
): AgentOptions {
  const summary = sessionSummaries.get(sessionKey);
  if (!summary) return agentOptions;
  return {
    ...agentOptions,
    systemPrompt: {
      ...agentOptions.systemPrompt,
      append:
        `## Previous Conversation Summary\n\n${summary}\n\n` +
        agentOptions.systemPrompt.append,
    },
  };
}

// ---------------------------------------------------------------------------
// runAgentTurn
// ---------------------------------------------------------------------------

/**
 * Execute a single agent turn within the context of a session.
 *
 * Lifecycle:
 * 1. Resume the SDK session if a previous session ID exists for this key
 * 2. Call the SDK `query()` with the user message
 * 3. Capture the SDK session ID for future resumption
 * 4. Collect the response text from assistant messages in the stream
 * 5. Save the user + assistant messages to the session transcript (audit)
 * 6. Append an audit entry to the daily log
 */
export async function runAgentTurn(
  message: string,
  sessionKey: string,
  agentOptions: AgentOptions,
  config: Config,
): Promise<AgentTurnResult> {
  // 1. Build the user message
  const userMsg: SessionMessage = {
    role: "user",
    content: message,
    timestamp: new Date().toISOString(),
  };

  // 2. Context pruning: compact if threshold reached, load existing summary
  await compactSessionIfNeeded(sessionKey, config);

  // 3. Check for existing SDK session to resume
  const sdkSessionId = sdkSessionIds.get(sessionKey);

  // 4. Inject compaction summary into system prompt (if any)
  const effectiveOptions = buildEffectiveOptions(agentOptions, sessionKey);

  // 5. Call SDK query (with resume if we have a previous session)
  const result = query({
    prompt: message,
    options: {
      ...effectiveOptions,
      ...(sdkSessionId ? { resume: sdkSessionId } : {}),
    } as unknown as Options,
  });

  // 4. Collect response from async generator
  let responseText = "";
  let partial = false;
  const turnMessages: SessionMessage[] = [userMsg];

  try {
    for await (const msg of result) {
      // Capture SDK session ID for future resumption
      if (
        !sdkSessionIds.has(sessionKey) &&
        "session_id" in msg &&
        msg.session_id
      ) {
        sdkSessionIds.set(sessionKey, msg.session_id as string);
      }

      if (
        msg.type === "assistant" &&
        (msg as SDKAssistantMessage).message?.content
      ) {
        const assistantMsg = msg as SDKAssistantMessage;
        for (const block of assistantMsg.message.content) {
          if (typeof block === "string") {
            responseText += block;
          } else if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            (block as { type: string }).type === "text" &&
            "text" in block
          ) {
            responseText += (block as { type: "text"; text: string }).text;
          }
        }
      }
    }
  } catch (err) {
    // The SDK can throw "ProcessTransport is not ready for writing" when the
    // Claude Code subprocess exits while a hook callback (e.g. PreToolUse) is
    // still being processed. If we already collected a response, treat the
    // turn as successful but mark it as partial; otherwise re-throw.
    const isTransportError =
      err instanceof Error &&
      err.message.includes("ProcessTransport is not ready");
    if (isTransportError && responseText) {
      partial = true;
    } else {
      // Enhance process exit errors with actionable guidance
      if (err instanceof Error) {
        const exitMatch = err.message.match(
          /Claude Code process exited with code (\d+)/,
        );
        if (exitMatch) {
          const code = exitMatch[1];
          const hint =
            code === "1"
              ? "This usually means an authentication error or a crash in the Claude Code subprocess. " +
                "Check that your ANTHROPIC_API_KEY is set and valid, or run `claude` directly to diagnose."
              : `Exit code ${code} from the Claude Code subprocess. Run \`claude\` directly to diagnose.`;
          throw new Error(`${err.message}\n${hint}`);
        }
      }
      throw err;
    }
  } finally {
    // Ensure the SDK transport is closed and its process "exit" listener is
    // removed. Without this, each query() leaks a listener on `process`,
    // triggering MaxListenersExceededWarning after ~11 calls.
    if (typeof (result as any).close === "function") {
      try {
        (result as any).close();
      } catch {
        // Already closed or process already exited — safe to ignore.
      }
    }
  }

  // Add assistant response to turn messages
  turnMessages.push({
    role: "assistant",
    content: responseText,
    timestamp: new Date().toISOString(),
  });

  // 5. Save to session transcript (audit trail)
  await saveInteraction(sessionKey, turnMessages, config);

  // 6. Increment turn counter (used to trigger compaction on the next turn)
  sessionTurnCounts.set(sessionKey, (sessionTurnCounts.get(sessionKey) ?? 0) + 1);

  // 7. Append audit entry
  await appendAuditEntry(config.security.workspace, {
    timestamp: new Date().toISOString(),
    source: sessionKey.split("--")[0],
    sessionKey,
    type: "interaction",
    userMessage: message,
    assistantResponse: responseText,
  });

  return { response: responseText, messages: turnMessages, partial };
}

// ---------------------------------------------------------------------------
// streamAgentTurn
// ---------------------------------------------------------------------------

/**
 * Streaming variant of `runAgentTurn()` — an async generator that yields
 * `StreamEvent` objects as they arrive from the SDK.
 *
 * Used by the terminal REPL to display incremental output (text deltas,
 * tool start/progress indicators) while the agent turn is in flight.
 *
 * The final event is always either a `result` or an `error`.
 */
export async function* streamAgentTurn(
  message: string,
  sessionKey: string,
  agentOptions: AgentOptions,
  config: Config,
): AsyncGenerator<StreamEvent> {
  // 1. Build the user message
  const userMsg: SessionMessage = {
    role: "user",
    content: message,
    timestamp: new Date().toISOString(),
  };

  // 2. Context pruning: compact if threshold reached, load existing summary
  await compactSessionIfNeeded(sessionKey, config);

  // 3. Check for existing SDK session to resume
  const sdkSessionId = sdkSessionIds.get(sessionKey);

  // 4. Inject compaction summary into system prompt (if any)
  const effectiveOptions = buildEffectiveOptions(agentOptions, sessionKey);

  // 5. Call SDK query (with resume if we have a previous session)
  const result = query({
    prompt: message,
    options: {
      ...effectiveOptions,
      ...(sdkSessionId ? { resume: sdkSessionId } : {}),
    } as unknown as Options,
  });

  // 6. Iterate the async generator, yielding stream events
  let responseText = "";
  let partial = false;
  const turnMessages: SessionMessage[] = [userMsg];

  // Track active tool_use blocks by content block index for input buffering
  const activeTools = new Map<number, { toolName: string; jsonChunks: string[] }>();
  // Track whether stream_events were received since the last assistant message.
  // When true, text/tool content was already yielded via streaming — the
  // complete assistant message only needs to accumulate responseText.
  let hasStreamedSinceLastAssistant = false;

  try {
    for await (const msg of result) {
      // Capture SDK session ID for future resumption
      if (
        !sdkSessionIds.has(sessionKey) &&
        "session_id" in msg &&
        msg.session_id
      ) {
        sdkSessionIds.set(sessionKey, msg.session_id as string);
      }

      if (msg.type === "stream_event") {
        const streamMsg = msg as SDKPartialAssistantMessage;
        const event = (streamMsg as any).event;
        if (!event) continue;

        hasStreamedSinceLastAssistant = true;

        if (event.type === "content_block_delta") {
          const delta = event.delta;
          if (delta?.type === "text_delta" && delta.text) {
            yield { type: "text_delta", text: delta.text };
          } else if (delta?.type === "input_json_delta" && delta.partial_json != null) {
            const tool = activeTools.get(event.index);
            if (tool) {
              tool.jsonChunks.push(delta.partial_json);
            }
          }
        } else if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block?.type === "tool_use" && block.name) {
            activeTools.set(event.index, { toolName: block.name, jsonChunks: [] });
            yield { type: "tool_start", toolName: block.name };
          }
        } else if (event.type === "content_block_stop") {
          const tool = activeTools.get(event.index);
          if (tool) {
            const raw = tool.jsonChunks.join("");
            let input: Record<string, unknown> = {};
            if (raw) {
              try {
                input = JSON.parse(raw);
              } catch {
                // Malformed JSON — yield empty input
              }
            }
            yield { type: "tool_input", toolName: tool.toolName, input };
            activeTools.delete(event.index);
          }
        }
      } else if (msg.type === "tool_progress") {
        const toolMsg = msg as any;
        yield {
          type: "tool_progress",
          toolName: toolMsg.tool_name as string,
          elapsedSeconds: toolMsg.elapsed_time_seconds as number,
        };
      } else if (
        msg.type === "assistant" &&
        (msg as SDKAssistantMessage).message?.content
      ) {
        const assistantMsg = msg as SDKAssistantMessage;
        for (const block of assistantMsg.message.content) {
          if (typeof block === "string") {
            responseText += block;
            if (!hasStreamedSinceLastAssistant) {
              yield { type: "text_delta", text: block };
            }
          } else if (
            typeof block === "object" &&
            block !== null &&
            "type" in block
          ) {
            const typed = block as { type: string; [k: string]: unknown };
            if (typed.type === "text" && "text" in typed) {
              const text = typed.text as string;
              responseText += text;
              if (!hasStreamedSinceLastAssistant) {
                yield { type: "text_delta", text };
              }
            } else if (typed.type === "tool_use" && "name" in typed) {
              const toolName = typed.name as string;
              if (!hasStreamedSinceLastAssistant) {
                yield { type: "tool_start", toolName };
                const input = (typed.input ?? {}) as Record<string, unknown>;
                yield { type: "tool_input", toolName, input };
              }
            }
          }
        }
        // Reset for the next turn — stream events for the next assistant
        // message (if any) will set this back to true.
        hasStreamedSinceLastAssistant = false;
      }
    }
  } catch (err) {
    const isTransportError =
      err instanceof Error &&
      err.message.includes("ProcessTransport is not ready");
    if (isTransportError && responseText) {
      partial = true;
    } else {
      if (responseText) {
        // Non-transport error but we have a partial response
        partial = true;
      } else {
        // Enhance process exit errors with actionable guidance
        let errorMessage = err instanceof Error ? err.message : String(err);
        if (err instanceof Error) {
          const exitMatch = err.message.match(
            /Claude Code process exited with code (\d+)/,
          );
          if (exitMatch) {
            const code = exitMatch[1];
            const hint =
              code === "1"
                ? "This usually means an authentication error or a crash in the Claude Code subprocess. " +
                  "Check that your ANTHROPIC_API_KEY is set and valid, or run `claude` directly to diagnose."
                : `Exit code ${code} from the Claude Code subprocess. Run \`claude\` directly to diagnose.`;
            errorMessage = `${err.message}\n${hint}`;
          }
        }
        yield { type: "error", error: errorMessage };
        return;
      }
    }
  } finally {
    // Ensure the SDK transport is closed
    if (typeof (result as any).close === "function") {
      try {
        (result as any).close();
      } catch {
        // Already closed or process already exited — safe to ignore.
      }
    }
  }

  // Add assistant response to turn messages
  turnMessages.push({
    role: "assistant",
    content: responseText,
    timestamp: new Date().toISOString(),
  });

  // Save to session transcript (audit trail)
  await saveInteraction(sessionKey, turnMessages, config);

  // Increment turn counter (used to trigger compaction on the next turn)
  sessionTurnCounts.set(sessionKey, (sessionTurnCounts.get(sessionKey) ?? 0) + 1);

  // Append audit entry
  await appendAuditEntry(config.security.workspace, {
    timestamp: new Date().toISOString(),
    source: sessionKey.split("--")[0],
    sessionKey,
    type: "interaction",
    userMessage: message,
    assistantResponse: responseText,
  });

  // Yield final result event
  yield { type: "result", response: responseText, messages: turnMessages, partial };
}
