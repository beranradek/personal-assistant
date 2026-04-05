/**
 * Integ-API Credential Store
 * ==========================
 *
 * Secure file-based credential storage for OAuth2 tokens.
 *
 * Security guarantees:
 * - Credentials directory: 0o700 (owner-only rwx)
 * - Credential files: 0o600 (owner-only read/write)
 * - Stored as JSON, one file per profileId: {profileId}.json
 *
 * Location: {dataDir}/integ-api/credentials/{profileId}.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../../core/logger.js";

const log = createLogger("integ-api:auth:store");

// ---------------------------------------------------------------------------
// CredentialStore interface
// ---------------------------------------------------------------------------

export interface CredentialStore {
  saveCredentials(profileId: string, credentials: object): Promise<void>;
  loadCredentials(profileId: string): Promise<object | null>;
  deleteCredentials(profileId: string): Promise<void>;
  /** List all stored profile IDs (derived from filenames in the credentials directory). */
  listProfiles(): string[];
}

// ---------------------------------------------------------------------------
// createCredentialStore
// ---------------------------------------------------------------------------

/**
 * Create a file-based credential store.
 *
 * @param dataDir - The global dataDir from config (e.g., ~/.personal-assistant/data)
 */
export function createCredentialStore(dataDir: string): CredentialStore {
  const credDir = path.join(dataDir, "integ-api", "credentials");

  /** Ensure the credential directory exists with 0o700 permissions. */
  function ensureDir(): void {
    if (!fs.existsSync(credDir)) {
      fs.mkdirSync(credDir, { recursive: true, mode: 0o700 });
      log.info({ credDir }, "Created credentials directory");
    }
  }

  function credPath(profileId: string): string {
    // Prevent path traversal attacks
    const sanitized = path.basename(profileId);
    if (sanitized !== profileId || profileId.includes("..") || profileId.includes("/")) {
      throw new Error(`Invalid profileId: "${profileId}"`);
    }
    return path.join(credDir, `${sanitized}.json`);
  }

  return {
    async saveCredentials(profileId: string, credentials: object): Promise<void> {
      ensureDir();
      const filePath = credPath(profileId);
      const content = JSON.stringify(credentials, null, 2);
      // Write to temp file first, then rename for atomicity
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o600 });
      // Ensure correct permissions even if file already existed
      fs.chmodSync(tmpPath, 0o600);
      fs.renameSync(tmpPath, filePath);
      log.debug({ profileId }, "Credentials saved");
    },

    async loadCredentials(profileId: string): Promise<object | null> {
      const filePath = credPath(profileId);
      if (!fs.existsSync(filePath)) {
        return null;
      }
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        return JSON.parse(raw) as object;
      } catch (err) {
        log.error({ err, profileId }, "Failed to load credentials");
        return null;
      }
    },

    async deleteCredentials(profileId: string): Promise<void> {
      const filePath = credPath(profileId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        log.debug({ profileId }, "Credentials deleted");
      }
    },

    listProfiles(): string[] {
      if (!fs.existsSync(credDir)) return [];
      return fs
        .readdirSync(credDir)
        .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
        .map((f) => f.replace(/\.json$/, ""));
    },
  };
}
