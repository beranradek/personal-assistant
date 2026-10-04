import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatSignalFailureMessage, type WorkloadLockInfo } from "./workload-guard.js";

/** A turn killed by scripts/codex-watchdog.sh (read back from its log file). */
export interface WatchdogKill {
  at: Date;
  reason: string;
}

/** Best-effort snapshot of host health; any field is null when unreadable. */
export interface HostSnapshot {
  memPressureAvg60: number | null;
  memAvailableMb: number | null;
  load1PerCpu: number | null;
  cpuCount: number;
  diskFreeMb: number | null;
}

export interface FailureContext {
  errorMessage: string;
  signal: string | null;
  lock: WorkloadLockInfo | null;
  watchdogKill: WatchdogKill | null;
  host: HostSnapshot | null;
}

// The watchdog SIGTERMs a turn and the error reaches the queue within seconds;
// anything older than this is a different incident.
const WATCHDOG_KILL_MAX_AGE_MS = 5 * 60 * 1000;
const WATCHDOG_LOG_TAIL_BYTES = 256 * 1024;
const WATCHDOG_LOG_RELATIVE = path.join("logs", "codex-watchdog.log");
const MAX_DETAIL_CHARS = 160;

const MEM_PRESSURE_WARN_PERCENT = 30;
const MEM_AVAILABLE_WARN_MB = 300;
const LOAD_PER_CPU_WARN = 2;
const DISK_FREE_WARN_MB = 1024;

const WATCHDOG_LINE = /^(\S+) TARGET reason="([^"]*)"/;

export function parseWatchdogKill(
  logTail: string,
  now: Date = new Date(),
): WatchdogKill | null {
  const lines = logTail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = WATCHDOG_LINE.exec(lines[i]!);
    if (!match) continue;
    const at = new Date(match[1]!);
    if (Number.isNaN(at.getTime())) return null;
    if (now.getTime() - at.getTime() > WATCHDOG_KILL_MAX_AGE_MS) return null;
    return { at, reason: match[2]! };
  }
  return null;
}

export async function readRecentWatchdogKill(
  dataDir: string,
  now: Date = new Date(),
): Promise<WatchdogKill | null> {
  try {
    const handle = await fs.open(path.join(dataDir, WATCHDOG_LOG_RELATIVE), "r");
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, WATCHDOG_LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return parseWatchdogKill(buffer.toString("utf8"), now);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function readMemPressureAvg60(): Promise<number | null> {
  try {
    const raw = await fs.readFile("/proc/pressure/memory", "utf8");
    const match = /^some .*avg60=([\d.]+)/m.exec(raw);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function readMemAvailableMb(): Promise<number | null> {
  try {
    const raw = await fs.readFile("/proc/meminfo", "utf8");
    const match = /^MemAvailable:\s+(\d+) kB/m.exec(raw);
    return match ? Math.round(Number(match[1]) / 1024) : null;
  } catch {
    return null;
  }
}

async function readDiskFreeMb(dir: string): Promise<number | null> {
  try {
    const stats = await fs.statfs(dir);
    return Math.round((stats.bavail * stats.bsize) / (1024 * 1024));
  } catch {
    return null;
  }
}

export async function readHostSnapshot(dataDir: string): Promise<HostSnapshot> {
  const cpuCount = Math.max(1, os.cpus().length);
  const [memPressureAvg60, memAvailableMb, diskFreeMb] = await Promise.all([
    readMemPressureAvg60(),
    readMemAvailableMb(),
    readDiskFreeMb(dataDir),
  ]);
  return {
    memPressureAvg60,
    memAvailableMb,
    load1PerCpu: os.loadavg()[0]! / cpuCount,
    cpuCount,
    diskFreeMb,
  };
}

/** Human-readable findings about host overload; empty when the host looks healthy. */
export function describeHostProblems(host: HostSnapshot | null): string[] {
  if (!host) return [];
  const problems: string[] = [];
  if (host.memPressureAvg60 !== null && host.memPressureAvg60 >= MEM_PRESSURE_WARN_PERCENT) {
    problems.push(`heavy memory pressure (${Math.round(host.memPressureAvg60)}% stalled)`);
  }
  if (host.memAvailableMb !== null && host.memAvailableMb < MEM_AVAILABLE_WARN_MB) {
    problems.push(`only ${host.memAvailableMb} MB RAM available`);
  }
  if (host.load1PerCpu !== null && host.load1PerCpu >= LOAD_PER_CPU_WARN) {
    problems.push(
      `CPU overloaded (load ${(host.load1PerCpu * host.cpuCount).toFixed(1)} on ${host.cpuCount} cores)`,
    );
  }
  if (host.diskFreeMb !== null && host.diskFreeMb < DISK_FREE_WARN_MB) {
    problems.push(`low disk space (${host.diskFreeMb} MB free)`);
  }
  return problems;
}

function hostSuffix(host: HostSnapshot | null): string {
  const problems = describeHostProblems(host);
  return problems.length > 0 ? ` Host state: ${problems.join(", ")}.` : "";
}

function firstLineExcerpt(errorMessage: string): string {
  const line = errorMessage.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  return line.length > MAX_DETAIL_CHARS ? `${line.slice(0, MAX_DETAIL_CHARS)}…` : line;
}

/**
 * Builds the user-facing text for a failed turn, naming the most specific
 * cause we can establish (watchdog kill, turn timeout, OOM-style SIGKILL,
 * protected workload, host overload) before falling back to a generic notice.
 */
export function formatFailureMessage(ctx: FailureContext): string {
  const { errorMessage, signal, lock, watchdogKill, host } = ctx;

  if (signal && watchdogKill) {
    return (
      `Sorry, the assistant subprocess was terminated by ${signal} while processing your message. ` +
      `It was stopped by codex-watchdog: ${watchdogKill.reason}.` +
      `${hostSuffix(host)} Please try again, ideally with a smaller task.`
    );
  }

  if (signal) {
    const base = formatSignalFailureMessage(signal, lock);
    if (lock) return base;
    const oomHint =
      signal === "SIGKILL"
        ? " SIGKILL on this host usually means the kernel OOM killer ran out of RAM."
        : "";
    return base.replace(/ Please try again\.$/, `${oomHint}${hostSuffix(host)} Please try again.`);
  }

  const timeout = /timed out after (\d+)ms/.exec(errorMessage);
  if (timeout) {
    const minutes = Math.round(Number(timeout[1]) / 60_000);
    return (
      `Sorry, processing your message exceeded the ${minutes}-minute turn time limit and was aborted.` +
      `${hostSuffix(host)} Please try again, ideally with a smaller task.`
    );
  }

  const detail = firstLineExcerpt(errorMessage);
  return (
    "Sorry, something went wrong while processing your message." +
    `${detail ? ` Cause: ${detail}.` : ""}${hostSuffix(host)} Please try again.`
  );
}
