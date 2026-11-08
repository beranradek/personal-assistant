import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildClaudeCompanionArgs, buildClaudeCompanionEnvironment, commandArgs, formatRemoteControlResponse, parseCommand, parseEpisodeEvalJson, parseEpisodeEvalOutputPath, parseReflectDate, runEpisodeEval, runInit, runRemoteCommand } from "./cli.js";
import * as episodeEvalRunner from "./memory/episodes/eval-runner.js";

describe("cli", () => {
  describe("parseCommand", () => {
    it('parses "terminal" subcommand', () => {
      const result = parseCommand(["node", "cli.js", "terminal"]);
      expect(result).toBe("terminal");
    });

    it('parses "daemon" subcommand', () => {
      const result = parseCommand(["node", "cli.js", "daemon"]);
      expect(result).toBe("daemon");
    });

    it('parses "init" subcommand', () => {
      const result = parseCommand(["node", "cli.js", "init"]);
      expect(result).toBe("init");
    });

    it("returns null for unknown subcommand", () => {
      const result = parseCommand(["node", "cli.js", "unknown"]);
      expect(result).toBeNull();
    });

    it("returns null when no subcommand given", () => {
      const result = parseCommand(["node", "cli.js"]);
      expect(result).toBeNull();
    });

    it("ignores --config flag when finding subcommand", () => {
      const result = parseCommand(["node", "cli.js", "--config", "/path/settings.json", "terminal"]);
      expect(result).toBe("terminal");
    });

    it("does not treat --help as a subcommand", () => {
      const result = parseCommand(["node", "cli.js", "--help"]);
      expect(result).toBeNull();
    });

    it('parses "reflect" subcommand', () => {
      const result = parseCommand(["node", "cli.js", "reflect"]);
      expect(result).toBe("reflect");
    });

    it('parses "episode-eval" subcommand', () => {
      const result = parseCommand(["node", "cli.js", "episode-eval"]);
      expect(result).toBe("episode-eval");
    });

    it('parses "claude-context" subcommand', () => {
      expect(parseCommand(["node", "cli.js", "claude-context", "--hook-json"])).toBe("claude-context");
    });

    it('parses "claude-security-hook" subcommand', () => {
      expect(parseCommand(["node", "cli.js", "claude-security-hook"])).toBe("claude-security-hook");
    });

    it('parses "remote" and "claude-remote-hook" subcommands', () => {
      expect(parseCommand(["node", "cli.js", "remote", "status"])).toBe("remote");
      expect(parseCommand(["node", "cli.js", "--config", "/x/settings.json", "claude-remote-hook", "listen-start"])).toBe("claude-remote-hook");
    });

    it('parses "claude" companion subcommand', () => {
      expect(parseCommand(["node", "cli.js", "claude"])).toBe("claude");
    });

    it('parses "agents-view" and does not take option values for commands', () => {
      expect(parseCommand(["node", "cli.js", "agents-view"])).toBe("agents-view");
      expect(parseCommand(["node", "cli.js", "agents-view", "--assistant", "claude"])).toBe("agents-view");
      expect(parseCommand(["node", "cli.js", "--assistant", "claude", "agents-view"])).toBe("agents-view");
      expect(parseCommand(["node", "cli.js", "--session", "daemon", "--config", "/x/settings.json", "agents-view"])).toBe("agents-view");
      expect(parseCommand(["node", "cli.js", "--assistant", "claude"])).toBeNull();
      expect(parseCommand(["node", "cli.js", "--assistant-cwd", "daemon", "agents-view", "-i", "--read-only"])).toBe("agents-view");
    });
  });

  it("builds a restricted Claude Code invocation with explicit companion config", () => {
    expect(buildClaudeCompanionArgs("/workspace", ["--model", "sonnet"])).toEqual([
      "--restricted", "--tools", "default", "--settings", "/workspace/.claude/settings.json",
      "--mcp-config", "/workspace/.mcp.json", "--model", "sonnet",
    ]);
  });

  it("passes the selected PA config directory to hooks and MCP children", () => {
    expect(buildClaudeCompanionEnvironment("/custom/pa", { KEEP: "yes", PA_CONFIG: "/old" })).toEqual({
      KEEP: "yes", PA_CONFIG: "/custom/pa",
    });
  });

  it("adds PA-configured directories to restricted Claude Code access", () => {
    expect(buildClaudeCompanionArgs("/workspace", [], ["/readable", "/writable", "/readable", "/workspace"])).toEqual([
      "--restricted", "--tools", "default", "--add-dir", "/readable", "/writable",
      "--settings", "/workspace/.claude/settings.json", "--mcp-config", "/workspace/.mcp.json",
    ]);
  });

  it("uses launcher-owned settings when supplied", () => {
    expect(buildClaudeCompanionArgs("/workspace", [], [], "/pa-config/claude-code/settings.json"))
      .toContain("/pa-config/claude-code/settings.json");
  });

  describe("parseReflectDate", () => {
    it("returns undefined when --date flag is absent", () => {
      expect(parseReflectDate(["node", "cli.js", "reflect"])).toBeUndefined();
    });

    it("returns the date string when --date YYYY-MM-DD is provided", () => {
      expect(
        parseReflectDate(["node", "cli.js", "reflect", "--date", "2026-04-01"]),
      ).toBe("2026-04-01");
    });

    it("returns undefined when --date appears without value", () => {
      // No value after --date means i+1 is out of bounds — treated as missing
      expect(parseReflectDate(["node", "cli.js", "reflect", "--date"])).toBeUndefined();
    });

    it("exits with error for malformed date", () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit"); });
      expect(() =>
        parseReflectDate(["node", "cli.js", "reflect", "--date", "not-a-date"]),
      ).toThrow();
      exitSpy.mockRestore();
    });
  });

  describe("parseEpisodeEvalJson", () => {
    it("returns false when --json flag is absent", () => {
      expect(parseEpisodeEvalJson(["node", "cli.js", "episode-eval"])).toBe(false);
    });

    it("returns true when --json is provided after episode-eval", () => {
      expect(parseEpisodeEvalJson(["node", "cli.js", "episode-eval", "--json"])).toBe(true);
    });

    it("ignores --json when episode-eval command is not selected", () => {
      expect(parseEpisodeEvalJson(["node", "cli.js", "reflect", "--json"])).toBe(false);
    });
  });

  describe("parseEpisodeEvalOutputPath", () => {
    it("returns undefined when --output flag is absent", () => {
      expect(parseEpisodeEvalOutputPath(["node", "cli.js", "episode-eval"])).toBeUndefined();
    });

    it("returns output path when --output is provided after episode-eval", () => {
      expect(
        parseEpisodeEvalOutputPath(["node", "cli.js", "episode-eval", "--output", "/tmp/eval.json"]),
      ).toBe("/tmp/eval.json");
    });

    it("ignores --output when episode-eval command is not selected", () => {
      expect(parseEpisodeEvalOutputPath(["node", "cli.js", "reflect", "--output", "/tmp/eval.json"])).toBeUndefined();
    });

    it("does not treat a following flag as an output path", () => {
      expect(parseEpisodeEvalOutputPath(["node", "cli.js", "episode-eval", "--output", "--json"])).toBe("--json");
    });
  });
});

describe("pa init --claude-remote", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pa-init-remote-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("merges hooks and allow entries into an existing workspace file and is idempotent", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const configDir = path.join(root, "config");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "settings.json"),
      JSON.stringify({ security: { workspace, dataDir: path.join(root, "data") } }),
    );
    const wsFile = path.join(workspace, ".claude", "settings.json");
    await fs.mkdir(path.dirname(wsFile), { recursive: true });
    await fs.writeFile(wsFile, JSON.stringify({ model: "opus", permissions: { allow: ["Read"], deny: ["Bash(rm *)"] } }));

    await runInit(configDir, { claudeCode: false, claudeRemote: true });

    const merged = JSON.parse(await fs.readFile(wsFile, "utf8"));
    expect(merged.model).toBe("opus");
    expect(merged.permissions.deny).toEqual(["Bash(rm *)"]);
    expect(merged.permissions.allow).toEqual([
      "Read",
      "mcp__pa__remote_session_status",
      "mcp__pa__remote_session_attach",
      "mcp__pa__remote_session_detach",
    ]);
    expect(Object.keys(merged.hooks)).toContain("StopFailure");
    // The launcher file does not exist: it is created from the template.
    const launcher = JSON.parse(await fs.readFile(path.join(configDir, "claude-code", "settings.json"), "utf8"));
    expect(launcher.permissions.allow).toContain("mcp__pa__remote_session_attach");

    const before = await fs.readFile(wsFile, "utf8");
    await runInit(configDir, { claudeCode: false, claudeRemote: true });
    expect(await fs.readFile(wsFile, "utf8")).toBe(before);
  });

  async function setupWorkspace(): Promise<{ configDir: string; wsFile: string }> {
    const configDir = path.join(root, "config");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "settings.json"),
      JSON.stringify({ security: { workspace, dataDir: path.join(root, "data") } }),
    );
    const wsFile = path.join(workspace, ".claude", "settings.json");
    await fs.mkdir(path.dirname(wsFile), { recursive: true });
    return { configDir, wsFile };
  }

  it("keeps the user hooks, keeps the security hook first, is idempotent and recognises the old command form", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { configDir, wsFile } = await setupWorkspace();
    const base = JSON.parse(await fs.readFile(new URL("./templates/claude-code/settings.json", import.meta.url), "utf8"));
    const existing = {
      ...base,
      hooks: {
        ...base.hooks,
        Stop: [{ hooks: [{ type: "command", command: "my-stop-notifier" }] }],
        SessionStart: [
          ...base.hooks.SessionStart,
          { hooks: [{ type: "command", command: "pa claude-remote-hook listen-start", async: true }] },
        ],
      },
    };
    await fs.writeFile(wsFile, JSON.stringify(existing));

    await runInit(configDir, { claudeCode: false, claudeRemote: true });

    const merged = JSON.parse(await fs.readFile(wsFile, "utf8"));
    const commands = (event: string): string[] =>
      merged.hooks[event].flatMap((g: { hooks: Array<{ command: string }> }) => g.hooks.map((h) => h.command));
    expect(commands("Stop")).toEqual(["my-stop-notifier", "pa-remote-hook listen-stop"]);
    expect(merged.hooks.PreToolUse[0].hooks[0].command).toBe("pa claude-security-hook");
    expect(commands("PreToolUse")).toEqual(["pa claude-security-hook", "pa-remote-hook PreToolUse"]);
    // The old form is rewritten in place (with the flags), not duplicated.
    expect(commands("SessionStart")).toEqual(["pa claude-context --hook-json", "pa-remote-hook listen-start"]);
    expect(merged.hooks.SessionStart[1].hooks[0]).toMatchObject({ async: true, asyncRewake: true });
    expect(commands("StopFailure")).toEqual(["pa-remote-hook listen-fail"]);
    expect(merged.permissions.allow).toEqual(expect.arrayContaining(base.permissions.allow));

    const before = await fs.readFile(wsFile, "utf8");
    await runInit(configDir, { claudeCode: false, claudeRemote: true });
    expect(await fs.readFile(wsFile, "utf8")).toBe(before);
  });

  it("pa init --claude-code alone installs no remote hooks", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { configDir, wsFile } = await setupWorkspace();
    await runInit(configDir, { claudeCode: true });
    const text = await fs.readFile(wsFile, "utf8");
    expect(text).toContain("pa claude-security-hook");
    expect(text).not.toContain("remote-hook");
    expect(text).not.toContain("remote_session");
  });
});

describe("runEpisodeEval", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "episode-eval-cli-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("prints the formatted report and keeps zero exit code on pass", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitCodeBefore = process.exitCode;
    process.exitCode = 0;
    vi.spyOn(episodeEvalRunner, "runDefaultEpisodeEval").mockResolvedValue({
      generatedAt: "2026-06-20T09:00:00.000Z",
      totalFixtures: 1,
      runtimeFixtures: 1,
      syntheticFixtures: 0,
      sharedStartupWiringFixtures: 0,
      sharedMemoryStartupFixtures: 0,
      terminalStartupEntrypointFixtures: 0,
      daemonStartupEntrypointFixtures: 0,
      passedFixtures: 1,
      runtimePassedFixtures: 1,
      syntheticPassedFixtures: 0,
      sharedStartupWiringPassedFixtures: 0,
      sharedMemoryStartupPassedFixtures: 0,
      terminalStartupEntrypointPassedFixtures: 0,
      daemonStartupEntrypointPassedFixtures: 0,
      failedFixtures: 0,
      failedFixtureIds: [],
      fixtureKinds: {},
      results: [],
    });
    vi.spyOn(episodeEvalRunner, "formatEpisodeEvalReport").mockReturnValue("episode eval ok");
    await runEpisodeEval();

    expect(logSpy).toHaveBeenCalledWith("episode eval ok");
    expect(process.exitCode).toBe(0);

    logSpy.mockRestore();
    process.exitCode = exitCodeBefore;
    vi.restoreAllMocks();
  });

  it("prints JSON report when --json flag is used", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitCodeBefore = process.exitCode;
    process.exitCode = 0;
    const report = {
      generatedAt: "2026-06-21T17:00:00.000Z",
      totalFixtures: 1,
      runtimeFixtures: 1,
      syntheticFixtures: 0,
      sharedStartupWiringFixtures: 0,
      sharedMemoryStartupFixtures: 0,
      terminalStartupEntrypointFixtures: 0,
      daemonStartupEntrypointFixtures: 0,
      passedFixtures: 1,
      runtimePassedFixtures: 1,
      syntheticPassedFixtures: 0,
      sharedStartupWiringPassedFixtures: 0,
      sharedMemoryStartupPassedFixtures: 0,
      terminalStartupEntrypointPassedFixtures: 0,
      daemonStartupEntrypointPassedFixtures: 0,
      failedFixtures: 0,
      failedFixtureIds: [],
      fixtureKinds: {},
      results: [],
    } satisfies Awaited<ReturnType<typeof episodeEvalRunner.runDefaultEpisodeEval>>;
    vi.spyOn(episodeEvalRunner, "runDefaultEpisodeEval").mockResolvedValue(report);
    const formatSpy = vi.spyOn(episodeEvalRunner, "formatEpisodeEvalReport");

    await runEpisodeEval(["node", "cli.js", "episode-eval", "--json"]);

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(report, null, 2));
    expect(formatSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);

    logSpy.mockRestore();
    process.exitCode = exitCodeBefore;
    vi.restoreAllMocks();
  });

  it("sets non-zero exit code when fixtures fail", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitCodeBefore = process.exitCode;
    process.exitCode = 0;
    vi.spyOn(episodeEvalRunner, "runDefaultEpisodeEval").mockResolvedValue({
      generatedAt: "2026-06-20T09:00:00.000Z",
      totalFixtures: 1,
      runtimeFixtures: 1,
      syntheticFixtures: 0,
      sharedStartupWiringFixtures: 0,
      sharedMemoryStartupFixtures: 0,
      terminalStartupEntrypointFixtures: 0,
      daemonStartupEntrypointFixtures: 0,
      passedFixtures: 0,
      runtimePassedFixtures: 0,
      syntheticPassedFixtures: 0,
      sharedStartupWiringPassedFixtures: 0,
      sharedMemoryStartupPassedFixtures: 0,
      terminalStartupEntrypointPassedFixtures: 0,
      daemonStartupEntrypointPassedFixtures: 0,
      failedFixtures: 1,
      failedFixtureIds: ["broken"],
      fixtureKinds: {},
      results: [],
    });
    vi.spyOn(episodeEvalRunner, "formatEpisodeEvalReport").mockReturnValue("episode eval failed");
    await runEpisodeEval();

    expect(logSpy).toHaveBeenCalledWith("episode eval failed");
    expect(process.exitCode).toBe(1);

    logSpy.mockRestore();
    process.exitCode = exitCodeBefore;
    vi.restoreAllMocks();
  });

  it("keeps failure exit code semantics for JSON output", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitCodeBefore = process.exitCode;
    process.exitCode = 0;
    const report = {
      generatedAt: "2026-06-21T17:00:00.000Z",
      totalFixtures: 1,
      runtimeFixtures: 1,
      syntheticFixtures: 0,
      sharedStartupWiringFixtures: 0,
      sharedMemoryStartupFixtures: 0,
      terminalStartupEntrypointFixtures: 0,
      daemonStartupEntrypointFixtures: 0,
      passedFixtures: 0,
      runtimePassedFixtures: 0,
      syntheticPassedFixtures: 0,
      sharedStartupWiringPassedFixtures: 0,
      sharedMemoryStartupPassedFixtures: 0,
      terminalStartupEntrypointPassedFixtures: 0,
      daemonStartupEntrypointPassedFixtures: 0,
      failedFixtures: 1,
      failedFixtureIds: ["broken"],
      fixtureKinds: {},
      results: [],
    } satisfies Awaited<ReturnType<typeof episodeEvalRunner.runDefaultEpisodeEval>>;
    vi.spyOn(episodeEvalRunner, "runDefaultEpisodeEval").mockResolvedValue(report);
    const formatSpy = vi.spyOn(episodeEvalRunner, "formatEpisodeEvalReport");

    await runEpisodeEval(["node", "cli.js", "episode-eval", "--json"]);

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(report, null, 2));
    expect(formatSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    logSpy.mockRestore();
    process.exitCode = exitCodeBefore;
    vi.restoreAllMocks();
  });

  it("writes a JSON artifact file when --output is used with text output", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitCodeBefore = process.exitCode;
    process.exitCode = 0;
    const report = {
      generatedAt: "2026-06-21T19:00:00.000Z",
      totalFixtures: 1,
      runtimeFixtures: 1,
      syntheticFixtures: 0,
      sharedStartupWiringFixtures: 0,
      sharedMemoryStartupFixtures: 0,
      terminalStartupEntrypointFixtures: 0,
      daemonStartupEntrypointFixtures: 0,
      passedFixtures: 1,
      runtimePassedFixtures: 1,
      syntheticPassedFixtures: 0,
      sharedStartupWiringPassedFixtures: 0,
      sharedMemoryStartupPassedFixtures: 0,
      terminalStartupEntrypointPassedFixtures: 0,
      daemonStartupEntrypointPassedFixtures: 0,
      failedFixtures: 0,
      failedFixtureIds: [],
      fixtureKinds: {},
      results: [],
    } satisfies Awaited<ReturnType<typeof episodeEvalRunner.runDefaultEpisodeEval>>;
    const outputPath = path.join(tempDir, "reports", "episode-eval.json");
    vi.spyOn(episodeEvalRunner, "runDefaultEpisodeEval").mockResolvedValue(report);
    vi.spyOn(episodeEvalRunner, "formatEpisodeEvalReport").mockReturnValue("episode eval ok");

    await runEpisodeEval(["node", "cli.js", "episode-eval", "--output", outputPath]);

    expect(logSpy).toHaveBeenCalledWith("episode eval ok");
    await expect(fs.readFile(outputPath, "utf8")).resolves.toBe(`${JSON.stringify(report, null, 2)}\n`);
    expect(process.exitCode).toBe(0);

    logSpy.mockRestore();
    process.exitCode = exitCodeBefore;
    vi.restoreAllMocks();
  });

  it("writes a JSON artifact file when --json and --output are combined", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitCodeBefore = process.exitCode;
    process.exitCode = 0;
    const report = {
      generatedAt: "2026-06-21T19:00:00.000Z",
      totalFixtures: 1,
      runtimeFixtures: 1,
      syntheticFixtures: 0,
      sharedStartupWiringFixtures: 0,
      sharedMemoryStartupFixtures: 0,
      terminalStartupEntrypointFixtures: 0,
      daemonStartupEntrypointFixtures: 0,
      passedFixtures: 1,
      runtimePassedFixtures: 1,
      syntheticPassedFixtures: 0,
      sharedStartupWiringPassedFixtures: 0,
      sharedMemoryStartupPassedFixtures: 0,
      terminalStartupEntrypointPassedFixtures: 0,
      daemonStartupEntrypointPassedFixtures: 0,
      failedFixtures: 0,
      failedFixtureIds: [],
      fixtureKinds: {},
      results: [],
    } satisfies Awaited<ReturnType<typeof episodeEvalRunner.runDefaultEpisodeEval>>;
    const outputPath = path.join(tempDir, "episode-eval.json");
    vi.spyOn(episodeEvalRunner, "runDefaultEpisodeEval").mockResolvedValue(report);
    const formatSpy = vi.spyOn(episodeEvalRunner, "formatEpisodeEvalReport");

    await runEpisodeEval(["node", "cli.js", "episode-eval", "--json", "--output", outputPath]);

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(report, null, 2));
    expect(formatSpy).not.toHaveBeenCalled();
    await expect(fs.readFile(outputPath, "utf8")).resolves.toBe(`${JSON.stringify(report, null, 2)}\n`);
    expect(process.exitCode).toBe(0);

    logSpy.mockRestore();
    process.exitCode = exitCodeBefore;
    vi.restoreAllMocks();
  });

  it("still writes the JSON artifact before setting failure exit code", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitCodeBefore = process.exitCode;
    process.exitCode = 0;
    const report = {
      generatedAt: "2026-06-22T14:00:00.000Z",
      totalFixtures: 1,
      runtimeFixtures: 1,
      syntheticFixtures: 0,
      sharedStartupWiringFixtures: 0,
      sharedMemoryStartupFixtures: 0,
      terminalStartupEntrypointFixtures: 0,
      daemonStartupEntrypointFixtures: 0,
      passedFixtures: 0,
      runtimePassedFixtures: 0,
      syntheticPassedFixtures: 0,
      sharedStartupWiringPassedFixtures: 0,
      sharedMemoryStartupPassedFixtures: 0,
      terminalStartupEntrypointPassedFixtures: 0,
      daemonStartupEntrypointPassedFixtures: 0,
      failedFixtures: 1,
      failedFixtureIds: ["broken"],
      fixtureKinds: {},
      results: [],
    } satisfies Awaited<ReturnType<typeof episodeEvalRunner.runDefaultEpisodeEval>>;
    const outputPath = path.join(tempDir, "failed-episode-eval.json");
    vi.spyOn(episodeEvalRunner, "runDefaultEpisodeEval").mockResolvedValue(report);
    const formatSpy = vi.spyOn(episodeEvalRunner, "formatEpisodeEvalReport");

    await runEpisodeEval(["node", "cli.js", "episode-eval", "--json", "--output", outputPath]);

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(report, null, 2));
    expect(formatSpy).not.toHaveBeenCalled();
    await expect(fs.readFile(outputPath, "utf8")).resolves.toBe(`${JSON.stringify(report, null, 2)}\n`);
    expect(process.exitCode).toBe(1);

    logSpy.mockRestore();
    process.exitCode = exitCodeBefore;
    vi.restoreAllMocks();
  });

  describe("remote command", () => {
    const response = {
      ok: true,
      message: "Attached.",
      sessions: [{ index: 1, name: "dev", cwd: "/w", pid: 12, attachedChatId: "42" }],
    };
    const makeOut = () => ({ log: vi.fn(), error: vi.fn() });

    it("commandArgs returns the arguments after the command without the --config pair", () => {
      expect(commandArgs(["--config", "/c/settings.json", "remote", "attach", "2"], "remote")).toEqual(["attach", "2"]);
      expect(commandArgs(["claude-remote-hook", "PreToolUse"], "claude-remote-hook")).toEqual(["PreToolUse"]);
    });

    it("sends attach with a target and prints the sessions", async () => {
      const control = vi.fn().mockResolvedValue(response);
      const out = makeOut();
      expect(await runRemoteCommand(["attach", "2"], control, out)).toBe(0);
      expect(control).toHaveBeenCalledWith({ action: "attach", target: "2" });
      expect(out.log).toHaveBeenCalledWith(formatRemoteControlResponse(response));
      expect(out.log.mock.calls[0][0]).toContain("1. dev (/w, pid 12) [attached: 42]");
    });

    it("sends detach and status without a target", async () => {
      const control = vi.fn().mockResolvedValue(response);
      await runRemoteCommand(["detach", "ignored"], control, makeOut());
      await runRemoteCommand(["status"], control, makeOut());
      expect(control.mock.calls.map((c) => c[0])).toEqual([{ action: "detach" }, { action: "status" }]);
    });

    it("returns 1 for an unknown action, a not ok response, and a failing call", async () => {
      const control = vi.fn().mockResolvedValue({ ...response, ok: false });
      const out = makeOut();
      expect(await runRemoteCommand(["bogus"], control, out)).toBe(1);
      expect(control).not.toHaveBeenCalled();
      expect(await runRemoteCommand(["status"], control, out)).toBe(1);
      const failing = vi.fn().mockRejectedValue(new Error("daemon down"));
      expect(await runRemoteCommand(["status"], failing, out)).toBe(1);
      expect(out.error).toHaveBeenLastCalledWith("remote status: daemon down");
    });
  });

  it("exits with error when --output has no value", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit"); });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(runEpisodeEval(["node", "cli.js", "episode-eval", "--output"])).rejects.toThrow("process.exit");
    expect(errorSpy).toHaveBeenCalledWith('Invalid episode-eval usage: "--output" requires a file path.');
    expect(logSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("exits with error when --output is followed by another flag", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit"); });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(runEpisodeEval(["node", "cli.js", "episode-eval", "--output", "--json"])).rejects.toThrow("process.exit");
    expect(errorSpy).toHaveBeenCalledWith('Invalid episode-eval usage: "--output" requires a file path.');
    expect(logSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
    vi.restoreAllMocks();
  });
});
