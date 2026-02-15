import * as readline from "node:readline";
import {
  createPasteInterceptor,
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

  let pendingPaste: string | null = null;
  let cleaned = false;

  // Set up paste interceptor Transform stream
  const pasteStream = createPasteInterceptor({
    onPaste: (text) => {
      pendingPaste = text;
      // Push a synthetic newline through the transform to trigger readline's
      // "line" event. The handler will pick up pendingPaste instead.
      pasteStream.push("\n");
    },
  });

  if (isTTY) {
    enableBracketedPaste();
  }

  process.stdin.setEncoding("utf-8");
  process.stdin.pipe(pasteStream);

  const rl = readline.createInterface({
    input: pasteStream,
    output: process.stdout,
    prompt: colors.prompt("You> "),
  });

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    spinner.stop();
    if (isTTY) {
      disableBracketedPaste();
    }
    process.stdin.unpipe(pasteStream);
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
    // If we have a pending paste, use that instead of the line content
    const userInput = pendingPaste ?? input;
    pendingPaste = null;

    // Show a preview for multiline pastes
    if (userInput.includes("\n")) {
      const lineCount = userInput.split("\n").length;
      console.log(colors.dim(`(pasted ${lineCount} lines)`));
    }

    spinner.start();
    let result;
    try {
      result = await handleLine(userInput, sessionKey, agentOptions, config);
    } finally {
      spinner.stop();
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
