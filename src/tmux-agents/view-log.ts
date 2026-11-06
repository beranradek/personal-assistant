import * as fs from "node:fs";
import * as path from "node:path";

/** The controller log is rotated (one backup) when it grows past this size. */
export const VIEW_LOG_MAX_BYTES = 256 * 1024;
const MAX_MESSAGE_CHARS = 500;

/**
 * Error log of the hidden `pa agents-view` controller (`<dir>/view.log`, mode 0600, one backup). The controller runs in a tmux
 * window nobody watches, so its errors would otherwise vanish. Only the error message is written (tmux stderr, session names),
 * never any agent screen text or user input.
 */
export function createViewLog(dir: string, now: () => Date = () => new Date()): (err: unknown) => void {
  const file = path.join(dir, "view.log");
  return (err) => {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        if (fs.statSync(file).size > VIEW_LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
      } catch {
        // missing file: nothing to rotate
      }
      const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, MAX_MESSAGE_CHARS);
      fs.appendFileSync(file, `${now().toISOString()} ${message}\n`, { encoding: "utf-8", mode: 0o600 });
    } catch {
      // Logging must never break the controller.
    }
  };
}
