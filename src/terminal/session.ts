import * as path from "node:path";
import { loadConfig } from "../core/config.js";
import { ensureWorkspace } from "../core/workspace.js";
import { readMemoryFiles } from "../memory/files.js";
import { collectMemoryFiles } from "../memory/collect-files.js";
import { createMemoryWatcher } from "../memory/watcher.js";
import { createEmbeddingProvider } from "../memory/embeddings.js";
import { createVectorStore } from "../memory/vector-store.js";
import { createIndexer } from "../memory/indexer.js";
import { createRobustMemorySearch } from "../memory/robust-search.js";
import { createMemoryServer } from "../tools/memory-server.js";
import { createAssistantServer } from "../tools/assistant-server.js";
import { loadHabits, markHabit } from "../heartbeat/habits.js";
import { createCronToolManager } from "../cron/tool.js";
import { handleExec } from "../exec/tool.js";
import { getSession, listSessions } from "../exec/process-registry.js";
import { buildAgentOptions } from "../core/agent-runner.js";
import { createBackend } from "../backends/factory.js";
import { createRedactor, CONSERVATIVE_PATTERNS } from "../security/content-redaction.js";
import type { AgentBackend } from "../backends/interface.js";
import type { Config } from "../core/types.js";

export const TERMINAL_SESSION_KEY = "terminal--default";

export interface TerminalSession {
  config: Config;
  backend: AgentBackend;
  sessionKey: string;
  /** Release resources (vector store, embedder, cron timer). */
  cleanup: () => Promise<void>;
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

  const memoryFiles = collectMemoryFiles(config.security.workspace, config.memory.extraPaths);
  await indexer.syncFiles(memoryFiles);

  const memoryWatcher = createMemoryWatcher(config.security.workspace, () => {
    const files = collectMemoryFiles(config.security.workspace, config.memory.extraPaths);
    indexer.syncFiles(files).catch(() => {});
  });

  const memoryContent = await readMemoryFiles(config.security.workspace, {
    includeHeartbeat: false,
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

  // Create MCP servers (memory + assistant + user-configured)
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

  const redact = createRedactor(CONSERVATIVE_PATTERNS);
  const backend = await createBackend(config, agentOptions, { configDir, redact });

  return {
    config,
    backend,
    sessionKey: TERMINAL_SESSION_KEY,
    cleanup: async () => {
      memoryWatcher.close();
      if (backend.close) await backend.close();
      cronManager.stop();
      store.close();
      await embedder.close();
    },
  };
}
