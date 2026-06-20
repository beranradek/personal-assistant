import { describe, it, expect, vi } from "vitest";
import { parseCommand, parseReflectDate, runEpisodeEval } from "./cli.js";
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
});

describe("runEpisodeEval", () => {
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
      passedFixtures: 1,
      runtimePassedFixtures: 1,
      syntheticPassedFixtures: 0,
      sharedStartupWiringPassedFixtures: 0,
      sharedMemoryStartupPassedFixtures: 0,
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
      passedFixtures: 0,
      runtimePassedFixtures: 0,
      syntheticPassedFixtures: 0,
      sharedStartupWiringPassedFixtures: 0,
      sharedMemoryStartupPassedFixtures: 0,
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
});
