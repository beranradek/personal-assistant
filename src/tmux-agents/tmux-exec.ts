/**
 * The one place that runs a tmux binary with `execFile` (no shell): used by the agents runner (`runner.ts`, dedicated socket,
 * Amy-facing tools) and by the user's-tmux runner of `pa agents-view` (`view.ts`). Each caller passes its OWN subcommand allowlist,
 * so sharing this helper does not widen either one.
 */
import { execFile as nodeExecFile } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 10_000;
/** Upper bound for captured stdout/stderr of one tmux call. */
const MAX_BUFFER_BYTES = 1024 * 1024;
/** Node reports an exceeded `maxBuffer` with this code (the child is killed too, so it is checked before `killed`). */
const MAX_BUFFER_ERROR = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

export type TmuxExecFailure = "not-allowed" | "semicolon" | "timeout" | "too-much-output" | "spawn";

/** A tmux call that was refused before it started, or that could not produce an exit code. */
export class TmuxExecError extends Error {
  constructor(
    readonly reason: TmuxExecFailure,
    message: string,
  ) {
    super(message);
    this.name = "TmuxExecError";
  }
}

export interface TmuxExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface TmuxExecOptions {
  binary: string;
  /** Arguments put in front of `args` (for example `-f /dev/null -u -S <socket>`). */
  prefix?: readonly string[];
  /** Subcommand allowlist: `args[0]` must be in it. */
  allowed: ReadonlySet<string>;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  /** Written to stdin (for `load-buffer -`). Stdin is always closed after the call starts. */
  input?: string;
  timeoutMs?: number;
  execFile?: typeof nodeExecFile;
}

/** Refuse a subcommand outside the allowlist and arguments that tmux would read as a command separator. */
export function assertTmuxArgs(args: readonly string[], allowed: ReadonlySet<string>): void {
  const subcommand = args[0];
  if (subcommand === undefined || !allowed.has(subcommand)) {
    throw new TmuxExecError("not-allowed", `tmux subcommand not allowed: ${subcommand ?? "(none)"}`);
  }
  // tmux treats an argv element that ends with ';' as a command separator (and eats the ';' or a '\' before it).
  if (args.some((arg) => arg.endsWith(";"))) {
    throw new TmuxExecError("semicolon", "tmux argument must not end with ';'");
  }
}

/**
 * Run `<binary> <prefix> <args>` and resolve with the exit code (also non-zero). Rejects with a `TmuxExecError` when the call is
 * refused (`not-allowed`, `semicolon`), times out, produces too much output, or cannot be started.
 */
export function execTmux(options: TmuxExecOptions): Promise<TmuxExecResult> {
  try {
    assertTmuxArgs(options.args, options.allowed);
  } catch (err) {
    return Promise.reject(err);
  }
  const execFile = options.execFile ?? nodeExecFile;
  const subcommand = options.args[0]!;
  return new Promise<TmuxExecResult>((resolve, reject) => {
    const child = execFile(
      options.binary,
      [...(options.prefix ?? []), ...options.args],
      {
        env: options.env,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: MAX_BUFFER_BYTES,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const err = error as NodeJS.ErrnoException & { killed?: boolean };
        if (err.code === MAX_BUFFER_ERROR) {
          reject(new TmuxExecError("too-much-output", `tmux ${subcommand} produced too much output`));
        } else if (err.killed) {
          reject(new TmuxExecError("timeout", `tmux ${subcommand} timed out`));
        } else if (typeof err.code === "number") {
          resolve({ code: err.code, stdout, stderr });
        } else {
          reject(new TmuxExecError("spawn", `tmux ${subcommand} failed: ${err.code ?? err.message}`));
        }
      },
    );
    // A closed stdin must not crash the process (EPIPE when tmux exits early).
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.input ?? "");
  });
}
