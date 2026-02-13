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
import { resolveConfigDir, loadConfig, DEFAULTS } from "./core/config.js";
import { ensureWorkspace } from "./core/workspace.js";
import { createTerminalSession, runTerminalRepl } from "./terminal.js";
import { startDaemon } from "./daemon.js";
import { createLogger } from "./core/logger.js";

const log = createLogger("cli");

const VALID_COMMANDS = ["terminal", "daemon", "init"] as const;
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

  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(DEFAULTS, null, 2) + "\n");
  console.log(`Created default settings: ${settingsPath}`);
  console.log("Edit this file to customize your configuration.");

  // Also ensure workspace directories exist
  const config = loadConfig(configDir);
  await ensureWorkspace(config);
  console.log(`Workspace initialized: ${config.security.workspace}`);
}

async function runTerminal(configDir: string): Promise<void> {
  const session = await createTerminalSession(configDir);
  runTerminalRepl(session);
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
  }
}

if (!process.env["VITEST"]) {
  main().catch((err) => {
    log.error({ err }, "Fatal error");
    console.error("Fatal:", err);
    process.exit(1);
  });
}
