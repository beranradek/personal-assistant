import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { execFile as ExecFile } from "node:child_process";
import { TmuxAgentError } from "./errors.js";
import { ALLOWED_SUBCOMMANDS, createTmuxRunner } from "./runner.js";

type Callback = (error: Error | null, stdout: string, stderr: string) => void;

interface Call {
  file: string;
  args: string[];
  options: Record<string, unknown>;
  stdin: string[];
}

/** Fake execFile: records the call and answers with the scripted outcome. */
function fakeExec(outcome: { error?: Partial<NodeJS.ErrnoException> & { killed?: boolean }; stdout?: string; stderr?: string } = {}) {
  const calls: Call[] = [];
  const execFile = ((file: string, args: string[], options: Record<string, unknown>, cb: Callback) => {
    const call: Call = { file, args, options, stdin: [] };
    calls.push(call);
    const error = outcome.error ? Object.assign(new Error("boom"), outcome.error) : null;
    queueMicrotask(() => cb(error, outcome.stdout ?? "", outcome.stderr ?? ""));
    return {
      stdin: { on: () => {}, end: (data?: string) => call.stdin.push(data ?? "") },
    };
  }) as unknown as typeof ExecFile;
  return { execFile, calls };
}

function code(err: unknown): string | undefined {
  return err instanceof TmuxAgentError ? err.code : undefined;
}

describe("createTmuxRunner", () => {
  let tmp: string;
  let socketPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runner-test-"));
    socketPath = path.join(tmp, "sub", "tmux.sock");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const make = (exec: ReturnType<typeof fakeExec>, env: NodeJS.ProcessEnv = {}, envAllowlist: string[] = []) =>
    createTmuxRunner({ tmuxBinary: "tmux-bin", socketPath, envAllowlist }, { execFile: exec.execFile, env });

  it("prepends -S <socket>, uses the configured binary and no shell", async () => {
    const exec = fakeExec({ stdout: "ok\n" });
    const result = await make(exec).run(["has-session", "-t", "$1"]);
    expect(result).toEqual({ code: 0, stdout: "ok\n", stderr: "", noServer: false });
    expect(exec.calls[0]!.file).toBe("tmux-bin");
    expect(exec.calls[0]!.args).toEqual(["-S", socketPath, "has-session", "-t", "$1"]);
    expect(exec.calls[0]!.options).not.toHaveProperty("shell");
  });

  it("creates the socket directory with mode 0700 before the first call", async () => {
    await make(fakeExec()).run(["list-sessions"]);
    expect(fs.statSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700);
  });

  it("passes only the allowlisted environment", async () => {
    const exec = fakeExec();
    const env = { PATH: "/bin", HOME: "/h", PA_SECRET: "x", ANTHROPIC_API_KEY: "k", MY_VAR: "v" };
    await make(exec, env, ["MY_VAR"]).run(["list-sessions"]);
    expect(exec.calls[0]!.options["env"]).toEqual({ PATH: "/bin", HOME: "/h", MY_VAR: "v" });
  });

  it("sets a timeout, a SIGKILL signal and a buffer cap", async () => {
    const exec = fakeExec();
    await make(exec).run(["list-sessions"], { timeoutMs: 1234 });
    expect(exec.calls[0]!.options).toMatchObject({ timeout: 1234, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
  });

  it("refuses subcommands outside the fixed set before any process starts", async () => {
    const exec = fakeExec();
    const runner = make(exec);
    const dangerous = [
      "kill-server", "run-shell", "pipe-pane", "source-file", "if-shell", "set-hook", "respawn-pane", "respawn-window",
      "new-window", "split-window", "bind-key", "set-option", "set", "set-environment", "attach-session", "command-prompt",
      "confirm-before", "display-popup", "pipe-pane", "save-buffer", "set-buffer", "show-environment", "wait-for",
      "-f", "-L", "-S", "",
    ];
    for (const sub of dangerous) {
      await expect(runner.run([sub, "-t", "x"])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    await expect(runner.run([])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(exec.calls).toHaveLength(0);
  });

  it("allows every subcommand of the fixed set", async () => {
    const exec = fakeExec();
    const runner = make(exec);
    for (const sub of ALLOWED_SUBCOMMANDS) await runner.run([sub]);
    expect(exec.calls.map((c) => c.args[2])).toEqual([...ALLOWED_SUBCOMMANDS]);
  });

  it("refuses an argument that ends with a semicolon (tmux command separator)", async () => {
    const exec = fakeExec();
    await expect(make(exec).run(["send-keys", "-l", "--", "ls;"])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(make(exec).run(["send-keys", "-l", "--", "ls\\;"])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(exec.calls).toHaveLength(0);
  });

  it("maps 'no server running' and 'error connecting' to noServer, not an exception", async () => {
    const a = await make(fakeExec({ error: { code: 1 as unknown as string }, stderr: "no server running on /x" })).run(["list-sessions"]);
    expect(a).toMatchObject({ code: 1, noServer: true });
    const b = await make(fakeExec({ error: { code: 1 as unknown as string }, stderr: "error connecting to /x (No such file)" }))
      .run(["list-sessions"]);
    expect(b).toMatchObject({ code: 1, noServer: true });
  });

  it("returns a non-zero exit as a result", async () => {
    const result = await make(fakeExec({ error: { code: 1 as unknown as string }, stderr: "can't find session: $9" }))
      .run(["has-session", "-t", "$9"]);
    expect(result).toMatchObject({ code: 1, noServer: false, stderr: "can't find session: $9" });
  });

  it("rejects with TIMEOUT when the child was killed", async () => {
    const err = await make(fakeExec({ error: { killed: true } })).run(["list-sessions"]).catch((e: unknown) => e);
    expect(code(err)).toBe("TIMEOUT");
  });

  it("rejects with TMUX_ERROR when the binary is missing", async () => {
    const err = await make(fakeExec({ error: { code: "ENOENT" } })).run(["list-sessions"]).catch((e: unknown) => e);
    expect(code(err)).toBe("TMUX_ERROR");
  });

  it("writes input to stdin and always closes stdin", async () => {
    const exec = fakeExec();
    const runner = make(exec);
    await runner.run(["load-buffer", "-b", "pa-1", "-"], { input: "line1\nline2" });
    await runner.run(["list-sessions"]);
    expect(exec.calls[0]!.stdin).toEqual(["line1\nline2"]);
    expect(exec.calls[1]!.stdin).toEqual([""]);
  });
});
