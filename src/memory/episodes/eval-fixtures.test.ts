import { describe, expect, it } from "vitest";
import { createDefaultEpisodeEvalFixtures } from "./eval-fixtures.js";

describe("default episode eval fixtures", () => {
  it("builds degraded startup fixture from the terminal startup entrypoint probe", async () => {
    const fixtures = await createDefaultEpisodeEvalFixtures();
    const degraded = fixtures.find((fixture) => fixture.id === "degraded-store-startup");

    expect(degraded).toBeDefined();
    expect(degraded?.fixtureKind).toBe("terminal_startup_entrypoint");
    expect(degraded?.actualMode).toBe("raw_audit_fallback");
    expect(degraded?.actualResults?.[0]?.explanation).toContain("Terminal session startup degraded correctly");
  });
});
