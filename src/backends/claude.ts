/**
 * Claude Agent Backend
 * ====================
 *
 * Wraps the existing Claude Agent SDK integration (agent-runner.ts) into
 * the AgentBackend interface. This is a thin delegation layer — all logic
 * remains in agent-runner.ts.
 */

import type { AgentBackend } from "./interface.js";
import type { AgentOptions, StreamEvent, AgentTurnResult } from "../core/agent-runner.js";
import type { Config } from "../core/types.js";
import {
  streamAgentTurn,
  runAgentTurn,
  clearSdkSession,
} from "../core/agent-runner.js";

export function createClaudeBackend(
  agentOptions: AgentOptions,
  config: Config,
  redact?: (text: string) => string,
): AgentBackend {
  return {
    name: "claude",

    async *runTurn(message: string, sessionKey: string): AsyncGenerator<StreamEvent> {
      yield* streamAgentTurn(message, sessionKey, agentOptions, config, redact);
    },

    async runTurnSync(message: string, sessionKey: string): Promise<AgentTurnResult> {
      return runAgentTurn(message, sessionKey, agentOptions, config, redact);
    },

    clearSession(sessionKey: string): void {
      clearSdkSession(sessionKey);
    },
  };
}
