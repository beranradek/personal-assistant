/**
 * Remote token file
 * =================
 *
 * The daemon creates a random bearer token when remote mode is on. It writes the token to `<configDir>/remote-token`
 * (mode 0600, atomic write). Local clients (`pa claude-remote-hook`, `pa remote`, the stdio MCP server) read this file.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { REMOTE_TOKEN_FILE } from "./protocol.js";

export interface RemoteTokenHandle {
  token: string;
  /** Absolute path of the token file. */
  path: string;
  /** Remove the token file. Never throws. */
  remove(): Promise<void>;
}

export function remoteTokenPath(configDir: string): string {
  return path.join(configDir, REMOTE_TOKEN_FILE);
}

/** Make a new random 32-byte hex token. Nothing is written to disk. */
export function generateRemoteToken(): string {
  return randomBytes(32).toString("hex");
}

/** Create a new token and write it to the token file. */
export async function createRemoteToken(configDir: string): Promise<RemoteTokenHandle> {
  return writeRemoteToken(configDir, generateRemoteToken());
}

/**
 * Write the token to the token file (replaces an old file). Call it only when this process owns the HTTP port.
 * `remove()` deletes the file only if it still holds this token, so it never deletes the file of another daemon.
 */
export async function writeRemoteToken(configDir: string, token: string): Promise<RemoteTokenHandle> {
  const filePath = remoteTokenPath(configDir);
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  // Atomic write: a reader never sees a half-written token.
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmpPath, `${token}\n`, { mode: 0o600, flag: "w" });
    await fs.chmod(tmpPath, 0o600);
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
  return {
    token,
    path: filePath,
    async remove() {
      if ((await readRemoteToken(configDir)) !== token) return;
      await fs.rm(filePath, { force: true }).catch(() => undefined);
    },
  };
}

/** Read the token of a running daemon. Returns undefined when the file is missing or empty. */
export async function readRemoteToken(configDir: string): Promise<string | undefined> {
  try {
    const value = (await fs.readFile(remoteTokenPath(configDir), "utf8")).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}
