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
import { collectMemoryFiles } from "./memory/collect-files.js";
import { createMemoryWatcher } from "./memory/watcher.js";
import { buildAgentOptions } from "./core/agent-runner.js";
import { createBackend } from "./backends/factory.js";
import { createEmbeddingProvider } from "./memory/embeddings.js";
import { createVectorStore } from "./memory/vector-store.js";
import { createIndexer } from "./memory/indexer.js";
import { createRobustMemorySearch } from "./memory/robust-search.js";
import { createMemoryServer } from "./tools/memory-server.js";
import { createAssistantServer } from "./tools/assistant-server.js";
import { createMessageQueue } from "./gateway/queue.js";
import { createRouter } from "./gateway/router.js";
import { createTelegramAdapter } from "./adapters/telegram.js";
import { createSlackAdapter } from "./adapters/slack.js";
import { createHeartbeatScheduler } from "./heartbeat/scheduler.js";
import { drainSystemEvents } from "./heartbeat/system-events.js";
import { resolveHeartbeatPrompt, appendMorningEveningContent, buildDiffAwarePrompt, appendHabitContent } from "./heartbeat/prompts.js";
import { loadHabits, markHabit } from "./heartbeat/habits.js";
import { pullWorkspace, pushWorkspace } from "./heartbeat/git-sync.js";
import { createCronToolManager } from "./cron/tool.js";
import { handleExec } from "./exec/tool.js";
import { getSession, listSessions } from "./exec/process-registry.js";
import cron from "node-cron";
import { runDailyReflection } from "./memory/daily-reflection.js";
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
  const memoryFiles = collectMemoryFiles(
    config.security.workspace,
    config.memory.extraPaths,
    {
      indexDailyLogs: config.memory.indexDailyLogs,
      dailyLogRetentionDays: config.memory.dailyLogRetentionDays,
    },
  );
  await indexer.syncFiles(memoryFiles);

  // Guard against concurrent syncFiles calls (watcher + periodic timer can overlap)
  let syncInProgress = false;
  const syncMemoryFiles = async (reason: string) => {
    if (syncInProgress) return;
    syncInProgress = true;
    try {
      const files = collectMemoryFiles(config.security.workspace, config.memory.extraPaths, {
        indexDailyLogs: config.memory.indexDailyLogs,
        dailyLogRetentionDays: config.memory.dailyLogRetentionDays,
      });
      log.info({ fileCount: files.length, reason }, "Reindexing memory files");
      await indexer.syncFiles(files);
    } catch (err) {
      log.error({ err, reason }, "Reindex failed");
    } finally {
      syncInProgress = false;
    }
  };

  // Watch for memory file changes and reindex
  const memoryWatcher = createMemoryWatcher(config.security.workspace, () => {
    syncMemoryFiles("watcher");
  });

  // Periodic re-sync as a safety net (fs.watch can miss events on Linux)
  const MEMORY_RESYNC_INTERVAL_MS = 60_000;
  const memorySyncTimer = setInterval(() => {
    syncMemoryFiles("periodic");
  }, MEMORY_RESYNC_INTERVAL_MS);
  memorySyncTimer.unref();

  // 3. Read memory files for system prompt
  const memoryContent = await readMemoryFiles(config.security.workspace, {
    includeHeartbeat: true,
  });

  const searchMemory = createRobustMemorySearch({
    workspaceDir: config.security.workspace,
    extraPaths: config.memory.extraPaths,
    store,
    embedder,
    config: {
      vectorWeight: config.memory.search.hybridWeights.vector,
      keywordWeight: config.memory.search.hybridWeights.keyword,
      minScore: config.memory.search.minScore,
      maxResults: config.memory.search.maxResults,
    },
  });

  // 4. Create MCP servers
  const memoryServer = createMemoryServer({
    search: searchMemory,
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
    handleHabitCheck: async (pillarLabel, done) => {
      if (!config.habits.enabled) {
        return { success: false, message: "Habits tracking is disabled in config" };
      }
      await markHabit(config.security.workspace, pillarLabel, done);
      return { success: true, message: `Habit "${pillarLabel}" marked as ${done ? "done" : "undone"}` };
    },
    handleHabitStatus: async () => {
      if (!config.habits.enabled) {
        return { error: "Habits tracking is disabled in config" };
      }
      const data = await loadHabits(config.security.workspace);
      if (!data) return { error: "HABITS.md not found in workspace" };
      return {
        pillars: data.pillars.map((p) => ({
          label: p.label,
          type: p.type,
          done: data.checklist[p.label] === true,
        })),
      };
    },
  });

  // 5. Build agent options (built-in + user-configured MCP servers)
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

  // 6. Create backend + gateway queue & router
  const backend = await createBackend(config, agentOptions, { configDir });
  log.info({ backend: backend.name }, "Agent backend initialized");

  if (config.agent.backend === "codex") {
    log.info(
      { sandbox: config.codex.sandboxMode, approval: config.codex.approvalPolicy },
      "Codex backend active — PA security hooks (bash allowlist, path validation) are " +
      "not used. Command security is enforced by Codex CLI sandbox and approval policy.",
    );
  }

  const queue = createMessageQueue(config);
  const router = createRouter();

  // 7. Start adapters (only if enabled)
  const activeAdapters: Adapter[] = [];

  if (config.adapters.telegram.enabled) {
    const telegram = createTelegramAdapter(
      config.adapters.telegram,
      (msg) => {
        const result = queue.enqueue(msg);
        if (!result.accepted) {
          log.warn({ source: msg.source, reason: result.reason }, "message rejected by queue");
          telegram.sendResponse({
            source: msg.source,
            sourceId: msg.sourceId,
            text: "I'm currently busy processing other messages. Please try again in a moment.",
            metadata: msg.metadata,
          }).catch((err) => log.error({ err }, "failed to send queue-full notice"));
        }
      },
    );
    router.register(telegram);
    await telegram.start();
    activeAdapters.push(telegram);
    log.info("Telegram adapter started");
  }

  if (config.adapters.slack.enabled) {
    const slack = createSlackAdapter(
      config.adapters.slack,
      (msg) => {
        const result = queue.enqueue(msg);
        if (!result.accepted) {
          log.warn({ source: msg.source, reason: result.reason }, "message rejected by queue");
          slack.sendResponse({
            source: msg.source,
            sourceId: msg.sourceId,
            text: "I'm currently busy processing other messages. Please try again in a moment.",
            metadata: msg.metadata,
          }).catch((err) => log.error({ err }, "failed to send queue-full notice"));
        }
      },
    );
    router.register(slack);
    await slack.start();
    activeAdapters.push(slack);
    log.info("Slack adapter started");
  }

  // 8. Start heartbeat scheduler
  const heartbeat = createHeartbeatScheduler(config, async () => {
    // Pull before heartbeat (with stash) so the workspace is current
    if (config.heartbeat.gitSync.enabled) {
      await pullWorkspace(config.security.workspace, config.heartbeat.gitSync.remote);
    }

    const events = drainSystemEvents();
    const basePrompt = resolveHeartbeatPrompt(events);
    const currentContext = events.map((e) => e.text);
    const diffedPrompt = await buildDiffAwarePrompt(
      basePrompt,
      config.security.dataDir,
      currentContext,
      config.heartbeat.stateDiffing,
    );
    const morningEveningPrompt = await appendMorningEveningContent(
      diffedPrompt,
      config,
      config.security.workspace,
    );
    const prompt = await appendHabitContent(
      morningEveningPrompt,
      config,
      config.security.workspace,
    );
    const heartbeatMessage: AdapterMessage = {
      source: "heartbeat",
      sourceId: config.heartbeat.deliverTo,
      text: prompt,
    };
    queue.enqueue(heartbeatMessage);

    // Push after the agent has had time to complete the heartbeat turn.
    // Using a deferred push (60 s) avoids coupling to the queue processing loop.
    if (config.heartbeat.gitSync.enabled) {
      const { workspace, } = config.security;
      const { remote } = config.heartbeat.gitSync;
      const pushTimer = setTimeout(() => {
        pushWorkspace(workspace, remote).catch((err) => {
          log.error({ err }, "Unexpected error in pushWorkspace");
        });
      }, 60_000);
      pushTimer.unref();
    }
  });

  // 9. Schedule daily reflection (before morning heartbeat by default: "0 7 * * *")
  let reflectionTask: { stop(): void } | null = null;
  if (config.reflection.enabled) {
    reflectionTask = cron.schedule(config.reflection.schedule, () => {
      log.info("Daily reflection firing");
      Promise.resolve(runDailyReflection(config, config.security.workspace)).catch((err) => {
        log.error({ err }, "Daily reflection failed");
      });
    });
    log.info({ schedule: config.reflection.schedule }, "Daily reflection scheduled");
  }

  // 10. Load cron jobs and arm timer
  await cronManager.rearmTimer();

  // 11. Start processing loop (non-blocking -- processLoop runs until stopped)
  queue.processLoop(backend, config, router);

  log.info("Daemon started");

  // 12. Graceful shutdown
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

    // Stop daily reflection cron
    if (reflectionTask) reflectionTask.stop();

    // Stop cron timer
    cronManager.stop();

    // Close backend
    if (backend.close) {
      await backend.close();
    }

    // Close memory watcher/timer and system
    clearInterval(memorySyncTimer);
    memoryWatcher.close();
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
    // Suppress harmless SDK transport race condition (see cli.ts for details)
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (msg.includes("ProcessTransport is not ready")) {
      log.debug("Suppressed SDK transport race condition (process already exited)");
      return;
    }
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
