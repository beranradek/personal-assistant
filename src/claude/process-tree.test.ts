import { describe, expect, it } from "vitest";
import { findClaudePid, isPidAlive, parseProcStat, type ProcessInfo } from "./process-tree.js";

function reader(list: ProcessInfo[]) {
  const map = new Map(list.map((p) => [p.pid, p]));
  return (pid: number) => map.get(pid);
}

describe("parseProcStat", () => {
  it("parses ppid and comm", () => {
    expect(parseProcStat(10, "10 (claude) S 5 10 10 0 -1")).toEqual({ ppid: 5, comm: "claude" });
  });

  it("handles spaces and parentheses in comm", () => {
    expect(parseProcStat(10, "10 (a (b) c) S 7 10")).toEqual({ ppid: 7, comm: "a (b) c" });
  });

  it("returns undefined for bad input", () => {
    expect(parseProcStat(10, "garbage")).toBeUndefined();
    expect(parseProcStat(10, "10 (x) S")).toBeUndefined();
  });
});

describe("findClaudePid", () => {
  it("finds the claude ancestor by comm", () => {
    const read = reader([
      { pid: 30, ppid: 20, comm: "node", cmdline: ["node", "pa"] },
      { pid: 20, ppid: 10, comm: "sh", cmdline: ["sh", "-c", "pa"] },
      { pid: 10, ppid: 1, comm: "claude", cmdline: ["claude"] },
    ]);
    expect(findClaudePid(30, read)).toBe(10);
  });

  it("finds a node process running the claude script", () => {
    const read = reader([
      { pid: 30, ppid: 20, comm: "sh", cmdline: ["sh"] },
      { pid: 20, ppid: 10, comm: "node", cmdline: ["node", "/usr/lib/node_modules/.bin/claude", "--x"] },
      { pid: 10, ppid: 1, comm: "zsh", cmdline: ["zsh"] },
    ]);
    expect(findClaudePid(30, read)).toBe(20);
  });

  it("never guesses: no claude ancestor means undefined, even with unknown parents", () => {
    const read = reader([
      { pid: 30, ppid: 20, comm: "node", cmdline: ["node"] },
      { pid: 20, ppid: 10, comm: "sh", cmdline: ["sh"] },
      { pid: 10, ppid: 2, comm: "wrapper", cmdline: ["wrapper"] },
      { pid: 2, ppid: 1, comm: "other", cmdline: ["other"] },
    ]);
    expect(findClaudePid(30, read)).toBeUndefined();
  });

  it("matches common claude installs", () => {
    const cases: string[][] = [
      ["claude", "--resume"],
      ["/home/u/.local/bin/claude"],
      ["/home/u/.local/share/claude/versions/2.1.0", "--x"],
      ["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"],
      ["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.mjs"],
      ["bun", "/opt/x/claude"],
    ];
    for (const cmdline of cases) {
      const read = reader([
        { pid: 30, ppid: 20, comm: "sh", cmdline: ["sh"] },
        { pid: 20, ppid: 1, comm: "2.1.0", cmdline },
      ]);
      expect(findClaudePid(30, read), cmdline.join(" ")).toBe(20);
    }
  });

  it("returns undefined for a headless claude run (-p, --print, --output-format)", () => {
    for (const flags of [["-p", "hi"], ["--print", "hi"], ["--output-format", "json"], ["--output-format=json"]]) {
      const read = reader([
        { pid: 30, ppid: 20, comm: "sh", cmdline: ["sh"] },
        { pid: 20, ppid: 1, comm: "claude", cmdline: ["claude", "--model", "x", ...flags] },
      ]);
      expect(findClaudePid(30, read), flags.join(" ")).toBeUndefined();
    }
    const interactive = reader([
      { pid: 30, ppid: 20, comm: "sh", cmdline: ["sh"] },
      { pid: 20, ppid: 1, comm: "claude", cmdline: ["claude", "--model", "x", "--resume"] },
    ]);
    expect(findClaudePid(30, interactive)).toBe(20);
  });

  it("never matches a terminal emulator, tmux or a shell that only mentions claude", () => {
    const cases: [string, string[]][] = [
      ["tmux: server", ["tmux", "new-session", "-d", "claude"]],
      ["gnome-terminal-", ["gnome-terminal", "--", "claude"]],
      ["kitty", ["kitty", "claude"]],
      ["bash", ["bash", "-c", "claude"]],
      ["node", ["node", "/srv/app/server.js"]],
      ["node", ["node", "/srv/app/cli.js"]],
    ];
    for (const [comm, cmdline] of cases) {
      const read = reader([{ pid: 20, ppid: 1, comm, cmdline }]);
      expect(findClaudePid(20, read), cmdline.join(" ")).toBeUndefined();
    }
  });

  it("returns undefined when only helpers exist", () => {
    const read = reader([
      { pid: 30, ppid: 20, comm: "node", cmdline: ["node"] },
      { pid: 20, ppid: 1, comm: "sh", cmdline: ["sh"] },
    ]);
    expect(findClaudePid(30, read)).toBeUndefined();
  });

  it("stops on cycles and unreadable processes", () => {
    const read = reader([
      { pid: 30, ppid: 20, comm: "sh", cmdline: [] },
      { pid: 20, ppid: 30, comm: "sh", cmdline: [] },
    ]);
    expect(findClaudePid(30, read)).toBeUndefined();
    expect(findClaudePid(99, read)).toBeUndefined();
  });
});

describe("isPidAlive", () => {
  it("is true for this process and false for an unused pid", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2 ** 22 + 12345)).toBe(false);
  });
});
