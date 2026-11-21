/**
 * Terminal opener for `/cc new`: starts a terminal emulator window that runs the tmux attach command of a session.
 * Never throws: a missing display or terminal gives `{ opened: false, reason }` and the session keeps running headless.
 *
 * Linux: the first known emulator on PATH, when a display exists (`WAYLAND_DISPLAY` or `DISPLAY`). The display variables are
 * taken from the daemon env, else from `systemctl --user show-environment` (a systemd user service can start before login).
 * macOS: Terminal.app through `osascript`. Under systemd the emulator is started in its own transient scope, so a restart of
 * the daemon does not close the window. The window is a tmux client: closing it only detaches.
 */
import { execFile as nodeExecFile, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import * as path from "node:path";
import type { ClaudeCodeRemoteNewSessionConfig } from "../core/types.js";
import { findExecutableOnPath } from "../tmux-agents/binary.js";

export interface OpenTerminalResult {
  opened: boolean;
  /** Program that was started, or why nothing was started. */
  detail: string;
}

export interface TerminalOpener {
  open(input: { attachArgv: string[]; title: string }): Promise<OpenTerminalResult>;
}

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface TerminalOpenerDeps {
  config: ClaudeCodeRemoteNewSessionConfig["terminal"];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  /** Output of `systemctl --user show-environment` (tests). Default: run it. */
  systemdEnvironment?: () => Promise<string>;
  /** Tests. Default: search `PATH`. */
  which?: (command: string) => string | undefined;
}

/** Known emulators in order. `argv` gets the attach command appended. */
const LINUX_TERMINALS: Array<{ command: string; args: (title: string) => string[] }> = [
  { command: "gnome-terminal", args: (t) => ["--title", t, "--"] },
  { command: "ghostty", args: (t) => [`--title=${t}`, "-e"] },
  { command: "kitty", args: (t) => ["--title", t] },
  { command: "konsole", args: () => ["-e"] },
  { command: "xterm", args: (t) => ["-T", t, "-e"] },
  { command: "x-terminal-emulator", args: () => ["-e"] },
];
const BASE_VARS = ["PATH", "HOME", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL", "TMPDIR", "XDG_DATA_DIRS", "XDG_CONFIG_HOME"] as const;
const DISPLAY_VARS = ["WAYLAND_DISPLAY", "DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"] as const;

function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

function parseSystemdEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

function defaultSystemdEnvironment(): Promise<string> {
  return new Promise((resolve) => {
    nodeExecFile("systemctl", ["--user", "show-environment"], { timeout: 3_000, encoding: "utf8" }, (err, stdout) => resolve(err ? "" : stdout));
  });
}

export function createTerminalOpener(deps: TerminalOpenerDeps): TerminalOpener {
  const platform = deps.platform ?? process.platform;
  const baseEnv = deps.env ?? process.env;
  const spawn: SpawnFn = deps.spawn ?? ((c, a, o) => nodeSpawn(c, a, o));
  const which = deps.which ?? ((c: string) => findExecutableOnPath(c, baseEnv["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"));
  const systemdEnvironment = deps.systemdEnvironment ?? defaultSystemdEnvironment;
  const scoped = baseEnv["INVOCATION_ID"] !== undefined && which("systemd-run") !== undefined;

  /** Fire and forget; resolves false when the process cannot be started. */
  function launch(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const wrapped = scoped && platform === "linux";
        const child = wrapped
          ? spawn("systemd-run", ["--user", "--scope", "--quiet", "--collect", "--", command, ...args], { detached: true, stdio: "ignore", env })
          : spawn(command, args, { detached: true, stdio: "ignore", env });
        let done = false;
        child.once("error", () => {
          if (!done) resolve(false);
          done = true;
        });
        // A start failure (ENOENT) is reported at once. After that the window runs on its own.
        setTimeout(() => {
          if (!done) resolve(true);
          done = true;
          child.unref();
        }, 300);
      } catch {
        resolve(false);
      }
    });
  }

  async function displayEnv(): Promise<NodeJS.ProcessEnv> {
    // Allowlist: the emulator must not get adapter tokens or other secrets of the daemon env.
    const env: NodeJS.ProcessEnv = {};
    for (const name of [...BASE_VARS, ...DISPLAY_VARS]) if (baseEnv[name] !== undefined) env[name] = baseEnv[name];
    if (platform !== "linux") return env;
    if (!env["WAYLAND_DISPLAY"] && !env["DISPLAY"]) {
      const fromSystemd = parseSystemdEnv(await systemdEnvironment());
      for (const name of DISPLAY_VARS) if (fromSystemd[name]) env[name] = fromSystemd[name];
    }
    return env;
  }

  return {
    async open({ attachArgv, title }) {
      const mode = deps.config.mode;
      if (mode === "none") return { opened: false, detail: "terminal.mode is none" };
      const env = await displayEnv();
      if (mode === "custom") {
        const template = deps.config.command;
        if (!template?.length) return { opened: false, detail: "terminal.command is not set" };
        const argv = template.flatMap((w) => (w === "{attach}" ? attachArgv : [w]));
        const ok = await launch(argv[0]!, argv.slice(1), env);
        return ok ? { opened: true, detail: argv[0]! } : { opened: false, detail: `could not start ${argv[0]}` };
      }
      if (platform === "darwin") {
        const script = `tell application "Terminal" to do script ${JSON.stringify(attachArgv.map(shellQuote).join(" "))}`;
        const ok = await launch("osascript", ["-e", script, "-e", 'tell application "Terminal" to activate'], env);
        return ok ? { opened: true, detail: "Terminal.app" } : { opened: false, detail: "osascript failed" };
      }
      if (platform !== "linux") return { opened: false, detail: `no terminal support for ${platform}` };
      if (!env["WAYLAND_DISPLAY"] && !env["DISPLAY"]) return { opened: false, detail: "no display (headless host)" };
      for (const t of LINUX_TERMINALS) {
        const found = which(t.command);
        if (!found) continue;
        if (await launch(path.basename(found) === t.command ? found : t.command, [...t.args(title), ...attachArgv], env)) {
          return { opened: true, detail: t.command };
        }
      }
      return { opened: false, detail: "no terminal emulator found" };
    },
  };
}
