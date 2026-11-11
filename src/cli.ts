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
 *   pa --config <path> ...   Override settings.json location
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { resolveConfigDir, loadConfig, DEFAULTS } from "./core/config.js";
import { ensureWorkspace } from "./core/workspace.js";
import { createTerminalSession, runTerminalRepl } from "./terminal.js";
import { startDaemon } from "./daemon.js";
import { createLogger } from "./core/logger.js";
import { runDailyReflection } from "./memory/daily-reflection.js";
import * as episodeEvalRunner from "./memory/episodes/eval-runner.js";
import { buildClaudeContext, formatSessionStartHookOutput } from "./claude/context.js";
import { evaluateClaudePreToolUse } from "./claude/security-hook.js";
import { claudeCompanionSettingsPath, installClaudeCodeTemplates, installClaudeRemoteConfig } from "./claude/templates.js";
import { createRemoteControlClient, type RemoteControlFn } from "./remote/control-client.js";
import { REMOTE_CHANNEL_IDS, type RemoteChannelId, type RemoteControlRequest, type RemoteControlResponse } from "./remote/protocol.js";

const log = createLogger("cli");

const VALID_COMMANDS = [
  "terminal",
  "daemon",
  "init",
  "mcp-server",
  "integapi",
  "reflect",
  "episode-eval",
  "claude-context",
  "claude-security-hook",
  "claude-remote-hook",
  "remote",
  "claude",
  "agents-view",
] as const;
type Command = (typeof VALID_COMMANDS)[number];

/** Options whose value must not be mistaken for a command (for example `--assistant claude`). */
const VALUE_OPTIONS = new Set(["--config", "--assistant", "--assistant-cwd", "--session", "--watch"]);

/**
 * Parse the subcommand from argv, skipping option values (`--config <path>`, `--assistant <cmd>`, ...).
 * Returns the command string or null if not found/invalid.
 */
export function parseCommand(argv: string[]): Command | null {
  const args = argv.slice(2); // skip node and script path
  for (let i = 0; i < args.length; i++) {
    if (VALUE_OPTIONS.has(args[i]!)) {
      i++; // skip the next arg (the option value)
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
                          [--claude-code] [--claude-remote]
  mcp-server            Start stdio MCP server (for Codex backend integration)
  claude-context        Print safe SessionStart context for Claude Code
  claude-security-hook  Apply PA's PreToolUse security policy for Claude Code
  claude-remote-hook    Hook command for remote sessions (used by Claude Code hooks)
  remote <sub>          Remote session control: attach [target] [--channel slack|telegram] [--force] | detach | status
  claude                Start Claude Code in workspace-restricted companion mode
  agents-view           tmux view: assistant left, agent sessions right (writable)
                          [--assistant <cmd>] [--assistant-cwd <dir>] [-i|--interactive-shell] [--read-only]
                          [--session <name>] [--no-attach]
  integapi <sub>        Integ-API commands (serve, list, health, gmail, calendar, auth)
  reflect               Run daily reflection for yesterday (or --date YYYY-MM-DD)
  episode-eval          Run the built-in episodic memory evaluation fixture corpus [--json] [--output <path>]

Options:
  --config <path>       Path to settings.json (default: ~/.personal-assistant/settings.json)

Environment:
  PA_CONFIG             Config directory path (overridden by --config flag)`);
}

export async function runInit(configDir: string, options: { claudeCode: boolean; claudeRemote?: boolean }): Promise<void> {
  const settingsPath = path.join(configDir, "settings.json");
  let settingsAlreadyExist = false;

  try {
    await fs.access(settingsPath);
    settingsAlreadyExist = true;
    console.log(`Settings file already exists: ${settingsPath}`);
    console.log("Edit it to customize your configuration.");
    if (!options.claudeCode && !options.claudeRemote) return;
  } catch {
    // File doesn't exist, continue
  }

  if (!settingsAlreadyExist) {
    await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(settingsPath, JSON.stringify(DEFAULTS, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log(`Created default settings: ${settingsPath}`);
    console.log("Edit this file to customize your configuration.");
  }

  // Also ensure workspace directories exist
  const config = loadConfig(configDir);
  await ensureWorkspace(config);
  console.log(`Workspace initialized: ${config.security.workspace}`);
  if (options.claudeCode) {
    const result = await installClaudeCodeTemplates(config.security.workspace, configDir);
    console.log(`Claude Code templates created: ${result.created.join(", ") || "none"}`);
    if (result.skipped.length > 0) console.log(`Claude Code templates preserved: ${result.skipped.join(", ")}`);
  }
  if (options.claudeRemote) {
    const result = await installClaudeRemoteConfig(config.security.workspace, configDir);
    console.log(`Claude remote hooks created in: ${result.created.join(", ") || "none"}`);
    console.log(`Claude remote hooks and allow entries added to: ${result.updated.join(", ") || "none"}`);
    for (const [file, entries] of Object.entries(result.allowAdded)) {
      if (entries.length > 0) console.log(`Claude remote allow entries added to ${file}: ${entries.join(", ")}`);
    }
    if (result.unchanged.length > 0) {
      console.log(`Claude remote hooks and allow entries already present in: ${result.unchanged.join(", ")}`);
    }
  }
}

/** Arguments after the command name (the `--config <path>` pair is removed). */
export function commandArgs(args: string[], command: string): string[] {
  const rest: string[] = [];
  let found = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config") {
      i++;
      continue;
    }
    if (!found && args[i] === command) {
      found = true;
      continue;
    }
    if (found) rest.push(args[i]!);
  }
  return rest;
}

export function formatRemoteControlResponse(response: RemoteControlResponse): string {
  const lines = [response.message];
  for (const session of response.sessions) {
    const attached = session.attachedChatId ? ` [attached: ${session.attachedChatId}]` : "";
    lines.push(`${session.index}. ${session.name} (${session.cwd}, pid ${session.pid})${attached}`);
  }
  return lines.join("\n");
}

const REMOTE_USAGE = "Usage: pa remote attach [target] [--channel slack|telegram] [--force] | detach [--channel ...] | status [--channel ...]";

/** Parse `[target] [--channel <id>] [--force]` (flags in any position). Returns undefined for invalid input. */
function parseRemoteArgs(args: string[]): { target?: string; channel?: RemoteChannelId; force: boolean } | undefined {
  let target: string | undefined;
  let channel: RemoteChannelId | undefined;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--force") {
      force = true;
    } else if (arg === "--channel") {
      const value = args[++i];
      channel = REMOTE_CHANNEL_IDS.find((id) => id === value);
      if (!channel) return undefined;
    } else if (!arg.startsWith("--") && target === undefined) {
      target = arg;
    } else {
      return undefined;
    }
  }
  return { ...(target ? { target } : {}), ...(channel ? { channel } : {}), force };
}

/** `pa remote attach|detach|status [target] [--channel <id>] [--force]`. Returns the exit code. */
export async function runRemoteCommand(
  args: string[],
  control: RemoteControlFn,
  out: { log: (text: string) => void; error: (text: string) => void } = console,
): Promise<number> {
  const action = args[0];
  const parsed = parseRemoteArgs(args.slice(1));
  if ((action !== "attach" && action !== "detach" && action !== "status") || !parsed) {
    out.error(REMOTE_USAGE);
    return 1;
  }
  const request: RemoteControlRequest = {
    action,
    // The target is for attach; detach and status ignore it (and `--force` only applies to attach).
    ...(action === "attach" && parsed.target ? { target: parsed.target } : {}),
    ...(parsed.channel ? { channel: parsed.channel } : {}),
    ...(action === "attach" && parsed.force ? { force: true } : {}),
  };
  try {
    const response = await control(request);
    out.log(formatRemoteControlResponse(response));
    return response.ok ? 0 : 1;
  } catch (err) {
    out.error(`remote ${action}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function runRemote(configDir: string, args: string[]): Promise<void> {
  const config = loadConfig(configDir);
  const control = createRemoteControlClient({ configDir, port: config.codex.httpMcpPort });
  process.exitCode = await runRemoteCommand(commandArgs(args, "remote"), control);
}

/** Hook entry point. Never writes to stdout. The exit code tells Claude Code what to do (2 = wake the session). */
async function runClaudeRemoteHookCommand(configDir: string, args: string[]): Promise<void> {
  try {
    const { runRemoteHookEntry } = await import("./claude/remote-hook.js");
    process.exitCode = await runRemoteHookEntry(commandArgs(args, "claude-remote-hook"), configDir);
  } catch {
    process.exitCode = 0;
  }
}

async function runClaudeContext(configDir: string, hookJson: boolean): Promise<void> {
  const config = loadConfig(configDir);
  const context = await buildClaudeContext(config.security.workspace);
  console.log(hookJson ? formatSessionStartHookOutput(context) : context);
}

async function readHookInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Claude hook input exceeds 1 MB");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function runClaudeSecurityHook(configDir: string): Promise<void> {
  try {
    const config = loadConfig(configDir);
    console.log(JSON.stringify(await evaluateClaudePreToolUse(await readHookInput(), config)));
  } catch {
    // Hook stderr is visible to Claude Code; never expose configuration details here.
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "PA security hook could not validate this tool call",
      },
    }));
  }
}

export function buildClaudeCompanionArgs(workspaceDir: string, args: string[], additionalDirs: string[] = [], settingsPath = path.join(workspaceDir, ".claude", "settings.json")): string[] {
  const safeDirs = [...new Set(additionalDirs.map((dir) => path.resolve(dir)))].filter((dir) => dir !== path.resolve(workspaceDir));
  return [
    "--restricted",
    "--tools", "default",
    ...(safeDirs.length > 0 ? ["--add-dir", ...safeDirs] : []),
    "--settings", settingsPath,
    "--mcp-config", path.join(workspaceDir, ".mcp.json"),
    ...args,
  ];
}

export function buildClaudeCompanionEnvironment(configDir: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, PA_CONFIG: configDir };
}

async function runClaudeCompanion(configDir: string, rawArgs: string[]): Promise<void> {
  const config = loadConfig(configDir);
  const commandIndex = rawArgs.indexOf("claude");
  const companionArgs = rawArgs.slice(commandIndex + 1).filter((arg, index, values) =>
    arg !== "--config" && values[index - 1] !== "--config",
  );
  const launcherSettingsPath = claudeCompanionSettingsPath(configDir);
  try {
    await fs.access(launcherSettingsPath);
  } catch {
    throw new Error(`Claude companion settings are missing. Run: pa --config ${path.join(configDir, "settings.json")} init --claude-code`);
  }
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const extraDirs = [
      config.security.dataDir,
      ...config.security.additionalReadDirs,
      ...config.security.additionalWriteDirs,
    ];
    const child = spawn(process.env["CLAUDE_PATH"] || "claude", buildClaudeCompanionArgs(config.security.workspace, companionArgs, extraDirs, launcherSettingsPath), {
      cwd: config.security.workspace,
      stdio: "inherit",
      env: buildClaudeCompanionEnvironment(configDir),
    });
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (exitCode !== 0) process.exitCode = exitCode ?? 1;
}

async function startMcpServer(configDir: string): Promise<void> {
  // Dynamic imports to avoid loading heavy deps at CLI parse time
  const [
    { createConfiguredEmbeddingProvider },
    { createVectorStore },
    { createIndexer },
    { createConfiguredMemorySync },
    { createRobustMemorySearch },
    { lintMemoryKnowledgeBase },
    { createCronToolManager },
    { handleExec },
    { loadHabits, markHabit },
    { getSession, listSessions },
    { createStdioMcpServer, runStdioServer },
    { createIntegMcpProxy },
    { startTmuxAgentService },
    { createRedactor, CONSERVATIVE_PATTERNS },
  ] = await Promise.all([
    import("./memory/embeddings.js"),
    import("./memory/vector-store.js"),
    import("./memory/indexer.js"),
    import("./memory/sync.js"),
    import("./memory/robust-search.js"),
    import("./memory/linter.js"),
    import("./cron/tool.js"),
    import("./exec/tool.js"),
    import("./heartbeat/habits.js"),
    import("./exec/process-registry.js"),
    import("./tools/stdio-mcp-server.js"),
    import("./integ-api/mcp-proxy.js"),
    import("./tmux-agents/startup.js"),
    import("./security/content-redaction.js"),
  ]);

  const config = loadConfig(configDir);
  await ensureWorkspace(config);

  // Initialize memory system. The model loads on the first search and is released when idle,
  // so a short-lived stdio server does not hold it in memory.
  // Such a server is short-lived and may run next to the daemon's own model worker, so it releases
  // its worker after 2 idle minutes at most (0 = keep, as configured).
  const { idleUnloadMinutes } = config.memory.embedding;
  const embedder = await createConfiguredEmbeddingProvider({
    ...config.memory.embedding,
    idleUnloadMinutes: idleUnloadMinutes > 0 ? Math.min(idleUnloadMinutes, 2) : 0,
  });
  const dbPath = path.join(config.security.dataDir, "vectors.db");
  const store = createVectorStore(dbPath, embedder.dimensions);
  const indexer = createIndexer(store, embedder);

  // Changed files are indexed right before a search (never at startup: a long sync would exceed
  // codex's startup_timeout_sec and cause every turn to fail). The wait is capped.
  const memorySync = createConfiguredMemorySync({ config, indexer });

  const baseSearchMemory = createRobustMemorySearch({
    workspaceDir: config.security.workspace,
    extraPaths: config.memory.extraPaths,
    store,
    embedder,
    config: {
      vectorWeight: config.memory.search.hybridWeights.vector,
      keywordWeight: config.memory.search.hybridWeights.keyword,
      minScore: config.memory.search.minScore,
      maxResults: config.memory.search.maxResults,
      recencyBoost: config.memory.search.recencyBoost,
      recencyHalfLifeDays: config.memory.search.recencyHalfLifeDays,
    },
  });
  const searchMemory: typeof baseSearchMemory = async (query, maxResults, filters) => {
    await memorySync.syncIfStale();
    return baseSearchMemory(query, maxResults, filters);
  };

  // Create cron manager
  const cronStorePath = path.join(config.security.dataDir, "cron-jobs.json");
  const cronManager = createCronToolManager({ storePath: cronStorePath });
  await cronManager.rearmTimer();
  const integProxy = createIntegMcpProxy(config.integApi);

  // Optional tmux agent sessions. No reaper here: the daemon owns the only reaper.
  const tmuxAgents = await startTmuxAgentService(config, {
    redact: createRedactor(CONSERVATIVE_PATTERNS),
    caller: "mcp-server",
    reaper: false,
  });

  // Create and start the stdio MCP server
  const server = createStdioMcpServer({
    search: searchMemory,
    lintMemory: () => lintMemoryKnowledgeBase(config.security.workspace),
    handleCronAction: cronManager.handleAction,
    handleExec: (options) => handleExec(options, config),
    getProcessSession: getSession,
    listProcessSessions: listSessions,
    handleHabitCheck: async (label, done) => {
      if (!config.habits.enabled) return { success: false, message: "Habits tracking is disabled in config" };
      await markHabit(config.security.workspace, label, done);
      return { success: true, message: `Habit "${label}" marked as ${done ? "done" : "undone"}` };
    },
    handleHabitStatus: async () => {
      if (!config.habits.enabled) return { error: "Habits tracking is disabled in config" };
      const habits = await loadHabits(config.security.workspace);
      if (!habits) return { error: "HABITS.md not found in workspace" };
      return { pillars: habits.pillars.map((pillar) => ({ label: pillar.label, type: pillar.type, done: habits.checklist[pillar.label] === true })) };
    },
    handleIntegList: integProxy.list,
    handleIntegGmail: integProxy.gmail,
    handleIntegCalendar: integProxy.calendar,
    handleIntegSlack: integProxy.slack,
    ...(tmuxAgents ? { tmuxAgents } : {}),
    // This process is not the daemon: remote control goes to the daemon over HTTP (token file in the config dir).
    ...(config.claudeCode.remote.enabled
      ? { handleRemoteControl: createRemoteControlClient({ configDir, port: config.codex.httpMcpPort }) }
      : {}),
  });

  // Clean shutdown
  const cleanup = async () => {
    cronManager.stop();
    tmuxAgents?.close();
    store.close();
    await embedder.close();
    process.exit(0);
  };

  process.once("SIGTERM", cleanup);
  process.once("SIGINT", cleanup);
  // The MCP client closed our stdin (it exited or finished its turn): release the model worker and exit.
  process.stdin.once("end", () => void cleanup());

  await runStdioServer(server);
}

async function runTerminal(configDir: string): Promise<void> {
  const session = await createTerminalSession(configDir);
  runTerminalRepl(session);
}

/**
 * Parse --date YYYY-MM-DD from argv args that come after the "reflect" subcommand.
 * Returns the date string or undefined.
 */
export function parseReflectDate(argv: string[]): string | undefined {
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--date" && i + 1 < args.length) {
      const val = args[i + 1]!;
      if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
      console.error(`Invalid date format: "${val}". Expected YYYY-MM-DD.`);
      process.exit(1);
    }
  }
  return undefined;
}

export function parseEpisodeEvalJson(argv: string[]): boolean {
  const args = argv.slice(2);
  const commandIndex = args.indexOf("episode-eval");
  if (commandIndex === -1) {
    return false;
  }

  return args.slice(commandIndex + 1).includes("--json");
}

export function parseEpisodeEvalOutputPath(argv: string[]): string | undefined {
  const args = argv.slice(2);
  const commandIndex = args.indexOf("episode-eval");
  if (commandIndex === -1) {
    return undefined;
  }

  const commandArgs = args.slice(commandIndex + 1);
  for (let i = 0; i < commandArgs.length; i++) {
    if (commandArgs[i] === "--output") {
      return commandArgs[i + 1];
    }
  }

  return undefined;
}

function resolveEpisodeEvalOutputPath(argv: string[]): string | undefined {
  const args = argv.slice(2);
  const commandIndex = args.indexOf("episode-eval");
  if (commandIndex === -1) {
    return undefined;
  }

  const commandArgs = args.slice(commandIndex + 1);
  for (let i = 0; i < commandArgs.length; i++) {
    if (commandArgs[i] !== "--output") {
      continue;
    }

    const outputPath = commandArgs[i + 1];
    if (!outputPath || outputPath.startsWith("--")) {
      console.error('Invalid episode-eval usage: "--output" requires a file path.');
      process.exit(1);
    }
    return outputPath;
  }

  return undefined;
}

async function runReflect(configDir: string, targetDate?: string): Promise<void> {
  const config = loadConfig(configDir);
  await ensureWorkspace(config);

  const dateLabel = targetDate ?? "yesterday";
  console.log(`Running daily reflection for ${dateLabel}...`);

  await runDailyReflection(config, config.security.workspace, targetDate);
  console.log("Done.");
}

export async function runEpisodeEval(argv: string[] = process.argv): Promise<void> {
  const outputPath = resolveEpisodeEvalOutputPath(argv);
  const report = await episodeEvalRunner.runDefaultEpisodeEval();
  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(report, null, 2) + "\n");
  }
  if (parseEpisodeEvalJson(argv)) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(episodeEvalRunner.formatEpisodeEvalReport(report));
  }
  if (report.failedFixtures > 0) {
    process.exitCode = 1;
  }
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
      await runInit(configDir, { claudeCode: args.includes("--claude-code"), claudeRemote: args.includes("--claude-remote") });
      break;
    case "terminal":
      await runTerminal(configDir);
      break;
    case "daemon":
      await startDaemon(configDir);
      break;
    case "mcp-server":
      await startMcpServer(configDir);
      break;
    case "claude-context":
      await runClaudeContext(configDir, args.includes("--hook-json"));
      break;
    case "claude-security-hook":
      await runClaudeSecurityHook(configDir);
      break;
    case "claude-remote-hook":
      await runClaudeRemoteHookCommand(configDir, args);
      break;
    case "remote":
      await runRemote(configDir, args);
      break;
    case "claude":
      await runClaudeCompanion(configDir, args);
      break;
    case "agents-view": {
      const { runAgentsView } = await import("./tmux-agents/view-cli.js");
      const viewArgs: string[] = [];
      let configPath: string | undefined;
      let afterCommand = false;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--config") { configPath = args[++i]; continue; }
        if (!afterCommand && args[i] === "agents-view") { afterCommand = true; continue; }
        viewArgs.push(args[i]!);
      }
      try {
        process.exitCode = await runAgentsView(configDir, viewArgs, configPath);
      } catch (err) {
        console.error(`agents-view: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
      break;
    }
    case "reflect": {
      const targetDate = parseReflectDate(process.argv);
      await runReflect(configDir, targetDate);
      break;
    }
    case "episode-eval":
      await runEpisodeEval();
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
