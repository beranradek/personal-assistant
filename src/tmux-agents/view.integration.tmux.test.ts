/**
 * Integration test of `pa agents-view` with REAL tmux: two private servers (the "user" tmux and the agents' tmux), a fake agent,
 * and the controller loop running in this process. Skipped when tmux is missing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import * as fs from "node:fs";
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

const VIEW_OPTIONS = { session: "viewtest", assistant: "sleep 600", insideTmux: false };

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

describe.skipIf(!tmuxAvailable)("agents view (real tmux, two private servers)", { timeout: 60_000 }, () => {
  let base: string;
  let userSock: string;
  let agentsSock: string;
  let user: UserTmux;
  let windowId: string;
  let controller: AbortController;
  let ended: Promise<ViewControllerEnd>;

  type Raw = { stdout?: string; stderr?: string };
  const raw = (sock: string, args: string[]) => run("tmux", ["-f", "/dev/null", "-S", sock, ...args]).catch((err: Raw) => err);
  const userRaw = (...args: string[]) => raw(userSock, args);
  const agentsRaw = (...args: string[]) => raw(agentsSock, args);

  /** True when the agents server has the session (`run` rejects on a non-zero exit). */
  const agentAlive = (name: string) =>
    run("tmux", ["-f", "/dev/null", "-S", agentsSock, "has-session", "-t", `=${name}`]).then(
      () => true,
      () => false,
    );

  const startAgent = (name: string) =>
    agentsRaw("new-session", "-d", "-s", name, "-x", "100", "-y", "30", "--", "node", FAKE_AGENT, path.join(base, "messages.jsonl"), "600");

  const panes = async () => (await listViewPanes(user, windowId)) ?? [];
  const agentPane = async (session: string) => (await panes()).find((pane) => pane.agent === session);
  const geometry = async () => {
    const format = "#{pane_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{@pa_agent}";
    const out = (await userRaw("list-panes", "-t", windowId, "-F", format)).stdout ?? "";
    return out
      .trim()
      .split("\n")
      .map((line) => {
        const [paneId, left, top, width, height, agent] = line.split("|");
        return { paneId: paneId!, left: Number(left), top: Number(top), width: Number(width), height: Number(height), agent: agent ?? "" };
      });
  };

  beforeAll(async () => {
    base = fs.realpathSync(fs.mkdtempSync("/tmp/pa-view-"));
    userSock = path.join(base, "user.sock");
    agentsSock = path.join(base, "agents.sock");
    user = createUserTmux({ socketPath: userSock, configFile: "/dev/null" });

    // `sleep` stands in for the hidden controller window (the controller runs in-process below)
    const view = await openAgentsView(user, { ...VIEW_OPTIONS, controllerArgv: () => ["sleep", "600"] });
    expect(view).toMatchObject({ created: true, mode: "session" });
    windowId = view.windowId;

    controller = new AbortController();
    ended = runViewController({
      user,
      listAgentSessions: createAgentSessionLister(createTmuxRunner({ tmuxBinary: "tmux", socketPath: agentsSock, envAllowlist: [] })),
      tmuxBinary: "tmux",
      agentSocketPath: agentsSock,
      windowId,
      signal: controller.signal,
      pollMs: 200,
    });
  });

  afterAll(async () => {
    controller?.abort();
    await ended;
    await userRaw("kill-server");
    await agentsRaw("kill-server");
    for (const sock of [userSock, agentsSock]) {
      const after = await run("tmux", ["-S", sock, "list-sessions"]).catch((err: { stderr?: string }) => err);
      expect(`${(after as { stderr?: string }).stderr ?? ""}`).toMatch(/no server running|error connecting/);
    }
    fs.rmSync(base, { recursive: true, force: true });
    expect(fs.existsSync(base)).toBe(false);
  });

  it("creates the view idempotently: assistant pane marked, controller window present", async () => {
    const before = await panes();
    expect(before).toEqual([{ paneId: expect.stringMatching(/^%\d+$/), main: true, agent: "" }]);
    const windows = (await userRaw("list-windows", "-t", "=viewtest", "-F", "#{window_name}")).stdout ?? "";
    expect(windows.trim().split("\n").sort()).toEqual(["amy", "amy-ctl"]);

    const again = await openAgentsView(user, { ...VIEW_OPTIONS, controllerArgv: () => ["sleep", "600"] });
    expect(again).toMatchObject({ windowId, created: false });
    expect((await panes()).length).toBe(1);
  });

  it("adds a read-only mirror pane when an agent session starts, with the assistant on the left", async () => {
    await startAgent(SESSION_A);
    const pane = await waitFor(() => agentPane(SESSION_A), "pane for session A");
    const geo = await geometry();
    const main = geo.find((entry) => entry.agent === "")!;
    const agent = geo.find((entry) => entry.paneId === pane.paneId)!;
    expect(main.left).toBe(0);
    expect(agent.left).toBeGreaterThan(0);
    expect(Math.abs(main.width - agent.width)).toBeLessThanOrEqual(2); // about 50% / 50%

    // the pane border labels name the agent session and the assistant pane
    const label = async (paneId: string) =>
      ((await userRaw("display-message", "-p", "-t", paneId, "#{T:pane-border-format}")).stdout ?? "").trim();
    expect(await label(pane.paneId)).toBe(SESSION_A);
    expect(await label(main.paneId)).toBe("assistant");

    // the pane mirrors the fake agent screen through a nested read-only attach
    const mirrored = async () => ((await userRaw("capture-pane", "-p", "-t", pane.paneId)).stdout ?? "").includes("? for shortcuts");
    await waitFor(mirrored, "mirrored screen");
    // read-only: typed keys do not reach the agent
    await userRaw("send-keys", "-t", pane.paneId, "-l", "typed-into-mirror");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const agentScreen = (await agentsRaw("capture-pane", "-p", "-t", `=${SESSION_A}`)).stdout ?? "";
    expect(agentScreen).not.toContain("typed-into-mirror");
  });

  it("stacks further agents under each other on the right", async () => {
    await startAgent(SESSION_B);
    await waitFor(() => agentPane(SESSION_B), "pane for session B");
    const geo = await geometry();
    const agents = geo.filter((entry) => entry.agent !== "");
    expect(agents).toHaveLength(2);
    expect(agents[0]!.left).toBe(agents[1]!.left);
    expect(agents[0]!.top).not.toBe(agents[1]!.top);
    expect(geo.find((entry) => entry.agent === "")!.left).toBe(0);
  });

  it("removes the pane when the agent session ends, and re-applies the layout", async () => {
    await agentsRaw("kill-session", "-t", `=${SESSION_A}`);
    await waitFor(async () => !(await agentPane(SESSION_A)), "pane A gone");
    expect((await panes()).map((pane) => pane.agent).sort()).toEqual(["", SESSION_B]);
    // the remaining agent pane fills the whole right side (same height as the assistant pane)
    await waitFor(async () => {
      const geo = await geometry();
      return geo.find((entry) => entry.agent === SESSION_B)?.height === geo.find((entry) => entry.agent === "")?.height;
    }, "layout re-applied");
  });

  it("does not re-add a pane that the user closed while the session is alive", async () => {
    const pane = (await agentPane(SESSION_B))!;
    await userRaw("kill-pane", "-t", pane.paneId);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await agentPane(SESSION_B)).toBeUndefined();
    expect(await agentAlive(SESSION_B)).toBe(true);
  });

  it("ends the controller and closes the view window when the assistant pane is gone", async () => {
    await startAgent(SESSION_C);
    await waitFor(() => agentPane(SESSION_C), "pane for session C");
    const main = (await panes()).find((pane) => pane.main)!;
    await userRaw("kill-pane", "-t", main.paneId);
    expect(await ended).toBe("assistant-gone");
    const windows = (await userRaw("list-windows", "-t", "=viewtest", "-F", "#{window_name}")).stdout ?? "";
    expect(windows.trim().split("\n")).toEqual(["amy-ctl"]);
    // the agent sessions are untouched: the view only mirrored them
    expect(await agentAlive(SESSION_C)).toBe(true);
  });
});
