import { colors } from "./colors.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;

export interface Spinner {
  start(message?: string): void;
  stop(): void;
  isSpinning(): boolean;
}

export function createSpinner(): Spinner {
  let timer: ReturnType<typeof setInterval> | null = null;
  let frameIdx = 0;

  return {
    start(message = "Thinking...") {
      if (timer) return;
      frameIdx = 0;
      const write = () => {
        const frame = FRAMES[frameIdx % FRAMES.length];
        process.stdout.write(`\r${colors.dim(frame)} ${colors.dim(message)}`);
        frameIdx++;
      };
      write();
      timer = setInterval(write, INTERVAL_MS);
    },

    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      process.stdout.write("\r\x1b[K");
    },

    isSpinning() {
      return timer !== null;
    },
  };
}
