import { execFile as nodeExecFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TmuxAgentsConfig } from "../core/types.js";
import { TmuxAgentError } from "./errors.js";

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

const DEFAULT_TIMEOUT_MS = 10_000;
/** Upper bound for captured stdout/stderr of one tmux call. */
const MAX_BUFFER_BYTES = 1024 * 1024;

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

/** The single entry point for every tmux call of the module. It prepends `-S <socketPath>`. */
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

function isNoServer(stderr: string): boolean {
  return /no server running|error connecting to/i.test(stderr);
}

export function createTmuxRunner(config: RunnerConfig, deps: TmuxRunnerDeps = {}): TmuxRunner {
  const execFile = deps.execFile ?? nodeExecFile;
  const env = buildEnv(deps.env ?? process.env, config.envAllowlist);
  let socketDirReady = false;

  function ensureSocketDir(): void {
    if (socketDirReady) return;
    fs.mkdirSync(path.dirname(config.socketPath), { recursive: true, mode: 0o700 });
    socketDirReady = true;
  }

  function assertRunnable(args: readonly string[]): void {
    const subcommand = args[0];
    if (subcommand === undefined || !ALLOWED.has(subcommand)) {
      throw new TmuxAgentError("INVALID_INPUT", `tmux subcommand not allowed: ${subcommand ?? "(none)"}`);
    }
    // tmux treats an argv element that ends with ';' as a command separator (and eats the ';' or a '\' before it).
    if (args.some((arg) => arg.endsWith(";"))) {
      throw new TmuxAgentError("INVALID_INPUT", "tmux argument must not end with ';'");
    }
  }

  return {
    socketPath: config.socketPath,
    async run(args, options = {}) {
      assertRunnable(args);
      ensureSocketDir();
      return new Promise<TmuxRunResult>((resolve, reject) => {
        const child = execFile(
          config.tmuxBinary,
          ["-S", config.socketPath, ...args],
          {
            env,
            timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            killSignal: "SIGKILL",
            maxBuffer: MAX_BUFFER_BYTES,
            encoding: "utf8",
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            if (!error) {
              resolve({ code: 0, stdout, stderr, noServer: false });
              return;
            }
            const err = error as NodeJS.ErrnoException & { killed?: boolean };
            if (err.killed) {
              reject(new TmuxAgentError("TIMEOUT", `tmux ${args[0]} timed out`));
            } else if (typeof err.code === "number") {
              resolve({ code: err.code, stdout, stderr, noServer: isNoServer(stderr) });
            } else {
              reject(new TmuxAgentError("TMUX_ERROR", `tmux ${args[0]} failed: ${err.code ?? err.message}`));
            }
          },
        );
        // A closed stdin must not crash the process (EPIPE when tmux exits early).
        child.stdin?.on("error", () => {});
        child.stdin?.end(options.input ?? "");
      });
    },
  };
}
