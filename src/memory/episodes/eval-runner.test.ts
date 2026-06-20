import { describe, expect, it } from "vitest";
import { createDefaultEpisodeEvalFixtures } from "./eval-fixtures.js";
import type { EpisodeEvalFixture } from "./eval.js";
import { evaluateEpisodeFixtures, formatEpisodeEvalReport } from "./eval-runner.js";

describe("episode eval runner", () => {
  it("evaluates the default fixture corpus without failures", async () => {
    const report = evaluateEpisodeFixtures(await createDefaultEpisodeEvalFixtures());

    expect(report.totalFixtures).toBe(6);
    expect(report.passedFixtures).toBe(6);
    expect(report.failedFixtures).toBe(0);
    expect(report.runtimeFixtures).toBe(5);
    expect(report.syntheticFixtures).toBe(0);
    expect(report.sharedStartupWiringFixtures).toBe(0);
    expect(report.sharedMemoryStartupFixtures).toBe(0);
    expect(report.terminalStartupEntrypointFixtures).toBe(1);
    expect(report.runtimePassedFixtures).toBe(5);
    expect(report.syntheticPassedFixtures).toBe(0);
    expect(report.sharedStartupWiringPassedFixtures).toBe(0);
    expect(report.sharedMemoryStartupPassedFixtures).toBe(0);
    expect(report.terminalStartupEntrypointPassedFixtures).toBe(1);
    expect(report.failedFixtureIds).toEqual([]);
    expect(report.fixtureKinds["degraded-store-startup"]).toBe("terminal_startup_entrypoint");
  });

  it("formats a concise human-readable report", async () => {
    const report = evaluateEpisodeFixtures(await createDefaultEpisodeEvalFixtures());
    const text = formatEpisodeEvalReport(report);

    expect(text).toContain("Episode eval report: 5/5 runtime fixtures passed");
    expect(text).toContain("Terminal startup entrypoint fixtures: 1/1 passed");
    expect(text).toContain("github-issue-success: PASS | kind=runtime");
    expect(text).toContain("degraded-store-startup: PASS | kind=terminal_startup_entrypoint");
  });

  it("reports both legacy synthetic and entrypoint fixture summaries", () => {
    const fixtures: EpisodeEvalFixture[] = [
      {
        id: "runtime",
        insertedEpisodes: [],
        expectedMode: "semantic_episodic",
        actualMode: "semantic_episodic",
        actualResults: [],
      },
      {
        id: "synthetic",
        synthetic: true,
        insertedEpisodes: [],
        expectedMode: "semantic_markdown",
        actualMode: "semantic_markdown",
        actualResults: [],
      },
      {
        id: "startup-helper",
        fixtureKind: "terminal_startup_entrypoint",
        insertedEpisodes: [],
        expectedMode: "raw_audit_fallback",
        actualMode: "raw_audit_fallback",
        actualResults: [{
          id: "startup-log",
          matchedFields: [],
          matchedFilters: [],
          explanation: "helper fallback",
        }],
      },
    ];

    const report = evaluateEpisodeFixtures(fixtures);
    const text = formatEpisodeEvalReport(report);

    expect(report.runtimeFixtures).toBe(1);
    expect(report.syntheticFixtures).toBe(1);
    expect(report.sharedStartupWiringFixtures).toBe(0);
    expect(report.sharedMemoryStartupFixtures).toBe(0);
    expect(report.terminalStartupEntrypointFixtures).toBe(1);
    expect(text).toContain("Synthetic fixtures: 1/1 passed");
    expect(text).toContain("Terminal startup entrypoint fixtures: 1/1 passed");
  });
});
