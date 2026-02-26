import * as readline from "node:readline";
import {
  createPasteTracker,
  enableBracketedPaste,
  disableBracketedPaste,
} from "./paste.js";
import { createSpinner } from "./spinner.js";
import { renderMarkdown } from "./markdown.js";
import { colors } from "./colors.js";
import { handleLine } from "./handler.js";
import type { TerminalSession } from "./session.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("terminal");

/**
 * Run the interactive terminal REPL loop with:
 * - Bracketed paste support (multiline paste submitted as single message)
 * - Colored prompt and output
 * - Spinner while waiting for agent response
 * - Markdown rendering of assistant responses
 */
export function runTerminalRepl(session: TerminalSession): void {
  const { config, agentOptions, sessionKey } = session;
  const spinner = createSpinner();
  const isTTY = process.stdin.isTTY ?? false;

  const paste = createPasteTracker();
  let processing = false;
  let cleaned = false;

  if (isTTY) {
    enableBracketedPaste();
  }

  process.stdin.setEncoding("utf-8");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: colors.prompt("You> "),
  });

  // Listen for paste-start / paste-end keypress events emitted by readline
  if (isTTY) {
    process.stdin.on("keypress", (_ch: string, key: { name?: string }) => {
      paste.handleKeypress(key?.name);
    });
  }

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    spinner.stop();
    if (isTTY) {
      disableBracketedPaste();
    }
    await session.cleanup();
  };

  // Safety net: always restore terminal on process exit
  process.on("exit", () => {
    if (isTTY) {
      disableBracketedPaste();
    }
  });

  rl.prompt();

  rl.on("line", async (input) => {
    // Guard against concurrent processing (e.g. user presses Enter twice quickly)
    if (processing) return;

    const userInput = paste.handleLine(input);

    // null means the line was buffered during a paste — wait for more
    if (userInput === null) return;

    // Show a preview for multiline pastes
    if (userInput.includes("\n")) {
      const lineCount = userInput.split("\n").length;
      console.log(colors.dim(`(pasted ${lineCount} lines)`));
    }

    processing = true;
    spinner.start();
    let result;
    try {
      result = await handleLine(userInput, sessionKey, agentOptions, config);
    } finally {
      spinner.stop();
      processing = false;
    }

    if (result === null) {
      rl.prompt();
      return;
    }

    if (result.error) {
      console.error(colors.error(`Error: ${result.error}`));
    } else if (result.response) {
      console.log();
      console.log(colors.label("Assistant:"));
      console.log(renderMarkdown(result.response));
      console.log();
    }

    rl.prompt();
  });

  rl.on("close", async () => {
    log.info("Terminal session ended");
    await cleanup();
    process.exit(0);
  });
}
