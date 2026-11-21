import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createTerminalOpener, type TerminalOpenerDeps } from "./terminal-opener.js";

function fakeSpawn(failFor: string[] = []) {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
  const spawn = vi.fn((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, env: options.env });
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    if (failFor.includes(command)) setTimeout(() => child.emit("error", new Error("ENOENT")), 1);
    return child;
  });
  return { spawn: spawn as unknown as TerminalOpenerDeps["spawn"], calls };
}

const attach = ["tmux", "-S", "/s", "attach-session", "-t", "pa-cc-1"];
const baseDeps = { config: { mode: "auto" as const }, platform: "linux" as const };

describe("terminal opener", () => {
  it("uses the first known terminal with a title", async () => {
    const { spawn, calls } = fakeSpawn();
    const opener = createTerminalOpener({
      ...baseDeps,
      env: { WAYLAND_DISPLAY: "wayland-0", PATH: "/usr/bin" },
      spawn,
      which: (c) => (c === "ghostty" || c === "xterm" ? `/usr/bin/${c}` : undefined),
    });
    const res = await opener.open({ attachArgv: attach, title: "x (pa-cc-1)" });
    expect(res).toEqual({ opened: true, detail: "ghostty" });
    expect(calls[0]).toMatchObject({ command: "/usr/bin/ghostty", args: ["--title=x (pa-cc-1)", "-e", ...attach] });
  });

  it("takes display variables from the systemd user environment when the daemon env has none", async () => {
    const { spawn, calls } = fakeSpawn();
    const opener = createTerminalOpener({
      ...baseDeps,
      env: { PATH: "/usr/bin" },
      spawn,
      which: (c) => (c === "gnome-terminal" ? "/usr/bin/gnome-terminal" : undefined),
      systemdEnvironment: async () => "WAYLAND_DISPLAY=wayland-0\nDBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus\nFOO=bar\n",
    });
    const res = await opener.open({ attachArgv: attach, title: "t" });
    expect(res.opened).toBe(true);
    expect(calls[0]!.env).toMatchObject({ WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" });
    expect(calls[0]!.env?.["FOO"]).toBeUndefined();
    expect(calls[0]!.args.slice(0, 3)).toEqual(["--title", "t", "--"]);
  });

  it("starts the terminal in its own systemd scope under systemd", async () => {
    const { spawn, calls } = fakeSpawn();
    const opener = createTerminalOpener({
      ...baseDeps,
      env: { DISPLAY: ":0", INVOCATION_ID: "abc", PATH: "/usr/bin" },
      spawn,
      which: (c) => `/usr/bin/${c}`,
    });
    await opener.open({ attachArgv: attach, title: "t" });
    expect(calls[0]!.command).toBe("systemd-run");
    expect(calls[0]!.args.slice(0, 5)).toEqual(["--user", "--scope", "--quiet", "--collect", "--"]);
  });

  it("is headless without a display, with mode none, or without a terminal", async () => {
    const { spawn } = fakeSpawn();
    const common = { platform: "linux" as const, spawn, which: () => "/usr/bin/xterm", systemdEnvironment: async () => "" };
    expect((await createTerminalOpener({ ...common, config: { mode: "auto" }, env: {} }).open({ attachArgv: attach, title: "t" })).detail).toMatch(/no display/);
    expect((await createTerminalOpener({ ...common, config: { mode: "none" }, env: { DISPLAY: ":0" } }).open({ attachArgv: attach, title: "t" })).opened).toBe(false);
    const none = createTerminalOpener({ ...common, config: { mode: "auto" }, env: { DISPLAY: ":0" }, which: () => undefined });
    expect((await none.open({ attachArgv: attach, title: "t" })).detail).toMatch(/no terminal emulator/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("tries the next terminal when a start fails", async () => {
    const { spawn, calls } = fakeSpawn(["/usr/bin/gnome-terminal"]);
    const opener = createTerminalOpener({ ...baseDeps, env: { DISPLAY: ":0" }, spawn, which: (c) => `/usr/bin/${c}` });
    const res = await opener.open({ attachArgv: attach, title: "t" });
    expect(res.detail).toBe("ghostty");
    expect(calls.map((c) => c.command)).toEqual(["/usr/bin/gnome-terminal", "/usr/bin/ghostty"]);
  });

  it("custom mode splices {attach}; darwin uses osascript", async () => {
    const a = fakeSpawn();
    const custom = createTerminalOpener({ platform: "linux", config: { mode: "custom", command: ["mine", "-x", "{attach}"] }, env: {}, spawn: a.spawn, systemdEnvironment: async () => "" });
    expect((await custom.open({ attachArgv: attach, title: "t" })).opened).toBe(true);
    expect(a.calls[0]).toMatchObject({ command: "mine", args: ["-x", ...attach] });
    const b = fakeSpawn();
    const mac = createTerminalOpener({ platform: "darwin", config: { mode: "auto" }, env: {}, spawn: b.spawn });
    expect((await mac.open({ attachArgv: ["tmux", "a b"], title: "t" })).detail).toBe("Terminal.app");
    expect(b.calls[0]!.command).toBe("osascript");
    expect(b.calls[0]!.args[1]).toContain("'a b'");
  });
});
