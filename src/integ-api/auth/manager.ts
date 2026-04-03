/**
 * Integ-API Auth Manager
 * ======================
 *
 * Manages OAuth2 access tokens for all integrations with:
 * - Multi-profile registration and rotation
 * - Automatic token refresh via Google OAuth2 token endpoint
 * - Cooldown logic after consecutive failures (3 failures → 5 minute backoff)
 * - Auth rotation: on failure, tries next profile; after all fail → auth_failed
 *
 * Google OAuth2 token endpoint docs:
 * https://developers.google.com/identity/protocols/oauth2/web-server#offline
 * POST https://oauth2.googleapis.com/token
 * Required fields: client_id, client_secret, refresh_token, grant_type=refresh_token
 */

import { createLogger } from "../../core/logger.js";
import type { CredentialStore } from "./store.js";

const log = createLogger("integ-api:auth:manager");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Google OAuth2 token endpoint. */
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Number of consecutive failures before entering cooldown. */
const FAILURE_THRESHOLD = 3;

/** Cooldown duration after hitting the failure threshold (ms). */
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/** Refresh a token this many ms before it expires (eager refresh). */
const EXPIRY_BUFFER_MS = 60 * 1000; // 1 minute

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** OAuth2 credentials stored per profile. */
export interface OAuth2Credentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string;
  /** Unix timestamp (ms) when the access token expires. */
  expiresAt: number;
}

/** Configuration passed when registering a profile. */
export interface AuthProfileConfig {
  id: string;
  service: string;
  type: "oauth2";
  credentials: OAuth2Credentials;
}

/** Runtime state for a registered profile. */
interface ProfileState {
  config: AuthProfileConfig;
  credentials: OAuth2Credentials;
  consecutiveFailures: number;
  cooldownUntil: number; // unix timestamp ms, 0 = no cooldown
}

/** Result of a successful getAccessToken call. */
export interface TokenResult {
  token: string;
  profileId: string;
}

// ---------------------------------------------------------------------------
// AuthManager interface
// ---------------------------------------------------------------------------

export interface AuthManager {
  /**
   * Register a profile. Overwrites any existing profile with the same id.
   * Persists credentials to the store.
   */
  registerProfile(profile: AuthProfileConfig): Promise<void>;

  /**
   * Get a valid access token for the given service.
   *
   * Tries profiles in registration order:
   * - Skips profiles in cooldown
   * - Refreshes expired tokens automatically
   * - On 401/403 failures, moves to the next profile
   * - If all profiles fail, returns auth_failed error
   *
   * @throws AuthFailedError if no profile can provide a token
   */
  getAccessToken(serviceId: string): Promise<TokenResult>;

  /**
   * Explicitly refresh the token for a specific profile.
   * Updates credentials in-memory and in the store.
   *
   * @returns The new access token
   */
  refreshToken(profileId: string): Promise<string>;

  /**
   * Mark a profile as having failed (e.g., received 401/403).
   * Increments failure count; after FAILURE_THRESHOLD, activates cooldown.
   * Resets failure count to 0 on success (getAccessToken resolved).
   */
  markFailed(profileId: string): void;

  /**
   * Mark a profile as having succeeded. Resets consecutive failure count.
   */
  markSuccess(profileId: string): void;

  /**
   * List all registered profile IDs for a service.
   */
  listProfiles(serviceId: string): string[];
}

// ---------------------------------------------------------------------------
// AuthFailedError
// ---------------------------------------------------------------------------

export class AuthFailedError extends Error {
  readonly profilesTried: number;
  readonly service: string;

  constructor(service: string, profilesTried: number) {
    super(`Authentication failed for service "${service}" after trying ${profilesTried} profile(s)`);
    this.name = "AuthFailedError";
    this.profilesTried = profilesTried;
    this.service = service;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Return true if the access token is expired (or will expire within buffer). */
function isExpired(credentials: OAuth2Credentials): boolean {
  return Date.now() >= credentials.expiresAt - EXPIRY_BUFFER_MS;
}

/** Call Google OAuth2 token endpoint to exchange refresh_token for a new access token. */
async function fetchNewAccessToken(credentials: OAuth2Credentials): Promise<{
  accessToken: string;
  expiresAt: number;
}> {
  // POST https://oauth2.googleapis.com/token
  // Body: client_id, client_secret, refresh_token, grant_type=refresh_token
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "(unreadable)");
    throw new Error(`Token refresh failed: HTTP ${response.status} — ${errorText}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
    token_type: string;
  };

  if (!data.access_token) {
    throw new Error("Token refresh response missing access_token");
  }

  const expiresAt = Date.now() + data.expires_in * 1000;
  return { accessToken: data.access_token, expiresAt };
}

// ---------------------------------------------------------------------------
// createAuthManager
// ---------------------------------------------------------------------------

/**
 * Create an auth manager backed by the given credential store.
 *
 * @param store - Credential store for persisting OAuth2 tokens
 */
export function createAuthManager(store: CredentialStore): AuthManager {
  /** Map from profileId → runtime state. Ordered by insertion. */
  const profiles = new Map<string, ProfileState>();

  function getProfile(profileId: string): ProfileState {
    const state = profiles.get(profileId);
    if (!state) throw new Error(`Auth profile not found: "${profileId}"`);
    return state;
  }

  /** Return profiles for a service in registration order. */
  function profilesForService(serviceId: string): ProfileState[] {
    return [...profiles.values()].filter((p) => p.config.service === serviceId);
  }

  const manager: AuthManager = {
    async registerProfile(profile: AuthProfileConfig): Promise<void> {
      const state: ProfileState = {
        config: profile,
        credentials: { ...profile.credentials },
        consecutiveFailures: 0,
        cooldownUntil: 0,
      };
      profiles.set(profile.id, state);
      await store.saveCredentials(profile.id, profile.credentials);
      log.info({ profileId: profile.id, service: profile.service }, "Auth profile registered");
    },

    async getAccessToken(serviceId: string): Promise<TokenResult> {
      const candidates = profilesForService(serviceId);
      if (candidates.length === 0) {
        throw new AuthFailedError(serviceId, 0);
      }

      let profilesTried = 0;

      for (const state of candidates) {
        const now = Date.now();

        // Skip profiles in cooldown
        if (state.cooldownUntil > now) {
          const remainingMs = state.cooldownUntil - now;
          log.debug(
            { profileId: state.config.id, remainingMs },
            "Profile in cooldown, skipping",
          );
          continue;
        }

        profilesTried++;

        try {
          // Refresh token if expired
          if (isExpired(state.credentials)) {
            log.debug({ profileId: state.config.id }, "Token expired, refreshing");
            await manager.refreshToken(state.config.id);
          }

          // Success — reset failure count
          manager.markSuccess(state.config.id);

          return { token: state.credentials.accessToken, profileId: state.config.id };
        } catch (err) {
          log.warn({ err, profileId: state.config.id }, "Failed to get token for profile, trying next");
          manager.markFailed(state.config.id);
          // Continue to next profile
        }
      }

      throw new AuthFailedError(serviceId, profilesTried);
    },

    async refreshToken(profileId: string): Promise<string> {
      const state = getProfile(profileId);

      log.debug({ profileId }, "Refreshing OAuth2 access token");
      const { accessToken, expiresAt } = await fetchNewAccessToken(state.credentials);

      // Update in-memory credentials
      state.credentials.accessToken = accessToken;
      state.credentials.expiresAt = expiresAt;

      // Persist updated credentials
      await store.saveCredentials(profileId, state.credentials);

      log.info({ profileId, expiresAt }, "Token refreshed successfully");
      return accessToken;
    },

    markFailed(profileId: string): void {
      const state = getProfile(profileId);
      state.consecutiveFailures++;

      if (state.consecutiveFailures >= FAILURE_THRESHOLD) {
        state.cooldownUntil = Date.now() + COOLDOWN_MS;
        log.warn(
          {
            profileId,
            consecutiveFailures: state.consecutiveFailures,
            cooldownMs: COOLDOWN_MS,
          },
          "Profile entered cooldown after repeated failures",
        );
      } else {
        log.debug(
          { profileId, consecutiveFailures: state.consecutiveFailures },
          "Profile failure recorded",
        );
      }
    },

    markSuccess(profileId: string): void {
      const state = getProfile(profileId);
      if (state.consecutiveFailures > 0) {
        log.debug({ profileId }, "Profile success — resetting failure count");
      }
      state.consecutiveFailures = 0;
      state.cooldownUntil = 0;
    },

    listProfiles(serviceId: string): string[] {
      return profilesForService(serviceId).map((p) => p.config.id);
    },
  };

  return manager;
}
