import { evaluateEpisodeFixture, type EpisodeEvalFixture, type EpisodeEvalResult } from "./eval.js";
import { createDefaultEpisodeEvalFixtures } from "./eval-fixtures.js";

export type EpisodeEvalReport = {
  generatedAt: string;
  totalFixtures: number;
  runtimeFixtures: number;
  syntheticFixtures: number;
  passedFixtures: number;
  runtimePassedFixtures: number;
  syntheticPassedFixtures: number;
  failedFixtures: number;
  failedFixtureIds: string[];
  fixtureKinds: Record<string, "runtime" | "synthetic">;
  results: EpisodeEvalResult[];
};

export function evaluateEpisodeFixtures(fixtures: EpisodeEvalFixture[]): EpisodeEvalReport {
  const results = fixtures.map((fixture) => evaluateEpisodeFixture(fixture));
  const syntheticFixtureIds = new Set(
    fixtures.filter((fixture) => fixture.synthetic).map((fixture) => fixture.id),
  );
  const failedFixtureIds = results
    .filter((result) => result.failureClasses.length > 0)
    .map((result) => result.fixtureId);
  const runtimeFixtures = fixtures.length - syntheticFixtureIds.size;
  const syntheticPassedFixtures = results.filter(
    (result) => syntheticFixtureIds.has(result.fixtureId) && result.failureClasses.length === 0,
  ).length;
  const runtimePassedFixtures = results.filter(
    (result) => !syntheticFixtureIds.has(result.fixtureId) && result.failureClasses.length === 0,
  ).length;

  return {
    generatedAt: new Date().toISOString(),
    totalFixtures: results.length,
    runtimeFixtures,
    syntheticFixtures: syntheticFixtureIds.size,
    passedFixtures: results.length - failedFixtureIds.length,
    runtimePassedFixtures,
    syntheticPassedFixtures,
    failedFixtures: failedFixtureIds.length,
    failedFixtureIds,
    fixtureKinds: Object.fromEntries(
      fixtures.map((fixture) => [fixture.id, fixture.synthetic ? "synthetic" : "runtime"]),
    ),
    results,
  };
}

export function formatEpisodeEvalReport(report: EpisodeEvalReport): string {
  const lines = [
    `Episode eval report: ${report.runtimePassedFixtures}/${report.runtimeFixtures} runtime fixtures passed`,
    `Generated at: ${report.generatedAt}`,
  ];
  if (report.syntheticFixtures > 0) {
    lines.push(
      `Synthetic fixtures: ${report.syntheticPassedFixtures}/${report.syntheticFixtures} passed (not counted as runtime coverage)`,
    );
  }

  if (report.failedFixtures > 0) {
    lines.push(`Failed fixtures: ${report.failedFixtureIds.join(", ")}`);
  } else {
    lines.push("Failed fixtures: none");
  }

  lines.push("");
  lines.push("Per-fixture results:");
  for (const result of report.results) {
    const status = result.failureClasses.length === 0 ? "PASS" : "FAIL";
    const failures = result.failureClasses.length === 0 ? "-" : result.failureClasses.join(", ");
    const fixtureKind = report.fixtureKinds[result.fixtureId] ?? "runtime";
    lines.push(
      `- ${result.fixtureId}: ${status} | kind=${fixtureKind} | mode=${result.actualMode} | failures=${failures} | top1=${result.resultIds[0] ?? "-"} | latencyMs=${result.metrics.latencyMs.toFixed(2)}`,
    );
  }

  return lines.join("\n");
}

export async function runDefaultEpisodeEval(): Promise<EpisodeEvalReport> {
  return evaluateEpisodeFixtures(createDefaultEpisodeEvalFixtures());
}
