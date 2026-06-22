import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function resolveEpisodeEvalReportPath(argv = process.argv, env = process.env) {
  return argv[2] || env.EPISODE_EVAL_OUTPUT_PATH || "./tmp/episode-eval-report.json";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertEpisodeEvalReportShape(report) {
  if (!isRecord(report)) {
    throw new Error("top-level value must be an object");
  }

  const requiredNumberFields = [
    "runtimeFixtures",
    "runtimePassedFixtures",
    "terminalStartupEntrypointFixtures",
    "terminalStartupEntrypointPassedFixtures",
    "daemonStartupEntrypointFixtures",
    "daemonStartupEntrypointPassedFixtures",
    "sharedMemoryStartupFixtures",
    "sharedMemoryStartupPassedFixtures",
    "sharedStartupWiringFixtures",
    "sharedStartupWiringPassedFixtures",
    "syntheticFixtures",
    "syntheticPassedFixtures",
    "failedFixtures",
  ];

  if (typeof report.generatedAt !== "string" || report.generatedAt.length === 0) {
    throw new Error("generatedAt must be a non-empty string");
  }

  for (const field of requiredNumberFields) {
    if (typeof report[field] !== "number") {
      throw new Error(`${field} must be a number`);
    }
  }

  if (!Array.isArray(report.failedFixtureIds)) {
    throw new Error("failedFixtureIds must be an array");
  }

  if (!isRecord(report.fixtureKinds)) {
    throw new Error("fixtureKinds must be an object");
  }

  if (!Array.isArray(report.results)) {
    throw new Error("results must be an array");
  }

  for (const result of report.results) {
    if (!isRecord(result)) {
      throw new Error("results entries must be objects");
    }
    if (typeof result.fixtureId !== "string" || result.fixtureId.length === 0) {
      throw new Error("result.fixtureId must be a non-empty string");
    }
    if (!Array.isArray(result.failureClasses)) {
      throw new Error("result.failureClasses must be an array");
    }
    if (!Array.isArray(result.resultIds)) {
      throw new Error("result.resultIds must be an array");
    }
    if (!isRecord(result.metrics) || typeof result.metrics.latencyMs !== "number") {
      throw new Error("result.metrics.latencyMs must be a number");
    }
    if (!Array.isArray(result.probeStateMismatches)) {
      throw new Error("result.probeStateMismatches must be an array");
    }
  }
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
  let raw;
  try {
    raw = await fs.readFile(resolvedPath, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      throw new Error(`Episode eval report not found at ${resolvedPath}`, { cause: error });
    }
    throw new Error(`Episode eval report at ${resolvedPath} could not be read (${String(code ?? "unknown error")})`, {
      cause: error,
    });
  }

  let report;
  try {
    report = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Episode eval report at ${resolvedPath} is not valid JSON`, { cause: error });
  }

  try {
    assertEpisodeEvalReportShape(report);
    return formatEpisodeEvalSummary(report);
  } catch (error) {
    throw new Error(`Episode eval report at ${resolvedPath} has an invalid summary shape`, { cause: error });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const reportPath = resolveEpisodeEvalReportPath(process.argv, process.env);
    const summary = await renderEpisodeEvalSummary(reportPath);
    process.stdout.write(summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
