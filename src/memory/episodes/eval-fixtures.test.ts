import { describe, expect, it } from "vitest";
import { createDefaultEpisodeEvalFixtures } from "./eval-fixtures.js";

describe("default episode eval fixtures", () => {
  it("builds degraded startup fixtures with a shared degraded probe-state contract", async () => {
    const fixtures = await createDefaultEpisodeEvalFixtures();
    const degraded = fixtures.find((fixture) => fixture.id === "degraded-store-startup");
    const degradedDaemon = fixtures.find((fixture) => fixture.id === "degraded-daemon-startup");
    const expectedProbeState = {
      fallbackTriggered: true,
      warningTriggered: true,
      episodicSurfaceExposed: false,
      mcpServersInjected: true,
    };

    expect(degraded).toBeDefined();
    expect(degraded?.fixtureKind).toBe("terminal_startup_entrypoint");
    expect(degraded?.actualMode).toBe("raw_audit_fallback");
    expect(degraded?.probeStateExpected).toEqual(expectedProbeState);
    expect(degraded?.actualResults?.[0]?.explanation).toContain("Terminal session startup degraded correctly");
    expect(degradedDaemon?.fixtureKind).toBe("daemon_startup_entrypoint");
    expect(degradedDaemon?.probeStateExpected).toEqual(expectedProbeState);
    expect(degradedDaemon?.actualResults?.[0]?.explanation).toContain("Daemon startup degraded correctly");
  });
});
