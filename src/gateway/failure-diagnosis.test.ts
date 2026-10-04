import { describe, expect, it } from "vitest";
import {
  describeHostProblems,
  formatFailureMessage,
  parseWatchdogKill,
  type FailureContext,
  type HostSnapshot,
} from "./failure-diagnosis.js";

const healthy: HostSnapshot = {
  memPressureAvg60: 1,
  memAvailableMb: 2000,
  load1PerCpu: 0.2,
  cpuCount: 2,
  diskFreeMb: 20_000,
};

const overloaded: HostSnapshot = {
  memPressureAvg60: 88.35,
  memAvailableMb: 120,
  load1PerCpu: 12.9,
  cpuCount: 2,
  diskFreeMb: 700,
};

function ctx(overrides: Partial<FailureContext>): FailureContext {
  return {
    errorMessage: "boom",
    signal: null,
    lock: null,
    watchdogKill: null,
    host: healthy,
    ...overrides,
  };
}

describe("parseWatchdogKill", () => {
  const now = new Date("2026-10-04T10:45:30Z");
  const line = (ts: string) =>
    `${ts} TARGET reason="codex turn exceeded 2700s (age=2714s)" root=1 cmd="x"`;

  it("returns the latest recent kill", () => {
    const tail = `${line("2026-10-04T08:46:39+00:00")}\n${line("2026-10-04T10:45:16+00:00")}\n`;
    expect(parseWatchdogKill(tail, now)).toEqual({
      at: new Date("2026-10-04T10:45:16+00:00"),
      reason: "codex turn exceeded 2700s (age=2714s)",
    });
  });

  it("ignores kills older than five minutes", () => {
    expect(parseWatchdogKill(line("2026-10-04T10:00:00+00:00"), now)).toBeNull();
  });

  it("ignores non-TARGET lines and empty input", () => {
    expect(parseWatchdogKill("2026-10-04T10:45:16+00:00 other\n", now)).toBeNull();
    expect(parseWatchdogKill("", now)).toBeNull();
  });
});

describe("describeHostProblems", () => {
  it("is empty for a healthy host or missing snapshot", () => {
    expect(describeHostProblems(healthy)).toEqual([]);
    expect(describeHostProblems(null)).toEqual([]);
  });

  it("names every overload dimension", () => {
    const text = describeHostProblems(overloaded).join("; ");
    expect(text).toContain("memory pressure (88%");
    expect(text).toContain("120 MB RAM available");
    expect(text).toContain("load 25.8 on 2 cores");
    expect(text).toContain("700 MB free");
  });
});

describe("formatFailureMessage", () => {
  it("attributes a SIGTERM to the watchdog with its reason", () => {
    const text = formatFailureMessage(
      ctx({
        signal: "SIGTERM",
        watchdogKill: { at: new Date(), reason: "codex turn exceeded 2700s" },
        host: overloaded,
      }),
    );
    expect(text).toContain("terminated by SIGTERM");
    expect(text).toContain("codex-watchdog: codex turn exceeded 2700s");
    expect(text).toContain("Host state:");
  });

  it("hints at the OOM killer for SIGKILL", () => {
    const text = formatFailureMessage(ctx({ signal: "SIGKILL" }));
    expect(text).toContain("terminated by SIGKILL");
    expect(text).toContain("OOM killer");
    expect(text.endsWith("Please try again.")).toBe(true);
  });

  it("keeps the generic SIGTERM wording on a healthy host", () => {
    const text = formatFailureMessage(ctx({ signal: "SIGTERM" }));
    expect(text).toContain("terminated by SIGTERM");
    expect(text).toContain("competing local workload");
    expect(text).not.toContain("Host state:");
  });

  it("prefers the protected workload explanation when a lock is active", () => {
    const text = formatFailureMessage(
      ctx({
        signal: "SIGTERM",
        lock: { path: "p", pid: 1, startedAt: null, reason: "heavy tests", command: null },
      }),
    );
    expect(text).toContain("protected local workload is active (heavy tests)");
  });

  it("explains a turn timeout in minutes", () => {
    const text = formatFailureMessage(
      ctx({
        errorMessage: "Codex agent turn timed out after 3600000ms and was aborted",
        host: overloaded,
      }),
    );
    expect(text).toContain("60-minute turn time limit");
    expect(text).toContain("Host state:");
    expect(text).not.toContain("something went wrong");
  });

  it("falls back to a generic message with a short cause excerpt", () => {
    const text = formatFailureMessage(ctx({ errorMessage: `agent failure\n${"x".repeat(500)}` }));
    expect(text).toContain("something went wrong");
    expect(text).toContain("Cause: agent failure.");
    expect(text.length).toBeLessThan(250);
  });

  it("truncates long single-line causes", () => {
    const text = formatFailureMessage(ctx({ errorMessage: "y".repeat(500) }));
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(300);
  });
});
