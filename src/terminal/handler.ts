import type { AgentBackend, StreamEvent } from "../backends/interface.js";
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
  backend: AgentBackend,
): Promise<HandleLineResult | null> {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  // Handle /clear command — reset conversation history
  if (trimmed === "/clear") {
    backend.clearSession(sessionKey);
    return { response: "Conversation cleared. Starting fresh.", error: null };
  }

  try {
    const result = await backend.runTurnSync(trimmed, sessionKey);
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

/**
 * Streaming variant of handleLine. Yields StreamEvent objects as they arrive.
 *
 * Yields nothing (empty generator) for empty/whitespace input.
 * For /clear, yields a single result event.
 * Otherwise, delegates to streamAgentTurn and yields all events.
 */
export async function* handleLineStreaming(
  input: string,
  sessionKey: string,
  backend: AgentBackend,
): AsyncGenerator<StreamEvent> {
  const trimmed = input.trim();
  if (!trimmed) {
    return;
  }

  if (trimmed === "/clear") {
    backend.clearSession(sessionKey);
    yield {
      type: "result",
      response: "Conversation cleared. Starting fresh.",
      messages: [],
      partial: false,
    };
    return;
  }

  yield* backend.runTurn(trimmed, sessionKey);
}
