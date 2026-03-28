import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SystemEvent, Config } from "../core/types.js";
import { parseActiveHours } from "./scheduler.js";

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
