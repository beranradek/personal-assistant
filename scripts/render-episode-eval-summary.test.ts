import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatEpisodeEvalSummary,
  renderEpisodeEvalSummary,
  resolveEpisodeEvalReportPath,
} from "./render-episode-eval-summary.mjs";

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
});
