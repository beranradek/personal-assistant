import { createHash } from "node:crypto";
import { AuditEntrySchema, type AuditEntry } from "../../core/types.js";
import { EpisodeRecordSchema, EpisodeSourceSchema, type EpisodeRecord } from "./types.js";

export interface BuildEpisodeOptions {
  id?: string;
  action?: string;
  summary?: string;
  why?: string | null;
  skillsUsed?: string[];
  tags?: string[];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeAction(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))];
}

function inferSource(value: string): EpisodeRecord["source"] {
  const parsed = EpisodeSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : "system";
}

function inferInitiator(source: EpisodeRecord["source"]): EpisodeRecord["initiator"] {
  if (source === "heartbeat") return "heartbeat";
  if (source === "system") return "system";
  return "user";
}

function inferOutcome(entries: AuditEntry[]): EpisodeRecord["outcome"] {
  let lastAssistantIndex = -1;
  let lastErrorIndex = -1;

  for (const [index, entry] of entries.entries()) {
    if (entry.type === "interaction" && entry.assistantResponse?.trim()) {
      lastAssistantIndex = index;
    }
    if (entry.type === "error" && entry.errorMessage?.trim()) {
      lastErrorIndex = index;
    }
  }

  if (lastAssistantIndex === -1 && lastErrorIndex === -1) {
    return "aborted";
  }
  if (lastErrorIndex > lastAssistantIndex) {
    return "failure";
  }
  if (lastAssistantIndex !== -1 && lastErrorIndex !== -1) {
    return "partial_success";
  }
  if (lastAssistantIndex !== -1) {
    return "success";
  }
  return "aborted";
}

function inferSuccessScore(outcome: EpisodeRecord["outcome"]): number {
  switch (outcome) {
    case "success":
      return 1;
    case "partial_success":
      return 0.6;
    case "failure":
      return 0;
    case "aborted":
      return 0.2;
  }
}

function inferAction(entries: AuditEntry[]): string {
  for (const entry of entries) {
    if (entry.type === "interaction" && entry.userMessage?.trim()) {
      return normalizeWhitespace(entry.userMessage);
    }
  }
  for (const entry of entries) {
    if (entry.type === "tool_call" && entry.toolName?.trim()) {
      return `Tool run: ${normalizeWhitespace(entry.toolName)}`;
    }
    if (entry.type === "error" && entry.errorMessage?.trim()) {
      return normalizeWhitespace(entry.errorMessage);
    }
  }
  return "Session activity";
}

function inferSummary(entries: AuditEntry[], action: string): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "interaction" && entry.assistantResponse?.trim()) {
      return normalizeWhitespace(entry.assistantResponse);
    }
    if (entry.type === "error" && entry.errorMessage?.trim()) {
      return normalizeWhitespace(entry.errorMessage);
    }
  }
  return action;
}

function inferOpenQuestions(entries: AuditEntry[], outcome: EpisodeRecord["outcome"]): string[] {
  const issues: string[] = [];
  const hasAssistantResponse = entries.some(
    (entry) => entry.type === "interaction" && entry.assistantResponse?.trim(),
  );
  const lastEntry = entries.at(-1);

  if (!hasAssistantResponse) {
    issues.push("missing assistant response in bounded audit window");
  }
  const lastHasTerminalSignal =
    lastEntry?.type === "error" ||
    (lastEntry?.type === "interaction" && Boolean(lastEntry.assistantResponse?.trim()));
  if (outcome === "aborted" || !lastHasTerminalSignal) {
    issues.push("missing terminal outcome in bounded audit window");
  }

  return issues;
}

function summarizeUnknown(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return {
      kind: "array",
      itemCount: value.length,
    };
  }
  if (value && typeof value === "object") {
    return {
      kind: "object",
      keys: Object.keys(value).sort(),
    };
  }
  if (typeof value === "string") {
    return {
      kind: "string",
      length: value.length,
    };
  }
  return {
    kind: value === null ? "null" : typeof value,
  };
}

function buildTrajectory(entries: AuditEntry[]): EpisodeRecord["trajectory"] {
  const steps: EpisodeRecord["trajectory"] = [];

  for (const [auditIndex, entry] of entries.entries()) {
    const baseData = {
      auditIndex,
      source: entry.source,
      type: entry.type,
    };

    if (entry.type === "interaction") {
      if (entry.userMessage?.trim()) {
        steps.push({
          at: entry.timestamp,
          kind: "action",
          label: normalizeWhitespace(entry.userMessage),
          data: baseData,
        });
      }
      if (entry.assistantResponse?.trim()) {
        steps.push({
          at: entry.timestamp,
          kind: "observation",
          label: normalizeWhitespace(entry.assistantResponse),
          data: baseData,
        });
      }
      continue;
    }

    if (entry.type === "tool_call") {
      if (entry.toolName?.trim()) {
        steps.push({
          at: entry.timestamp,
          kind: "tool_call",
          label: normalizeWhitespace(entry.toolName),
          data: {
            ...baseData,
            ...(entry.toolInput !== undefined ? { hasInput: true, inputKeys: summarizeUnknown(entry.toolInput).keys ?? [] } : {}),
          },
        });
        if (entry.toolResult !== undefined || entry.durationMs !== undefined) {
          const resultSummary = entry.toolResult !== undefined ? summarizeUnknown(entry.toolResult) : null;
          steps.push({
            at: entry.timestamp,
            kind: "tool_result",
            label: normalizeWhitespace(entry.toolName),
            data: {
              ...baseData,
              ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
              ...(resultSummary ? { hasResult: true, resultType: resultSummary.kind } : {}),
            },
          });
        }
      }
      continue;
    }

    if (entry.type === "error" && entry.errorMessage?.trim()) {
      steps.push({
        at: entry.timestamp,
        kind: "observation",
        label: normalizeWhitespace(entry.errorMessage),
        data: {
          ...baseData,
          ...(entry.context ? { context: entry.context } : {}),
        },
      });
    }
  }

  return steps;
}

export function buildSemanticEmbeddingText(episode: {
  action: string;
  summary: string;
  outcome: EpisodeRecord["outcome"];
  source: EpisodeRecord["source"];
  projectName?: string | null;
  jobName?: string | null;
  issueId?: string | null;
  pullRequestId?: string | null;
  category?: string | null;
  toolsUsed: string[];
  errors: string[];
  tags: string[];
}): string {
  return [
    `action: ${episode.action}`,
    `summary: ${episode.summary}`,
    `outcome: ${episode.outcome}`,
    `source: ${episode.source}`,
    episode.projectName ? `project: ${episode.projectName}` : null,
    episode.jobName ? `job: ${episode.jobName}` : null,
    episode.issueId ? `issue: ${episode.issueId}` : null,
    episode.pullRequestId ? `pull_request: ${episode.pullRequestId}` : null,
    episode.category ? `category: ${episode.category}` : null,
    episode.toolsUsed.length > 0 ? `tools: ${episode.toolsUsed.join(", ")}` : null,
    episode.errors.length > 0 ? `errors: ${episode.errors.join(" | ")}` : null,
    episode.tags.length > 0 ? `tags: ${episode.tags.join(", ")}` : null,
  ]
    .filter((line): line is string => line != null)
    .join("\n");
}

function buildDeterministicId(entries: AuditEntry[]): string {
  const seed = JSON.stringify(
    entries.map((entry) => ({
      timestamp: entry.timestamp,
      source: entry.source,
      sessionKey: entry.sessionKey,
      type: entry.type,
      userMessage: entry.userMessage ?? null,
      assistantResponse: entry.assistantResponse ?? null,
      toolName: entry.toolName ?? null,
      toolInputShape: entry.toolInput !== undefined ? summarizeUnknown(entry.toolInput) : null,
      toolResultShape: entry.toolResult !== undefined ? summarizeUnknown(entry.toolResult) : null,
      errorMessage: entry.errorMessage ?? null,
      context: entry.context ?? null,
      taskContext: entry.taskContext ?? null,
    })),
  );
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 16);
  return `episode-${hash}`;
}

export function buildEpisodeFromAuditEntries(
  rawEntries: AuditEntry[],
  options: BuildEpisodeOptions = {},
): EpisodeRecord {
  if (rawEntries.length === 0) {
    throw new Error("Cannot build episode from empty audit entry set");
  }

  const entries = rawEntries
    .map((entry) => AuditEntrySchema.parse(entry))
    .slice()
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));

  const sessionKeys = new Set(entries.map((entry) => entry.sessionKey));
  if (sessionKeys.size !== 1) {
    throw new Error("Cannot build episode from multiple session keys");
  }

  const firstEntry = entries[0];
  const lastEntry = entries[entries.length - 1];
  const source = inferSource(firstEntry.source);
  const action = normalizeWhitespace(options.action ?? inferAction(entries));
  const summary = normalizeWhitespace(options.summary ?? inferSummary(entries, action));
  const outcome = inferOutcome(entries);
  const mergedTaskContext = entries.reduce<Record<string, unknown>>((acc, entry) => {
    if (!entry.taskContext) return acc;
    return { ...acc, ...entry.taskContext };
  }, {});
  const toolsUsed = unique(
    entries
      .filter((entry) => entry.type === "tool_call")
      .map((entry) => entry.toolName),
  );
  const errors = unique(
    entries
      .filter((entry) => entry.type === "error")
      .map((entry) => entry.errorMessage),
  );
  const tags = unique([
    ...(options.tags ?? []),
    typeof mergedTaskContext.category === "string" ? mergedTaskContext.category : undefined,
    source,
    typeof mergedTaskContext.projectName === "string" ? mergedTaskContext.projectName : undefined,
  ]);
  const episode: EpisodeRecord = {
    id: options.id ?? buildDeterministicId(entries),
    startedAt: firstEntry.timestamp,
    endedAt: lastEntry.timestamp,
    source,
    sessionKey: firstEntry.sessionKey,
    sessionId: null,
    initiator: inferInitiator(source),
    action,
    normalizedAction: normalizeAction(action),
    summary,
    why: options.why ?? null,
    projectName:
      typeof mergedTaskContext.projectName === "string" ? mergedTaskContext.projectName : null,
    jobName: typeof mergedTaskContext.jobName === "string" ? mergedTaskContext.jobName : null,
    issueId: typeof mergedTaskContext.issueId === "string" ? mergedTaskContext.issueId : null,
    pullRequestId:
      typeof mergedTaskContext.pullRequestId === "string" ? mergedTaskContext.pullRequestId : null,
    detailedMemoryFile:
      typeof mergedTaskContext.detailedMemoryFile === "string"
        ? mergedTaskContext.detailedMemoryFile
        : null,
    category: typeof mergedTaskContext.category === "string" ? mergedTaskContext.category : null,
    skillsUsed: unique(options.skillsUsed ?? []),
    toolsUsed,
    tags,
    outcome,
    successScore: inferSuccessScore(outcome),
    blockers: [],
    errors,
    openQuestions: inferOpenQuestions(entries, outcome),
    relatedEpisodeIds: [],
    model: null,
    inputTokens: null,
    outputTokens: null,
    location: null,
    trajectory: buildTrajectory(entries),
    semanticEmbeddingText: "",
  };

  episode.semanticEmbeddingText = buildSemanticEmbeddingText({
    action: episode.action,
    summary: episode.summary,
    outcome: episode.outcome,
    source: episode.source,
    projectName: episode.projectName,
    jobName: episode.jobName,
    issueId: episode.issueId,
    pullRequestId: episode.pullRequestId,
    category: episode.category,
    toolsUsed: episode.toolsUsed,
    errors: episode.errors,
    tags: episode.tags,
  });

  return EpisodeRecordSchema.parse(episode);
}
