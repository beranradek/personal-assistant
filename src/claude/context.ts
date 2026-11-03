import { readMemoryFiles } from "../memory/files.js";

/** Conservative ceiling for context injected by a Claude Code SessionStart hook. */
export const DEFAULT_CLAUDE_CONTEXT_MAX_BYTES = 128 * 1024;

export async function buildClaudeContext(
  workspaceDir: string,
  maxBytes: number = DEFAULT_CLAUDE_CONTEXT_MAX_BYTES,
): Promise<string> {
  return readMemoryFiles(workspaceDir, { includeHeartbeat: false, maxBytes });
}

export function formatSessionStartHookOutput(context: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  });
}
