import * as path from "node:path";
import { loadConfig } from "../core/config.js";
import { ensureWorkspace } from "../core/workspace.js";
import { readMemoryFiles } from "../memory/files.js";
import { createEmbeddingProvider } from "../memory/embeddings.js";
import { createVectorStore } from "../memory/vector-store.js";
import { createIndexer } from "../memory/indexer.js";
import { hybridSearch } from "../memory/hybrid-search.js";
import { createMemoryServer } from "../tools/memory-server.js";
import { createAssistantServer } from "../tools/assistant-server.js";
import { createCronToolManager } from "../cron/tool.js";
import { handleExec } from "../exec/tool.js";
import { getSession, listSessions } from "../exec/process-registry.js";
import { buildAgentOptions } from "../core/agent-runner.js";
import type { AgentOptions } from "../core/agent-runner.js";
import type { Config } from "../core/types.js";

export const TERMINAL_SESSION_KEY = "terminal--default";

export interface TerminalSession {
  config: Config;
  agentOptions: AgentOptions;
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
