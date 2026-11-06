import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AssistantExitedError,
  EMPTY_VIEW_STATE,
  USER_TMUX_SUBCOMMANDS,
  applyViewLayout,
  preflightAssistantCommand,
  createAgentSessionLister,
  createRegisteredSessionLister,
  createUserTmux,
  listViewPanes,
  openAgentsView,
  parseAgentsViewArgs,
  planView,
  runViewController,
  showAgentsView,
  buildAssistantCommand,
  resolveAssistantCwd,
  resolveInteractiveShell,
  validateAssistantCommand,
  validateViewSession,
  type UserTmux,
  type UserTmuxResult,
  type ViewControllerDeps,
} from "./view.js";

const ok = (stdout = ""): UserTmuxResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "can't find window"): UserTmuxResult => ({ code: 1, stdout: "", stderr });

type Handler = (args: readonly string[]) => UserTmuxResult | undefined;

/** Fake user tmux: records calls; the first handler that answers wins, default is success with empty output. */
function fakeUser(...handlers: Handler[]): UserTmux & { calls: string[][]; attached: string[] } {
  const calls: string[][] = [];
  const attached: string[] = [];
  return {
    calls,
    attached,
    async run(args) {
      calls.push([...args]);
      for (const handler of handlers) {
        const answer = handler(args);
        if (answer) return answer;
      }
      return ok();
    },
    async attach(target) {
      attached.push(target);
      return 0;
    },
  };
}

const A = "pa-alpha-1111";
const B = "pa-beta-2222";
const sub = (calls: string[][], name: string) => calls.filter((call) => call[0] === name);

describe("validation and argument parsing", () => {
  it("accepts simple session names and rejects tmux target characters", () => {
    expect(validateViewSession("amy")).toBe("amy");
    for (const bad of ["", "a b", "a:b", "a.b", "-x", "a;b", "$(x)", "x".repeat(33), "é"]) {
      expect(() => validateViewSession(bad)).toThrow();
    }
  });

  it("validates the assistant command", () => {
    expect(validateAssistantCommand("  pa claude ")).toBe("pa claude");
    for (const bad of ["", "   ", "-x", "a;", "a\nb", "a\0b", "x".repeat(2001)]) expect(() => validateAssistantCommand(bad)).toThrow();
  });

  it("parses options with defaults", () => {
    // writable agent panes and a non-interactive assistant shell are the defaults
    expect(parseAgentsViewArgs([])).toEqual({ assistant: "pa claude", interactiveShell: false, readOnly: false, attach: true });
    expect(parseAgentsViewArgs(["--assistant", "pa terminal", "--session", "work", "--no-attach"])).toEqual({
      assistant: "pa terminal",
      interactiveShell: false,
      readOnly: false,
      session: "work",
      attach: false,
    });
    expect(parseAgentsViewArgs(["--watch", "@12"])).toMatchObject({ watch: "@12" });
  });

  it("parses --assistant-cwd, --interactive-shell (-i) and --read-only", () => {
    expect(parseAgentsViewArgs(["--assistant-cwd", "../proj"])).toMatchObject({ assistantCwd: "../proj" });
    expect(parseAgentsViewArgs(["--interactive-shell"])).toMatchObject({ interactiveShell: true });
    expect(parseAgentsViewArgs(["-i"])).toMatchObject({ interactiveShell: true });
    expect(parseAgentsViewArgs(["--read-only"])).toMatchObject({ readOnly: true });
    expect(() => parseAgentsViewArgs(["--assistant-cwd"])).toThrow(/requires a value/);
    expect(() => parseAgentsViewArgs(["--assistant-cwd", "/a\0b"])).toThrow(/NUL/);
  });

  it("rejects unknown options, missing values and bad window ids", () => {
    expect(() => parseAgentsViewArgs(["--nope"])).toThrow(/Unknown option/);
    expect(() => parseAgentsViewArgs(["--assistant"])).toThrow(/requires a value/);
    expect(() => parseAgentsViewArgs(["--session", "--no-attach"])).toThrow(/requires a value/);
    expect(() => parseAgentsViewArgs(["--watch", "12"])).toThrow(/window id/);
    expect(() => parseAgentsViewArgs(["--watch", "@1; kill-server"])).toThrow(/window id/);
  });
});

describe("assistant start directory and shell", () => {
  it("resolves --assistant-cwd to an existing absolute directory (default: the current directory)", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pa-view-cwd-")));
    try {
      fs.mkdirSync(path.join(dir, "proj"));
      fs.writeFileSync(path.join(dir, "file.txt"), "x");
      expect(resolveAssistantCwd(undefined, dir)).toBe(dir);
      expect(resolveAssistantCwd("proj", dir)).toBe(path.join(dir, "proj"));
      expect(resolveAssistantCwd("./proj/..", dir)).toBe(dir);
      expect(resolveAssistantCwd(path.join(dir, "proj"), "/")).toBe(path.join(dir, "proj"));
      expect(() => resolveAssistantCwd("missing", dir)).toThrow(/not an existing directory/);
      expect(() => resolveAssistantCwd("file.txt", dir)).toThrow(/not an existing directory/);
      expect(() => resolveAssistantCwd("a\0b", dir)).toThrow(/NUL/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses $SHELL for --interactive-shell when it is an absolute executable, else /bin/sh", () => {
    expect(resolveInteractiveShell({ SHELL: "/bin/sh" })).toBe("/bin/sh");
    expect(resolveInteractiveShell({})).toBe("/bin/sh");
    expect(resolveInteractiveShell({ SHELL: "zsh" })).toBe("/bin/sh");
    expect(resolveInteractiveShell({ SHELL: "/nonexistent/zsh" })).toBe("/bin/sh");
  });

  it("builds the assistant argv: one string for the tmux shell, or <shell> -i -c <command> without exec", () => {
    expect(buildAssistantCommand("pa claude")).toEqual(["pa claude"]);
    expect(buildAssistantCommand("myalias --flag", "/usr/bin/zsh")).toEqual(["/usr/bin/zsh", "-i", "-c", "myalias --flag"]);
  });
});

describe("user tmux runner", () => {
  it("refuses subcommands outside the allowlist and arguments ending with ';' before any process starts", async () => {
    const execFile = vi.fn();
    const user = createUserTmux({ execFile: execFile as never });
    const forbidden = [
      "kill-server", "run-shell", "pipe-pane", "source-file", "if-shell", "set-hook", "respawn-pane", "send-keys", "kill-session",
    ];
    for (const bad of forbidden) {
      await expect(user.run([bad])).rejects.toThrow(/not allowed/);
    }
    await expect(user.run(["display-message", "-p", "x;"])).rejects.toThrow(/';'/);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("uses execFile with an argv array, no shell, and the optional private socket", async () => {
    const execFile = vi.fn((_bin: string, _args: string[], _opts: object, cb: (e: null, out: string, err: string) => void) => {
      cb(null, "out", "");
      return { stdin: { end: vi.fn() } };
    });
    const user = createUserTmux({ execFile: execFile as never, socketPath: "/tmp/x.sock", env: { HOME: "/h" } });
    expect(await user.run(["list-panes", "-t", "@1"])).toEqual({ code: 0, stdout: "out", stderr: "" });
    const [binary, args, options] = execFile.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(binary).toBe("tmux");
    expect(args).toEqual(["-S", "/tmp/x.sock", "list-panes", "-t", "@1"]);
    expect(options["shell"]).toBeUndefined();
    expect(options["env"]).toEqual({ HOME: "/h" });
  });

  it("allows exactly the documented subcommands", () => {
    expect([...USER_TMUX_SUBCOMMANDS].sort()).toEqual(
      [
        "attach-session", "display-message", "has-session", "kill-window", "list-panes", "list-sessions", "list-windows",
        "new-session", "new-window", "select-layout", "select-pane", "select-window", "set-option", "split-window", "switch-client",
      ].sort(),
    );
  });
});

describe("planView", () => {
  it("adds panes for live sessions without a pane, sorted, and rejects names that do not match the pattern", () => {
    const plan = planView([B, A, "pa-bad", "other", "pa-x-1"], new Set(), EMPTY_VIEW_STATE);
    expect(plan.toAdd).toEqual([A, B]);
    expect([...plan.next.known].sort()).toEqual([A, B]);
  });

  it("does not add a pane twice", () => {
    const plan = planView([A], new Set([A]), { known: new Set([A]), dismissed: new Set() });
    expect(plan.toAdd).toEqual([]);
  });

  it("dismisses a session whose pane the user closed while it is alive, and keeps it dismissed", () => {
    const first = planView([A], new Set(), { known: new Set([A]), dismissed: new Set() });
    expect(first.toAdd).toEqual([]);
    expect([...first.next.dismissed]).toEqual([A]);
    const second = planView([A], new Set(), first.next);
    expect(second.toAdd).toEqual([]);
  });

  it("forgets ended sessions, so a new session with the same name would get a pane again", () => {
    const state = { known: new Set([A]), dismissed: new Set([B]) };
    const ended = planView([], new Set(), state);
    expect(ended.next.known.size).toBe(0);
    expect(ended.next.dismissed.size).toBe(0);
    expect(planView([A], new Set(), ended.next).toAdd).toEqual([A]);
  });

  it("treats panes that exist without prior state (controller restart) as known", () => {
    const plan = planView([A], new Set([A]), EMPTY_VIEW_STATE);
    expect(plan.toAdd).toEqual([]);
    expect([...plan.next.known]).toEqual([A]);
  });
});

describe("listViewPanes", () => {
  it("parses panes and ignores malformed agent names", async () => {
    const user = fakeUser(() => ok(`%1|1|\n%2||${A}\n%3||not-an-agent\nbroken\n`));
    expect(await listViewPanes(user, "@1")).toEqual([
      { paneId: "%1", main: true, agent: "" },
      { paneId: "%2", main: false, agent: A },
      { paneId: "%3", main: false, agent: "" },
    ]);
  });

  it("returns null when the window is gone", async () => {
    expect(await listViewPanes(fakeUser(() => fail()), "@1")).toBeNull();
  });
});

describe("preflightAssistantCommand", () => {
  let binDir: string;
  beforeAll(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-preflight-"));
    fs.writeFileSync(path.join(binDir, "mytool"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, "notexec"), "#!/bin/sh\n", { mode: 0o644 });
  });
  afterAll(() => fs.rmSync(binDir, { recursive: true, force: true }));

  it("refuses a bare command that is not on PATH (alias-like) and explains the options", () => {
    const env = { PATH: binDir };
    expect(() => preflightAssistantCommand("clauded", env)).toThrow(/"clauded" was not found on PATH/);
    expect(() => preflightAssistantCommand("clauded --flag x", env)).toThrow(/alias or a function/);
    expect(() => preflightAssistantCommand("clauded", env)).toThrow(/--interactive-shell \(-i\).*full command.*script on PATH/s);
  });

  it("refuses a file on PATH that is not executable", () => {
    expect(() => preflightAssistantCommand("notexec", { PATH: binDir })).toThrow(/not found on PATH/);
  });

  it("passes a command that is found on PATH, with arguments", () => {
    expect(() => preflightAssistantCommand("mytool", { PATH: binDir })).not.toThrow();
    expect(() => preflightAssistantCommand("  mytool --flag  x ", { PATH: binDir })).not.toThrow();
  });

  it("skips what it cannot judge: shell syntax, paths, assignments and shell builtins", () => {
    const env = { PATH: binDir };
    for (const command of [
      "nothere | mytool", "nothere && mytool", "nothere; mytool", "cd /tmp && nothere", "$(nothere)", "echo `nothere`", "nothere > out",
      "nothere \"quoted\"", "nothere 'quoted'", "~/bin/nothere", "./nothere", "/opt/x/nothere", "FOO=1 nothere", "exec nothere", "cd /tmp",
    ]) {
      expect(() => preflightAssistantCommand(command, env), command).not.toThrow();
    }
  });

  it("treats a missing or empty PATH as not found", () => {
    expect(() => preflightAssistantCommand("mytool", {})).toThrow(/not found on PATH/);
  });
});

describe("openAgentsView", () => {
  const ctlArgv = (id: string) => ["node", "pa.js", "agents-view", "--watch", id];
  const baseOptions = { assistant: "pa claude", assistantCwd: "/home/u/proj", insideTmux: false, controllerArgv: ctlArgv };

  it("creates session, window options, controller window and layout when the session is missing", async () => {
    const user = fakeUser((args) => {
      if (args[0] === "has-session") return fail("can't find session");
      if (args[0] === "new-session") return ok("@5|%9\n");
      if (args[0] === "list-windows") return ok("@5|1|\n");
      if (args[0] === "new-window") return ok("@6\n");
      return undefined;
    });
    const view = await openAgentsView(user, baseOptions);
    expect(view).toEqual({ windowId: "@5", sessionTarget: "=amy", created: true, mode: "session", warnings: [] });
    const create = sub(user.calls, "new-session")[0]!;
    // the assistant pane starts in assistantCwd (-c); the controller window and the agent panes get no -c
    expect(create).toEqual(
      ["new-session", "-d", "-s", "amy", "-n", "amy", "-c", "/home/u/proj", "-P", "-F", "#{window_id}|#{pane_id}", "--", "pa claude"],
    );
    expect(user.calls.filter((call) => call.includes("-c"))).toHaveLength(1);
    // the view window and the assistant pane are tagged FIRST, then the window options
    const options = sub(user.calls, "set-option");
    expect(options.slice(0, 2)).toEqual([
      ["set-option", "-w", "-t", "@5", "@pa_view", "1"],
      ["set-option", "-p", "-t", "%9", "@pa_main", "1"],
    ]);
    expect(user.calls).toContainEqual(["set-option", "-w", "-t", "@5", "remain-on-exit", "off"]);
    expect(user.calls).toContainEqual(["set-option", "-w", "-t", "@5", "main-pane-width", "50%"]);
    // the controller window is named after the view window id and tagged with it
    expect(user.calls).toContainEqual(
      ["new-window", "-d", "-t", "=amy:", "-n", "amy-ctl-5", "-P", "-F", "#{window_id}", "--", ...ctlArgv("@5")],
    );
    expect(user.calls).toContainEqual(["set-option", "-w", "-t", "@6", "@pa_ctl", "@5"]);
    expect(user.calls.at(-1)).toEqual(["select-layout", "-t", "@5", "main-vertical"]);
  });

  it("is idempotent: an existing session with a tagged view and controller window is reused and nothing is created", async () => {
    const user = fakeUser((args) => {
      if (args[0] === "list-windows") return ok("@5|1|\n@6||@5\n");
      return undefined;
    });
    const view = await openAgentsView(user, baseOptions);
    expect(view).toMatchObject({ windowId: "@5", created: false });
    expect(sub(user.calls, "new-session")).toHaveLength(0);
    expect(sub(user.calls, "new-window")).toHaveLength(0);
    expect(sub(user.calls, "set-option")).toHaveLength(0);
  });

  it("never reuses an untagged window of the user that is named like the view, and creates its own", async () => {
    const user = fakeUser((args) => {
      if (args[0] === "list-windows") return ok("@2||\n");
      if (args[0] === "new-window" && args.includes("amy")) return ok("@9|%13\n");
      if (args[0] === "new-window") return ok("@10\n");
      return undefined;
    });
    const view = await openAgentsView(user, baseOptions);
    expect(view).toMatchObject({ windowId: "@9", created: true });
    expect(user.calls).toContainEqual(["set-option", "-w", "-t", "@9", "@pa_view", "1"]);
    expect(sub(user.calls, "kill-window")).toHaveLength(0);
  });

  it("starts a new controller when the old one belongs to another view window", async () => {
    const user = fakeUser((args) => {
      if (args[0] === "list-windows") return ok("@5|1|\n@6||@4\n");
      if (args[0] === "new-window") return ok("@7\n");
      return undefined;
    });
    await openAgentsView(user, baseOptions);
    expect(user.calls).toContainEqual(["set-option", "-w", "-t", "@7", "@pa_ctl", "@5"]);
  });

  it("removes a half configured view window when configuring fails, so a rerun starts clean", async () => {
    const user = fakeUser((args) => {
      if (args[0] === "has-session") return fail("can't find session");
      if (args[0] === "new-session") return ok("@5|%9\n");
      if (args[0] === "set-option" && args[4] === "pane-border-status") return fail("bad option");
      return undefined;
    });
    await expect(openAgentsView(user, baseOptions)).rejects.toThrow(/set-option failed: bad option/);
    expect(user.calls).toContainEqual(["kill-window", "-t", "@5"]);
    expect(sub(user.calls, "new-window")).toHaveLength(0);
  });

  it("removes the controller window when it cannot be tagged", async () => {
    const user = fakeUser((args) => {
      if (args[0] === "list-windows") return ok("@5|1|\n");
      if (args[0] === "new-window") return ok("@6\n");
      if (args[0] === "set-option" && args[4] === "@pa_ctl") return fail("nope");
      return undefined;
    });
    await expect(openAgentsView(user, baseOptions)).rejects.toThrow(/set-option failed: nope/);
    expect(user.calls).toContainEqual(["kill-window", "-t", "@6"]);
  });

  it("only notes (does not fail) when this tmux rejects a percentage main-pane-width", async () => {
    const user = fakeUser((args) => {
      if (args[0] === "has-session") return fail("can't find session");
      if (args[0] === "new-session") return ok("@5|%9\n");
      if (args[0] === "list-windows") return ok("@5|1|\n");
      if (args[0] === "new-window") return ok("@6\n");
      if (args[0] === "set-option" && args[4] === "main-pane-width") return fail("value is invalid: 50%");
      return undefined;
    });
    const view = await openAgentsView(user, baseOptions);
    expect(view.warnings).toEqual([expect.stringContaining("needs tmux 3.3+")]);
    expect(view.created).toBe(true);
  });

  it("adds the view window to an existing session that lacks it", async () => {
    const user = fakeUser((args) => {
      if (args[0] === "list-windows") return ok("@1||\n");
      if (args[0] === "new-window" && args.includes("amy")) return ok("@7|%11\n");
      if (args[0] === "new-window") return ok("@12\n");
      return undefined;
    });
    const view = await openAgentsView(user, { ...baseOptions, session: "work" });
    expect(view).toMatchObject({ windowId: "@7", sessionTarget: "=work", created: true });
    expect(user.calls).toContainEqual(
      ["new-window", "-d", "-t", "=work:", "-n", "amy", "-c", "/home/u/proj", "-P", "-F", "#{window_id}|#{pane_id}", "--", "pa claude"],
    );
  });

  it("runs the assistant command through an interactive shell as separate argv elements when asked", async () => {
    const user = fakeUser((args) => {
      if (args[0] === "has-session") return fail("can't find session");
      if (args[0] === "new-session") return ok("@5|%9\n");
      if (args[0] === "list-windows") return ok("@5|1|\n");
      if (args[0] === "new-window") return ok("@6\n");
      return undefined;
    });
    await openAgentsView(user, { ...baseOptions, assistant: "clauded --flag", interactiveShell: "/usr/bin/zsh" });
    expect(sub(user.calls, "new-session")[0]!.slice(-5)).toEqual(["--", "/usr/bin/zsh", "-i", "-c", "clauded --flag"]);
  });

  it("inside tmux without a session name it uses a window of the current session", async () => {
    const user = fakeUser((args) => {
      if (args[0] === "display-message") return ok("$3\n");
      if (args[0] === "list-windows") return ok("@1||\n");
      if (args[0] === "new-window" && args.includes("amy")) return ok("@8|%12\n");
      if (args[0] === "new-window") return ok("@13\n");
      return undefined;
    });
    const view = await openAgentsView(user, { ...baseOptions, insideTmux: true });
    expect(view).toEqual({ windowId: "@8", sessionTarget: "$3", created: true, mode: "window", warnings: [] });
    expect(sub(user.calls, "has-session")).toHaveLength(0);
    expect(user.calls).toContainEqual(
      ["new-window", "-d", "-t", "$3:", "-n", "amy-ctl-8", "-P", "-F", "#{window_id}", "--", ...ctlArgv("@8")],
    );
  });

  it("fails when tmux returns no usable window id", async () => {
    const user = fakeUser((args) => (args[0] === "has-session" ? fail() : args[0] === "new-session" ? ok("garbage\n") : undefined));
    await expect(openAgentsView(user, baseOptions)).rejects.toThrow(/window id/);
  });

  it("surfaces tmux failures", async () => {
    const user = fakeUser((args) => (args[0] === "has-session" ? fail() : args[0] === "new-session" ? fail("boom") : undefined));
    await expect(openAgentsView(user, baseOptions)).rejects.toThrow(/new-session failed: boom/);
  });

  describe("an assistant command that exits at once", () => {
    const gone = "no server running on /tmp/tmux-1000/default";

    it("is reported clearly (not as a raw tmux error) when the window is gone while configuring", async () => {
      const user = fakeUser((args) => {
        if (args[0] === "has-session") return fail("can't find session");
        if (args[0] === "new-session") return ok("@5|%9\n");
        if (args[0] === "set-option" || args[0] === "list-panes") return fail(gone);
        return undefined;
      });
      const err = await openAgentsView(user, baseOptions).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AssistantExitedError);
      expect((err as Error).message).toMatch(/exited immediately.*--interactive-shell \(-i\)/s);
      expect((err as Error).message).not.toMatch(/no server running|set-option/);
      // the probe asked tmux whether the view window is still there
      expect(user.calls).toContainEqual(["list-panes", "-t", "@5", "-F", "#{pane_id}"]);
    });

    it("removes the view and controller windows it created when the window vanishes before the layout", async () => {
      const user = fakeUser((args) => {
        if (args[0] === "has-session") return fail("can't find session");
        if (args[0] === "new-session") return ok("@5|%9\n");
        if (args[0] === "list-windows") return ok("@5|1|\n");
        if (args[0] === "new-window") return ok("@6\n");
        if (args[0] === "select-layout" || args[0] === "list-panes") return fail(gone);
        return undefined;
      });
      await expect(openAgentsView(user, baseOptions)).rejects.toBeInstanceOf(AssistantExitedError);
      expect(user.calls).toContainEqual(["kill-window", "-t", "@5"]);
      expect(user.calls).toContainEqual(["kill-window", "-t", "@6"]);
    });

    it("keeps the original tmux error when the window is still there", async () => {
      const user = fakeUser((args) => {
        if (args[0] === "has-session") return fail("can't find session");
        if (args[0] === "new-session") return ok("@5|%9\n");
        if (args[0] === "set-option") return fail("bad option");
        return undefined;
      });
      const err = await openAgentsView(user, baseOptions).catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(AssistantExitedError);
      expect((err as Error).message).toMatch(/set-option failed: bad option/);
    });
  });
});

describe("showAgentsView", () => {
  const view = { windowId: "@5", sessionTarget: "=amy", created: false, mode: "session" as const, warnings: [] };

  it("attaches outside tmux and switches the client inside tmux", async () => {
    const outside = fakeUser();
    await showAgentsView(outside, view, false);
    expect(outside.attached).toEqual(["=amy"]);
    expect(outside.calls).toContainEqual(["select-window", "-t", "@5"]);

    const inside = fakeUser();
    await showAgentsView(inside, view, true);
    expect(inside.attached).toEqual([]);
    expect(inside.calls).toContainEqual(["switch-client", "-t", "=amy"]);
  });

  it("only selects the window in window mode", async () => {
    const user = fakeUser();
    await showAgentsView(user, { ...view, mode: "window" }, true);
    expect(user.calls.map((call) => call[0])).toEqual(["select-window"]);
  });

  describe("an assistant that exited after the view was created", () => {
    const gone = "no server running on /tmp/tmux-1000/default";

    it("is reported clearly when selecting the window fails and the window is gone", async () => {
      const user = fakeUser((args) => (args[0] === "select-window" || args[0] === "list-panes" ? fail(gone) : undefined));
      await expect(showAgentsView(user, view, false)).rejects.toBeInstanceOf(AssistantExitedError);
      expect(user.attached).toEqual([]);
    });

    it("keeps the tmux error when selecting fails but the window is still there", async () => {
      const user = fakeUser((args) => (args[0] === "select-window" ? fail("some other problem") : undefined));
      await expect(showAgentsView(user, view, false)).rejects.toThrow(/select-window failed: some other problem/);
    });

    it("is reported clearly when attach fails and the window is gone", async () => {
      const user = fakeUser((args) => (args[0] === "list-panes" ? fail(gone) : undefined));
      user.attach = async () => 1;
      await expect(showAgentsView(user, view, false)).rejects.toBeInstanceOf(AssistantExitedError);
    });

    it("passes a failing attach code on when the window is still there", async () => {
      const user = fakeUser();
      user.attach = async () => 3;
      expect(await showAgentsView(user, view, false)).toBe(3);
    });
  });
});

describe("createAgentSessionLister", () => {
  it("returns only matching session names, [] without a server, and throws on other errors", async () => {
    const run = vi.fn();
    const list = createAgentSessionLister({ run });
    run.mockResolvedValueOnce({ code: 0, stdout: `${A}\nfoo\n${B}\n`, stderr: "", noServer: false });
    expect(await list()).toEqual([A, B]);
    run.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "no server running", noServer: true });
    expect(await list()).toEqual([]);
    run.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "weird", noServer: false });
    await expect(list()).rejects.toThrow(/list-sessions failed/);
    expect(run.mock.calls[0]![0]).toEqual(["list-sessions", "-F", "#{session_name}"]);
  });
});

describe("createRegisteredSessionLister", () => {
  const record = (name: string, state: string) => ({ name, state });
  const registry = (records: ReturnType<typeof record>[], corrupt = false) =>
    ({ read: vi.fn(async () => ({ records, corrupt })) }) as unknown as Parameters<typeof createRegisteredSessionLister>[1];

  it("keeps only live sessions that are running records, never a foreign pa- session", async () => {
    const list = createRegisteredSessionLister(async () => [A, B, "pa-foreign-3333"], registry([record(A, "running"), record(B, "stopped")]));
    expect(await list()).toEqual([A]);
  });

  it("shows nothing with an empty or corrupt registry, and does not read the registry without live sessions", async () => {
    expect(await createRegisteredSessionLister(async () => [A], registry([], true))()).toEqual([]);
    const reg = registry([record(A, "running")]);
    expect(await createRegisteredSessionLister(async () => [], reg)()).toEqual([]);
    expect((reg as unknown as { read: ReturnType<typeof vi.fn> }).read).not.toHaveBeenCalled();
  });

  it("lets a registry read error through, so that the controller counts it as a failed tick", async () => {
    const reg = { read: async () => { throw new Error("EACCES"); } } as unknown as Parameters<typeof createRegisteredSessionLister>[1];
    await expect(createRegisteredSessionLister(async () => [A], reg)()).rejects.toThrow(/EACCES/);
  });
});

describe("runViewController", () => {
  /** Scripted world: `panes` is mutated by split-window/kill, `live` by the test. */
  function world(initialLive: string[] = []) {
    const state = {
      live: initialLive,
      panes: [{ paneId: "%1", main: true, agent: "" }],
      next: 2,
      windowAlive: true,
      failLive: false,
      /** Value of the window option `@pa_view` (the controller kills only a tagged window). */
      viewTag: "1",
      /** Sessions for which `split-window` fails (no space for a new pane). */
      noSpaceFor: [] as string[],
    };
    const user = fakeUser((args) => {
      if (args[0] === "list-panes") {
        if (!state.windowAlive) return fail();
        return ok(state.panes.map((pane) => `${pane.paneId}|${pane.main ? "1" : ""}|${pane.agent}`).join("\n"));
      }
      if (args[0] === "display-message") return ok(`${state.viewTag}\n`);
      if (args[0] === "split-window") {
        if (state.noSpaceFor.some((name) => args.includes(`=${name}`))) return fail("no space for new pane");
        const paneId = `%${state.next++}`;
        state.panes.push({ paneId, main: false, agent: "" });
        return ok(`${paneId}\n`);
      }
      if (args[0] === "set-option" && args[4] === "@pa_agent") {
        const pane = state.panes.find((candidate) => candidate.paneId === args[3]);
        if (!pane) return fail("can't find pane");
        pane.agent = args[5]!;
        return ok();
      }
      return undefined;
    });
    const controller = new AbortController();
    let tick = 0;
    const base = (script: (tick: number) => void): ViewControllerDeps => ({
      user,
      listAgentSessions: async () => {
        if (state.failLive) throw new Error("agents server error");
        return [...state.live];
      },
      tmuxBinary: "tmux",
      agentSocketPath: "/tmp/agents.sock",
      windowId: "@5",
      signal: controller.signal,
      pollMs: 1,
      sleep: async () => {
        script(++tick);
      },
    });
    return { state, user, controller, base };
  }

  it("adds a pane per live session with a WRITABLE nested attach, tags it, and applies the layout once per change", async () => {
    const w = world([A, B]);
    const end = await runViewController(w.base((tick) => { if (tick >= 2) w.controller.abort(); }));
    expect(end).toBe("aborted");
    const splits = sub(w.user.calls, "split-window");
    expect(splits).toHaveLength(2);
    expect(splits[0]).toEqual([
      "split-window", "-d", "-t", "@5", "-P", "-F", "#{pane_id}", "--",
      "env", "-u", "TMUX", "tmux", "-u", "-S", "/tmp/agents.sock", "attach-session", "-t", `=${A}`,
    ]);
    expect(w.state.panes.map((pane) => pane.agent)).toEqual(["", A, B]);
    expect(sub(w.user.calls, "select-layout")).toHaveLength(1);
    // no -c for agent panes, and the agents server options are never touched
    expect(w.user.calls.some((call) => call.includes("-c"))).toBe(false);
  });

  it("attaches read-only (-r) with readOnly", async () => {
    const w = world([A]);
    await runViewController({ ...w.base((tick) => { if (tick >= 1) w.controller.abort(); }), readOnly: true });
    expect(sub(w.user.calls, "split-window")[0]).toEqual([
      "split-window", "-d", "-t", "@5", "-P", "-F", "#{pane_id}", "--",
      "env", "-u", "TMUX", "tmux", "-u", "-S", "/tmp/agents.sock", "attach-session", "-r", "-t", `=${A}`,
    ]);
  });

  it("follows sessions that appear and disappear, re-applying the layout when the pane count changes", async () => {
    const w = world();
    const end = await runViewController(
      w.base((tick) => {
        if (tick === 1) w.state.live = [A];
        if (tick === 2) w.state.live = [A, B];
        if (tick === 3) { // A ended: its nested attach exited, the pane closed
          w.state.live = [B];
          w.state.panes = w.state.panes.filter((pane) => pane.agent !== A);
        }
        if (tick === 4) w.controller.abort();
      }),
    );
    expect(end).toBe("aborted");
    expect(sub(w.user.calls, "split-window")).toHaveLength(2);
    expect(w.state.panes.map((pane) => pane.agent)).toEqual(["", B]);
    // initial (1 pane), +A, +B, -A
    expect(sub(w.user.calls, "select-layout")).toHaveLength(4);
  });

  it("does not re-add a pane that the user closed while the session lives", async () => {
    const w = world([A]);
    await runViewController(
      w.base((tick) => {
        if (tick === 1) w.state.panes = w.state.panes.filter((pane) => pane.agent !== A);
        if (tick === 3) w.controller.abort();
      }),
    );
    expect(sub(w.user.calls, "split-window")).toHaveLength(1);
  });

  it("does not add duplicates for panes that already exist (controller restart)", async () => {
    const w = world([A]);
    w.state.panes.push({ paneId: "%7", main: false, agent: A });
    await runViewController(w.base((tick) => { if (tick >= 2) w.controller.abort(); }));
    expect(sub(w.user.calls, "split-window")).toHaveLength(0);
  });

  it("copes with an agents server that is not running (no sessions)", async () => {
    const w = world([]);
    const end = await runViewController(w.base((tick) => { if (tick >= 3) w.controller.abort(); }));
    expect(end).toBe("aborted");
    expect(sub(w.user.calls, "split-window")).toHaveLength(0);
  });

  it("tolerates a vanished new pane (tagging fails) without failing the loop", async () => {
    const w = world([A]);
    const onError = vi.fn();
    const deps = w.base((tick) => { if (tick >= 1) w.controller.abort(); });
    const original = w.user.run.bind(w.user);
    w.user.run = async (args) => {
      if (args[0] === "set-option" && args[4] === "@pa_agent") { w.user.calls.push([...args]); return fail("can't find pane"); }
      return original(args);
    };
    expect(await runViewController({ ...deps, onError })).toBe("aborted");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("ends with window-gone when the window or the tmux server is gone", async () => {
    const w = world();
    w.state.windowAlive = false;
    expect(await runViewController(w.base(() => {}))).toBe("window-gone");
  });

  it("kills the TAGGED view window and ends when the assistant pane is gone", async () => {
    const w = world([A]);
    w.state.panes = [{ paneId: "%2", main: false, agent: A }];
    w.state.viewTag = "1";
    expect(await runViewController(w.base(() => {}))).toBe("assistant-gone");
    expect(w.user.calls).toContainEqual(["kill-window", "-t", "@5"]);
  });

  it("never kills a window that is not tagged as the view", async () => {
    const w = world([A]);
    w.state.panes = [{ paneId: "%2", main: false, agent: A }];
    w.state.viewTag = "";
    expect(await runViewController(w.base(() => {}))).toBe("assistant-gone");
    expect(sub(w.user.calls, "kill-window")).toHaveLength(0);
  });

  it("gives up after repeated failures to LIST and reports each error", async () => {
    const w = world();
    w.state.failLive = true;
    const onError = vi.fn();
    expect(await runViewController({ ...w.base(() => {}), onError })).toBe("tmux-unreachable");
    expect(onError).toHaveBeenCalledTimes(5);
  });

  it("one session without room for a pane does not block the others or stop the controller, and is retried with backoff", async () => {
    const w = world([A, B]);
    const onError = vi.fn();
    w.state.noSpaceFor = [A];
    const split = (): number => w.user.calls.filter((call) => call[0] === "split-window" && call.includes(`=${A}`)).length;
    const end = await runViewController({
      ...w.base((tick) => {
        if (tick === 6) w.state.noSpaceFor = [];
        if (tick >= 30) w.controller.abort();
      }),
      onError,
    });
    expect(end).toBe("aborted");
    // B got its pane at once; A failed (reported, not counted toward giving up), then succeeded after the backoff
    expect(w.state.panes.map((pane) => pane.agent).sort()).toEqual(["", A, B]);
    expect(onError).toHaveBeenCalled();
    // not retried on every tick: the delay doubles (2, 4, ...), so far fewer attempts than ticks
    expect(split()).toBeLessThan(8);
  });

  it("does not treat a failed add as a pane the user closed (no dismissal)", async () => {
    const w = world([A]);
    w.state.noSpaceFor = [A];
    await runViewController({
      ...w.base((tick) => {
        if (tick === 2) w.state.noSpaceFor = [];
        if (tick >= 12) w.controller.abort();
      }),
      onError: () => {},
    });
    expect(w.state.panes.some((pane) => pane.agent === A)).toBe(true);
  });

  it("reports a failing layout call but keeps running", async () => {
    const w = world([A]);
    const onError = vi.fn();
    const original = w.user.run.bind(w.user);
    w.user.run = async (args) => (args[0] === "select-layout" ? fail("layout failed") : original(args));
    const end = await runViewController({ ...w.base((tick) => { if (tick >= 2) w.controller.abort(); }), onError });
    expect(end).toBe("aborted");
    expect(onError).toHaveBeenCalled();
  });

  it("recovers from a transient failure", async () => {
    const w = world([A]);
    w.state.failLive = true;
    const end = await runViewController(
      w.base((tick) => {
        if (tick === 2) w.state.failLive = false;
        if (tick === 4) w.controller.abort();
      }),
    );
    expect(end).toBe("aborted");
    expect(sub(w.user.calls, "split-window")).toHaveLength(1);
  });

  it("stops at once when aborted, with the default abortable sleep and no timer left", async () => {
    const w = world();
    const deps = { ...w.base(() => {}), sleep: undefined, pollMs: 60_000 };
    const promise = runViewController(deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    w.controller.abort();
    expect(await promise).toBe("aborted");
  });
});

describe("applyViewLayout", () => {
  it("selects main-vertical", async () => {
    const user = fakeUser();
    await applyViewLayout(user, "@3");
    expect(user.calls).toEqual([["select-layout", "-t", "@3", "main-vertical"]]);
  });

  it("throws when tmux fails", async () => {
    await expect(applyViewLayout(fakeUser(() => fail("nope")), "@3")).rejects.toThrow(/select-layout failed: nope/);
  });
});
