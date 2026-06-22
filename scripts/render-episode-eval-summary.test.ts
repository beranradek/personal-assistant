import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatEpisodeEvalSummary,
  renderEpisodeEvalSummary,
  resolveEpisodeEvalReportPath,
} from "./render-episode-eval-summary.mjs";
import { runDefaultEpisodeEval } from "../src/memory/episodes/eval-runner.js";

const execFileAsync = promisify(execFile);

describe("render-episode-eval-summary script", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "episode-eval-summary-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("uses CLI path first, then env override, then default path", () => {
    expect(resolveEpisodeEvalReportPath(["node", "script.mjs", "./tmp/custom.json"], {})).toBe("./tmp/custom.json");
    expect(resolveEpisodeEvalReportPath(["node", "script.mjs"], { EPISODE_EVAL_OUTPUT_PATH: "./tmp/env.json" })).toBe(
      "./tmp/env.json",
    );
    expect(resolveEpisodeEvalReportPath(["node", "script.mjs"], {})).toBe("./tmp/episode-eval-report.json");
  });

  it("formats a passing report without a failing section", () => {
    const summary = formatEpisodeEvalSummary({
      generatedAt: "2026-06-22T15:00:00.000Z",
      totalFixtures: 7,
      runtimeFixtures: 5,
      syntheticFixtures: 0,
      sharedStartupWiringFixtures: 0,
      sharedMemoryStartupFixtures: 0,
      terminalStartupEntrypointFixtures: 1,
      daemonStartupEntrypointFixtures: 1,
      passedFixtures: 7,
      runtimePassedFixtures: 5,
      syntheticPassedFixtures: 0,
      sharedStartupWiringPassedFixtures: 0,
      sharedMemoryStartupPassedFixtures: 0,
      terminalStartupEntrypointPassedFixtures: 1,
      daemonStartupEntrypointPassedFixtures: 1,
      failedFixtures: 0,
      failedFixtureIds: [],
      fixtureKinds: {
        "degraded-store-startup": "terminal_startup_entrypoint",
        "degraded-daemon-startup": "daemon_startup_entrypoint",
      },
      results: [],
    });

    expect(summary).toContain("## Episode Eval PASSED");
    expect(summary).toContain("- Runtime fixtures: 5/5 passed");
    expect(summary).toContain("- Failed fixtures: none");
    expect(summary).not.toContain("### Failing fixtures");
  });

  it("formats failing fixtures with probe mismatch details", () => {
    const summary = formatEpisodeEvalSummary({
      generatedAt: "2026-06-22T15:00:00.000Z",
      totalFixtures: 2,
      runtimeFixtures: 1,
      syntheticFixtures: 0,
      sharedStartupWiringFixtures: 0,
      sharedMemoryStartupFixtures: 0,
      terminalStartupEntrypointFixtures: 1,
      daemonStartupEntrypointFixtures: 0,
      passedFixtures: 1,
      runtimePassedFixtures: 0,
      syntheticPassedFixtures: 0,
      sharedStartupWiringPassedFixtures: 0,
      sharedMemoryStartupPassedFixtures: 0,
      terminalStartupEntrypointPassedFixtures: 1,
      daemonStartupEntrypointPassedFixtures: 0,
      failedFixtures: 1,
      failedFixtureIds: ["github-issue-success"],
      fixtureKinds: {
        "github-issue-success": "runtime",
      },
      results: [
        {
          fixtureId: "github-issue-success",
          expectedMode: "exact_episodic",
          actualMode: "semantic_episodic",
          metrics: {
            latencyMs: 12.345,
          },
          resultIds: ["ep-1"],
          failureClasses: ["routing", "ranking"],
          probeStateMismatches: [
            {
              key: "mcpServersInjected",
              actual: false,
              expected: true,
            },
          ],
        },
      ],
    });

    expect(summary).toContain("## Episode Eval FAILED");
    expect(summary).toContain("### Failing fixtures");
    expect(summary).toContain("- `github-issue-success` (runtime)");
    expect(summary).toContain("  - failures: routing, ranking");
    expect(summary).toContain("  - probe mismatches: `mcpServersInjected` actual=`false` expected=`true`");
  });

  it("renders summary from a JSON report file", async () => {
    const reportPath = path.join(tempDir, "episode-eval-report.json");
    await fs.writeFile(
      reportPath,
      JSON.stringify({
        generatedAt: "2026-06-22T15:00:00.000Z",
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
      }),
      "utf8",
    );

    await expect(renderEpisodeEvalSummary(reportPath)).resolves.toContain("## Episode Eval PASSED");
  });

  it("renders a summary from the real default eval report contract", async () => {
    const reportPath = path.join(tempDir, "real-episode-eval-report.json");
    const report = await runDefaultEpisodeEval();
    await fs.writeFile(reportPath, JSON.stringify(report), "utf8");

    const summary = await renderEpisodeEvalSummary(reportPath);

    expect(summary).toContain("## Episode Eval PASSED");
    expect(summary).toContain(`- Runtime fixtures: ${report.runtimePassedFixtures}/${report.runtimeFixtures} passed`);
    expect(summary).toContain("- Failed fixtures: none");
  });

  it("supports EPISODE_EVAL_OUTPUT_PATH in the real script entrypoint", async () => {
    const reportPath = path.join(tempDir, "custom-episode-eval-report.json");
    await fs.writeFile(
      reportPath,
      JSON.stringify({
        generatedAt: "2026-06-22T16:00:00.000Z",
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
      }),
      "utf8",
    );

    const { stdout } = await execFileAsync("node", ["scripts/render-episode-eval-summary.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        EPISODE_EVAL_OUTPUT_PATH: reportPath,
      },
    });

    expect(stdout).toContain("## Episode Eval PASSED");
    expect(stdout).toContain("- Generated at: `2026-06-22T16:00:00.000Z`");
  });

  it("fails with a clear error when the report file is missing", async () => {
    await expect(renderEpisodeEvalSummary(path.join(tempDir, "missing-report.json"))).rejects.toThrow(
      "Episode eval report not found",
    );
  });

  it("fails with a clear error when the report file is malformed", async () => {
    const reportPath = path.join(tempDir, "broken-report.json");
    await fs.writeFile(reportPath, "{ not json", "utf8");

    await expect(renderEpisodeEvalSummary(reportPath)).rejects.toThrow(
      `Episode eval report at ${reportPath} is not valid JSON`,
    );
  });

  it("fails with a clear error when the report JSON shape is invalid", async () => {
    const reportPath = path.join(tempDir, "wrong-shape-report.json");
    await fs.writeFile(reportPath, JSON.stringify({ generatedAt: "2026-06-22T17:00:00.000Z" }), "utf8");

    await expect(renderEpisodeEvalSummary(reportPath)).rejects.toThrow(
      `Episode eval report at ${reportPath} has an invalid summary shape`,
    );
  });

  it("fails with a clear read error when the report path is unreadable as a file", async () => {
    await expect(renderEpisodeEvalSummary(tempDir)).rejects.toThrow(
      `Episode eval report at ${tempDir} could not be read (EISDIR)`,
    );
  });

  it("returns exit code 1 with a clear message for missing report in the real script entrypoint", async () => {
    await expect(
      execFileAsync("node", ["scripts/render-episode-eval-summary.mjs"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          EPISODE_EVAL_OUTPUT_PATH: path.join(tempDir, "missing-report.json"),
        },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Episode eval report not found"),
    });
  });

  it("returns exit code 1 with a clear message for invalid summary shape in the real script entrypoint", async () => {
    const reportPath = path.join(tempDir, "wrong-shape-report.json");
    await fs.writeFile(reportPath, JSON.stringify({ generatedAt: "2026-06-22T17:00:00.000Z" }), "utf8");

    await expect(
      execFileAsync("node", ["scripts/render-episode-eval-summary.mjs"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          EPISODE_EVAL_OUTPUT_PATH: reportPath,
        },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("has an invalid summary shape"),
    });
  });
});
