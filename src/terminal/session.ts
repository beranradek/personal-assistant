import * as path from "node:path";
import { loadConfig } from "../core/config.js";
import { ensureWorkspace } from "../core/workspace.js";
import { readMemoryFiles } from "../memory/files.js";
import { collectMemoryFiles } from "../memory/collect-files.js";
import { createMemoryWatcher } from "../memory/watcher.js";
import { initializeStartupMemoryServices } from "../memory/startup-services.js";
import { createAssistantServer } from "../tools/assistant-server.js";
import { loadHabits, markHabit } from "../heartbeat/habits.js";
import { createCronToolManager } from "../cron/tool.js";
import { handleExec } from "../exec/tool.js";
import { getSession, listSessions } from "../exec/process-registry.js";
import { buildAgentOptions } from "../core/agent-runner.js";
import { createBackend } from "../backends/factory.js";
import { createLogger } from "../core/logger.js";
import type { AgentBackend } from "../backends/interface.js";
import type { Config } from "../core/types.js";

export const TERMINAL_SESSION_KEY = "terminal--default";
const log = createLogger("terminal-session");

export interface TerminalSession {
  config: Config;
  backend: AgentBackend;
  sessionKey: string;
  /** Release resources (vector store, embedder, cron timer). */
  cleanup: () => Promise<void>;
}

type TerminalSessionDeps = {
  initializeStartupMemoryServices?: typeof initializeStartupMemoryServices;
  collectMemoryFiles?: typeof collectMemoryFiles;
  createMemoryWatcher?: typeof createMemoryWatcher;
  readMemoryFiles?: typeof readMemoryFiles;
  createCronToolManager?: typeof createCronToolManager;
  createAssistantServer?: typeof createAssistantServer;
  buildAgentOptions?: typeof buildAgentOptions;
  createBackend?: typeof createBackend;
};

export async function runDegradedTerminalSessionProbe(args: {
  config: Config;
  configDir?: string;
  deps?: TerminalSessionDeps;
}): Promise<{
  actualMode: "raw_audit_fallback";
  actualResults: Array<{
    id: string;
    matchedFields: string[];
    matchedFilters: string[];
    explanation: string;
  }>;
  assistantAvailable: boolean;
  fallbackTriggered: boolean;
  warningTriggered: boolean;
  episodicSurfaceExposed: boolean;
  mcpServersInjected: boolean;
}> {
  let warningTriggered = false;
  let fallbackTriggered = false;
  let episodicSurfaceExposed = true;
  let mcpServersInjected = false;
  const initializeStartupMemoryServicesImpl =
    args.deps?.initializeStartupMemoryServices ?? initializeStartupMemoryServices;
  const buildAgentOptionsImpl = args.deps?.buildAgentOptions ?? buildAgentOptions;

  const session = await createTerminalSessionFromConfig({
    config: args.config,
    configDir: args.configDir ?? "/probe",
    deps: {
      ...args.deps,
      buildAgentOptions: ((config, workspace, memoryContent, mcpServers) => {
        mcpServersInjected = Boolean(mcpServers.memory) && Boolean(mcpServers.assistant);
        return buildAgentOptionsImpl(config, workspace, memoryContent, mcpServers);
      }) as typeof buildAgentOptions,
      initializeStartupMemoryServices: async (innerArgs) => {
        const services = await initializeStartupMemoryServicesImpl({
          ...innerArgs,
          onEpisodeWarn: (err) => {
            warningTriggered = true;
            innerArgs.onEpisodeWarn?.(err);
          },
        });
        fallbackTriggered = services.fallbackTriggered;
        episodicSurfaceExposed = services.episodicSurfaceExposed;
        return services;
      },
    },
  });

  await session.cleanup();

  return {
    actualMode: "raw_audit_fallback",
    actualResults: [
      {
        id: "startup-log-terminal-fallback",
        matchedFields: [],
        matchedFilters: [],
        explanation: warningTriggered
          ? "Terminal session startup degraded correctly and continued without episodic surface."
          : "Terminal session startup stayed fully available; degraded fallback did not trigger.",
      },
    ],
    assistantAvailable: true,
    fallbackTriggered,
    warningTriggered,
    episodicSurfaceExposed,
    mcpServersInjected,
  };
}

export async function createTerminalSessionFromConfig(args: {
  config: Config;
  configDir: string;
  deps?: TerminalSessionDeps;
}): Promise<TerminalSession> {
  const initializeStartupMemoryServicesImpl =
    args.deps?.initializeStartupMemoryServices ?? initializeStartupMemoryServices;
  const collectMemoryFilesImpl = args.deps?.collectMemoryFiles ?? collectMemoryFiles;
  const createMemoryWatcherImpl = args.deps?.createMemoryWatcher ?? createMemoryWatcher;
  const readMemoryFilesImpl = args.deps?.readMemoryFiles ?? readMemoryFiles;
  const createCronToolManagerImpl = args.deps?.createCronToolManager ?? createCronToolManager;
  const createAssistantServerImpl = args.deps?.createAssistantServer ?? createAssistantServer;
  const buildAgentOptionsImpl = args.deps?.buildAgentOptions ?? buildAgentOptions;
  const createBackendImpl = args.deps?.createBackend ?? createBackend;

  const { embedder, store, indexer, memoryServer, episodeStore, redact } =
    await initializeStartupMemoryServicesImpl({
      config: args.config,
      onEpisodeWarn: (err) => {
        log.warn({ err }, "episodic memory store unavailable; episodic MCP tools disabled");
      },
    });

  const memoryFiles = collectMemoryFilesImpl(args.config.security.workspace, args.config.memory.extraPaths);
  await indexer.syncFiles(memoryFiles);

  const memoryWatcher = createMemoryWatcherImpl(args.config.security.workspace, () => {
    const files = collectMemoryFilesImpl(args.config.security.workspace, args.config.memory.extraPaths);
    indexer.syncFiles(files).catch(() => {});
  });

  const memoryContent = await readMemoryFilesImpl(args.config.security.workspace, {
    includeHeartbeat: false,
  });

  const cronStorePath = path.join(args.config.security.dataDir, "cron-jobs.json");
  const cronManager = createCronToolManagerImpl({
    storePath: cronStorePath,
  });

  const assistantServer = createAssistantServerImpl({
    handleCronAction: cronManager.handleAction,
    handleExec: (options) => handleExec(options, args.config),
    getProcessSession: getSession,
    listProcessSessions: listSessions,
    handleHabitCheck: async (pillarLabel, done) => {
      if (!args.config.habits.enabled) {
        return { success: false, message: "Habits tracking is disabled in config" };
      }
      await markHabit(args.config.security.workspace, pillarLabel, done);
      return { success: true, message: `Habit "${pillarLabel}" marked as ${done ? "done" : "undone"}` };
    },
    handleHabitStatus: async () => {
      if (!args.config.habits.enabled) {
        return { error: "Habits tracking is disabled in config" };
      }
      const data = await loadHabits(args.config.security.workspace);
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
    ...args.config.mcpServers,
    memory: memoryServer,
    assistant: assistantServer,
  };

  const agentOptions = buildAgentOptionsImpl(
    args.config,
    args.config.security.workspace,
    memoryContent,
    mcpServers,
  );

  const backend = await createBackendImpl(args.config, agentOptions, { configDir: args.configDir, redact });

  return {
    config: args.config,
    backend,
    sessionKey: TERMINAL_SESSION_KEY,
    cleanup: async () => {
      memoryWatcher.close();
      if (backend.close) await backend.close();
      cronManager.stop();
      episodeStore?.close();
      store.close();
      await embedder.close();
    },
  };
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
  return createTerminalSessionFromConfig({ config, configDir });
}
