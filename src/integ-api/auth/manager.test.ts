/**
 * Tests for integ-api AuthManager.
 *
 * GWT verification:
 * 1. Given valid OAuth2 credentials, When getAccessToken is called, Then returns the current access token
 * 2. Given an expired access token, When getAccessToken is called, Then it refreshes and returns new token
 * 3. Given refresh fails for profile[0], When getAccessToken is called, Then it tries profile[1]
 * 4. Given all profiles fail, When getAccessToken is called, Then it returns auth_failed error
 * 5. Given a profile has 3 consecutive failures, When getAccessToken is called within cooldown, Then skips that profile
 * 6. Unit test rotation logic with 2 mock profiles
 * 7. Unit test cooldown timer resets after success
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createAuthManager,
  AuthFailedError,
  type AuthProfileConfig,
  type OAuth2Credentials,
} from "./manager.js";
import type { CredentialStore } from "./store.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a no-op in-memory credential store for tests. */
function makeMemoryStore(): CredentialStore {
  const data = new Map<string, object>();
  return {
    async saveCredentials(id, creds) { data.set(id, creds); },
    async loadCredentials(id) { return data.get(id) ?? null; },
    async deleteCredentials(id) { data.delete(id); },
  };
}

/** Create a valid (non-expired) set of OAuth2 credentials. */
function makeCreds(overrides?: Partial<OAuth2Credentials>): OAuth2Credentials {
  return {
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshToken: "refresh-token",
    accessToken: "access-token",
    expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour from now
    ...overrides,
  };
}

/** Create a profile config. */
function makeProfile(id: string, service: string, creds?: Partial<OAuth2Credentials>): AuthProfileConfig {
  return {
    id,
    service,
    type: "oauth2",
    credentials: makeCreds(creds),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AuthManager", () => {
  let store: CredentialStore;

  beforeEach(() => {
    store = makeMemoryStore();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1: Valid credentials — returns current token
  // -------------------------------------------------------------------------

  it("GWT1: returns current access token when credentials are valid", async () => {
    const manager = createAuthManager(store);
    const profile = makeProfile("p1", "gmail");
    await manager.registerProfile(profile);

    const result = await manager.getAccessToken("gmail");

    expect(result.token).toBe("access-token");
    expect(result.profileId).toBe("p1");
  });

  // -------------------------------------------------------------------------
  // Test 2: Expired token — refreshes and returns new token
  // -------------------------------------------------------------------------

  it("GWT2: refreshes expired token and returns new access token", async () => {
    const manager = createAuthManager(store);
    // Expired credentials (expiresAt in the past)
    const profile = makeProfile("p1", "gmail", { expiresAt: Date.now() - 1000, accessToken: "old-token" });
    await manager.registerProfile(profile);

    // Mock the fetch call for token refresh
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "new-token", expires_in: 3600, token_type: "Bearer" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await manager.getAccessToken("gmail");

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(result.token).toBe("new-token");
    expect(result.profileId).toBe("p1");

    // Verify credentials were persisted with new token
    const saved = await store.loadCredentials("p1") as { accessToken: string };
    expect(saved?.accessToken).toBe("new-token");
  });

  // -------------------------------------------------------------------------
  // Test 3: First profile refresh fails — falls back to second profile
  // -------------------------------------------------------------------------

  it("GWT3: tries next profile when first profile token refresh fails", async () => {
    const manager = createAuthManager(store);

    // Profile 0: expired — refresh will fail
    const p0 = makeProfile("p0", "gmail", { expiresAt: Date.now() - 1000, accessToken: "old-p0" });
    // Profile 1: valid token
    const p1 = makeProfile("p1", "gmail", { accessToken: "good-token-p1" });

    await manager.registerProfile(p0);
    await manager.registerProfile(p1);

    // First fetch call (for p0 refresh) fails; second call should not be needed
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network error"));

    const result = await manager.getAccessToken("gmail");

    expect(result.token).toBe("good-token-p1");
    expect(result.profileId).toBe("p1");
  });

  // -------------------------------------------------------------------------
  // Test 4: All profiles fail → AuthFailedError with profilesTried count
  // -------------------------------------------------------------------------

  it("GWT4: throws AuthFailedError when all profiles fail", async () => {
    const manager = createAuthManager(store);

    const p0 = makeProfile("p0", "gmail", { expiresAt: Date.now() - 1000 });
    const p1 = makeProfile("p1", "gmail", { expiresAt: Date.now() - 1000 });

    await manager.registerProfile(p0);
    await manager.registerProfile(p1);

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("all fail"));

    await expect(manager.getAccessToken("gmail")).rejects.toThrow(AuthFailedError);

    try {
      await manager.getAccessToken("gmail");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthFailedError);
      const authErr = err as AuthFailedError;
      expect(authErr.service).toBe("gmail");
      expect(authErr.profilesTried).toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------------------------
  // Test 5: 3 consecutive failures → profile enters cooldown → skipped
  // -------------------------------------------------------------------------

  it("GWT5: skips profile in cooldown after 3 consecutive failures", async () => {
    const manager = createAuthManager(store);

    const p0 = makeProfile("p0", "gmail");
    const p1 = makeProfile("p1", "gmail", { accessToken: "fallback-token" });

    await manager.registerProfile(p0);
    await manager.registerProfile(p1);

    // Trigger 3 failures for p0
    manager.markFailed("p0");
    manager.markFailed("p0");
    manager.markFailed("p0"); // enters cooldown

    const result = await manager.getAccessToken("gmail");

    // p0 skipped (in cooldown), p1 used
    expect(result.token).toBe("fallback-token");
    expect(result.profileId).toBe("p1");
  });

  // -------------------------------------------------------------------------
  // Test 6: Rotation logic with 2 mock profiles
  // -------------------------------------------------------------------------

  it("GWT6: rotates through profiles in registration order", async () => {
    const manager = createAuthManager(store);

    const p0 = makeProfile("p0", "calendar", { accessToken: "tok-p0" });
    const p1 = makeProfile("p1", "calendar", { accessToken: "tok-p1" });

    await manager.registerProfile(p0);
    await manager.registerProfile(p1);

    // p0 should be first
    const r1 = await manager.getAccessToken("calendar");
    expect(r1.profileId).toBe("p0");
    expect(r1.token).toBe("tok-p0");

    // Mark p0 failed 3 times → cooldown
    manager.markFailed("p0");
    manager.markFailed("p0");
    manager.markFailed("p0");

    // Now p1 should be used
    const r2 = await manager.getAccessToken("calendar");
    expect(r2.profileId).toBe("p1");
    expect(r2.token).toBe("tok-p1");
  });

  // -------------------------------------------------------------------------
  // Test 7: Cooldown resets after success
  // -------------------------------------------------------------------------

  it("GWT7: cooldown resets after markSuccess", async () => {
    const manager = createAuthManager(store);

    const p0 = makeProfile("p0", "gmail", { accessToken: "tok-p0" });
    await manager.registerProfile(p0);

    // Enter cooldown
    manager.markFailed("p0");
    manager.markFailed("p0");
    manager.markFailed("p0");

    // Verify profile is skipped (in cooldown)
    const p1 = makeProfile("p1", "gmail", { accessToken: "tok-p1" });
    await manager.registerProfile(p1);

    const r1 = await manager.getAccessToken("gmail");
    expect(r1.profileId).toBe("p1"); // p0 in cooldown

    // Advance time past cooldown (5 minutes + 1ms)
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    // Now p0 should be available again
    const r2 = await manager.getAccessToken("gmail");
    expect(r2.profileId).toBe("p0");
  });

  // -------------------------------------------------------------------------
  // Additional: no profiles for service → AuthFailedError with 0 profilesTried
  // -------------------------------------------------------------------------

  it("throws AuthFailedError immediately if no profiles registered for service", async () => {
    const manager = createAuthManager(store);

    await expect(manager.getAccessToken("unknown-service")).rejects.toThrow(AuthFailedError);

    try {
      await manager.getAccessToken("unknown-service");
    } catch (err) {
      const e = err as AuthFailedError;
      expect(e.profilesTried).toBe(0);
      expect(e.service).toBe("unknown-service");
    }
  });

  // -------------------------------------------------------------------------
  // Additional: registerProfile persists to store
  // -------------------------------------------------------------------------

  it("registerProfile persists credentials to store", async () => {
    const manager = createAuthManager(store);
    const creds = makeCreds({ accessToken: "stored-token" });
    await manager.registerProfile({ id: "sp1", service: "gmail", type: "oauth2", credentials: creds });

    const saved = await store.loadCredentials("sp1") as { accessToken: string };
    expect(saved?.accessToken).toBe("stored-token");
  });

  // -------------------------------------------------------------------------
  // Additional: listProfiles returns profile IDs for service
  // -------------------------------------------------------------------------

  it("listProfiles returns all profile IDs for a given service", async () => {
    const manager = createAuthManager(store);
    await manager.registerProfile(makeProfile("a", "gmail"));
    await manager.registerProfile(makeProfile("b", "gmail"));
    await manager.registerProfile(makeProfile("c", "calendar"));

    expect(manager.listProfiles("gmail")).toEqual(["a", "b"]);
    expect(manager.listProfiles("calendar")).toEqual(["c"]);
    expect(manager.listProfiles("sheets")).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Additional: markSuccess resets consecutive failure counter
  // -------------------------------------------------------------------------

  it("markSuccess resets failure counter so cooldown requires 3 new failures", async () => {
    const manager = createAuthManager(store);
    await manager.registerProfile(makeProfile("p0", "gmail", { accessToken: "tok" }));

    manager.markFailed("p0");
    manager.markFailed("p0"); // 2 failures, no cooldown yet
    manager.markSuccess("p0"); // reset

    // Only 2 more failures after reset — should NOT enter cooldown
    manager.markFailed("p0");
    manager.markFailed("p0");

    // p0 should still be accessible (no cooldown)
    const result = await manager.getAccessToken("gmail");
    expect(result.profileId).toBe("p0");
  });

  // -------------------------------------------------------------------------
  // Additional: refreshToken updates store credentials
  // -------------------------------------------------------------------------

  it("refreshToken updates credentials in store after successful refresh", async () => {
    const manager = createAuthManager(store);
    const profile = makeProfile("rp1", "gmail", { expiresAt: Date.now() - 1000 });
    await manager.registerProfile(profile);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "refreshed", expires_in: 3600, token_type: "Bearer" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const token = await manager.refreshToken("rp1");
    expect(token).toBe("refreshed");

    const saved = await store.loadCredentials("rp1") as { accessToken: string };
    expect(saved?.accessToken).toBe("refreshed");
  });

  // -------------------------------------------------------------------------
  // getAccessTokenForProfile — targets a specific profile
  // -------------------------------------------------------------------------

  it("getAccessTokenForProfile returns token for a specific profile", async () => {
    const manager = createAuthManager(store);
    await manager.registerProfile(makeProfile("p0", "gmail", { accessToken: "tok-p0" }));
    await manager.registerProfile(makeProfile("p1", "gmail", { accessToken: "tok-p1" }));

    const result = await manager.getAccessTokenForProfile("p1");
    expect(result.token).toBe("tok-p1");
    expect(result.profileId).toBe("p1");
  });

  it("getAccessTokenForProfile throws when profile is in cooldown", async () => {
    const manager = createAuthManager(store);
    await manager.registerProfile(makeProfile("p0", "gmail", { accessToken: "tok" }));

    // Enter cooldown
    manager.markFailed("p0");
    manager.markFailed("p0");
    manager.markFailed("p0");

    await expect(manager.getAccessTokenForProfile("p0")).rejects.toThrow("cooldown");
  });

  it("getAccessTokenForProfile refreshes expired token", async () => {
    const manager = createAuthManager(store);
    await manager.registerProfile(makeProfile("p0", "gmail", { expiresAt: Date.now() - 1000 }));

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600, token_type: "Bearer" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await manager.getAccessTokenForProfile("p0");
    expect(result.token).toBe("fresh");
  });
});
