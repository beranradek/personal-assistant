import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseCommand, parseEpisodeEvalJson, parseEpisodeEvalOutputPath, parseReflectDate, runEpisodeEval } from "./cli.js";
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
