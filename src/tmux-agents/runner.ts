import type { execFile as nodeExecFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TmuxAgentsConfig } from "../core/types.js";
import { TmuxAgentError } from "./errors.js";
import { assertTmuxArgs, execTmux, TmuxExecError } from "./tmux-exec.js";

/** The only tmux subcommands this module may run. Everything else (run-shell, pipe-pane, kill-server, ...) is refused. */
export const ALLOWED_SUBCOMMANDS = [
  "new-session",
  "has-session",
  "list-sessions",
  "capture-pane",
  "send-keys",
  "load-buffer",
  "paste-buffer",
  "delete-buffer",
  "display-message",
  "kill-session",
] as const;

const ALLOWED = new Set<string>(ALLOWED_SUBCOMMANDS);

/** Environment variables passed to tmux (and so to every agent) before `tmuxAgents.envAllowlist`. */
export const BASE_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "USER", "LOGNAME", "SHELL", "TMPDIR"] as const;

export interface TmuxRunOptions {
  /** Written to stdin (for `load-buffer -`). Stdin is always closed after the call starts. */
  input?: string;
  timeoutMs?: number;
}

export interface TmuxRunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** No tmux server on the socket (never started, exited, or the socket file is gone). */
  noServer: boolean;
}

/** The single entry point for every tmux call of the module. It prepends `-f /dev/null -u -S <socketPath>`. */
export interface TmuxRunner {
  readonly socketPath: string;
  run(args: readonly string[], options?: TmuxRunOptions): Promise<TmuxRunResult>;
}

export interface TmuxRunnerDeps {
  execFile?: typeof nodeExecFile;
  env?: NodeJS.ProcessEnv;
}

type RunnerConfig = Pick<TmuxAgentsConfig, "tmuxBinary" | "envAllowlist"> & { socketPath: string };

function buildEnv(source: NodeJS.ProcessEnv, extra: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [...BASE_ENV_ALLOWLIST, ...extra]) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** tmux says "no server running on <socket>" or "error connecting to <socket> (No such file or directory)". Other errors are real. */
function isNoServer(stderr: string): boolean {
  return /no server running|error connecting to .*\(No such file or directory\)/i.test(stderr);
}

/** Map a failed tmux call to the module's error codes (refused input, timeout, other tmux failure). */
function toAgentError(err: unknown): unknown {
  if (!(err instanceof TmuxExecError)) return err;
  if (err.reason === "not-allowed" || err.reason === "semicolon") return new TmuxAgentError("INVALID_INPUT", err.message);
  if (err.reason === "timeout") return new TmuxAgentError("TIMEOUT", err.message);
  return new TmuxAgentError("TMUX_ERROR", err.message);
}

export function createTmuxRunner(config: RunnerConfig, deps: TmuxRunnerDeps = {}): TmuxRunner {
  const execFile = deps.execFile;
  const env = buildEnv(deps.env ?? process.env, config.envAllowlist);
  let socketDirReady = false;

  /** Create the socket directory (mode 0700) and refuse one that others could write into (tmux sockets are group-accessible). */
  function ensureSocketDir(): void {
    if (socketDirReady) return;
    const dir = path.dirname(config.socketPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.statSync(dir);
    const uid = process.getuid?.();
    if ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022) !== 0) {
      throw new TmuxAgentError(
        "TMUX_ERROR",
        `Socket directory ${dir} must be owned by the daemon user and not writable by group or others (use mode 0700)`,
      );
    }
    socketDirReady = true;
  }

  return {
    socketPath: config.socketPath,
    async run(args, options = {}) {
      try {
        assertTmuxArgs(args, ALLOWED);
        ensureSocketDir();
        const result = await execTmux({
          binary: config.tmuxBinary,
          // `-f /dev/null`: never read ~/.tmux.conf or /etc/tmux.conf (options such as destroy-unattached, run-shell hooks).
          // `-u`: always UTF-8, also without a UTF-8 LANG (systemd): the screen detectors rely on characters like ❯ and ✻.
          prefix: ["-f", "/dev/null", "-u", "-S", config.socketPath],
          allowed: ALLOWED,
          args,
          env,
          input: options.input,
          timeoutMs: options.timeoutMs,
          execFile,
        });
        return { ...result, noServer: result.code !== 0 && isNoServer(result.stderr) };
      } catch (err) {
        throw toAgentError(err);
      }
    },
  };
}
