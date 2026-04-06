/**
 * Integ-API Auth Loader
 * =====================
 *
 * Loads persisted OAuth2 credentials from the credential store
 * and registers them with the auth manager on server startup.
 *
 * A single Google OAuth2 credential (e.g. "google-personal") is registered
 * once per enabled service (gmail, calendar) so that each service can
 * resolve its own auth profile via AuthManager.getAccessToken(serviceId).
 */

import { createLogger } from "../../core/logger.js";
import type { CredentialStore } from "./store.js";
import type { AuthManager, OAuth2Credentials } from "./manager.js";

const log = createLogger("integ-api:auth:loader");

/**
 * Load all stored credential profiles and register them with the auth manager
 * for each enabled service.
 *
 * @param store    - Credential store to read from
 * @param authMgr  - Auth manager to register profiles into
 * @param services - List of enabled service IDs (e.g. ["gmail", "calendar"])
 */
export async function loadStoredProfiles(
  store: CredentialStore,
  authMgr: AuthManager,
  services: string[],
): Promise<void> {
  const allProfileIds = store.listProfiles();
  // Filter out composite IDs (e.g. "google-personal--calendar") that were
  // created by registerProfile on a previous run — only load base profiles.
  const serviceSuffixes = services.map((s) => `--${s}`);
  const profileIds = allProfileIds.filter(
    (id) => !serviceSuffixes.some((suffix) => id.endsWith(suffix)),
  );
  if (profileIds.length === 0) {
    log.info("No stored credential profiles found");
    return;
  }

  for (const profileId of profileIds) {
    const raw = await store.loadCredentials(profileId);
    if (!raw) continue;

    const creds = raw as OAuth2Credentials;
    if (!creds.clientId || !creds.refreshToken) {
      log.warn({ profileId }, "Skipping profile with missing credentials");
      continue;
    }

    // Register this credential for each enabled service
    for (const service of services) {
      const compositeId = `${profileId}--${service}`;
      await authMgr.registerProfile({
        id: compositeId,
        service,
        type: "oauth2",
        credentials: creds,
      });
    }

    log.info({ profileId, services }, "Loaded stored profile for services");
  }
}
