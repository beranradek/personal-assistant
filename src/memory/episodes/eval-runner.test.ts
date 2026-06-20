import { describe, expect, it } from "vitest";
import { createDefaultEpisodeEvalFixtures } from "./eval-fixtures.js";
import { evaluateEpisodeFixtures, formatEpisodeEvalReport } from "./eval-runner.js";

describe("episode eval runner", () => {
  it("evaluates the default fixture corpus without failures", () => {
    const report = evaluateEpisodeFixtures(createDefaultEpisodeEvalFixtures());

    expect(report.totalFixtures).toBe(6);
    expect(report.passedFixtures).toBe(6);
    expect(report.failedFixtures).toBe(0);
    expect(report.runtimeFixtures).toBe(5);
    expect(report.syntheticFixtures).toBe(1);
    expect(report.runtimePassedFixtures).toBe(5);
    expect(report.syntheticPassedFixtures).toBe(1);
    expect(report.failedFixtureIds).toEqual([]);
    expect(report.fixtureKinds["degraded-store-startup"]).toBe("synthetic");
  });

  it("formats a concise human-readable report", () => {
    const report = evaluateEpisodeFixtures(createDefaultEpisodeEvalFixtures());
    const text = formatEpisodeEvalReport(report);

    expect(text).toContain("Episode eval report: 5/5 runtime fixtures passed");
    expect(text).toContain("Synthetic fixtures: 1/1 passed");
    expect(text).toContain("github-issue-success: PASS | kind=runtime");
    expect(text).toContain("degraded-store-startup: PASS | kind=synthetic");
  });
});
