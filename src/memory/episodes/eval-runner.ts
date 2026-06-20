import {
  evaluateEpisodeFixture,
  type EpisodeEvalFixture,
  type EpisodeEvalFixtureKind,
  type EpisodeEvalResult,
} from "./eval.js";
import { createDefaultEpisodeEvalFixtures } from "./eval-fixtures.js";

export type EpisodeEvalReport = {
  generatedAt: string;
  totalFixtures: number;
  runtimeFixtures: number;
  syntheticFixtures: number;
  sharedStartupHelperFixtures: number;
  passedFixtures: number;
  runtimePassedFixtures: number;
  syntheticPassedFixtures: number;
  sharedStartupHelperPassedFixtures: number;
  failedFixtures: number;
  failedFixtureIds: string[];
  fixtureKinds: Record<string, EpisodeEvalFixtureKind>;
  results: EpisodeEvalResult[];
};

function resolveFixtureKind(fixture: EpisodeEvalFixture): EpisodeEvalFixtureKind {
  if (fixture.fixtureKind) return fixture.fixtureKind;
  return fixture.synthetic ? "synthetic" : "runtime";
}

function formatFixtureKindSummary(kind: EpisodeEvalFixtureKind, passed: number, total: number): string {
  switch (kind) {
    case "synthetic":
      return `Synthetic fixtures: ${passed}/${total} passed (not counted as runtime coverage)`;
    case "shared_startup_helper":
      return `Shared startup helper fixtures: ${passed}/${total} passed (not counted as runtime coverage)`;
    case "runtime":
      return `Runtime fixtures: ${passed}/${total} passed`;
  }
}

export function evaluateEpisodeFixtures(fixtures: EpisodeEvalFixture[]): EpisodeEvalReport {
  const results = fixtures.map((fixture) => evaluateEpisodeFixture(fixture));
  const fixtureKinds = Object.fromEntries(
    fixtures.map((fixture) => [fixture.id, resolveFixtureKind(fixture)]),
  ) as Record<string, EpisodeEvalFixtureKind>;
  const failedFixtureIds = results
    .filter((result) => result.failureClasses.length > 0)
    .map((result) => result.fixtureId);
  const runtimeFixtures = fixtures.filter((fixture) => resolveFixtureKind(fixture) === "runtime").length;
  const syntheticFixtures = fixtures.filter((fixture) => resolveFixtureKind(fixture) === "synthetic").length;
  const sharedStartupHelperFixtures = fixtures.filter(
    (fixture) => resolveFixtureKind(fixture) === "shared_startup_helper",
  ).length;
  const syntheticPassedFixtures = results.filter(
    (result) => fixtureKinds[result.fixtureId] === "synthetic" && result.failureClasses.length === 0,
  ).length;
  const sharedStartupHelperPassedFixtures = results.filter(
    (result) => fixtureKinds[result.fixtureId] === "shared_startup_helper" && result.failureClasses.length === 0,
  ).length;
  const runtimePassedFixtures = results.filter(
    (result) => fixtureKinds[result.fixtureId] === "runtime" && result.failureClasses.length === 0,
  ).length;

  return {
    generatedAt: new Date().toISOString(),
    totalFixtures: results.length,
    runtimeFixtures,
    syntheticFixtures,
    sharedStartupHelperFixtures,
    passedFixtures: results.length - failedFixtureIds.length,
    runtimePassedFixtures,
    syntheticPassedFixtures,
    sharedStartupHelperPassedFixtures,
    failedFixtures: failedFixtureIds.length,
    failedFixtureIds,
    fixtureKinds,
    results,
  };
}

export function formatEpisodeEvalReport(report: EpisodeEvalReport): string {
  const lines = [
    `Episode eval report: ${report.runtimePassedFixtures}/${report.runtimeFixtures} runtime fixtures passed`,
    `Generated at: ${report.generatedAt}`,
  ];
  if (report.syntheticFixtures > 0) {
    lines.push(formatFixtureKindSummary("synthetic", report.syntheticPassedFixtures, report.syntheticFixtures));
  }
  if (report.sharedStartupHelperFixtures > 0) {
    lines.push(
      formatFixtureKindSummary(
        "shared_startup_helper",
        report.sharedStartupHelperPassedFixtures,
        report.sharedStartupHelperFixtures,
      ),
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
