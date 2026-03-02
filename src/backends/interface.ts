/**
 * Agent Backend Interface
 * =======================
 *
 * Abstracts the agent execution layer so that both Claude Agent SDK and
 * Codex SDK can be used interchangeably. Both backends produce the same
 * StreamEvent async generator consumed by the gateway queue and terminal.
 */

import type { StreamEvent, AgentTurnResult } from "../core/agent-runner.js";

export type { StreamEvent, AgentTurnResult };

/**
 * An agent backend that can execute turns and produce streaming events.
 */
export interface AgentBackend {
  /** Human-readable backend name (e.g. "claude", "codex"). */
  readonly name: string;

  /**
   * Execute a single agent turn, yielding StreamEvent objects.
   *
   * The generator must:
   * 1. Emit tool_start/tool_input/text_delta events as the turn progresses
   * 2. Save the interaction to the session transcript
   * 3. Append an audit entry to the daily log
   * 4. Yield a final `result` event (or `error` event on failure)
   *
   * Callers (gateway queue, terminal handler) consume this identically
   * regardless of which backend is active.
   */
  runTurn(
    message: string,
    sessionKey: string,
  ): AsyncGenerator<StreamEvent>;

  /**
   * Execute a single agent turn without streaming.
   * Returns the collected response text.
   * Used by non-streaming code paths (e.g. adapters without processing message support).
   */
  runTurnSync(
    message: string,
    sessionKey: string,
  ): Promise<AgentTurnResult>;

  /**
   * Clear the session for the given key.
   * Called by the /clear command to reset conversation state.
   */
  clearSession(sessionKey: string): void;

  /**
   * Clean up resources (close SDK transports, etc.).
   * Called during graceful shutdown.
   */
  close?(): Promise<void>;
}
