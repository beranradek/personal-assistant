import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createLogger } from "../core/logger.js";
import type { CronJob } from "./types.js";

const log = createLogger("cron-store");

/**
 * Load cron jobs from a JSON file.
 * Returns an empty array if the file doesn't exist, is corrupt, or is not a JSON array.
 */
export async function loadCronStore(filePath: string): Promise<CronJob[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  if (raw.trim() === "") {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      log.warn({ filePath }, "Cron store file does not contain an array, returning empty");
      return [];
    }
    return parsed as CronJob[];
  } catch {
    log.warn({ filePath }, "Corrupt cron store file, returning empty");
    return [];
  }
}

/**
 * Atomically save cron jobs to a JSON file.
 * Writes to a temporary file first, then renames (atomic on most filesystems).
 * Creates parent directories if needed.
 */
export async function saveCronStore(
  filePath: string,
  jobs: CronJob[],
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const tmpPath = filePath + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(jobs, null, 2), "utf-8");
  await fs.rename(tmpPath, filePath);
}
