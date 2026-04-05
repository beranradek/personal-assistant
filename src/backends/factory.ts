/**
 * Backend Factory
 * ===============
 *
 * Creates the appropriate AgentBackend based on config.agent.backend.
 */

import type { AgentBackend } from "./interface.js";
import type { AgentOptions } from "../core/agent-runner.js";
import type { Config } from "../core/types.js";
import { createClaudeBackend } from "./claude.js";
import { createCodexBackend } from "./codex.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("backend-factory");

export interface CreateBackendOptions {
  /** Config directory path, forwarded to the Codex backend for MCP server --config. */
  configDir?: string;
  /** Optional content redactor applied to persisted sessions and audit logs. */
  redact?: (text: string) => string;
}

export async function createBackend(
  config: Config,
  agentOptions?: AgentOptions,
  options?: CreateBackendOptions,
): Promise<AgentBackend> {
  const backendType = config.agent.backend;
  log.info({ backend: backendType }, "Creating agent backend");

  switch (backendType) {
    case "claude":
      if (!agentOptions) {
        throw new Error("AgentOptions required for Claude backend");
      }
      return createClaudeBackend(agentOptions, config, options?.redact);
    case "codex":
      return createCodexBackend(config, { configDir: options?.configDir, redact: options?.redact });
    default:
      throw new Error(`Unknown agent backend: ${backendType}`);
  }
}
