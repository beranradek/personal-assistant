import { runAgentTurn, clearSdkSession } from "../core/agent-runner.js";
import type { AgentOptions } from "../core/agent-runner.js";
import type { Config } from "../core/types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("terminal");

export interface HandleLineResult {
  response: string | null;
  error: string | null;
}

/**
 * Handle a single line of user input.
 *
 * Returns `null` when the input is empty/whitespace (caller should re-prompt).
 * Returns `{ response, error }` otherwise:
 *   - On success: `{ response: "...", error: null }`
 *   - On failure: `{ response: null, error: "..." }`
 */
export async function handleLine(
  input: string,
  sessionKey: string,
  agentOptions: AgentOptions,
  config: Config,
): Promise<HandleLineResult | null> {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  // Handle /clear command — reset conversation history
  if (trimmed === "/clear") {
    clearSdkSession(sessionKey);
    return { response: "Conversation cleared. Starting fresh.", error: null };
  }

  try {
    const result = await runAgentTurn(trimmed, sessionKey, agentOptions, config);
    return { response: result.response, error: null };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // For process exit errors the message already contains the actionable hint;
    // log without the stack trace to avoid noise in the terminal.
    const isProcessExit =
      err instanceof Error &&
      /Claude Code process exited with code/.test(err.message);
    if (isProcessExit) {
      log.error("Agent turn failed: %s", errorMessage);
    } else {
      log.error({ err }, "Agent turn failed");
    }
    return { response: null, error: errorMessage };
  }
}
