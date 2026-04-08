import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SystemEvent, Config } from "../core/types.js";
import { parseActiveHours } from "./scheduler.js";
import { loadState, saveState, diffState } from "./state.js";
import {
  loadHabits,
  checkAutoHabits,
  resetDaily,
  markHabit,
  formatHabitStatus,
} from "./habits.js";

/**
 * Standard heartbeat prompt — generates a fresh timestamp on each call
 * so the agent always sees the current time.
 */
export const HEARTBEAT_PROMPT = (): string =>
  `Read HEARTBEAT.md if it exists. Follow its instructions strictly. Check what needs attention. The current time is ${new Date().toISOString()}. If nothing needs your attention, respond with HEARTBEAT_OK.`;

/**
 * Prompt used when a background command has completed.
 */
export const EXEC_EVENT_PROMPT = (event: SystemEvent): string =>
  `A background command completed. Details: "${event.text}". Check the result and notify the user if there is something important. If nothing noteworthy, respond with HEARTBEAT_OK.`;

/**
 * Prompt used when a scheduled cron reminder fires.
 */
export const CRON_EVENT_PROMPT = (event: SystemEvent): string =>
  `A scheduled reminder fired: "${event.text}". Act on this reminder. Notify the user if needed. If no action needed, respond with HEARTBEAT_OK.`;

/**
 * Choose the right heartbeat prompt based on pending system events.
 *
 * Priority: exec events first, then cron events, then the standard heartbeat.
 */
export function resolveHeartbeatPrompt(events: SystemEvent[]): string {
  // Check for exec events first
  const execEvent = events.find((e) => e.type === "exec");
  if (execEvent) return EXEC_EVENT_PROMPT(execEvent);

  // Then cron events
  const cronEvent = events.find((e) => e.type === "cron");
  if (cronEvent) return CRON_EVENT_PROMPT(cronEvent);

  // Standard heartbeat
  return HEARTBEAT_PROMPT();
}

/**
 * Returns `true` when the agent response contains "HEARTBEAT_OK"
 * anywhere in the text (case-insensitive).
 */
export function isHeartbeatOk(response: string): boolean {
  return /HEARTBEAT_OK/i.test(response);
}

// ---------------------------------------------------------------------------
// Morning / evening heartbeat detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the current hour matches the morning heartbeat hour:
 * max(start working hour, morningHour).
 */
export function isMorningHeartbeat(config: Config, now?: Date): boolean {
  const { start } = parseActiveHours(config.heartbeat.activeHours);
  const morningHour = Math.max(start, config.heartbeat.morningHour);
  const hour = (now ?? new Date()).getHours();
  return hour === morningHour;
}

/**
 * Returns true if the current hour matches the evening heartbeat hour:
 * min(end working hour, eveningHour).
 */
export function isEveningHeartbeat(config: Config, now?: Date): boolean {
  const { end } = parseActiveHours(config.heartbeat.activeHours);
  const eveningHour = Math.min(end, config.heartbeat.eveningHour);
  const hour = (now ?? new Date()).getHours();
  return hour === eveningHour;
}

/**
 * Returns the daily log path relative to the workspace for the given date.
 */
function getDailyLogRelativePath(now?: Date): string {
  const date = (now ?? new Date()).toISOString().slice(0, 10); // YYYY-MM-DD
  return `daily/${date}.jsonl`;
}

/**
 * Build a diff-aware heartbeat prompt that highlights only what changed since
 * the last heartbeat. If stateDiffing is disabled or there is no previous state,
 * returns `basePrompt` unchanged. Always saves the new state before returning.
 *
 * @param basePrompt - The base prompt string (from resolveHeartbeatPrompt)
 * @param dataDir - Directory where heartbeat-state.json is persisted
 * @param currentContext - Current context items to diff against previous state
 * @param enabled - Whether state diffing is enabled (config.heartbeat.stateDiffing)
 */
export async function buildDiffAwarePrompt(
  basePrompt: string,
  dataDir: string,
  currentContext: string[],
  enabled: boolean,
): Promise<string> {
  // Always save current state so next run has a baseline
  const now = new Date().toISOString();

  if (!enabled) {
    await saveState(dataDir, { lastRun: now, snapshot: {}, notifiedItems: currentContext });
    return basePrompt;
  }

  const previous = await loadState(dataDir);

  // Save new state immediately (even before building prompt, so a crash doesn't lose state)
  await saveState(dataDir, { lastRun: now, snapshot: {}, notifiedItems: currentContext });

  if (!previous) {
    // First run — no diff to report
    return basePrompt;
  }

  const { newItems, resolvedItems, unchanged } = diffState(previous, currentContext);

  // If nothing changed, no diff section needed
  if (newItems.length === 0 && resolvedItems.length === 0) {
    return basePrompt;
  }

  const parts: string[] = [
    `Changes since last heartbeat at ${previous.lastRun}:`,
  ];
  if (newItems.length > 0) {
    parts.push(`New: ${newItems.join("; ")}.`);
  }
  if (resolvedItems.length > 0) {
    parts.push(`Resolved: ${resolvedItems.join("; ")}.`);
  }
  parts.push(`Unchanged: ${unchanged.length} item(s).`);

  return `${basePrompt}\n\n${parts.join(" ")}`;
}

/**
 * If the current heartbeat is a morning or evening heartbeat, load the
 * corresponding extra prompt file (HEARTBEAT_MORNING.md or HEARTBEAT_EVENING.md)
 * from the workspace, substitute the {{DAILY_LOG}} placeholder, and append it
 * to `basePrompt`.  Returns `basePrompt` unchanged when neither condition applies
 * or when the template file is absent.
 */
export async function appendMorningEveningContent(
  basePrompt: string,
  config: Config,
  workspace: string,
  now?: Date,
): Promise<string> {
  let templateFile: string | null = null;

  if (isMorningHeartbeat(config, now)) {
    templateFile = "HEARTBEAT_MORNING.md";
  } else if (isEveningHeartbeat(config, now)) {
    templateFile = "HEARTBEAT_EVENING.md";
  }

  if (!templateFile) return basePrompt;

  let content: string;
  try {
    content = await fs.readFile(path.join(workspace, templateFile), "utf-8");
  } catch {
    return basePrompt; // File missing – gracefully skip
  }

  // Replace {{DAILY_LOG}} with the actual relative path to today's daily log
  const dailyLogPath = getDailyLogRelativePath(now);
  const extra = content.replace(/\{\{DAILY_LOG\}\}/g, dailyLogPath);

  if (!extra.trim()) return basePrompt;

  return `${basePrompt}\n\n${extra}`;
}

/**
 * If the current heartbeat is a morning heartbeat, load yesterday's reflection
 * file ({workspace}/memory/reflection-YYYY-MM-DD.md) and append its contents
 * to the prompt under a "## Yesterday's Reflection" header.
 *
 * Returns `basePrompt` unchanged when:
 *  - It is not a morning heartbeat
 *  - The reflection file does not exist (daemon was off, or first run)
 */
export async function appendYesterdayReflection(
  basePrompt: string,
  config: Config,
  workspace: string,
  now?: Date,
): Promise<string> {
  if (!isMorningHeartbeat(config, now)) return basePrompt;

  const yesterday = new Date(now ?? new Date());
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().slice(0, 10);
  const reflectionPath = path.join(workspace, "memory", `reflection-${dateStr}.md`);

  let content: string;
  try {
    content = await fs.readFile(reflectionPath, "utf-8");
  } catch {
    return basePrompt; // File missing — gracefully skip
  }

  // Strip YAML frontmatter (--- ... ---) before injecting
  const stripped = content.replace(/^---[\s\S]*?---\n/, "").trim();
  if (!stripped) return basePrompt;

  return `${basePrompt}\n\n## Yesterday's Reflection (${dateStr})\n\n${stripped}`;
}

/**
 * If habits tracking is enabled, append the current habit status to the prompt.
 *
 * - Morning heartbeat: call resetDaily() to archive yesterday and reset today's
 *   checklist, then include fresh status.
 * - Regular and evening heartbeats: run auto-detection, update HABITS.md for any
 *   newly completed auto-pillars, then include status with an evening nudge.
 *
 * Returns `basePrompt` unchanged when habits are disabled or HABITS.md is absent.
 */
export async function appendHabitContent(
  basePrompt: string,
  config: Config,
  workspacePath: string,
  now?: Date,
): Promise<string> {
  if (!config.habits.enabled) return basePrompt;

  const morning = isMorningHeartbeat(config, now);
  const evening = isEveningHeartbeat(config, now);

  // Morning: reset daily checklist first (idempotent)
  if (morning) {
    await resetDaily(workspacePath, now);
  }

  const data = await loadHabits(workspacePath);
  if (!data || data.pillars.length === 0) return basePrompt;

  // Run auto-detection and persist results to HABITS.md
  if (!morning) {
    const autoResults = await checkAutoHabits(workspacePath, data.pillars);
    for (const [pillarId, done] of Object.entries(autoResults)) {
      if (done) {
        const pillar = data.pillars.find((p) => p.id === pillarId);
        if (pillar) {
          await markHabit(workspacePath, pillar.label, true);
          // Update in-memory checklist too
          data.checklist[pillar.label] = true;
        }
      }
    }
  }

  const statusLine = formatHabitStatus(data.checklist, data.pillars);

  const parts: string[] = [`Habits: ${statusLine}`];

  if (evening) {
    const unchecked = data.pillars.filter((p) => !data.checklist[p.label]);
    if (unchecked.length > 0) {
      parts.push(
        `You have ${unchecked.length} unchecked habit(s) remaining today: ${unchecked.map((p) => p.label).join(", ")}. Consider nudging the user.`,
      );
    } else {
      parts.push("All habits completed today! Congratulate the user.");
    }
  }

  return `${basePrompt}\n\n${parts.join(" ")}`;
}
