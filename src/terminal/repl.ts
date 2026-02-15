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
  let pasteInsertPos = 0;
  let processing = false;
  let cleaned = false;

  // Declared as `let` so the onPaste callback can reference `rl` via closure
  // (rl is assigned after pasteStream is created, but onPaste runs later).
  // eslint-disable-next-line prefer-const
  let rl: readline.Interface;

  // Set up paste interceptor Transform stream
  const pasteStream = createPasteInterceptor({
    onPaste: (text) => {
      pendingPaste = text;
      // Capture cursor position so we can insert the paste at the right spot
      // when the user eventually presses Enter.
      pasteInsertPos = (rl as any).cursor ?? 0;
      // Don't push a synthetic \n — let the user press Enter naturally.
      // This allows combining text typed before/after the paste into one message.
    },
  });

  if (isTTY) {
    enableBracketedPaste();
  }

  process.stdin.setEncoding("utf-8");
  process.stdin.pipe(pasteStream);

  rl = readline.createInterface({
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
    // Guard against concurrent processing (e.g. user presses Enter twice quickly)
    if (processing) return;

    // Combine typed text with pending paste content.
    // When the user types before pasting, pastes, then types after — we merge
    // all three parts: text-before + paste + text-after, using the cursor
    // position captured at paste time.
    let userInput: string;
    if (pendingPaste !== null) {
      const paste = pendingPaste;
      const pos = pasteInsertPos;
      pendingPaste = null;

      const before = input.slice(0, pos).trimEnd();
      const after = input.slice(pos).trimStart();
      userInput = [before, paste, after].filter(Boolean).join("\n");
    } else {
      userInput = input;
    }

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
