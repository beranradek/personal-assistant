import { describe, expect, it } from "vitest";
import { createDefaultEpisodeEvalFixtures } from "./eval-fixtures.js";
import type { EpisodeEvalFixture } from "./eval.js";
import { evaluateEpisodeFixtures, formatEpisodeEvalReport } from "./eval-runner.js";

describe("episode eval runner", () => {
  it("evaluates the default fixture corpus without failures", () => {
    const report = evaluateEpisodeFixtures(createDefaultEpisodeEvalFixtures());

    expect(report.totalFixtures).toBe(6);
    expect(report.passedFixtures).toBe(6);
    expect(report.failedFixtures).toBe(0);
    expect(report.runtimeFixtures).toBe(5);
    expect(report.syntheticFixtures).toBe(0);
    expect(report.sharedStartupHelperFixtures).toBe(1);
    expect(report.runtimePassedFixtures).toBe(5);
    expect(report.syntheticPassedFixtures).toBe(0);
    expect(report.sharedStartupHelperPassedFixtures).toBe(1);
    expect(report.failedFixtureIds).toEqual([]);
    expect(report.fixtureKinds["degraded-store-startup"]).toBe("shared_startup_helper");
  });

  it("formats a concise human-readable report", () => {
    const report = evaluateEpisodeFixtures(createDefaultEpisodeEvalFixtures());
    const text = formatEpisodeEvalReport(report);

    expect(text).toContain("Episode eval report: 5/5 runtime fixtures passed");
    expect(text).toContain("Shared startup helper fixtures: 1/1 passed");
    expect(text).toContain("github-issue-success: PASS | kind=runtime");
    expect(text).toContain("degraded-store-startup: PASS | kind=shared_startup_helper");
  });

  it("reports both legacy synthetic and shared-startup-helper fixture summaries", () => {
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
        fixtureKind: "shared_startup_helper",
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
    expect(report.sharedStartupHelperFixtures).toBe(1);
    expect(text).toContain("Synthetic fixtures: 1/1 passed");
    expect(text).toContain("Shared startup helper fixtures: 1/1 passed");
  });
});
