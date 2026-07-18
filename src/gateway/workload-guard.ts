import * as fs from "node:fs/promises";

export interface WorkloadLockInfo {
  path: string;
  pid: number | null;
  startedAt: string | null;
  reason: string | null;
  command: string | null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function parseLockFile(lockPath: string): Promise<WorkloadLockInfo | null> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, "utf8");
  } catch {
    return null;
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    await fs.unlink(lockPath).catch(() => {});
    return null;
  }

  const pid =
    parsed && typeof parsed["pid"] === "number" && Number.isFinite(parsed["pid"])
      ? parsed["pid"]
      : null;

  if (pid === null || pid <= 0) {
    await fs.unlink(lockPath).catch(() => {});
    return null;
  }

  if (!isProcessAlive(pid)) {
    await fs.unlink(lockPath).catch(() => {});
    return null;
  }

  return {
    path: lockPath,
    pid,
    startedAt:
      parsed && typeof parsed["startedAt"] === "string"
        ? parsed["startedAt"]
        : null,
    reason:
      parsed && typeof parsed["reason"] === "string"
        ? parsed["reason"]
        : null,
    command:
      parsed && typeof parsed["command"] === "string"
        ? parsed["command"]
        : null,
  };
}

export async function findActiveWorkloadLock(
  lockPaths: string[],
): Promise<WorkloadLockInfo | null> {
  for (const lockPath of lockPaths) {
    const info = await parseLockFile(lockPath);
    if (info) return info;
  }
  return null;
}

export function formatWorkloadPauseMessage(lock: WorkloadLockInfo): string {
  const label = lock.reason?.trim() || "a local heavy workload";
  return `Assistant is temporarily paused because ${label} is running on this host. Please retry after it finishes.`;
}

export function formatSignalFailureMessage(
  signal: string,
  lock: WorkloadLockInfo | null,
): string {
  const suffix = lock
    ? ` A protected local workload is active (${lock.reason ?? "host workload"}).`
    : " This usually means the host killed or interrupted the worker process, often because of a competing local workload.";
  return `Sorry, the assistant subprocess was terminated by ${signal} while processing your message.${suffix} Please try again.`;
}
