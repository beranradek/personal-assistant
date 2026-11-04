import * as path from "node:path";
import { readMemoryFile } from "../memory/files.js";

/**
 * Ceiling for context injected by a Claude Code SessionStart hook.
 * Claude Code saves larger hook context to a file and shows the model only a ~2 KB preview,
 * so the persona (SOUL.md) would be lost. Keep the injected text below that preview size.
 */
export const DEFAULT_CLAUDE_CONTEXT_MAX_BYTES = 2000;

/** Files the agent must read itself with its Read tool (too large to inject). */
const FILES_TO_READ = ["AGENTS.md", "USER.md", "MEMORY.md"] as const;
const PERSONA_FILE = "SOUL.md";
const TRUNCATION_MARKER = "\n[SOUL.md truncated]";

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, Math.max(0, maxBytes)).toString("utf8").replace(/�+$/u, "");
}

/**
 * Build a small SessionStart context: an instruction to read the large context files
 * (rules, user profile, long-term memory) plus the persona file inline.
 */
export async function buildClaudeContext(
  workspaceDir: string,
  maxBytes: number = DEFAULT_CLAUDE_CONTEXT_MAX_BYTES,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive safe integer");

  const existing: string[] = [];
  for (const filename of FILES_TO_READ) {
    if ((await readMemoryFile(workspaceDir, filename)) !== null) existing.push(path.resolve(workspaceDir, filename));
  }
  const header = [
    "Personal assistant session start.",
    ...(existing.length > 0
      ? ["Before your first answer, read these files with the Read tool (rules, user profile, long-term memory):", ...existing.map((file) => `- ${file}`)]
      : []),
    `Your persona (${PERSONA_FILE}) follows:`,
  ].join("\n");

  const soul = await readMemoryFile(workspaceDir, PERSONA_FILE);
  if (soul === null) return truncateUtf8(header, maxBytes);

  const separator = "\n\n";
  const available = maxBytes - Buffer.byteLength(header) - Buffer.byteLength(separator);
  if (available <= 0) return truncateUtf8(header, maxBytes);
  if (Buffer.byteLength(soul) <= available) return header + separator + soul;
  const room = available - Buffer.byteLength(TRUNCATION_MARKER);
  return header + separator + (room > 0 ? truncateUtf8(soul, room) + TRUNCATION_MARKER : truncateUtf8(TRUNCATION_MARKER, available));
}

export function formatSessionStartHookOutput(context: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  });
}
