#!/usr/bin/env node

/**
 * CLI Entry Point
 * ===============
 *
 * Global entry point for the personal-assistant CLI.
 *
 * Usage:
 *   pa terminal              Interactive REPL
 *   pa daemon                Headless service
 *   pa init                  Create default settings.json
 *   pa profiles              Print routing + profile configuration
 *   pa --config <path> ...   Override settings.json location
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveConfigDir, loadConfig, DEFAULTS } from "./core/config.js";
import { collectMemoryFiles } from "./memory/collect-files.js";
import { ensureWorkspace } from "./core/workspace.js";
import { createTerminalSession, runTerminalRepl } from "./terminal.js";
import { startDaemon } from "./daemon.js";
import { createLogger } from "./core/logger.js";

const log = createLogger("cli");

const VALID_COMMANDS = [
  "terminal",
  "daemon",
  "init",
  "profiles",
  "mcp-server",
  "integapi",
  "codex-hook",
] as const;
type Command = (typeof VALID_COMMANDS)[number];

/**
 * Parse the subcommand from argv, skipping --config and its value.
 * Returns the command string or null if not found/invalid.
 */
export function parseCommand(argv: string[]): Command | null {
  const args = argv.slice(2); // skip node and script path
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config") {
      i++; // skip the next arg (the path)
      continue;
    }
    if (VALID_COMMANDS.includes(args[i] as Command)) {
      return args[i] as Command;
    }
  }
  return null;
}

function printUsage(): void {
  console.log(`Usage: pa <command> [options]

Commands:
  terminal              Start interactive terminal mode
  daemon                Start headless daemon mode
  init                  Create default settings.json in config directory
  profiles              Print routing + profile configuration (no secrets)
  mcp-server            Start stdio MCP server (for Codex backend integration)
  integapi <sub>        Integ-API commands (serve, list, health, gmail, calendar, auth)
  codex-hook <sub>      Codex CLI hook handler (internal)

Options:
  --config <path>       Path to settings.json (default: ~/.personal-assistant/settings.json)

Environment:
  PA_CONFIG             Config directory path (overridden by --config flag)`);
}

async function runInit(configDir: string): Promise<void> {
  const settingsPath = path.join(configDir, "settings.json");

  try {
    await fs.access(settingsPath);
    console.log(`Settings file already exists: ${settingsPath}`);
    console.log("Edit it to customize your configuration.");
    return;
  } catch {
    // File doesn't exist, continue
  }

  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(settingsPath, JSON.stringify(DEFAULTS, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(`Created default settings: ${settingsPath}`);
  console.log("Edit this file to customize your configuration.");

  // Also ensure workspace directories exist
  const config = loadConfig(configDir);
  await ensureWorkspace(config);
  console.log(`Workspace initialized: ${config.security.workspace}`);
}

async function startMcpServer(configDir: string): Promise<void> {
  // Dynamic imports to avoid loading heavy deps at CLI parse time
  const [
    { createEmbeddingProvider },
    { createVectorStore },
    { createIndexer },
    { createRobustMemorySearch },
    { createCronToolManager },
    { handleExec },
    { getSession, listSessions },
    { createStdioMcpServer, runStdioServer },
  ] = await Promise.all([
    import("./memory/embeddings.js"),
    import("./memory/vector-store.js"),
    import("./memory/indexer.js"),
    import("./memory/robust-search.js"),
    import("./cron/tool.js"),
    import("./exec/tool.js"),
    import("./exec/process-registry.js"),
    import("./tools/stdio-mcp-server.js"),
  ]);

  const config = loadConfig(configDir);
  await ensureWorkspace(config);

  // Initialize memory system
  const embedder = await createEmbeddingProvider();
  const dbPath = path.join(config.security.dataDir, "vectors.db");
  const store = createVectorStore(dbPath, embedder.dimensions);
  const indexer = createIndexer(store, embedder);

  const memoryFiles = collectMemoryFiles(config.security.workspace, config.memory.extraPaths, {
    indexDailyLogs: config.memory.indexDailyLogs,
    dailyLogRetentionDays: config.memory.dailyLogRetentionDays,
  });
  await indexer.syncFiles(memoryFiles);

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

  // Create cron manager
  const cronStorePath = path.join(config.security.dataDir, "cron-jobs.json");
  const cronManager = createCronToolManager({ storePath: cronStorePath });
  await cronManager.rearmTimer();

  // Create and start the stdio MCP server
  const server = createStdioMcpServer({
    search: searchMemory,
    handleCronAction: cronManager.handleAction,
    handleExec: (options) => handleExec(options, config),
    getProcessSession: getSession,
    listProcessSessions: listSessions,
  });

  // Clean shutdown
  const cleanup = async () => {
    cronManager.stop();
    store.close();
    await embedder.close();
    process.exit(0);
  };

  process.once("SIGTERM", cleanup);
  process.once("SIGINT", cleanup);

  await runStdioServer(server);
}

async function runTerminal(configDir: string): Promise<void> {
  const session = await createTerminalSession(configDir);
  runTerminalRepl(session);
}

async function runProfiles(configDir: string): Promise<void> {
  const config = loadConfig(configDir);
  const profiles = Object.fromEntries(
    Object.entries(config.profiles).map(([name, p]) => [
      name,
      { backend: p.backend, model: p.model, tools: p.tools },
    ]),
  );

  console.log(JSON.stringify({ routing: config.routing, profiles }, null, 2));
}

async function runCodexHook(configDir: string): Promise<void> {
  const config = loadConfig(configDir);

  // Extract args after "codex-hook" (skip --config and its value)
  const hookArgs: string[] = [];
  const rawArgs = process.argv.slice(2);
  let found = false;
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--config") {
      i++;
      continue;
    }
    if (!found && rawArgs[i] === "codex-hook") {
      found = true;
      continue;
    }
    if (found) hookArgs.push(rawArgs[i]!);
  }

  const sub = hookArgs[0] ?? "";
  if (sub !== "pretool") {
    console.error(`Unknown codex-hook subcommand: ${sub || "(missing)"}`);
    process.exit(2);
  }

  const { handleCodexPreToolUseHook } = await import("./codex/hooks.js");
  await handleCodexPreToolUseHook(config);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const command = parseCommand(process.argv);

  if (!command) {
    printUsage();
    process.exit(1);
  }

  const configDir = resolveConfigDir(process.argv);

  switch (command) {
    case "init":
      await runInit(configDir);
      break;
    case "terminal":
      await runTerminal(configDir);
      break;
    case "daemon":
      await startDaemon(configDir);
      break;
    case "profiles":
      await runProfiles(configDir);
      break;
    case "mcp-server":
      await startMcpServer(configDir);
      break;
    case "codex-hook":
      await runCodexHook(configDir);
      break;
    case "integapi": {
      const { runIntegApiCli } = await import("./integ-api/cli.js");
      const config = loadConfig(configDir);
      // Extract args after "integapi" (skip --config and its value)
      const integArgs: string[] = [];
      const rawArgs = process.argv.slice(2);
      let foundIntegapi = false;
      for (let i = 0; i < rawArgs.length; i++) {
        if (rawArgs[i] === "--config") { i++; continue; }
        if (!foundIntegapi && rawArgs[i] === "integapi") { foundIntegapi = true; continue; }
        if (foundIntegapi) integArgs.push(rawArgs[i]!);
      }
      await runIntegApiCli(config, integArgs);
      break;
    }
  }
}

if (!process.env["VITEST"]) {
  // The Claude Agent SDK fires hook callbacks (handleControlRequest) without
  // awaiting them. When the Claude Code subprocess exits while a hook is still
  // being processed, the SDK tries to write the response to the dead process
  // and throws "ProcessTransport is not ready for writing" as an unhandled
  // rejection. This is harmless — the turn already completed — so suppress it.
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (msg.includes("ProcessTransport is not ready")) {
      log.debug("Suppressed SDK transport race condition (process already exited)");
      return;
    }
    log.error({ err: reason }, "Unhandled promise rejection");
  });

  main().catch((err) => {
    log.error({ err }, "Fatal error");
    console.error("Fatal:", err);
    process.exit(1);
  });
}
