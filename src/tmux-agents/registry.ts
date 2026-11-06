import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createLogger } from "../core/logger.js";
import { PERMISSION_MODES } from "./kinds.js";
import { TmuxAgentError } from "./errors.js";

const log = createLogger("tmux-agents-registry");

export const SESSION_STATES = ["running", "stopped", "lost"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** Owner record of one agent session. Ownership = this record plus matching tmux id and creation time. */
export const SessionRecordSchema = z.strictObject({
  /** Label `pa-<project>-<4 hex>`; never used as a tmux target. */
  name: z.string().min(1),
  project: z.string().min(1),
  kind: z.string().min(1),
  cwd: z.string().min(1),
  permissionMode: z.enum(PERMISSION_MODES),
  createdAt: z.string().min(1),
  creatorPid: z.number().int(),
  /** Id of the service instance that created the record. */
  instanceId: z.string().min(1),
  tmuxSessionId: z.string().regex(/^\$\d+$/),
  tmuxPaneId: z.string().regex(/^%\d+$/),
  /** `#{session_created}` (epoch seconds): detects a reused session id after a tmux server restart. */
  tmuxCreated: z.string().regex(/^\d+$/),
  lastInputAt: z.string().optional(),
  state: z.enum(SESSION_STATES),
  /** When the record became `stopped` or `lost`; terminal records are pruned after `TERMINAL_RECORD_RETENTION_MS`. */
  endedAt: z.string().optional(),
  recoveredFrom: z.string().optional(),
});

export type SessionRecord = z.infer<typeof SessionRecordSchema>;

const RegistryFileSchema = z.strictObject({
  version: z.literal(1),
  sessions: z.array(SessionRecordSchema),
});

export interface RegistrySnapshot {
  records: SessionRecord[];
  /** The file exists but is unreadable or invalid. Sessions are then not adopted and `start` is refused. */
  corrupt: boolean;
}

export interface Registry {
  read(): Promise<RegistrySnapshot>;
  /**
   * Locked read-modify-write. `fn` gets a copy of the records and returns the new records plus a result.
   * The lock is held only for this call: never run tmux calls inside `fn`.
   */
  mutate<T>(fn: (records: SessionRecord[]) => { records: SessionRecord[]; result: T }): Promise<T>;
}

export interface RegistryOptions {
  /** Directory of `registry.json` (created with mode 0700). */
  dir: string;
  lockStaleMs?: number;
  /** A lock of a dead pid counts as stale only after this age (the pid may live in another PID namespace). */
  lockDeadPidMinAgeMs?: number;
  lockWaitMs?: number;
  lockPollMs?: number;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
}

const DEFAULT_LOCK_STALE_MS = 10_000;
const DEFAULT_LOCK_DEAD_PID_MIN_AGE_MS = 2_000;
const LOCK_STALE_SUFFIX = ".stale-";
/** Stopped and lost records are kept this long (history for `list`), then dropped. */
export const TERMINAL_RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_LOCK_WAIT_MS = 5_000;
const DEFAULT_LOCK_POLL_MS = 20;

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const errCode = (err: unknown) => (err as NodeJS.ErrnoException).code;
const exists = (p: string) => fs.access(p).then(() => true, () => false);

export function createRegistry(options: RegistryOptions): Registry {
  const file = path.join(options.dir, "registry.json");
  const lockDir = `${file}.lock`;
  const staleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  const deadPidMinAgeMs = options.lockDeadPidMinAgeMs ?? DEFAULT_LOCK_DEAD_PID_MIN_AGE_MS;
  const waitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  const pollMs = options.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
  const now = options.now ?? Date.now;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;

  async function read(): Promise<RegistrySnapshot> {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf-8");
    } catch (err) {
      if (errCode(err) === "ENOENT") return { records: [], corrupt: false };
      throw err;
    }
    try {
      return { records: RegistryFileSchema.parse(JSON.parse(raw)).sessions, corrupt: false };
    } catch (err) {
      log.warn({ file, err }, "Corrupt tmux agent registry, treating it as empty");
      return { records: [], corrupt: true };
    }
  }

  async function write(records: SessionRecord[]): Promise<void> {
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify({ version: 1, sessions: records }, null, 2), { encoding: "utf-8", mode: 0o600 });
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }

  /** Whether a lock directory is stale: older than `staleMs`, or owned by a dead process and older than `deadPidMinAgeMs`. */
  async function isStale(dir: string): Promise<boolean> {
    try {
      const owner = JSON.parse(await fs.readFile(path.join(dir, "owner.json"), "utf-8")) as { pid: number; ts: number };
      const age = now() - owner.ts;
      return age > staleMs || (age > deadPidMinAgeMs && !isPidAlive(owner.pid));
    } catch {
      // No (readable) owner file yet: the owner may still be writing it. Fall back to the directory age.
      try {
        return now() - (await fs.stat(dir)).mtimeMs > staleMs;
      } catch {
        return false;
      }
    }
  }

  /**
   * Take over a stale lock by an atomic rename: only the process whose rename succeeds removes the old directory.
   * Staleness is checked before the rename, so a lock that a faster process just re-created could be renamed by
   * mistake. The renamed directory is checked again and put back when it turns out to be fresh, but only while
   * `lockDir` is still free: `rename` would silently replace a directory that another process just created.
   * Residual risk (a few filesystem calls wide, needs a crashed holder plus two more contenders): the fresh lock
   * is dropped and its owner loses mutual exclusion for one write.
   */
  async function takeOverStale(): Promise<void> {
    const stale = `${lockDir}${LOCK_STALE_SUFFIX}${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      await fs.rename(lockDir, stale);
    } catch {
      return; // another process won the takeover (or the owner just released)
    }
    if (!(await isStale(stale)) && !(await exists(lockDir))) {
      try {
        await fs.rename(stale, lockDir);
        return;
      } catch {
        // lockDir was re-created meanwhile: fall through and remove the renamed copy
      }
    }
    await fs.rm(stale, { recursive: true, force: true });
  }

  /** Remove `.stale-*` directories that a crashed process left behind (best effort, once per registry instance). */
  let staleDirsCleaned = false;
  async function cleanLeftovers(): Promise<void> {
    if (staleDirsCleaned) return;
    staleDirsCleaned = true;
    const base = `${path.basename(lockDir)}${LOCK_STALE_SUFFIX}`;
    try {
      for (const name of await fs.readdir(options.dir)) {
        if (!name.startsWith(base)) continue;
        const full = path.join(options.dir, name);
        if (now() - (await fs.stat(full)).mtimeMs > staleMs) await fs.rm(full, { recursive: true, force: true });
      }
    } catch (err) {
      log.debug({ err }, "Could not clean leftover tmux agent lock directories");
    }
  }

  async function acquire(): Promise<string> {
    await fs.mkdir(options.dir, { recursive: true, mode: 0o700 });
    await cleanLeftovers();
    const deadline = now() + waitMs;
    const token = randomBytes(8).toString("hex");
    for (;;) {
      try {
        await fs.mkdir(lockDir);
      } catch (err) {
        if (errCode(err) !== "EEXIST") throw err;
        if (await isStale(lockDir)) {
          await takeOverStale();
          continue;
        }
        if (now() >= deadline) throw new TmuxAgentError("TMUX_ERROR", "Timed out waiting for the registry lock");
        await sleep(pollMs);
        continue;
      }
      try {
        await fs.writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, ts: now(), token }));
        return token;
      } catch (err) {
        // Without owner.json nobody could release this lock: do not leave a directory that stalls all writers.
        await fs.rm(lockDir, { recursive: true, force: true });
        throw err;
      }
    }
  }

  async function release(token: string): Promise<void> {
    try {
      const owner = JSON.parse(await fs.readFile(path.join(lockDir, "owner.json"), "utf-8")) as { token?: string };
      if (owner.token !== token) return; // our lock was taken over; do not remove the new owner's lock
    } catch {
      return;
    }
    await fs.rm(lockDir, { recursive: true, force: true });
  }

  return {
    read,
    async mutate(fn) {
      const token = await acquire();
      try {
        const snapshot = await read();
        if (snapshot.corrupt) {
          throw new TmuxAgentError("TMUX_ERROR", "registry corrupt, manual repair needed");
        }
        const { records, result } = fn([...snapshot.records]);
        await write(records);
        return result;
      } finally {
        await release(token);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Reconcile (pure)
// ---------------------------------------------------------------------------

export interface LiveSession {
  name: string;
  sessionId: string;
  created: string;
}

export interface ReconcileResult {
  /** Running records whose tmux session is still alive (same id and creation time). */
  adopt: SessionRecord[];
  /** Running records without a live session with their id (or whose id is now used by another session). */
  markLost: SessionRecord[];
  /** Live sessions with our prefix that no running record owns. Logged only, never touched. */
  ignoreForeign: LiveSession[];
}

/**
 * Drop stopped and lost records that ended longer ago than `retentionMs`, so the file (and every read-modify-write)
 * does not grow forever. Records from before `endedAt` existed use their last activity instead.
 */
export function pruneTerminal(
  records: readonly SessionRecord[],
  nowMs: number,
  retentionMs: number = TERMINAL_RECORD_RETENTION_MS,
): SessionRecord[] {
  return records.filter((r) => {
    if (r.state === "running") return true;
    const ended = Date.parse(r.endedAt ?? r.lastInputAt ?? r.createdAt);
    return Number.isNaN(ended) || nowMs - ended <= retentionMs;
  });
}

/** Compare the registry with the live sessions of OUR tmux server. Matches by id and creation time, never by name. */
export function reconcile(records: readonly SessionRecord[], live: readonly LiveSession[], prefix: string): ReconcileResult {
  const running = records.filter((r) => r.state === "running");
  const owns = (r: SessionRecord, l: LiveSession) => r.tmuxSessionId === l.sessionId && r.tmuxCreated === l.created;
  const adopt = running.filter((r) => live.some((l) => owns(r, l)));
  const markLost = running.filter((r) => !live.some((l) => owns(r, l)));
  const ignoreForeign = live.filter((l) => l.name.startsWith(prefix) && !running.some((r) => owns(r, l)));
  return { adopt, markLost, ignoreForeign };
}
