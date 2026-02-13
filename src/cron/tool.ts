import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import type { CronJob } from "./types.js";
import { CronScheduleSchema, CronPayloadSchema } from "./types.js";
import { loadCronStore, saveCronStore } from "./store.js";
import { armTimer, type CronTimerHandle } from "./timer.js";
import { enqueueSystemEvent } from "../heartbeat/system-events.js";

export interface CronToolDeps {
  storePath: string;
  onJobFired?: (job: CronJob) => void | Promise<void>;
}

export interface CronToolResult {
  success: boolean;
  message: string;
  data?: unknown;
}

function validateCronExpression(expression: string): { valid: boolean; reason?: string } {
  try {
    CronExpressionParser.parse(expression, { tz: "UTC" });
    return { valid: true };
  } catch {
    return { valid: false, reason: `Invalid cron expression: "${expression}"` };
  }
}

export async function handleCronAction(
  action: string,
  params: Record<string, unknown>,
  deps: CronToolDeps,
): Promise<CronToolResult> {
  switch (action) {
    case "add":
      return handleAdd(params, deps);
    case "list":
      return handleList(deps);
    case "update":
      return handleUpdate(params, deps);
    case "remove":
      return handleRemove(params, deps);
    default:
      return { success: false, message: `Unknown action: "${action}"` };
  }
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function handleAdd(
  params: Record<string, unknown>,
  deps: CronToolDeps,
): Promise<CronToolResult> {
  const { label, schedule, payload } = params;

  if (typeof label !== "string" || label.trim() === "") {
    return { success: false, message: "Missing required field: label" };
  }
  if (!schedule || typeof schedule !== "object") {
    return { success: false, message: "Missing required field: schedule" };
  }
  if (!payload || typeof payload !== "object") {
    return { success: false, message: "Missing required field: payload" };
  }

  // Validate schedule with Zod schema
  const scheduleResult = CronScheduleSchema.safeParse(schedule);
  if (!scheduleResult.success) {
    return { success: false, message: `Invalid schedule: ${scheduleResult.error.issues[0]?.message ?? "unknown error"}` };
  }

  // Validate cron expressions are parseable
  if (scheduleResult.data.type === "cron") {
    const cronResult = validateCronExpression(scheduleResult.data.expression);
    if (!cronResult.valid) {
      return { success: false, message: cronResult.reason! };
    }
  }

  // Validate payload with Zod schema
  const payloadResult = CronPayloadSchema.safeParse(payload);
  if (!payloadResult.success) {
    return { success: false, message: `Invalid payload: ${payloadResult.error.issues[0]?.message ?? "unknown error"}` };
  }

  const job: CronJob = {
    id: randomUUID(),
    label: label.trim(),
    schedule: scheduleResult.data,
    payload: payloadResult.data,
    createdAt: new Date().toISOString(),
    lastFiredAt: null,
    enabled: true,
  };

  const jobs = await loadCronStore(deps.storePath);
  jobs.push(job);
  await saveCronStore(deps.storePath, jobs);

  return { success: true, message: "Job created", data: job };
}

async function handleList(deps: CronToolDeps): Promise<CronToolResult> {
  const jobs = await loadCronStore(deps.storePath);
  return { success: true, message: `Found ${jobs.length} job(s)`, data: jobs };
}

async function handleUpdate(
  params: Record<string, unknown>,
  deps: CronToolDeps,
): Promise<CronToolResult> {
  const { id, label, schedule, payload, enabled } = params;

  if (typeof id !== "string" || id.trim() === "") {
    return { success: false, message: "Missing required field: id" };
  }

  const jobs = await loadCronStore(deps.storePath);
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) {
    return { success: false, message: `Job not found: ${id}` };
  }

  const job = jobs[idx];

  if (typeof label === "string") {
    job.label = label;
  }
  if (schedule !== undefined && typeof schedule === "object" && schedule !== null) {
    const scheduleResult = CronScheduleSchema.safeParse(schedule);
    if (!scheduleResult.success) {
      return { success: false, message: `Invalid schedule: ${scheduleResult.error.issues[0]?.message ?? "unknown error"}` };
    }
    if (scheduleResult.data.type === "cron") {
      const cronResult = validateCronExpression(scheduleResult.data.expression);
      if (!cronResult.valid) {
        return { success: false, message: cronResult.reason! };
      }
    }
    job.schedule = scheduleResult.data;
  }
  if (payload !== undefined && typeof payload === "object" && payload !== null) {
    const payloadResult = CronPayloadSchema.safeParse(payload);
    if (!payloadResult.success) {
      return { success: false, message: `Invalid payload: ${payloadResult.error.issues[0]?.message ?? "unknown error"}` };
    }
    job.payload = payloadResult.data;
  }
  if (typeof enabled === "boolean") {
    job.enabled = enabled;
  }

  jobs[idx] = job;
  await saveCronStore(deps.storePath, jobs);

  return { success: true, message: "Job updated", data: job };
}

async function handleRemove(
  params: Record<string, unknown>,
  deps: CronToolDeps,
): Promise<CronToolResult> {
  const { id } = params;

  if (typeof id !== "string" || id.trim() === "") {
    return { success: false, message: "Missing required field: id" };
  }

  const jobs = await loadCronStore(deps.storePath);
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) {
    return { success: false, message: `Job not found: ${id}` };
  }

  jobs.splice(idx, 1);
  await saveCronStore(deps.storePath, jobs);

  return { success: true, message: "Job removed" };
}

// ---------------------------------------------------------------------------
// Cron Tool Manager
// ---------------------------------------------------------------------------

export function createCronToolManager(deps: CronToolDeps) {
  let timerHandle: CronTimerHandle | null = null;

  async function rearmTimer() {
    timerHandle?.disarm();
    const jobs = await loadCronStore(deps.storePath);
    timerHandle = armTimer(jobs, async (job) => {
      enqueueSystemEvent(job.payload.text, "cron");
      // Update lastFiredAt
      job.lastFiredAt = new Date().toISOString();
      const allJobs = await loadCronStore(deps.storePath);
      const updated = allJobs.map((j) => (j.id === job.id ? job : j));
      await saveCronStore(deps.storePath, updated);
      rearmTimer(); // Re-arm for next job
      deps.onJobFired?.(job);
    });
  }

  return {
    handleAction: (action: string, params: Record<string, unknown>) =>
      handleCronAction(action, params, deps),
    rearmTimer,
    stop: () => timerHandle?.disarm(),
  };
}
