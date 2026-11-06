/**
 * Integration test of `pa agents-view` with REAL tmux: two private servers (the "user" tmux and the agents' tmux), a fake agent,
 * and the controller loop running in this process. Skipped when tmux is missing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { createTmuxRunner } from "./runner.js";
import {
  createAgentSessionLister,
  createUserTmux,
  listViewPanes,
  openAgentsView,
  runViewController,
  type UserTmux,
  type ViewControllerEnd,
} from "./view.js";

const run = promisify(execFile);
const tmuxAvailable = spawnSync("tmux", ["-V"]).status === 0;
const FAKE_AGENT = new URL("./fixtures/fake-agent.mjs", import.meta.url).pathname;
const which = (name: string): string | undefined => {
  const result = spawnSync("which", [name]);
  return result.status === 0 ? result.stdout.toString().trim() : undefined;
};

const SESSION_A = "pa-alpha-1111";
const SESSION_B = "pa-beta-2222";
const SESSION_C = "pa-gamma-3333";

async function waitFor<T>(fn: () => Promise<T | undefined | false>, what: string, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Raw = { stdout?: string; stderr?: string };

/** Two private tmux servers (user and agents) in a temp dir, with raw helpers, and the view plus controller on top. */
class Harness {
  readonly base = fs.realpathSync(fs.mkdtempSync("/tmp/pa-view-"));
  readonly userSock = path.join(this.base, "user.sock");
  readonly agentsSock = path.join(this.base, "agents.sock");
  readonly user: UserTmux;
  windowId = "";
  private controller = new AbortController();
  private ended?: Promise<ViewControllerEnd>;

  constructor(env?: NodeJS.ProcessEnv) {
    this.user = createUserTmux({ socketPath: this.userSock, configFile: "/dev/null", env });
  }

  private raw(sock: string, args: string[]) {
    return run("tmux", ["-f", "/dev/null", "-S", sock, ...args]).catch((err: Raw) => err);
  }
  userRaw = (...args: string[]) => this.raw(this.userSock, args);
  agentsRaw = (...args: string[]) => this.raw(this.agentsSock, args);

  /** True when the agents server has the session (`run` rejects on a non-zero exit). */
  agentAlive = (name: string) =>
    run("tmux", ["-f", "/dev/null", "-S", this.agentsSock, "has-session", "-t", `=${name}`]).then(
      () => true,
      () => false,
    );

  startAgent = (name: string, size = "100x30") => {
    const [x, y] = size.split("x") as [string, string];
    const messageLog = path.join(this.base, "messages.jsonl");
    return this.agentsRaw("new-session", "-d", "-s", name, "-x", x, "-y", y, "--", "node", FAKE_AGENT, messageLog, "600");
  };

  /** Screen text of the agent session (the agents server is read directly). */
  agentScreen = async (name: string) => {
    const paneId = ((await this.agentsRaw("list-panes", "-t", `=${name}`, "-F", "#{pane_id}")).stdout ?? "").trim();
    return (await this.agentsRaw("capture-pane", "-p", "-t", paneId)).stdout ?? "";
  };

  panes = async () => (await listViewPanes(this.user, this.windowId)) ?? [];
  agentPane = async (session: string) => (await this.panes()).find((pane) => pane.agent === session);
  geometry = async () => {
    const format = "#{pane_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{@pa_agent}";
    const out = (await this.userRaw("list-panes", "-t", this.windowId, "-F", format)).stdout ?? "";
    return out
      .trim()
      .split("\n")
      .map((line) => {
        const [paneId, left, top, width, height, agent] = line.split("|");
        return { paneId: paneId!, left: Number(left), top: Number(top), width: Number(width), height: Number(height), agent: agent ?? "" };
      });
  };

  /** Open the view (`sleep` stands in for the hidden controller window) and optionally run the controller in-process. */
  async open(options: { assistant: string; assistantCwd?: string; interactiveShell?: string; readOnly?: boolean; controller?: boolean }) {
    const view = await openAgentsView(this.user, {
      session: "viewtest",
      assistant: options.assistant,
      assistantCwd: options.assistantCwd ?? this.base,
      interactiveShell: options.interactiveShell,
      insideTmux: false,
      controllerArgv: () => ["sleep", "600"],
    });
    this.windowId = view.windowId;
    if (options.controller !== false) {
      const agentsRunner = createTmuxRunner({ tmuxBinary: "tmux", socketPath: this.agentsSock, envAllowlist: [] });
      this.ended = runViewController({
        user: this.user,
        listAgentSessions: createAgentSessionLister(agentsRunner),
        tmuxBinary: "tmux",
        agentSocketPath: this.agentsSock,
        readOnly: options.readOnly,
        windowId: this.windowId,
        signal: this.controller.signal,
        pollMs: 200,
      });
    }
    return view;
  }

  get controllerEnd(): Promise<ViewControllerEnd> {
    return this.ended!;
  }

  async cleanup() {
    this.controller.abort();
    await this.ended;
    await this.userRaw("kill-server");
    await this.agentsRaw("kill-server");
    for (const sock of [this.userSock, this.agentsSock]) {
      const after = await run("tmux", ["-S", sock, "list-sessions"]).catch((err: { stderr?: string }) => err);
      expect(`${(after as { stderr?: string }).stderr ?? ""}`).toMatch(/no server running|error connecting/);
    }
    fs.rmSync(this.base, { recursive: true, force: true });
    expect(fs.existsSync(this.base)).toBe(false);
  }
}

describe.skipIf(!tmuxAvailable)("agents view (real tmux, two private servers, writable panes)", { timeout: 60_000 }, () => {
  let h: Harness;
  let workDir: string;
  let globalWindowSize: string;

  beforeAll(async () => {
    h = new Harness();
    workDir = path.join(h.base, "work");
    fs.mkdirSync(workDir);
    await h.open({ assistant: `pwd > ${h.base}/pwd.txt; sleep 600`, assistantCwd: workDir });
  });
  afterAll(() => h.cleanup());

  it("creates the view idempotently: assistant pane marked, controller window present", async () => {
    expect(await h.panes()).toEqual([{ paneId: expect.stringMatching(/^%\d+$/), main: true, agent: "" }]);
    const windows = (await h.userRaw("list-windows", "-t", "=viewtest", "-F", "#{window_name}")).stdout ?? "";
    expect(windows.trim().split("\n").sort()).toEqual(["amy", "amy-ctl"]);

    const again = await h.open({ assistant: "sleep 600", assistantCwd: workDir, controller: false });
    expect(again).toMatchObject({ windowId: h.windowId, created: false });
    expect((await h.panes()).length).toBe(1);
  });

  it("starts the assistant pane (and only that pane) in --assistant-cwd", async () => {
    const file = path.join(h.base, "pwd.txt");
    await waitFor(async () => fs.existsSync(file) && fs.readFileSync(file, "utf8").trim() !== "", "assistant pwd");
    expect(fs.readFileSync(file, "utf8").trim()).toBe(workDir);
  });

  it("adds a writable pane when an agent session starts, with the assistant on the left", async () => {
    await h.startAgent(SESSION_A);
    // the agents server exists now: remember its global window-size policy to prove later that the view never changes it
    globalWindowSize = ((await h.agentsRaw("show-options", "-gv", "window-size")).stdout ?? "").trim();
    expect(globalWindowSize).not.toBe("");
    const pane = await waitFor(() => h.agentPane(SESSION_A), "pane for session A");
    const geo = await h.geometry();
    const main = geo.find((entry) => entry.agent === "")!;
    const agent = geo.find((entry) => entry.paneId === pane.paneId)!;
    expect(main.left).toBe(0);
    expect(agent.left).toBeGreaterThan(0);
    expect(Math.abs(main.width - agent.width)).toBeLessThanOrEqual(2); // about 50% / 50%

    // the pane border labels name the agent session and the assistant pane
    const label = async (paneId: string) =>
      ((await h.userRaw("display-message", "-p", "-t", paneId, "#{T:pane-border-format}")).stdout ?? "").trim();
    expect(await label(pane.paneId)).toBe(SESSION_A);
    expect(await label(main.paneId)).toBe("assistant");

    // the pane shows the agent screen through a nested attach
    const mirrored = async () => ((await h.userRaw("capture-pane", "-p", "-t", pane.paneId)).stdout ?? "").includes("? for shortcuts");
    await waitFor(mirrored, "mirrored screen");

    // the client is writable, and keys typed in the view pane reach the agent
    const flags = ((await h.agentsRaw("list-clients", "-t", `=${SESSION_A}`, "-F", "#{client_readonly}")).stdout ?? "").trim();
    expect(flags).toBe("0");
    await h.userRaw("send-keys", "-t", pane.paneId, "-l", "typed-into-agent");
    await waitFor(async () => (await h.agentScreen(SESSION_A)).includes("typed-into-agent"), "typed text in the agent");
  });

  it("keeps the agent window valid with a second client; the agents server options are not changed", async () => {
    // second client of the same agent session in another user window (default window-size policy: the latest client wins)
    await h.userRaw("new-window", "-d", "-t", "=viewtest:", "-n", "second", "--",
      "env", "-u", "TMUX", "tmux", "-u", "-S", h.agentsSock, "attach-session", "-t", `=${SESSION_A}`);
    await h.userRaw("select-window", "-t", "=viewtest:second");
    const windowSize = async () => {
      const format = "#{window_width}x#{window_height}";
      const out = ((await h.agentsRaw("list-windows", "-t", `=${SESSION_A}`, "-F", format)).stdout ?? "").trim();
      const [w, hgt] = out.split("x").map(Number);
      return { w: w!, h: hgt! };
    };
    const clientCount = async () => ((await h.agentsRaw("list-clients", "-t", `=${SESSION_A}`)).stdout ?? "").trim().split("\n").length;
    await waitFor(async () => (await clientCount()) === 2, "two clients");
    const size = await windowSize();
    expect(size.w).toBeGreaterThan(10);
    expect(size.h).toBeGreaterThan(5);
    // the fake agent is still alive and answers while two clients are attached
    await h.userRaw("send-keys", "-t", (await h.agentPane(SESSION_A))!.paneId, "Enter");
    await h.userRaw("kill-window", "-t", "=viewtest:second");
    expect(await h.agentAlive(SESSION_A)).toBe(true);
    expect(((await h.agentsRaw("show-options", "-gv", "window-size")).stdout ?? "").trim()).toBe(globalWindowSize);
    await h.userRaw("select-window", "-t", h.windowId);
  });

  it("stacks further agents under each other on the right", async () => {
    await h.startAgent(SESSION_B);
    await waitFor(() => h.agentPane(SESSION_B), "pane for session B");
    const geo = await h.geometry();
    const agents = geo.filter((entry) => entry.agent !== "");
    expect(agents).toHaveLength(2);
    expect(agents[0]!.left).toBe(agents[1]!.left);
    expect(agents[0]!.top).not.toBe(agents[1]!.top);
    expect(geo.find((entry) => entry.agent === "")!.left).toBe(0);
  });

  it("removes the pane when the agent session ends, and re-applies the layout", async () => {
    await h.agentsRaw("kill-session", "-t", `=${SESSION_A}`);
    await waitFor(async () => !(await h.agentPane(SESSION_A)), "pane A gone");
    expect((await h.panes()).map((pane) => pane.agent).sort()).toEqual(["", SESSION_B]);
    // the remaining agent pane fills the whole right side (same height as the assistant pane)
    await waitFor(async () => {
      const geo = await h.geometry();
      return geo.find((entry) => entry.agent === SESSION_B)?.height === geo.find((entry) => entry.agent === "")?.height;
    }, "layout re-applied");
  });

  it("does not re-add a pane that the user closed while the session is alive", async () => {
    const pane = (await h.agentPane(SESSION_B))!;
    await h.userRaw("kill-pane", "-t", pane.paneId);
    await pause(1_000);
    expect(await h.agentPane(SESSION_B)).toBeUndefined();
    expect(await h.agentAlive(SESSION_B)).toBe(true);
  });

  it("ends the controller and closes the view window when the assistant pane is gone", async () => {
    await h.startAgent(SESSION_C);
    await waitFor(() => h.agentPane(SESSION_C), "pane for session C");
    const main = (await h.panes()).find((pane) => pane.main)!;
    await h.userRaw("kill-pane", "-t", main.paneId);
    expect(await h.controllerEnd).toBe("assistant-gone");
    const windows = (await h.userRaw("list-windows", "-t", "=viewtest", "-F", "#{window_name}")).stdout ?? "";
    expect(windows.trim().split("\n")).toEqual(["amy-ctl"]);
    // the agent sessions are untouched: the view only attached to them
    expect(await h.agentAlive(SESSION_C)).toBe(true);
  });
});

describe.skipIf(!tmuxAvailable)("agents view with --read-only (real tmux)", { timeout: 60_000 }, () => {
  let h: Harness;
  beforeAll(async () => {
    h = new Harness();
    await h.open({ assistant: "sleep 600", readOnly: true });
  });
  afterAll(() => h.cleanup());

  it("attaches read-only: the client is read-only and typed keys do not reach the agent", async () => {
    await h.startAgent(SESSION_A);
    const pane = await waitFor(() => h.agentPane(SESSION_A), "pane for session A");
    const shown = async () => ((await h.userRaw("capture-pane", "-p", "-t", pane.paneId)).stdout ?? "").includes("? for shortcuts");
    await waitFor(shown, "screen");
    const flags = ((await h.agentsRaw("list-clients", "-t", `=${SESSION_A}`, "-F", "#{client_readonly}")).stdout ?? "").trim();
    expect(flags).toBe("1");
    await h.userRaw("send-keys", "-t", pane.paneId, "-l", "typed-into-mirror");
    await pause(500);
    expect(await h.agentScreen(SESSION_A)).not.toContain("typed-into-mirror");
  });
});

/** `--interactive-shell`: aliases from a TEMPORARY rc (private HOME/ZDOTDIR; the real rc files are never read). */
for (const shellName of ["zsh", "bash"]) {
  const shell = which(shellName);
  describe.skipIf(!tmuxAvailable || !shell)(`agents view assistant command (${shellName}, real tmux)`, { timeout: 60_000 }, () => {
    let h: Harness;
    let home: string;

    beforeAll(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), "pa-view-home-"));
      const rc = "alias zzalias='echo ALIAS-WORKS'\n";
      for (const file of [".zshrc", ".bashrc"]) fs.writeFileSync(path.join(home, file), rc);
    });
    afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

    const start = async (interactive: boolean) => {
      h = new Harness({ ...process.env, HOME: home, ZDOTDIR: home, SHELL: shell!, TERM: "xterm" });
      const out = path.join(h.base, "alias.txt");
      await h.open({ assistant: `zzalias > ${out} 2>&1; sleep 600`, interactiveShell: interactive ? shell : undefined, controller: false });
      await waitFor(async () => fs.existsSync(out) && fs.readFileSync(out, "utf8").trim() !== "", "alias output");
      return fs.readFileSync(out, "utf8").trim();
    };

    it("does NOT find an alias by default (tmux runs the command through a non-interactive shell)", async () => {
      const output = await start(false);
      expect(output).not.toContain("ALIAS-WORKS");
      expect(output).toMatch(/zzalias/);
      await h.cleanup();
    });

    it("finds the alias with --interactive-shell", async () => {
      const output = await start(true);
      expect(output).toBe("ALIAS-WORKS");
      await h.cleanup();
    });
  });
}
