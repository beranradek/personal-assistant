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
  options?: { includeHeartbeat?: boolean; maxBytes?: number },
): Promise<string> {
  if (options?.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  const filenames: readonly string[] = options?.includeHeartbeat
    ? [...BASE_FILES, HEARTBEAT_FILE]
    : BASE_FILES;

  const contents: string[] = [];

  if (options?.maxBytes !== undefined) {
    return readMemoryFilesBounded(workspaceDir, filenames, options.maxBytes);
  }

  for (const filename of filenames) {
    const content = await readMemoryFile(workspaceDir, filename);
    if (content !== null) {
      contents.push(content);
    }
  }

  return contents.join(SEPARATOR);
}

const TRUNCATION_MARKER = "\n\n[Context truncated to configured byte limit.]";

async function readMemoryFilesBounded(
  workspaceDir: string,
  filenames: readonly string[],
  maxBytes: number,
): Promise<string> {
  let output = "";
  for (const filename of filenames) {
    const separator = output ? SEPARATOR : "";
    const available = maxBytes - Buffer.byteLength(output) - Buffer.byteLength(separator) - Buffer.byteLength(TRUNCATION_MARKER);
    if (available <= 0) return appendWithinLimit(output, TRUNCATION_MARKER, maxBytes);

    const read = await readMemoryFileLimited(workspaceDir, filename, available);
    if (!read) continue;
    output += separator + read.content;
    if (read.truncated) return appendWithinLimit(output, TRUNCATION_MARKER, maxBytes);
  }
  return output;
}

function appendWithinLimit(prefix: string, suffix: string, maxBytes: number): string {
  const remaining = maxBytes - Buffer.byteLength(prefix);
  if (remaining <= 0) return prefix;
  return prefix + truncateUtf8(suffix, remaining);
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  bytes = bytes.subarray(0, maxBytes);
  let text = bytes.toString("utf8");
  while (Buffer.byteLength(text) > maxBytes) {
    text = text.slice(0, -1);
  }
  return text;
}

/**
 * Read a single memory file from the workspace directory.
 * Returns `null` if the file does not exist.
 */
export async function readMemoryFile(
  workspaceDir: string,
  filename: string,
): Promise<string | null> {
  const filePath = path.resolve(workspaceDir, filename);
  const workspacePath = path.resolve(workspaceDir);
  if (path.relative(workspacePath, filePath).startsWith(`..${path.sep}`) || path.relative(workspacePath, filePath) === "..") {
    return null;
  }

  try {
    if (!(await fs.lstat(filePath)).isFile()) return null;
    return await fs.readFile(filePath, "utf-8");
  } catch (error: unknown) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function readMemoryFileLimited(
  workspaceDir: string,
  filename: string,
  maxBytes: number,
): Promise<{ content: string; truncated: boolean } | null> {
  const filePath = path.resolve(workspaceDir, filename);
  const workspacePath = path.resolve(workspaceDir);
  if (path.relative(workspacePath, filePath).startsWith(`..${path.sep}`) || path.relative(workspacePath, filePath) === "..") return null;

  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) return null;
    const handle = await fs.open(filePath, "r");
    try {
      const bytesToRead = Math.min(stat.size, maxBytes);
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
      return { content: truncateUtf8(buffer.subarray(0, bytesRead).toString("utf8"), maxBytes), truncated: stat.size > bytesRead };
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}
