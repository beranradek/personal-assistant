/**
 * Weekly Reflection — Memory Synthesis
 * =====================================
 *
 * Reads the daily reflection files from the previous ISO week, synthesises
 * them into a single consolidated weekly summary via the Anthropic API, and
 * writes the output to {workspaceDir}/memory/weekly-{YYYY-Www}.md.
 *
 * The pipeline is:
 *   1. Determine last week's ISO week identifier (YYYY-Www)
 *   2. Idempotency check — skip if weekly file already exists
 *   3. Scan memory/ for daily reflection files belonging to last week
 *   4. Skip if no daily reflections found for that week
 *   5. Call Anthropic API with the WEEKLY_REFLECTION_PROMPT template
 *   6. Write output to memory/weekly-{YYYY-Www}.md with YAML frontmatter
 *
 * The memory watcher automatically picks up the new file for indexing.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { callAnthropicForReflection } from "./daily-reflection.js";
import { createLogger } from "../core/logger.js";
import type { Config } from "../core/types.js";

const log = createLogger("weekly-reflection");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to the weekly synthesis system prompt template */
export const WEEKLY_REFLECTION_PROMPT_PATH = path.resolve(
  __dirname,
  "..",
  "templates",
  "WEEKLY_REFLECTION_PROMPT.md",
);

// ---------------------------------------------------------------------------
// ISO week helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Return the ISO week number (1–53) for a given date.
 * Uses the standard algorithm: week containing the first Thursday of the year.
 */
export function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Thursday in current week decides the year
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/**
 * Return the ISO week year for a given date.
 * (Can differ from calendar year at year boundaries.)
 */
export function getISOWeekYear(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  return d.getUTCFullYear();
}

/**
 * Return the ISO week identifier string for the week containing `date`,
 * formatted as "YYYY-Www" (e.g. "2026-W14").
 */
export function getWeekIdentifier(date: Date): string {
  const week = getISOWeek(date);
  const year = getISOWeekYear(date);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * Return the ISO week identifier for the week before the one containing `now`.
 */
export function getLastWeekIdentifier(now?: Date): string {
  const d = new Date(now ?? new Date());
  d.setDate(d.getDate() - 7);
  return getWeekIdentifier(d);
}

/**
 * Return the Monday and Sunday (inclusive) dates of the ISO week identified
 * by a "YYYY-Www" string, as "YYYY-MM-DD" strings.
 */
export function getWeekDateRange(weekId: string): { start: string; end: string } {
  const match = weekId.match(/^(\d{4})-W(\d{2})$/);
  if (!match) throw new Error(`Invalid week identifier: ${weekId}`);
  const year = parseInt(match[1]!, 10);
  const week = parseInt(match[2]!, 10);

  // ISO week 1 contains the first Thursday of the year.
  // Monday of week 1: find Jan 4 (always in week 1), go back to Monday.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const mondayOfWeek1 = new Date(jan4);
  mondayOfWeek1.setUTCDate(jan4.getUTCDate() - (jan4.getUTCDay() || 7) + 1);

  const monday = new Date(mondayOfWeek1);
  monday.setUTCDate(mondayOfWeek1.getUTCDate() + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);

  return {
    start: monday.toISOString().slice(0, 10),
    end: sunday.toISOString().slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

/**
 * Collect daily reflection file paths from {workspaceDir}/memory/ whose date
 * falls within [startDate, endDate] (both inclusive, YYYY-MM-DD strings).
 */
export async function collectDailyReflectionsForWeek(
  workspaceDir: string,
  startDate: string,
  endDate: string,
): Promise<string[]> {
  const memoryDir = path.join(workspaceDir, "memory");
  let entries: string[];
  try {
    entries = await fs.readdir(memoryDir);
  } catch {
    return [];
  }

  const result: string[] = [];
  for (const entry of entries) {
    const m = entry.match(/^reflection-(\d{4}-\d{2}-\d{2})\.md$/);
    if (!m) continue;
    const dateStr = m[1]!;
    if (dateStr >= startDate && dateStr <= endDate) {
      result.push(path.join(memoryDir, entry));
    }
  }
  result.sort(); // chronological order
  return result;
}

// ---------------------------------------------------------------------------
// Daily reflection cleanup
// ---------------------------------------------------------------------------

/**
 * Delete daily reflection files older than `retentionDays` from
 * {workspaceDir}/memory/. Files whose date is within retentionDays are kept.
 *
 * Called after weekly synthesis so that synthesised daily files are pruned
 * once they're no longer needed as raw source material.
 *
 * @param workspaceDir   - Workspace directory
 * @param retentionDays  - Files older than this many days are deleted (0 = skip)
 */
export async function cleanupOldDailyReflections(
  workspaceDir: string,
  retentionDays: number,
): Promise<void> {
  if (retentionDays <= 0) return;

  const memoryDir = path.join(workspaceDir, "memory");
  let entries: string[];
  try {
    entries = await fs.readdir(memoryDir);
  } catch {
    return;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

  for (const entry of entries) {
    const m = entry.match(/^reflection-(\d{4}-\d{2}-\d{2})\.md$/);
    if (!m) continue;
    const dateStr = m[1]!;
    if (dateStr < cutoffStr) {
      try {
        await fs.unlink(path.join(memoryDir, entry));
        log.info({ file: entry }, "Deleted old daily reflection file");
      } catch (err) {
        log.warn({ err, file: entry }, "Failed to delete old daily reflection file");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * Run the weekly reflection synthesis pipeline for last week.
 *
 * Reads all daily reflection files from the previous ISO week, synthesises
 * them via the Anthropic API, and writes the result to
 * {workspaceDir}/memory/weekly-{YYYY-Www}.md.
 *
 * Idempotent — skips if the weekly file already exists.
 * Non-fatal — errors are logged but never thrown to avoid blocking the daemon.
 */
export async function runWeeklyReflection(
  config: Config,
  workspaceDir: string,
): Promise<void> {
  if (!config.reflection.enabled || !config.reflection.weeklyEnabled) {
    log.debug("Weekly reflection disabled — skipping");
    return;
  }

  const weekId = getLastWeekIdentifier();
  const outputPath = path.join(workspaceDir, "memory", `weekly-${weekId}.md`);

  // Idempotency check — synthesis is skipped but cleanup still runs below
  let alreadyExists = false;
  try {
    await fs.access(outputPath);
    log.info({ weekId }, "Weekly reflection file already exists — skipping synthesis");
    alreadyExists = true;
  } catch {
    // File doesn't exist — proceed with synthesis
  }

  if (!alreadyExists) {
    const { start, end } = getWeekDateRange(weekId);
    const dailyFiles = await collectDailyReflectionsForWeek(workspaceDir, start, end);

    if (dailyFiles.length === 0) {
      log.info({ weekId, start, end }, "No daily reflections found for last week — skipping synthesis");
    } else {
      await synthesiseWeek(config, workspaceDir, weekId, dailyFiles, outputPath);
    }
  }

  // Always run cleanup (covers files from weeks daemon was offline)
  await cleanupOldDailyReflections(workspaceDir, config.reflection.dailyRetentionDays);
}

/**
 * Inner synthesis pipeline — called only when the weekly output file does not
 * yet exist and there are daily files to process.
 */
async function synthesiseWeek(
  config: Config,
  workspaceDir: string,
  weekId: string,
  dailyFiles: string[],
  outputPath: string,
): Promise<void> {

  // Read and concatenate daily reflection files
  const parts: string[] = [];
  for (const filePath of dailyFiles) {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      // Strip YAML frontmatter
      const stripped = raw.replace(/^---[\s\S]*?---\n/, "").trim();
      if (stripped) {
        const dateMatch = path.basename(filePath).match(/reflection-(\d{4}-\d{2}-\d{2})\.md/);
        const dateLabel = dateMatch?.[1] ?? path.basename(filePath);
        parts.push(`### ${dateLabel}\n\n${stripped}`);
      }
    } catch (err) {
      log.warn({ err, filePath }, "Failed to read daily reflection file — skipping");
    }
  }

  if (parts.length === 0) {
    log.info({ weekId }, "All daily reflection files were empty — skipping");
    return;
  }

  const combinedText = parts.join("\n\n---\n\n");

  // Load the weekly synthesis prompt template
  let systemPrompt: string;
  try {
    systemPrompt = await fs.readFile(WEEKLY_REFLECTION_PROMPT_PATH, "utf-8");
  } catch (err) {
    log.error({ err }, "Failed to read WEEKLY_REFLECTION_PROMPT template — skipping");
    return;
  }

  // Call Anthropic API
  let llmResponse: string;
  try {
    llmResponse = await callAnthropicForReflection(
      systemPrompt,
      combinedText,
      config.session.summarizationModel,
    );
  } catch (err) {
    log.error({ err, weekId }, "LLM call failed during weekly reflection — skipping");
    return;
  }

  const trimmed = llmResponse.trim();
  if (!trimmed || trimmed === "(nothing to extract)") {
    log.info({ weekId }, "LLM found nothing to extract for weekly synthesis — skipping");
    return;
  }

  const { start, end } = getWeekDateRange(weekId);

  const fileContent = [
    "---",
    `week: ${weekId}`,
    `period: ${start} to ${end}`,
    `daily_count: ${dailyFiles.length}`,
    "---",
    "",
    trimmed,
    "",
  ].join("\n");

  // Ensure memory/ dir exists
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true, mode: 0o700 });

  try {
    await fs.writeFile(outputPath, fileContent, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx", // atomic: fail if already exists
    });
    log.info({ weekId, dailyCount: dailyFiles.length }, "Weekly reflection written");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      log.info({ weekId }, "Weekly reflection file created concurrently — skipping");
    } else {
      log.error({ err, weekId }, "Failed to write weekly reflection file");
    }
  }
}
