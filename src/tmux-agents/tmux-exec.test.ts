import { describe, it, expect } from "vitest";
import type { execFile as nodeExecFile } from "node:child_process";
import { assertTmuxArgs, execTmux, TmuxExecError } from "./tmux-exec.js";

type Callback = (error: Error | null, stdout: string, stderr: string) => void;

/** Fake execFile: records the call and answers with the scripted outcome. */
function fakeExecFile(outcome: { error?: Partial<NodeJS.ErrnoException> & { killed?: boolean }; stdout?: string; stderr?: string }) {
  const calls: { file: string; args: readonly string[]; stdin: string[] }[] = [];
  const execFile = ((file: string, args: readonly string[], _options: unknown, callback: Callback) => {
    const call = { file, args, stdin: [] as string[] };
    calls.push(call);
    queueMicrotask(() => callback(outcome.error ? (Object.assign(new Error("boom"), outcome.error) as Error) : null, outcome.stdout ?? "", outcome.stderr ?? ""));
    return { stdin: { on() {}, end: (data: string) => call.stdin.push(data) } };
  }) as unknown as typeof nodeExecFile;
  return { calls, execFile };
}

const ALLOWED = new Set(["list-sessions", "has-session"]);

describe("assertTmuxArgs", () => {
  it("refuses a subcommand outside the allowlist and arguments ending with ';'", () => {
    expect(() => assertTmuxArgs(["kill-server"], ALLOWED)).toThrow(/not allowed: kill-server/);
    expect(() => assertTmuxArgs([], ALLOWED)).toThrow(/not allowed: \(none\)/);
    expect(() => assertTmuxArgs(["list-sessions", "-F", "x;"], ALLOWED)).toThrow(/must not end with ';'/);
    expect(() => assertTmuxArgs(["list-sessions", "-F", "x"], ALLOWED)).not.toThrow();
  });

  it("uses a typed error so that callers can map the reason", () => {
    try {
      assertTmuxArgs(["run-shell"], ALLOWED);
    } catch (err) {
      expect(err).toBeInstanceOf(TmuxExecError);
      expect((err as TmuxExecError).reason).toBe("not-allowed");
    }
  });
});

describe("execTmux", () => {
  const base = { binary: "tmux", prefix: ["-S", "/s"], allowed: ALLOWED, env: {}, args: ["list-sessions"] };

  it("runs the binary with prefix and args, closes stdin and returns the exit data", async () => {
    const { calls, execFile } = fakeExecFile({ stdout: "out" });
    expect(await execTmux({ ...base, execFile })).toEqual({ code: 0, stdout: "out", stderr: "" });
    expect(calls[0]).toMatchObject({ file: "tmux", args: ["-S", "/s", "list-sessions"], stdin: [""] });
  });

  it("writes input to stdin", async () => {
    const { calls, execFile } = fakeExecFile({});
    await execTmux({ ...base, input: "text", execFile });
    expect(calls[0]!.stdin).toEqual(["text"]);
  });

  it("resolves with a non-zero exit code", async () => {
    const { execFile } = fakeExecFile({ error: { code: 1 as unknown as string }, stderr: "no server" });
    expect(await execTmux({ ...base, execFile })).toEqual({ code: 1, stdout: "", stderr: "no server" });
  });

  it("maps timeout, too much output and spawn failures to typed errors, and starts nothing when refused", async () => {
    await expect(execTmux({ ...base, execFile: fakeExecFile({ error: { killed: true } }).execFile })).rejects.toMatchObject({
      reason: "timeout",
    });
    await expect(
      execTmux({ ...base, execFile: fakeExecFile({ error: { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true } }).execFile }),
    ).rejects.toMatchObject({ reason: "too-much-output" });
    await expect(execTmux({ ...base, execFile: fakeExecFile({ error: { code: "ENOENT" } }).execFile })).rejects.toMatchObject({
      reason: "spawn",
    });
    const refused = fakeExecFile({});
    await expect(execTmux({ ...base, args: ["kill-server"], execFile: refused.execFile })).rejects.toMatchObject({ reason: "not-allowed" });
    expect(refused.calls).toEqual([]);
  });
});
