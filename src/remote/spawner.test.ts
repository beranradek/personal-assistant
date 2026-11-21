import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeCodeRemoteNewSessionConfigSchema } from "../core/types.js";
import { cleanLabel, createSessionSpawner, type TmuxCall } from "./spawner.js";

const config = ClaudeCodeRemoteNewSessionConfigSchema.parse({ enabled: true, stopGraceMs: 1000 });

function setup(tmux: TmuxCall) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spawner-"));
  const spawner = createSessionSpawner({
    config,
    cwd: "/ws",
    socketPath: path.join(dir, "remote-tmux", "tmux.sock"),
    configDir: "/cfg",
    env: { PATH: "/usr/bin" },
    tmux,
    sleep: async () => undefined,
    resolveProgram: (p) => (p === "claude" ? "/home/u/.local/bin/claude" : undefined),
  });
  return spawner;
}

const ok = (stdout = ""): { code: number; stdout: string; stderr: string } => ({ code: 0, stdout, stderr: "" });

describe("cleanLabel", () => {
  it("keeps safe characters and cuts length", () => {
    expect(cleanLabel("  my;$(rm) task\n 1 ")).toBe("myrm task 1");
    expect(cleanLabel("!!!")).toBeUndefined();
    expect(cleanLabel("a".repeat(200))).toHaveLength(80);
    expect(cleanLabel(undefined)).toBeUndefined();
    expect(cleanLabel("--dangerous x")).toBe("dangerous x");
  });
});

describe("spawner.start", () => {
  it("runs the program as argv with name, cwd and a detached server", async () => {
    const calls: Array<{ args: readonly string[]; detach?: boolean }> = [];
    const tmux: TmuxCall = vi.fn(async (args, options) => {
      calls.push({ args, detach: options?.detachFromService });
      if (args[0] === "list-panes") return { code: 1, stdout: "", stderr: "no server running" };
      return ok("4242\n");
    });
    const spawner = setup(tmux);
    const s = await spawner.start({ label: "fix bug" });
    expect(s).toEqual({ tmuxName: "pa-cc-1", panePid: 4242, label: "fix bug" });
    const create = calls.find((c) => c.args[0] === "new-session")!;
    expect(create.detach).toBe(true);
    expect(create.args.slice(-4)).toEqual(["/home/u/.local/bin/claude", "--dangerously-skip-permissions", "--name", "fix bug"]);
    expect(create.args).toContain("/ws");
    expect(spawner.attachArgv("pa-cc-1")).toEqual(["tmux", "-u", "-S", spawner.socketPath, "attach-session", "-t", "=pa-cc-1"]);
  });

  it("numbers after the highest live session and keeps concurrent starts apart", async () => {
    let live = "pa-cc-4 10\nother 11\n";
    const tmux: TmuxCall = async (args) => {
      if (args[0] === "list-panes") return ok(live);
      live += `${args[args.indexOf("-s") + 1]} 99\n`;
      return ok("99\n");
    };
    const spawner = setup(tmux);
    const [a, b] = await Promise.all([spawner.start({}), spawner.start({})]);
    expect([a.tmuxName, b.tmuxName]).toEqual(["pa-cc-5", "pa-cc-6"]);
  });

  it("fails clearly when the program is missing or tmux fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spawner-"));
    const missing = createSessionSpawner({
      config: { ...config, command: ["nope"] },
      cwd: "/ws",
      socketPath: path.join(dir, "s", "t.sock"),
      configDir: "/c",
      env: {},
      tmux: async () => ok(),
      resolveProgram: () => undefined,
    });
    await expect(missing.start({})).rejects.toThrow(/Program not found: nope/);
    const failing = setup(async (args) => (args[0] === "list-panes" ? ok() : { code: 1, stdout: "", stderr: "boom" }));
    await expect(failing.start({})).rejects.toThrow(/boom/);
  });

  it("kills the session when tmux reports no pane pid", async () => {
    const calls: string[][] = [];
    const spawner = setup(async (args) => {
      calls.push([...args]);
      return args[0] === "list-panes" ? { code: 1, stdout: "", stderr: "no server running on /s" } : ok("garbage\n");
    });
    await expect(spawner.start({})).rejects.toThrow(/pane pid/);
    expect(calls.at(-1)).toEqual(["kill-session", "-t", "=pa-cc-1"]);
  });

  it("does not treat a tmux failure as an empty list", async () => {
    const spawner = setup(async () => ({ code: 1, stdout: "", stderr: "protocol version mismatch" }));
    await expect(spawner.list()).rejects.toThrow(/list-panes failed/);
    await expect(spawner.start({})).rejects.toThrow(/list-panes failed/);
  });

  it("does not add --name for another program", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spawner-"));
    const calls: string[][] = [];
    const spawner = createSessionSpawner({
      config: { ...config, command: ["/bin/mycc", "--x"] },
      cwd: "/ws",
      socketPath: path.join(dir, "s", "t.sock"),
      configDir: "/c",
      env: {},
      tmux: async (args) => {
        calls.push([...args]);
        return args[0] === "list-panes" ? ok() : ok("7\n");
      },
      resolveProgram: (p) => p,
    });
    await spawner.start({ label: "x" });
    expect(calls.find((c) => c[0] === "new-session")!.slice(-2)).toEqual(["/bin/mycc", "--x"]);
  });
});

describe("spawner.stop and list", () => {
  it("ends gracefully after /exit", async () => {
    let alive = true;
    const calls: string[] = [];
    const tmux: TmuxCall = async (args) => {
      calls.push(args.join(" "));
      if (args[0] === "has-session") return { code: alive ? 0 : 1, stdout: "", stderr: "" };
      if (args[0] === "send-keys" && args.includes("Enter")) alive = false;
      return ok();
    };
    expect(await setup(tmux).stop("pa-cc-1")).toBe(true);
    expect(calls).toContain("send-keys -t =pa-cc-1: -l -- /exit");
    expect(calls).toContain("has-session -t =pa-cc-1");
    expect(calls.some((c) => c.startsWith("kill-session"))).toBe(false);
  });

  it("kills the session after the grace time", async () => {
    let alive = true;
    const calls: string[] = [];
    const tmux: TmuxCall = async (args) => {
      calls.push(args[0]!);
      if (args[0] === "kill-session") alive = false;
      if (args[0] === "has-session") return { code: alive ? 0 : 1, stdout: "", stderr: "" };
      return ok();
    };
    expect(await setup(tmux).stop("pa-cc-2")).toBe(true);
    expect(calls).toContain("kill-session");
  });

  it("refuses foreign names and lists only pa-cc sessions", async () => {
    const tmux: TmuxCall = async () => ok("pa-cc-1 5\nwork 6\npa-cc-x 7\n");
    const spawner = setup(tmux);
    await expect(spawner.stop("work")).rejects.toThrow(/Not a session/);
    expect(await spawner.list()).toEqual([{ tmuxName: "pa-cc-1", panePid: 5 }]);
  });
});
