// Re-export exec types from core for convenience
export type { ProcessSession } from "../core/types.js";

export interface ExecOptions {
  command: string;
  background?: boolean;
  yieldMs?: number;
}

export interface ExecResult {
  success: boolean;
  sessionId?: string;
  output?: string;
  exitCode?: number | null;
  message?: string;
}
