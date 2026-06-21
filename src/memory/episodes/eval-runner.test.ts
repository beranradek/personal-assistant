import { describe, expect, it } from "vitest";
import { createDefaultEpisodeEvalFixtures } from "./eval-fixtures.js";
import { evaluateEpisodeFixture, type EpisodeEvalFixture } from "./eval.js";
import { evaluateEpisodeFixtures, formatEpisodeEvalReport } from "./eval-runner.js";

describe("episode eval runner", () => {
  it("evaluates the default fixture corpus without failures", async () => {
    const report = evaluateEpisodeFixtures(await createDefaultEpisodeEvalFixtures());

    expect(report.totalFixtures).toBe(7);
    expect(report.passedFixtures).toBe(7);
    expect(report.failedFixtures).toBe(0);
    expect(report.runtimeFixtures).toBe(5);
    expect(report.syntheticFixtures).toBe(0);
    expect(report.sharedStartupWiringFixtures).toBe(0);
    expect(report.sharedMemoryStartupFixtures).toBe(0);
    expect(report.terminalStartupEntrypointFixtures).toBe(1);
    expect(report.daemonStartupEntrypointFixtures).toBe(1);
    expect(report.runtimePassedFixtures).toBe(5);
    expect(report.syntheticPassedFixtures).toBe(0);
    expect(report.sharedStartupWiringPassedFixtures).toBe(0);
    expect(report.sharedMemoryStartupPassedFixtures).toBe(0);
    expect(report.terminalStartupEntrypointPassedFixtures).toBe(1);
    expect(report.daemonStartupEntrypointPassedFixtures).toBe(1);
    expect(report.failedFixtureIds).toEqual([]);
    expect(report.fixtureKinds["degraded-store-startup"]).toBe("terminal_startup_entrypoint");
    expect(report.fixtureKinds["degraded-daemon-startup"]).toBe("daemon_startup_entrypoint");
  });

  it("formats a concise human-readable report", async () => {
    const report = evaluateEpisodeFixtures(await createDefaultEpisodeEvalFixtures());
    const text = formatEpisodeEvalReport(report);

    expect(text).toContain("Episode eval report: 5/5 runtime fixtures passed");
    expect(text).toContain("Terminal startup entrypoint fixtures: 1/1 passed");
    expect(text).toContain("Daemon startup entrypoint fixtures: 1/1 passed");
    expect(text).toContain("github-issue-success: PASS | kind=runtime");
    expect(text).toContain("degraded-store-startup: PASS | kind=terminal_startup_entrypoint");
    expect(text).toContain("degraded-daemon-startup: PASS | kind=daemon_startup_entrypoint");
    expect(text).not.toContain("probeMismatches=");
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
      {
        id: "daemon-helper",
        fixtureKind: "daemon_startup_entrypoint",
        insertedEpisodes: [],
        expectedMode: "raw_audit_fallback",
        actualMode: "raw_audit_fallback",
        actualResults: [{
          id: "daemon-startup-log",
          matchedFields: [],
          matchedFilters: [],
          explanation: "daemon fallback",
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
    expect(report.daemonStartupEntrypointFixtures).toBe(1);
    expect(text).toContain("Synthetic fixtures: 1/1 passed");
    expect(text).toContain("Terminal startup entrypoint fixtures: 1/1 passed");
    expect(text).toContain("Daemon startup entrypoint fixtures: 1/1 passed");
  });

  it("fails terminal entrypoint fixture when degraded probe state does not trigger", () => {
    const result = evaluateEpisodeFixture({
      id: "terminal-startup-healthy",
      fixtureKind: "terminal_startup_entrypoint",
      insertedEpisodes: [],
      expectedMode: "raw_audit_fallback",
      actualMode: "raw_audit_fallback",
      actualResults: [{
        id: "startup-log-terminal-fallback",
        matchedFields: [],
        matchedFilters: [],
        explanation: "Terminal session startup stayed fully available; degraded fallback did not trigger.",
      }],
      availabilityExpected: true,
      availabilityActual: true,
      probeStateExpected: {
        fallbackTriggered: true,
        warningTriggered: true,
        episodicSurfaceExposed: false,
        mcpServersInjected: true,
      },
      probeStateActual: {
        fallbackTriggered: false,
        warningTriggered: false,
        episodicSurfaceExposed: true,
        mcpServersInjected: true,
      },
      mustHitIds: ["startup-log-terminal-fallback"],
      expectedTop1Id: "startup-log-terminal-fallback",
    });

    expect(result.metrics.probeStateOk).toBe(false);
    expect(result.probeStateMismatches).toEqual([
      { key: "fallbackTriggered", expected: true, actual: false },
      { key: "warningTriggered", expected: true, actual: false },
      { key: "episodicSurfaceExposed", expected: false, actual: true },
    ]);
    expect(result.failureClasses).toContain("availability");
  });

  it("fails daemon entrypoint fixture when MCP servers were not injected", () => {
    const result = evaluateEpisodeFixture({
      id: "daemon-startup-missing-mcp",
      fixtureKind: "daemon_startup_entrypoint",
      insertedEpisodes: [],
      expectedMode: "raw_audit_fallback",
      actualMode: "raw_audit_fallback",
      actualResults: [{
        id: "startup-log-daemon-entrypoint-fallback",
        matchedFields: [],
        matchedFilters: [],
        explanation: "Daemon startup degraded correctly and continued without episodic surface.",
      }],
      availabilityExpected: true,
      availabilityActual: true,
      probeStateExpected: {
        fallbackTriggered: true,
        warningTriggered: true,
        episodicSurfaceExposed: false,
        mcpServersInjected: true,
      },
      probeStateActual: {
        fallbackTriggered: true,
        warningTriggered: true,
        episodicSurfaceExposed: false,
        mcpServersInjected: false,
      },
      mustHitIds: ["startup-log-daemon-entrypoint-fallback"],
      expectedTop1Id: "startup-log-daemon-entrypoint-fallback",
    });

    expect(result.metrics.probeStateOk).toBe(false);
    expect(result.probeStateMismatches).toEqual([
      { key: "mcpServersInjected", expected: true, actual: false },
    ]);
    expect(result.failureClasses).toContain("availability");
  });

  it("formats probe state mismatch details for failing entrypoint fixtures", () => {
    const report = evaluateEpisodeFixtures([
      {
        id: "terminal-startup-healthy",
        fixtureKind: "terminal_startup_entrypoint",
        insertedEpisodes: [],
        expectedMode: "raw_audit_fallback",
        actualMode: "raw_audit_fallback",
        actualResults: [{
          id: "startup-log-terminal-fallback",
          matchedFields: [],
          matchedFilters: [],
          explanation: "Terminal session startup stayed fully available; degraded fallback did not trigger.",
        }],
        availabilityExpected: true,
        availabilityActual: true,
        probeStateExpected: {
          fallbackTriggered: true,
          warningTriggered: true,
          episodicSurfaceExposed: false,
          mcpServersInjected: true,
        },
        probeStateActual: {
          fallbackTriggered: false,
          warningTriggered: false,
          episodicSurfaceExposed: true,
          mcpServersInjected: true,
        },
        mustHitIds: ["startup-log-terminal-fallback"],
        expectedTop1Id: "startup-log-terminal-fallback",
      },
    ]);

    const text = formatEpisodeEvalReport(report);
    expect(text).toContain("probeMismatches=fallbackTriggered:false!=true,warningTriggered:false!=true,episodicSurfaceExposed:true!=false");
  });
});
