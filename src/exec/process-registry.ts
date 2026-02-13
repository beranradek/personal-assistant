import { randomUUID } from "node:crypto";
import type { ProcessSession } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TTL_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const sessions = new Map<string, ProcessSession>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a new process session.
 *
 * @param command - The command that was executed
 * @param pid - The OS process ID
 * @returns A unique session ID
 */
export function addSession(command: string, pid: number): string {
  const id = randomUUID();
  const session: ProcessSession = {
    pid,
    command,
    output: "",
    exitCode: null,
    startedAt: new Date().toISOString(),
    exitedAt: null,
  };
  sessions.set(id, session);
  return id;
}

/**
 * Retrieve a session by its ID.
 *
 * @param id - The session ID returned by `addSession`
 * @returns The session, or `undefined` if not found
 */
export function getSession(id: string): ProcessSession | undefined {
  return sessions.get(id);
}

/**
 * Mark a session as exited with the given exit code.
 *
 * @param id - The session ID
 * @param exitCode - The process exit code
 */
export function markExited(id: string, exitCode: number): void {
  const session = sessions.get(id);
  if (!session) return;

  session.exitCode = exitCode;
  session.exitedAt = new Date().toISOString();
}

/**
 * List all registered sessions.
 *
 * @returns Array of `{ id, session }` entries
 */
export function listSessions(): Array<{ id: string; session: ProcessSession }> {
  const result: Array<{ id: string; session: ProcessSession }> = [];
  for (const [id, session] of sessions) {
    result.push({ id, session });
  }
  return result;
}

/**
 * Remove sessions older than the TTL (30 minutes from startedAt).
 */
export function cleanExpired(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    const startedAt = new Date(session.startedAt).getTime();
    if (now - startedAt > TTL_MS) {
      sessions.delete(id);
    }
  }
}

/**
 * Remove all sessions. Intended for test cleanup.
 */
export function clearAll(): void {
  sessions.clear();
}
