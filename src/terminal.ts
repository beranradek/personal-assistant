/**
 * Terminal Mode (Facade)
 * ======================
 *
 * Re-exports from the terminal/ submodules for backward compatibility.
 * The actual implementation lives in:
 *   - terminal/handler.ts  — handleLine()
 *   - terminal/session.ts  — createTerminalSession()
 *   - terminal/repl.ts     — runTerminalRepl()
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

export { handleLine, handleLineStreaming, type HandleLineResult } from "./terminal/handler.js";
export {
  createTerminalSession,
  type TerminalSession,
  TERMINAL_SESSION_KEY,
} from "./terminal/session.js";
export { runTerminalRepl } from "./terminal/repl.js";

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main() {
  const { createTerminalSession } = await import("./terminal/session.js");
  const { runTerminalRepl } = await import("./terminal/repl.js");
  const configDir = new URL("..", import.meta.url).pathname;
  const session = await createTerminalSession(configDir);
  runTerminalRepl(session);
}

const __filename = fileURLToPath(import.meta.url);
const isDirectEntry =
  !process.env["VITEST"] &&
  process.argv[1] &&
  __filename === path.resolve(process.argv[1]);

if (isDirectEntry) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
