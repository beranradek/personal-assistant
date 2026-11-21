/**
 * Session spawner for `/cc new` and `/cc exit`
 * ============================================
 *
 * Starts a Claude Code session in a tmux session on a DEDICATED socket (`<dataDir>/remote-tmux/tmux.sock`) and ends it again.
 * The tmux session name is `pa-cc-<n>` (fixed prefix + counter, never chat text). The pane process is the program itself (argv, no
 * shell), so the pane pid is the `claude` pid that the remote hooks register in the bridge.
 *
 * When the daemon runs under systemd, the tmux server is started in its own transient scope, so `systemctl --user restart` of the
 * daemon does not kill the sessions. Ownership is "the session exists on our tmux server": nothing is stored on disk.
 * Own tmux subcommand allowlist, `-f /dev/null`, allowlisted environment.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ClaudeCodeRemoteNewSessionConfig } from "../core/types.js";
import { findExecutableOnPath } from "../tmux-agents/binary.js";
import { execTmux } from "../tmux-agents/tmux-exec.js";

export const SPAWN_TMUX_SUBCOMMANDS = ["new-session", "has-session", "list-panes", "send-keys", "kill-session"] as const;
const ALLOWED = new Set<string>(SPAWN_TMUX_SUBCOMMANDS);
export const SPAWN_SESSION_PREFIX = "pa-cc-";
const SESSION_NAME_RE = /^pa-cc-[0-9]{1,6}$/;
const MAX_LABEL_CHARS = 80;
/** Environment passed to the tmux server (and so to the session). `PA_CONFIG` is added by the caller. */
const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "USER", "LOGNAME", "SHELL", "TMPDIR"] as const;
/** Where a `claude` install lives when the (systemd) `PATH` is short. */
const KNOWN_DIRS = [".local/bin", ".claude/local", ".npm-global/bin"];

export interface SpawnedSession {
  /** tmux session name, `pa-cc-<n>`. */
  tmuxName: string;
  /** Pid of the pane process = pid of the program (matches the pid of the registered remote session). */
  panePid: number;
  label?: string;
}

export interface SessionSpawner {
  /** Argv of the command that shows a session in a terminal: `tmux -u -S <sock> attach-session -t <name>`. */
  attachArgv(tmuxName: string): string[];
  start(input: { label?: string }): Promise<SpawnedSession>;
  /** `/exit` typed into the session, then `kill-session` after the grace time. Resolves true when the session is gone. */
  stop(tmuxName: string): Promise<boolean>;
  list(): Promise<SpawnedSession[]>;
  readonly socketPath: string;
}

export interface TmuxCallResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** One tmux call. `detachFromService` is set for the call that may start the tmux server. */
export type TmuxCall = (args: readonly string[], options?: { detachFromService?: boolean }) => Promise<TmuxCallResult>;

export interface SpawnerDeps {
  config: ClaudeCodeRemoteNewSessionConfig;
  /** Working directory of the session (already resolved). */
  cwd: string;
  /** `<dataDir>/remote-tmux/tmux.sock`. */
  socketPath: string;
  /** PA config directory: the hooks of the session read the daemon port and token from it. */
  configDir: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Tests. Default: real tmux through `execTmux`. */
  tmux?: TmuxCall;
  sleep?: (ms: number) => Promise<void>;
  /** Tests. Default: executable lookup on PATH and the known install dirs. */
  resolveProgram?: (program: string) => string | undefined;
  /** Default: true when `INVOCATION_ID` is set (the process runs under systemd) and `systemd-run` exists. */
  useSystemdScope?: boolean;
}

/** Remove everything but letters, digits, space, `_`, `.`, `-`. Empty -> undefined. */
export function cleanLabel(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  // No leading dash: the label is a value of `--name` and must never look like an option.
  const clean = raw.replace(/[^A-Za-z0-9 _.-]/g, "").replace(/\s+/g, " ").trim().replace(/^-+/, "").trim().slice(0, MAX_LABEL_CHARS);
  return clean || undefined;
}

export class SpawnError extends Error {}

export function createSessionSpawner(deps: SpawnerDeps): SessionSpawner {
  const { config, cwd, socketPath } = deps;
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const labels = new Map<string, string>();
  const scope = deps.useSystemdScope ?? (env["INVOCATION_ID"] !== undefined && findExecutableOnPath("systemd-run", env["PATH"] ?? "/usr/bin") !== undefined);
  let queue: Promise<unknown> = Promise.resolve();

  const tmuxEnv: NodeJS.ProcessEnv = {};
  for (const name of ENV_ALLOWLIST) if (env[name] !== undefined) tmuxEnv[name] = env[name];
  tmuxEnv["PA_CONFIG"] = deps.configDir;

  function ensureSocketDir(): void {
    const dir = path.dirname(socketPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.statSync(dir);
    const uid = process.getuid?.();
    if ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022) !== 0) {
      throw new SpawnError(`Socket directory ${dir} must be owned by the daemon user and not writable by group or others (mode 0700)`);
    }
  }

  const tmux: TmuxCall =
    deps.tmux ??
    (async (args, options = {}) => {
      ensureSocketDir();
      const base = ["-f", "/dev/null", "-u", "-S", socketPath];
      const wrap = options.detachFromService === true && scope;
      return execTmux({
        binary: wrap ? "systemd-run" : config.tmuxBinary,
        prefix: wrap ? ["--user", "--scope", "--quiet", "--collect", "--", config.tmuxBinary, ...base] : base,
        allowed: ALLOWED,
        args,
        env: wrap ? { ...tmuxEnv, ...pickEnv(env, ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) } : tmuxEnv,
      });
    });

  function resolveProgram(program: string): string | undefined {
    if (deps.resolveProgram) return deps.resolveProgram(program);
    if (path.isAbsolute(program)) return fs.existsSync(program) ? program : undefined;
    const searchPath = [env["PATH"] ?? "", ...KNOWN_DIRS.map((d) => path.join(home, d))].join(path.delimiter);
    return findExecutableOnPath(program, searchPath);
  }

  async function list(): Promise<SpawnedSession[]> {
    const res = await tmux(["list-panes", "-a", "-F", "#{session_name} #{pane_pid}"]);
    if (res.code !== 0) {
      // Only "no server" means "no sessions". Another failure must not look like an empty list (limit bypass, name clash).
      if (/no server running|error connecting to .*\(No such file or directory\)/i.test(res.stderr)) return [];
      throw new SpawnError(`tmux list-panes failed: ${res.stderr.trim().slice(0, 200) || `exit ${res.code}`}`);
    }
    const out: SpawnedSession[] = [];
    for (const line of res.stdout.split("\n")) {
      const [name, pid] = line.trim().split(" ");
      if (!name || !SESSION_NAME_RE.test(name) || !/^\d+$/.test(pid ?? "")) continue;
      if (out.some((s) => s.tmuxName === name)) continue;
      const label = labels.get(name);
      out.push({ tmuxName: name, panePid: Number(pid), ...(label ? { label } : {}) });
    }
    return out;
  }

  async function startNow(label: string | undefined): Promise<SpawnedSession> {
    const program = resolveProgram(config.command[0]!);
    if (!program) {
      throw new SpawnError(`Program not found: ${config.command[0]}. Put it on the PATH of the daemon or use an absolute path in claudeCode.remote.newSession.command.`);
    }
    const existing = await list();
    const max = existing.reduce((m, s) => Math.max(m, Number(s.tmuxName.slice(SPAWN_SESSION_PREFIX.length))), 0);
    const tmuxName = `${SPAWN_SESSION_PREFIX}${max + 1}`;
    const named = label !== undefined && path.basename(program) === "claude";
    const argv = [program, ...config.command.slice(1), ...(named ? ["--name", label] : [])];
    const res = await tmux(
      ["new-session", "-d", "-s", tmuxName, "-x", "200", "-y", "50", "-c", cwd, "-P", "-F", "#{pane_pid}", ...argv],
      { detachFromService: true },
    );
    if (res.code !== 0) throw new SpawnError(`tmux new-session failed: ${res.stderr.trim().slice(0, 200) || `exit ${res.code}`}`);
    const panePid = Number(res.stdout.trim());
    if (!Number.isInteger(panePid) || panePid <= 0) {
      await tmux(["kill-session", "-t", `=${tmuxName}`]); // no orphan
      throw new SpawnError("tmux did not report the pane pid");
    }
    if (label) labels.set(tmuxName, label);
    return { tmuxName, panePid, ...(label ? { label } : {}) };
  }

  return {
    socketPath,
    attachArgv: (tmuxName) => [config.tmuxBinary, "-u", "-S", socketPath, "attach-session", "-t", `=${tmuxName}`],
    list,
    start({ label }) {
      // Serialized: the name counter must not be raced.
      const run = queue.then(() => startNow(label));
      queue = run.catch(() => undefined);
      return run;
    },
    async stop(tmuxName) {
      if (!SESSION_NAME_RE.test(tmuxName)) throw new SpawnError("Not a session of this daemon");
      // `=` = exact name (a bare `pa-cc-1` would also match `pa-cc-10`); send-keys needs a pane target, so `=name:`.
      const session = `=${tmuxName}`;
      const pane = `=${tmuxName}:`;
      const alive = async () => (await tmux(["has-session", "-t", session])).code === 0;
      if (!(await alive())) return true;
      await tmux(["send-keys", "-t", pane, "-l", "--", "/exit"]);
      await tmux(["send-keys", "-t", pane, "Enter"]);
      for (let waited = 0; waited < config.stopGraceMs; waited += 500) {
        await sleep(500);
        if (!(await alive())) {
          labels.delete(tmuxName);
          return true;
        }
      }
      await tmux(["kill-session", "-t", session]);
      labels.delete(tmuxName);
      return !(await alive());
    },
  };
}

function pickEnv(env: NodeJS.ProcessEnv, names: string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const n of names) if (env[n] !== undefined) out[n] = env[n];
  return out;
}
