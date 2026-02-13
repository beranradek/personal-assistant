import { SystemEvent } from "../core/types.js";

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
 * Returns `true` when the agent response is just "HEARTBEAT_OK"
 * (case-insensitive, allowing surrounding whitespace).
 */
export function isHeartbeatOk(response: string): boolean {
  return /^\s*HEARTBEAT_OK\s*$/i.test(response.trim());
}
