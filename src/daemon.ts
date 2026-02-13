/**
 * Daemon Mode
 * ===========
 *
 * The main daemon entry point that orchestrates all components of the
 * personal assistant:
 *
 * 1. Config loading + workspace initialization
 * 2. Memory system initialization (embedder + vector store + indexer)
 * 3. MCP server creation (memory + assistant)
 * 4. Agent options building
 * 5. Gateway queue + router creation
 * 6. Adapter startup (telegram/slack, if enabled)
 * 7. Heartbeat scheduler startup
 * 8. Cron job loading + timer arming
 * 9. Queue processing loop
 * 10. Graceful shutdown on SIGTERM/SIGINT
 *
 * Usage: `npm run daemon`
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./core/config.js";
import { ensureWorkspace } from "./core/workspace.js";
import { readMemoryFiles } from "./memory/files.js";
import { buildAgentOptions } from "./core/agent-runner.js";
import { createEmbeddingProvider } from "./memory/embeddings.js";
import { createVectorStore } from "./memory/vector-store.js";
import { createIndexer } from "./memory/indexer.js";
import { hybridSearch } from "./memory/hybrid-search.js";
import { createMemoryServer } from "./tools/memory-server.js";
import { createAssistantServer } from "./tools/assistant-server.js";
import { createMessageQueue } from "./gateway/queue.js";
import { createRouter } from "./gateway/router.js";
import { createTelegramAdapter } from "./adapters/telegram.js";
import { createSlackAdapter } from "./adapters/slack.js";
import { createHeartbeatScheduler } from "./heartbeat/scheduler.js";
import { drainSystemEvents } from "./heartbeat/system-events.js";
import { resolveHeartbeatPrompt } from "./heartbeat/prompts.js";
import { createCronToolManager } from "./cron/tool.js";
import { handleExec } from "./exec/tool.js";
import { getSession, listSessions } from "./exec/process-registry.js";
import { createLogger } from "./core/logger.js";
import type { Adapter, AdapterMessage } from "./core/types.js";

const log = createLogger("daemon");

// ---------------------------------------------------------------------------
// Exported startDaemon (testable without auto-running)
// ---------------------------------------------------------------------------

/**
 * Start the daemon. Initializes all subsystems, starts adapters, and begins
 * processing the message queue.
 *
 * @param configDir - Path to the directory containing settings.json
 */
export async function startDaemon(configDir: string): Promise<void> {
  // 1. Load config & ensure workspace
  const config = loadConfig(configDir);
  await ensureWorkspace(config);

  // 2. Initialize memory system
  const embedder = await createEmbeddingProvider();
  const dbPath = path.join(config.security.dataDir, "vectors.db");
  const store = createVectorStore(dbPath, embedder.dimensions);
  const indexer = createIndexer(store, embedder);

  // Sync memory files into the vector store on startup
  const memoryFiles = ["MEMORY.md", ...config.memory.extraPaths].map((f) =>
    f.startsWith("/") ? f : path.join(config.security.workspace, f),
  );
  await indexer.syncFiles(memoryFiles);

  // 3. Read memory files for system prompt
  const memoryContent = await readMemoryFiles(config.security.workspace, {
    includeHeartbeat: true,
  });

  // 4. Create MCP servers
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

  // 5. Build agent options
  const mcpServers: Record<string, unknown> = {
    memory: memoryServer,
    assistant: assistantServer,
  };
  const agentOptions = buildAgentOptions(
    config,
    config.security.workspace,
    memoryContent,
    mcpServers,
  );

  // 6. Create gateway queue & router
  const queue = createMessageQueue(config);
  const router = createRouter();

  // 7. Start adapters (only if enabled)
  const activeAdapters: Adapter[] = [];

  if (config.adapters.telegram.enabled) {
    const telegram = createTelegramAdapter(
      config.adapters.telegram,
      (msg) => queue.enqueue(msg),
    );
    router.register(telegram);
    await telegram.start();
    activeAdapters.push(telegram);
    log.info("Telegram adapter started");
  }

  if (config.adapters.slack.enabled) {
    const slack = createSlackAdapter(
      config.adapters.slack,
      (msg) => queue.enqueue(msg),
    );
    router.register(slack);
    await slack.start();
    activeAdapters.push(slack);
    log.info("Slack adapter started");
  }

  // 8. Start heartbeat scheduler
  const heartbeat = createHeartbeatScheduler(config, () => {
    const events = drainSystemEvents();
    const prompt = resolveHeartbeatPrompt(events);
    const heartbeatMessage: AdapterMessage = {
      source: "heartbeat",
      sourceId: config.heartbeat.deliverTo,
      text: prompt,
    };
    queue.enqueue(heartbeatMessage);
  });

  // 9. Load cron jobs and arm timer
  await cronManager.rearmTimer();

  // 10. Start processing loop (non-blocking -- processLoop runs until stopped)
  queue.processLoop(agentOptions, config, router);

  log.info("Daemon started");

  // 11. Graceful shutdown
  const SHUTDOWN_TIMEOUT_MS = 10_000;
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) {
      log.warn("Shutdown already in progress, ignoring duplicate signal");
      return;
    }
    shuttingDown = true;
    log.info("Shutting down daemon...");

    // Force exit if graceful shutdown takes too long
    const forceTimer = setTimeout(() => {
      log.error("Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    // Stop the queue processing loop (waits for current turn to finish)
    queue.stop();

    // Stop all active adapters
    for (const adapter of activeAdapters) {
      try {
        await adapter.stop();
      } catch (err) {
        log.error({ err, adapter: adapter.name }, "Error stopping adapter");
      }
    }

    // Stop heartbeat scheduler
    heartbeat.stop();

    // Stop cron timer
    cronManager.stop();

    // Close memory system
    store.close();
    await embedder.close();

    clearTimeout(forceTimer);
    log.info("Daemon shut down cleanly");
    process.exit(0);
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  // Catch unhandled rejections to prevent silent crashes
  process.on("unhandledRejection", (reason) => {
    log.error({ err: reason }, "Unhandled promise rejection");
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main() {
  const configDir = new URL("..", import.meta.url).pathname;
  await startDaemon(configDir);
}

// Only run main() when this file is the direct entry point (not when imported).
const __filename = fileURLToPath(import.meta.url);
const isDirectEntry =
  !process.env["VITEST"] &&
  process.argv[1] &&
  __filename === path.resolve(process.argv[1]);

if (isDirectEntry) {
  main().catch((err) => {
    log.error({ err }, "Fatal error");
    console.error("Fatal:", err);
    process.exit(1);
  });
}
