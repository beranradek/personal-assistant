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
  sharedStartupWiringFixtures: number;
  sharedMemoryStartupFixtures: number;
  terminalStartupEntrypointFixtures: number;
  passedFixtures: number;
  runtimePassedFixtures: number;
  syntheticPassedFixtures: number;
  sharedStartupWiringPassedFixtures: number;
  sharedMemoryStartupPassedFixtures: number;
  terminalStartupEntrypointPassedFixtures: number;
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
    case "shared_startup_wiring":
      return `Shared startup wiring fixtures: ${passed}/${total} passed (not counted as runtime coverage)`;
    case "shared_memory_startup":
      return `Shared memory startup fixtures: ${passed}/${total} passed (not counted as runtime coverage)`;
    case "terminal_startup_entrypoint":
      return `Terminal startup entrypoint fixtures: ${passed}/${total} passed (not counted as runtime coverage)`;
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
  const sharedStartupWiringFixtures = fixtures.filter(
    (fixture) => resolveFixtureKind(fixture) === "shared_startup_wiring",
  ).length;
  const sharedMemoryStartupFixtures = fixtures.filter(
    (fixture) => resolveFixtureKind(fixture) === "shared_memory_startup",
  ).length;
  const terminalStartupEntrypointFixtures = fixtures.filter(
    (fixture) => resolveFixtureKind(fixture) === "terminal_startup_entrypoint",
  ).length;
  const syntheticPassedFixtures = results.filter(
    (result) => fixtureKinds[result.fixtureId] === "synthetic" && result.failureClasses.length === 0,
  ).length;
  const sharedStartupWiringPassedFixtures = results.filter(
    (result) =>
      fixtureKinds[result.fixtureId] === "shared_startup_wiring" && result.failureClasses.length === 0,
  ).length;
  const sharedMemoryStartupPassedFixtures = results.filter(
    (result) =>
      fixtureKinds[result.fixtureId] === "shared_memory_startup" && result.failureClasses.length === 0,
  ).length;
  const terminalStartupEntrypointPassedFixtures = results.filter(
    (result) =>
      fixtureKinds[result.fixtureId] === "terminal_startup_entrypoint" && result.failureClasses.length === 0,
  ).length;
  const runtimePassedFixtures = results.filter(
    (result) => fixtureKinds[result.fixtureId] === "runtime" && result.failureClasses.length === 0,
  ).length;

  return {
    generatedAt: new Date().toISOString(),
    totalFixtures: results.length,
    runtimeFixtures,
    syntheticFixtures,
    sharedStartupWiringFixtures,
    sharedMemoryStartupFixtures,
    terminalStartupEntrypointFixtures,
    passedFixtures: results.length - failedFixtureIds.length,
    runtimePassedFixtures,
    syntheticPassedFixtures,
    sharedStartupWiringPassedFixtures,
    sharedMemoryStartupPassedFixtures,
    terminalStartupEntrypointPassedFixtures,
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
  if (report.sharedStartupWiringFixtures > 0) {
    lines.push(
      formatFixtureKindSummary(
        "shared_startup_wiring",
        report.sharedStartupWiringPassedFixtures,
        report.sharedStartupWiringFixtures,
      ),
    );
  }
  if (report.sharedMemoryStartupFixtures > 0) {
    lines.push(
      formatFixtureKindSummary(
        "shared_memory_startup",
        report.sharedMemoryStartupPassedFixtures,
        report.sharedMemoryStartupFixtures,
      ),
    );
  }
  if (report.terminalStartupEntrypointFixtures > 0) {
    lines.push(
      formatFixtureKindSummary(
        "terminal_startup_entrypoint",
        report.terminalStartupEntrypointPassedFixtures,
        report.terminalStartupEntrypointFixtures,
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
  return evaluateEpisodeFixtures(await createDefaultEpisodeEvalFixtures());
}
