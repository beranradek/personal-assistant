/**
 * Terminal Mode
 * =============
 *
 * Standalone interactive terminal entry point for the personal assistant.
 * Provides a readline-based REPL that sends user input to the agent runner
 * and prints responses to stdout.
 *
 * Usage: `npm run terminal`
 *
 * Extracted logic (handleLine, createTerminalSession) is testable
 * independently of the readline loop.
 */

import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./core/config.js";
import { ensureWorkspace } from "./core/workspace.js";
import { readMemoryFiles } from "./memory/files.js";
import { createEmbeddingProvider } from "./memory/embeddings.js";
import { createVectorStore } from "./memory/vector-store.js";
import { createIndexer } from "./memory/indexer.js";
import { hybridSearch } from "./memory/hybrid-search.js";
import { createMemoryServer } from "./tools/memory-server.js";
import { createAssistantServer } from "./tools/assistant-server.js";
import { createCronToolManager } from "./cron/tool.js";
import { handleExec } from "./exec/tool.js";
import { getSession, listSessions } from "./exec/process-registry.js";
import {
  buildAgentOptions,
  runAgentTurn,
  clearSdkSession,
} from "./core/agent-runner.js";
import type { AgentOptions } from "./core/agent-runner.js";
import type { Config } from "./core/types.js";
import { createLogger } from "./core/logger.js";

const log = createLogger("terminal");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TERMINAL_SESSION_KEY = "terminal--default";

// ---------------------------------------------------------------------------
// Testable extracted logic
// ---------------------------------------------------------------------------

export interface HandleLineResult {
  response: string | null;
  error: string | null;
}

export interface TerminalSession {
  config: Config;
  agentOptions: AgentOptions;
  sessionKey: string;
  /** Release resources (vector store, embedder, cron timer). */
  cleanup: () => Promise<void>;
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
    log.error({ err }, "Agent turn failed");
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { response: null, error: errorMessage };
  }
}

/**
 * Initialize a terminal session: load config, ensure workspace, read memory,
 * and build agent options.
 *
 * Returns the session object containing config, agentOptions, and sessionKey.
 */
export async function createTerminalSession(
  configDir: string,
): Promise<TerminalSession> {
  const config = loadConfig(configDir);
  await ensureWorkspace(config);

  // Initialize memory system
  const embedder = await createEmbeddingProvider();
  const dbPath = path.join(config.security.dataDir, "vectors.db");
  const store = createVectorStore(dbPath, embedder.dimensions);
  const indexer = createIndexer(store, embedder);

  const memoryFiles = ["MEMORY.md", ...config.memory.extraPaths].map((f) =>
    f.startsWith("/") ? f : path.join(config.security.workspace, f),
  );
  await indexer.syncFiles(memoryFiles);

  const memoryContent = await readMemoryFiles(config.security.workspace, {
    includeHeartbeat: false,
  });

  // Create MCP servers (memory + assistant + user-configured)
  const memoryServer = createMemoryServer({
    search: async (query: string, maxResults?: number) =>
      hybridSearch(query, store, embedder, {
        vectorWeight: config.memory.search.hybridWeights.vector,
        keywordWeight: config.memory.search.hybridWeights.keyword,
        minScore: config.memory.search.minScore,
        maxResults: maxResults ?? config.memory.search.maxResults,
      }),
  });

  const cronStorePath = path.join(config.security.dataDir, "cron-jobs.json");
  const cronManager = createCronToolManager({
    storePath: cronStorePath,
  });

  const assistantServer = createAssistantServer({
    handleCronAction: cronManager.handleAction,
    handleExec: (options) => handleExec(options, config),
    getProcessSession: getSession,
    listProcessSessions: listSessions,
  });

  await cronManager.rearmTimer();

  const mcpServers: Record<string, unknown> = {
    ...config.mcpServers,
    memory: memoryServer,
    assistant: assistantServer,
  };

  const agentOptions = buildAgentOptions(
    config,
    config.security.workspace,
    memoryContent,
    mcpServers,
  );

  return {
    config,
    agentOptions,
    sessionKey: TERMINAL_SESSION_KEY,
    cleanup: async () => {
      cronManager.stop();
      store.close();
      await embedder.close();
    },
  };
}

// ---------------------------------------------------------------------------
// REPL loop (reusable by cli.ts)
// ---------------------------------------------------------------------------

/**
 * Run the interactive terminal REPL loop.
 * Separated from main() so it can be reused by cli.ts.
 */
export function runTerminalRepl(session: TerminalSession): void {
  const { config, agentOptions, sessionKey } = session;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.setPrompt("You> ");
  rl.prompt();

  rl.on("line", async (input) => {
    const result = await handleLine(input, sessionKey, agentOptions, config);

    if (result === null) {
      // Empty input – just re-prompt
      rl.prompt();
      return;
    }

    if (result.error) {
      console.error("Error:", result.error);
    } else {
      console.log(`\nAssistant: ${result.response}\n`);
    }

    rl.prompt();
  });

  rl.on("close", async () => {
    log.info("Terminal session ended");
    await session.cleanup();
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main() {
  const configDir = new URL("..", import.meta.url).pathname;
  const session = await createTerminalSession(configDir);
  runTerminalRepl(session);
}

// Only run main() when this file is the direct entry point (not when imported).
const __filename = fileURLToPath(import.meta.url);
const isDirectEntry =
  !process.env["VITEST"] &&
  process.argv[1] &&
  __filename === path.resolve(process.argv[1]);

if (isDirectEntry) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
