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
 *   6. Save the interaction to the session transcript
 *   7. Run compaction if needed
 *   8. Append an audit entry to the daily log
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  HookCallbackMatcher,
  SDKMessage,
  SDKAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Config, SessionMessage } from "./types.js";
import { saveInteraction } from "../session/manager.js";
import { compactIfNeeded } from "../session/compactor.js";
import { sessionKeyToPath } from "../session/types.js";
import { appendAuditEntry } from "../memory/daily-log.js";
import { bashSecurityHook } from "../security/bash-hook.js";
import { fileToolSecurityHook } from "../security/file-tool-hook.js";

// ---------------------------------------------------------------------------
// SDK session ID cache
// ---------------------------------------------------------------------------

/**
 * In-memory cache mapping session keys (e.g. "terminal--default",
 * "telegram--123456") to SDK session IDs. When a session ID exists for a
 * given key, the next `runAgentTurn` call will use the SDK's `resume` option
 * so the model sees the full conversation history.
 */
const sdkSessionIds = new Map<string, string>();

/**
 * Clear the SDK session ID cache. Exposed for testing and daemon restart.
 */
export function clearSdkSessionIds(): void {
  sdkSessionIds.clear();
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
}

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
      "mcp__memory__memory_search",
      "mcp__assistant__cron",
      "mcp__assistant__exec",
      "mcp__assistant__process",
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
    settingSources: ["project"],
    model: config.agent.model ?? undefined,
    maxTurns: config.agent.maxTurns,
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
 * 5. Save the user + assistant messages to the session transcript
 * 6. Run compaction if enabled and threshold is exceeded
 * 7. Append an audit entry to the daily log
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

  // 2. Check for existing SDK session to resume
  const sdkSessionId = sdkSessionIds.get(sessionKey);

  // 3. Call SDK query (with resume if we have a previous session)
  const result = query({
    prompt: message,
    options: {
      ...agentOptions,
      ...(sdkSessionId ? { resume: sdkSessionId } : {}),
    } as unknown as Options,
  });

  // 4. Collect response from async generator
  let responseText = "";
  const turnMessages: SessionMessage[] = [userMsg];

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

  // Add assistant response to turn messages
  turnMessages.push({
    role: "assistant",
    content: responseText,
    timestamp: new Date().toISOString(),
  });

  // 5. Save to session transcript
  await saveInteraction(sessionKey, turnMessages, config);

  // 6. Compact if needed
  if (config.session.compactionEnabled) {
    const sessionPath = sessionKeyToPath(config.security.dataDir, sessionKey);
    await compactIfNeeded(sessionPath, config.session.maxHistoryMessages);
  }

  // 7. Append audit entry
  await appendAuditEntry(config.security.workspace, {
    timestamp: new Date().toISOString(),
    source: sessionKey.split("--")[0],
    sessionKey,
    type: "interaction",
    userMessage: message,
    assistantResponse: responseText,
  });

  return { response: responseText, messages: turnMessages };
}
