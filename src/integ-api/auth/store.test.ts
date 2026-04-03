/**
 * Tests for integ-api CredentialStore.
 *
 * GWT verification:
 * 1. Given valid credentials, When saveCredentials is called, Then file is written with 0o600 perms
 * 2. Given saved credentials, When loadCredentials is called, Then returns the saved object
 * 3. Given no credentials, When loadCredentials is called, Then returns null
 * 4. Given saved credentials, When deleteCredentials is called, Then file is removed
 * 5. Given an invalid profileId (path traversal), When saveCredentials is called, Then throws
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createCredentialStore } from "./store.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "integ-api-store-test-"));
}

function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CredentialStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmDir(tmpDir);
  });

  it("creates credentials directory with 0o700 on first save", async () => {
    const store = createCredentialStore(tmpDir);
    const credDir = path.join(tmpDir, "integ-api", "credentials");

    expect(fs.existsSync(credDir)).toBe(false);

    await store.saveCredentials("profile-1", { accessToken: "tok" });

    expect(fs.existsSync(credDir)).toBe(true);
    const stat = fs.statSync(credDir);
    // Check owner-only permissions (0o700)
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("writes credential file with 0o600 permissions", async () => {
    const store = createCredentialStore(tmpDir);
    const creds = { accessToken: "abc", refreshToken: "def" };

    await store.saveCredentials("profile-test", creds);

    const filePath = path.join(tmpDir, "integ-api", "credentials", "profile-test.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const stat = fs.statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("reads back saved credentials", async () => {
    const store = createCredentialStore(tmpDir);
    const creds = {
      clientId: "client-123",
      clientSecret: "secret-456",
      refreshToken: "rt",
      accessToken: "at",
      expiresAt: 9999999999999,
    };

    await store.saveCredentials("my-profile", creds);
    const loaded = await store.loadCredentials("my-profile");

    expect(loaded).toEqual(creds);
  });

  it("returns null when credentials file does not exist", async () => {
    const store = createCredentialStore(tmpDir);
    const result = await store.loadCredentials("nonexistent");
    expect(result).toBeNull();
  });

  it("deletes credentials file", async () => {
    const store = createCredentialStore(tmpDir);
    await store.saveCredentials("del-profile", { token: "x" });

    const filePath = path.join(tmpDir, "integ-api", "credentials", "del-profile.json");
    expect(fs.existsSync(filePath)).toBe(true);

    await store.deleteCredentials("del-profile");
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("deleteCredentials is a no-op when file does not exist", async () => {
    const store = createCredentialStore(tmpDir);
    // Should not throw
    await expect(store.deleteCredentials("ghost-profile")).resolves.toBeUndefined();
  });

  it("rejects path traversal in profileId", async () => {
    const store = createCredentialStore(tmpDir);
    await expect(store.saveCredentials("../evil", {})).rejects.toThrow("Invalid profileId");
    await expect(store.loadCredentials("../../etc/passwd")).rejects.toThrow("Invalid profileId");
  });

  it("overwrites existing credentials on second save", async () => {
    const store = createCredentialStore(tmpDir);
    await store.saveCredentials("p1", { token: "old" });
    await store.saveCredentials("p1", { token: "new" });

    const loaded = await store.loadCredentials("p1") as Record<string, unknown>;
    expect(loaded?.["token"]).toBe("new");

    // Permissions should still be 0o600
    const filePath = path.join(tmpDir, "integ-api", "credentials", "p1.json");
    const stat = fs.statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
