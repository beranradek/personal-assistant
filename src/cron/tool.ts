import { randomUUID } from "node:crypto";
import type { CronJob, CronSchedule, CronPayload } from "./types.js";
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

  const job: CronJob = {
    id: randomUUID(),
    label: label.trim(),
    schedule: schedule as CronSchedule,
    payload: payload as CronPayload,
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
    job.schedule = schedule as CronSchedule;
  }
  if (payload !== undefined && typeof payload === "object" && payload !== null) {
    job.payload = payload as CronPayload;
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
