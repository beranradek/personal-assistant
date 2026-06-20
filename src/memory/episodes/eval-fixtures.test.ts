import { describe, expect, it } from "vitest";
import { createDefaultEpisodeEvalFixtures } from "./eval-fixtures.js";

describe("default episode eval fixtures", () => {
  it("builds degraded startup fixture from the terminal startup entrypoint probe", async () => {
    const fixtures = await createDefaultEpisodeEvalFixtures();
    const degraded = fixtures.find((fixture) => fixture.id === "degraded-store-startup");
    const degradedDaemon = fixtures.find((fixture) => fixture.id === "degraded-daemon-startup");

    expect(degraded).toBeDefined();
    expect(degraded?.fixtureKind).toBe("terminal_startup_entrypoint");
    expect(degraded?.actualMode).toBe("raw_audit_fallback");
    expect(degraded?.probeStateExpected).toEqual({
      fallbackTriggered: true,
      warningTriggered: true,
      episodicSurfaceExposed: false,
    });
    expect(degraded?.actualResults?.[0]?.explanation).toContain("Terminal session startup degraded correctly");
    expect(degradedDaemon?.fixtureKind).toBe("daemon_startup_entrypoint");
    expect(degradedDaemon?.probeStateExpected).toEqual({
      fallbackTriggered: true,
      warningTriggered: true,
      episodicSurfaceExposed: false,
    });
    expect(degradedDaemon?.actualResults?.[0]?.explanation).toContain("Daemon startup degraded correctly");
  });
});
