import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./types.js";

// Owner-only permissions for sensitive directories and files
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// ---------------------------------------------------------------------------
// Path to bundled templates (resolved relative to this source file)
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, "..", "templates");

// Template files to copy into the workspace root on first run
const TEMPLATE_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "USER.md",
  "MEMORY.md",
  "HEARTBEAT.md",
] as const;

// ---------------------------------------------------------------------------
// writeFileIfMissing – write-exclusive file creation
// ---------------------------------------------------------------------------

/**
 * Write `content` to `filePath` only if the file does not already exist.
 *
 * Uses `fs.writeFile` with flag `"wx"` (O_CREAT | O_EXCL) so the operation
 * is atomic: if the file exists the call fails with EEXIST, which we
 * silently ignore.
 */
export async function writeFileIfMissing(
  filePath: string,
  content: string,
): Promise<void> {
  try {
    await fs.writeFile(filePath, content, { flag: "wx", mode: FILE_MODE });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return; // File already exists – nothing to do
    }
    throw err; // Re-throw unexpected errors
  }
}

// ---------------------------------------------------------------------------
// ensureWorkspace – idempotent workspace bootstrapper
// ---------------------------------------------------------------------------

/**
 * Ensure the workspace directory structure exists and all template files
 * are present.  Safe to call on every startup – existing files are never
 * overwritten.
 *
 * Created structure:
 * ```
 * {workspace}/
 * ├── AGENTS.md
 * ├── SOUL.md
 * ├── USER.md
 * ├── MEMORY.md
 * ├── HEARTBEAT.md
 * ├── daily/
 * └── .claude/
 *     └── skills/
 *
 * {dataDir}/
 * └── sessions/
 * ```
 */
export async function ensureWorkspace(config: Config): Promise<void> {
  const workspace = config.security.workspace;
  const dataDir = config.security.dataDir;

  // 1. Create directories with owner-only permissions.
  //    chmod after mkdir ensures existing dirs from older installations
  //    are also tightened (mkdir mode only applies to newly created dirs).
  const dirs = [
    workspace,
    path.join(workspace, "daily"),
    path.join(workspace, ".claude", "skills"),
    dataDir,
    path.join(dataDir, "sessions"),
  ];
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
    await fs.chmod(dir, DIR_MODE);
  }

  // 2. Copy template files into workspace root (write-exclusive)
  for (const name of TEMPLATE_FILES) {
    const src = path.join(TEMPLATES_DIR, name);
    const dest = path.join(workspace, name);
    const content = await fs.readFile(src, "utf-8");
    await writeFileIfMissing(dest, content);
  }
}
