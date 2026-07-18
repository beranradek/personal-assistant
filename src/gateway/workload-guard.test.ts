import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findActiveWorkloadLock } from "./workload-guard.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workload-guard-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("findActiveWorkloadLock", () => {
  it("ignores malformed lock files and removes them", async () => {
    const dir = makeTempDir();
    const lockPath = path.join(dir, "broken.lock");
    fs.writeFileSync(lockPath, "{broken");

    await expect(findActiveWorkloadLock([lockPath])).resolves.toBeNull();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("ignores lock files without a valid pid and removes them", async () => {
    const dir = makeTempDir();
    const lockPath = path.join(dir, "missing-pid.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ reason: "test" }));

    await expect(findActiveWorkloadLock([lockPath])).resolves.toBeNull();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("ignores stale lock files for dead processes and removes them", async () => {
    const dir = makeTempDir();
    const lockPath = path.join(dir, "stale.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999 }));

    await expect(findActiveWorkloadLock([lockPath])).resolves.toBeNull();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("returns a live lock when the pid is active", async () => {
    const dir = makeTempDir();
    const lockPath = path.join(dir, "active.lock");
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        reason: "local autoworker test run",
        command: "pnpm test:safe",
      }),
    );

    await expect(findActiveWorkloadLock([lockPath])).resolves.toEqual(
      expect.objectContaining({
        path: lockPath,
        pid: process.pid,
        reason: "local autoworker test run",
        command: "pnpm test:safe",
      }),
    );
  });
});
