import * as readline from "node:readline";
import {
  createPasteTracker,
  enableBracketedPaste,
  disableBracketedPaste,
} from "./paste.js";
import { createSpinner } from "./spinner.js";
import { renderMarkdown, hasMarkdownElements } from "./markdown.js";
import { colors } from "./colors.js";
import { handleLineStreaming } from "./handler.js";
import { formatToolSummary, countTerminalRows } from "./stream-render.js";
import type { TerminalSession } from "./session.js";
import type { StreamEvent } from "../core/agent-runner.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("terminal");

/**
 * Run the interactive terminal REPL loop with:
 * - Bracketed paste support (multiline paste submitted as single message)
 * - Streaming output with tool activity display
 * - Smart markdown re-render on completion
 * - Colored prompt and output
 * - Spinner while waiting for first response
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
    if (processing) return;

    const userInput = paste.handleLine(input);
    if (userInput === null) return;

    // Show a preview for multiline pastes
    if (userInput.includes("\n")) {
      const lineCount = userInput.split("\n").length;
      console.log(colors.dim(`(pasted ${lineCount} lines)`));
    }

    processing = true;
    spinner.start();

    let headerPrinted = false;
    let streamedText = "";
    let displayedRows = 0; // Total terminal rows for re-render cursor math
    let inTextBlock = false;
    // Track the last tool_start so we can update it with input details
    let pendingToolName: string | null = null;
    const columns = process.stdout.columns || 80;

    for await (const event of handleLineStreaming(userInput, sessionKey, agentOptions, config)) {
      switch (event.type) {
        case "text_delta": {
          if (!headerPrinted) {
            spinner.stop();
            console.log();
            console.log(colors.label("Assistant:"));
            headerPrinted = true;
          }
          inTextBlock = true;
          process.stdout.write(event.text);
          streamedText += event.text;
          // Recalculate displayed rows from accumulated text
          displayedRows = countTerminalRows(streamedText, columns);
          break;
        }

        case "tool_start": {
          if (!headerPrinted) {
            spinner.stop();
            console.log();
            console.log(colors.label("Assistant:"));
            headerPrinted = true;
          }
          if (inTextBlock) {
            process.stdout.write("\n");
            inTextBlock = false;
          }
          pendingToolName = event.toolName;
          // Show tool name immediately; will be updated when input arrives
          console.log(colors.dim(`  ${event.toolName}...`));
          displayedRows += 1; // tool line = 1 row
          break;
        }

        case "tool_input": {
          // Update the tool line with detailed summary
          if (pendingToolName === event.toolName) {
            const summary = formatToolSummary(event.toolName, event.input);
            // Move cursor up one line, clear it, rewrite
            process.stdout.write("\x1b[1A\x1b[2K");
            console.log(colors.dim(`  ${summary}`));
          }
          pendingToolName = null;
          break;
        }

        case "tool_progress": {
          // Show elapsed time — overwrite current tool line
          const secs = Math.round(event.elapsedSeconds);
          if (secs > 2) {
            process.stdout.write("\x1b[1A\x1b[2K");
            console.log(colors.dim(`  ${event.toolName}... (${secs}s)`));
          }
          break;
        }

        case "result": {
          spinner.stop();
          pendingToolName = null;

          if (!headerPrinted) {
            // No streaming events arrived — display result directly
            if (event.response) {
              console.log();
              console.log(colors.label("Assistant:"));
              console.log(renderMarkdown(event.response));
              console.log();
            }
          } else if (streamedText && hasMarkdownElements(event.response)) {
            // Smart re-render: clear raw text and tool lines, replace with markdown
            if (displayedRows > 0) {
              process.stdout.write(`\x1b[${displayedRows}A\x1b[J`);
            }
            console.log(renderMarkdown(event.response));
            console.log();
          } else {
            // Plain text — just finalize
            if (inTextBlock) {
              process.stdout.write("\n");
            }
            console.log();
          }
          break;
        }

        case "error": {
          spinner.stop();
          if (inTextBlock) {
            process.stdout.write("\n");
          }
          console.error(colors.error(`Error: ${event.error}`));
          break;
        }
      }
    }

    spinner.stop();
    processing = false;
    rl.prompt();
  });

  rl.on("close", async () => {
    log.info("Terminal session ended");
    await cleanup();
    process.exit(0);
  });
}
