/**
 * Process tree helper for the remote hook.
 *
 * Finds the pid of the `claude` process that started a hook command. Walks `/proc/<pid>/stat` upward from a start pid.
 *
 * An ancestor counts as claude when its comm is `claude`, or its command line shows a claude install:
 * - argv0 basename is `claude` or `claude.exe` (native binary),
 * - argv0 is a path inside a `claude` or `claude-code` directory (for example `~/.local/share/claude/versions/2.1.0`),
 * - argv0 is node, nodejs or bun and argv1 is a script named `claude`, `claude.exe`, or `cli.js`/`cli.mjs` inside a
 *   `claude-code` directory.
 * There is NO guess. When no ancestor matches, the function returns undefined and the hook does nothing (exit 0).
 * A wrong guess (terminal emulator, tmux, shell) would register a wrong session and poll for it.
 */

import fs from "node:fs";

export interface ProcessInfo {
  pid: number;
  ppid: number;
  comm: string;
  /** First words of the command line (may be empty when unreadable). */
  cmdline: string[];
}

/** Reads one process entry. Returns undefined when the process does not exist or cannot be read. */
export type ProcessReader = (pid: number) => ProcessInfo | undefined;

const MAX_DEPTH = 32;
const RUNTIME_NAMES = new Set(["node", "nodejs", "bun"]);
const CLAUDE_DIRS = new Set(["claude", "claude-code"]);

/** Parse the content of `/proc/<pid>/stat`. The comm field is in parentheses and may contain spaces and parentheses. */
export function parseProcStat(pid: number, stat: string): { ppid: number; comm: string } | undefined {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const comm = stat.slice(open + 1, close);
  const rest = stat.slice(close + 1).trim().split(/\s+/);
  // rest[0] = state, rest[1] = ppid
  const ppid = Number.parseInt(rest[1] ?? "", 10);
  if (!Number.isInteger(ppid) || pid <= 0) return undefined;
  return { ppid, comm };
}

/** Default reader backed by `/proc`. */
export function createProcReader(procDir = "/proc"): ProcessReader {
  return (pid) => {
    try {
      const stat = fs.readFileSync(`${procDir}/${pid}/stat`, "utf8");
      const parsed = parseProcStat(pid, stat);
      if (!parsed) return undefined;
      let cmdline: string[] = [];
      try {
        cmdline = fs.readFileSync(`${procDir}/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).slice(0, 4);
      } catch {
        // cmdline is optional
      }
      return { pid, ppid: parsed.ppid, comm: parsed.comm, cmdline };
    } catch {
      return undefined;
    }
  };
}

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

function inClaudeDir(p: string): boolean {
  return p.split("/").slice(0, -1).some((seg) => CLAUDE_DIRS.has(seg));
}

function isClaude(info: ProcessInfo): boolean {
  if (info.comm === "claude") return true;
  const [argv0 = "", argv1 = ""] = info.cmdline;
  const b0 = baseName(argv0);
  if (b0 === "claude" || b0 === "claude.exe" || inClaudeDir(argv0)) return true;
  if (!RUNTIME_NAMES.has(b0)) return false;
  const b1 = baseName(argv1);
  return b1 === "claude" || b1 === "claude.exe" || ((b1 === "cli.js" || b1 === "cli.mjs") && inClaudeDir(argv1));
}

/** Find the claude pid by walking up from `startPid`. Returns undefined when no ancestor is claude. */
export function findClaudePid(startPid: number, read: ProcessReader = createProcReader()): number | undefined {
  let pid = startPid;
  const seen = new Set<number>();
  for (let depth = 0; depth < MAX_DEPTH && pid > 1 && !seen.has(pid); depth++) {
    seen.add(pid);
    const info = read(pid);
    if (!info) break;
    if (isClaude(info)) return info.pid;
    pid = info.ppid;
  }
  return undefined;
}

/** True when the process exists (signal 0). EPERM means it exists. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
