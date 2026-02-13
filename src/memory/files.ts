import * as fs from "node:fs/promises";
import * as path from "node:path";

const SEPARATOR = "\n\n---\n\n";

const BASE_FILES = ["AGENTS.md", "SOUL.md", "USER.md", "MEMORY.md"] as const;
const HEARTBEAT_FILE = "HEARTBEAT.md" as const;

/**
 * Read and concatenate memory files from the workspace directory.
 *
 * Files are read in order: AGENTS.md, SOUL.md, USER.md, MEMORY.md,
 * and optionally HEARTBEAT.md. Missing files are silently skipped.
 * Existing file contents are joined with `\n\n---\n\n`.
 */
export async function readMemoryFiles(
  workspaceDir: string,
  options?: { includeHeartbeat?: boolean },
): Promise<string> {
  const filenames: readonly string[] = options?.includeHeartbeat
    ? [...BASE_FILES, HEARTBEAT_FILE]
    : BASE_FILES;

  const contents: string[] = [];

  for (const filename of filenames) {
    const content = await readMemoryFile(workspaceDir, filename);
    if (content !== null) {
      contents.push(content);
    }
  }

  return contents.join(SEPARATOR);
}

/**
 * Read a single memory file from the workspace directory.
 * Returns `null` if the file does not exist.
 */
export async function readMemoryFile(
  workspaceDir: string,
  filename: string,
): Promise<string | null> {
  try {
    return await fs.readFile(path.join(workspaceDir, filename), "utf-8");
  } catch {
    return null;
  }
}
