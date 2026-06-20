import { describe, expect, it } from "vitest";
import { createDefaultEpisodeEvalFixtures } from "./eval-fixtures.js";

describe("default episode eval fixtures", () => {
  it("builds degraded startup fixture from the shared memory startup probe", async () => {
    const fixtures = await createDefaultEpisodeEvalFixtures();
    const degraded = fixtures.find((fixture) => fixture.id === "degraded-store-startup");

    expect(degraded).toBeDefined();
    expect(degraded?.fixtureKind).toBe("shared_memory_startup");
    expect(degraded?.actualMode).toBe("raw_audit_fallback");
    expect(degraded?.actualResults?.[0]?.explanation).toContain("Shared startup memory services degraded correctly");
  });
});
