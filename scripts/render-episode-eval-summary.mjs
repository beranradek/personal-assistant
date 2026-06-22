import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function resolveEpisodeEvalReportPath(argv = process.argv, env = process.env) {
  return argv[2] || env.EPISODE_EVAL_OUTPUT_PATH || "./tmp/episode-eval-report.json";
}

function formatFixtureBucket(label, passed, total, note = "") {
  if (total <= 0) {
    return null;
  }

  const suffix = note ? ` ${note}` : "";
  return `- ${label}: ${passed}/${total} passed${suffix}`;
}

function formatProbeMismatches(result) {
  if (!Array.isArray(result.probeStateMismatches) || result.probeStateMismatches.length === 0) {
    return null;
  }

  return result.probeStateMismatches
    .map((mismatch) => `\`${mismatch.key}\` actual=\`${String(mismatch.actual)}\` expected=\`${String(mismatch.expected)}\``)
    .join(", ");
}

export function formatEpisodeEvalSummary(report) {
  const failed = report.failedFixtures > 0;
  const lines = [
    `## Episode Eval ${failed ? "FAILED" : "PASSED"}`,
    "",
    `- Generated at: \`${report.generatedAt}\``,
    `- Runtime fixtures: ${report.runtimePassedFixtures}/${report.runtimeFixtures} passed`,
  ];

  const optionalBuckets = [
    formatFixtureBucket(
      "Terminal startup entrypoint fixtures",
      report.terminalStartupEntrypointPassedFixtures,
      report.terminalStartupEntrypointFixtures,
      "(not counted as runtime coverage)",
    ),
    formatFixtureBucket(
      "Daemon startup entrypoint fixtures",
      report.daemonStartupEntrypointPassedFixtures,
      report.daemonStartupEntrypointFixtures,
      "(not counted as runtime coverage)",
    ),
    formatFixtureBucket(
      "Shared memory startup fixtures",
      report.sharedMemoryStartupPassedFixtures,
      report.sharedMemoryStartupFixtures,
      "(not counted as runtime coverage)",
    ),
    formatFixtureBucket(
      "Shared startup wiring fixtures",
      report.sharedStartupWiringPassedFixtures,
      report.sharedStartupWiringFixtures,
      "(not counted as runtime coverage)",
    ),
    formatFixtureBucket(
      "Synthetic fixtures",
      report.syntheticPassedFixtures,
      report.syntheticFixtures,
      "(not counted as runtime coverage)",
    ),
  ].filter(Boolean);

  lines.push(...optionalBuckets);
  lines.push(`- Failed fixtures: ${report.failedFixtures === 0 ? "none" : report.failedFixtureIds.join(", ")}`);

  if (failed) {
    lines.push("");
    lines.push("### Failing fixtures");
    lines.push("");
    for (const result of report.results.filter((item) => item.failureClasses.length > 0)) {
      const fixtureKind = report.fixtureKinds[result.fixtureId] ?? "runtime";
      lines.push(`- \`${result.fixtureId}\` (${fixtureKind})`);
      lines.push(`  - failures: ${result.failureClasses.join(", ")}`);
      lines.push(`  - mode: expected \`${result.expectedMode}\`, actual \`${result.actualMode}\``);
      lines.push(`  - top1: \`${result.resultIds[0] ?? "-"}\`, latencyMs: \`${result.metrics.latencyMs.toFixed(2)}\``);
      const probeMismatches = formatProbeMismatches(result);
      if (probeMismatches) {
        lines.push(`  - probe mismatches: ${probeMismatches}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function renderEpisodeEvalSummary(reportPath) {
  const resolvedPath = path.resolve(reportPath);
  const raw = await fs.readFile(resolvedPath, "utf8");
  return formatEpisodeEvalSummary(JSON.parse(raw));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reportPath = resolveEpisodeEvalReportPath(process.argv, process.env);
  const summary = await renderEpisodeEvalSummary(reportPath);
  process.stdout.write(summary);
}
