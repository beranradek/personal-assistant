/**
 * Shared episode MCP tool logic used by both the SDK memory-server (Claude
 * backend) and the stdio/HTTP MCP server (Codex backend).
 */

import { createHash } from "node:crypto";
import {
  EpisodeInitiatorSchema,
  EpisodeListFiltersSchema,
  EpisodeOutcomeSchema,
  EpisodeSourceSchema,
  type EpisodeListFilters,
  type EpisodeRecord,
} from "../memory/episodes/types.js";
import { buildSemanticEmbeddingText } from "../memory/episodes/builder.js";
import { searchEpisodes, matchesFilters } from "../memory/episodes/retrieval.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface EpisodeMcpDeps {
  listEpisodes: (filters?: EpisodeListFilters) => EpisodeRecord[];
  insertEpisode?: (episode: EpisodeRecord) => void | Promise<void>;
  searchEpisodesVector?: (query: string, maxResults?: number) => Promise<EpisodeRecord[]>;
  redact?: (text: string) => string;
}

// ---------------------------------------------------------------------------
// JSON schema tool definitions (MCP SDK native format, for stdio/HTTP server)
// ---------------------------------------------------------------------------

const EPISODE_FILTER_PROPERTIES = {
  sessionKey: { type: "string", description: "Exact session key filter" },
  source: {
    type: "string",
    enum: EpisodeSourceSchema.options,
    description: "Exact source filter",
  },
  outcome: {
    type: "string",
    enum: EpisodeOutcomeSchema.options,
    description: "Exact outcome filter",
  },
  startedAtFrom: { type: "string", description: "Only include episodes starting at or after this ISO timestamp" },
  startedAtTo: { type: "string", description: "Only include episodes starting at or before this ISO timestamp" },
  endedAtFrom: { type: "string", description: "Only include episodes ending at or after this ISO timestamp" },
  endedAtTo: { type: "string", description: "Only include episodes ending at or before this ISO timestamp" },
  projectName: { type: "string", description: "Exact project name filter" },
  jobName: { type: "string", description: "Exact job name filter" },
  issueId: { type: "string", description: "Exact issue identifier filter" },
  pullRequestId: { type: "string", description: "Exact pull request identifier filter" },
  detailedMemoryFile: { type: "string", description: "Exact detailed memory file filter" },
  category: { type: "string", description: "Exact category filter" },
  skillUsed: { type: "string", description: "Exact skill usage filter" },
};

export const EPISODE_TOOL_DEFINITIONS = [
  {
    name: "episode_recent",
    description: "List recent episodic memory records using exact filters such as project, job, issue, source, or outcome.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...EPISODE_FILTER_PROPERTIES,
        limit: { type: "number", description: "Max episodes to return" },
      },
    },
  },
  {
    name: "episode_search",
    description: "Search episodic memory across action, summary, tags, tools, errors, and identity fields. Supports combining a text query with exact filters. Use semantic:true to find similar past tasks even if the wording differs.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Case-insensitive text query" },
        maxResults: { type: "number", description: "Max matches to return" },
        semantic: { type: "boolean", description: "Use vector similarity search instead of keyword matching (slower but finds semantically related episodes)" },
        ...EPISODE_FILTER_PROPERTIES,
      },
    },
  },
  {
    name: "episode_stats",
    description: "Summarize episodic memory counts and top dimensions for a filtered subset of episodes.",
    inputSchema: {
      type: "object" as const,
      properties: { ...EPISODE_FILTER_PROPERTIES },
    },
  },
  {
    name: "episode_write",
    description: "Record a completed task or job as a structured episode in episodic memory. Call this at meaningful task boundaries — not after every turn. Required: action, summary, outcome.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", description: "One-line description of what was attempted" },
        summary: { type: "string", description: "Narrative of what happened: key decisions, approach, and result" },
        outcome: { type: "string", enum: EpisodeOutcomeSchema.options, description: "Task outcome: success | partial_success | failure | aborted" },
        why: { type: "string", description: "Why this task was needed / the motivation" },
        initiator: { type: "string", enum: EpisodeInitiatorSchema.options, description: "Who initiated: user | heartbeat | system (system = self-initiated)" },
        source: { type: "string", enum: EpisodeSourceSchema.options, description: "Conversation source: telegram | slack | terminal | github | heartbeat | system" },
        sessionKey: { type: "string", description: "Session key for this episode" },
        projectName: { type: "string", description: "Project name if applicable" },
        jobName: { type: "string", description: "Job or task name if applicable" },
        issueId: { type: "string", description: "GitHub/Linear issue identifier" },
        pullRequestId: { type: "string", description: "Pull request identifier" },
        detailedMemoryFile: { type: "string", description: "Path to a memory file with detailed notes about this episode (relative to workspace)" },
        category: { type: "string", description: "Task category, e.g. github-issue, deploy, review" },
        location: { type: "string", description: "Primary artifact location: file path, URL, or file:line" },
        blockers: { type: "array", items: { type: "string" }, description: "What blocked progress" },
        errors: { type: "array", items: { type: "string" }, description: "Key error messages (short)" },
        openQuestions: { type: "array", items: { type: "string" }, description: "Unresolved questions or evidence gaps" },
        toolsUsed: { type: "array", items: { type: "string" }, description: "Tools called during this task" },
        skillsUsed: { type: "array", items: { type: "string" }, description: "Skills applied" },
        tags: { type: "array", items: { type: "string" }, description: "Searchable labels" },
        trajectory: { type: "array", items: { type: "string" }, description: "Key decisions and pivots — not every turn, 3–7 items" },
        relatedEpisodeIds: { type: "array", items: { type: "string" }, description: "IDs of prior episodes this resolves or continues" },
      },
      required: ["action", "summary", "outcome"],
    },
  },
];

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function toJsonContent(value: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(value, null, 2) },
    ],
  };
}

function redactUnknown(value: unknown, redact?: (text: string) => string): unknown {
  if (!redact) return value;
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, redact));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, redactUnknown(v, redact)]),
    );
  }
  return value;
}

export function sanitizeEpisodeRecord(episode: EpisodeRecord, redact?: (text: string) => string) {
  return {
    id: episode.id,
    startedAt: episode.startedAt,
    endedAt: episode.endedAt,
    source: episode.source,
    sessionKey: episode.sessionKey,
    sessionId: episode.sessionId ?? null,
    initiator: episode.initiator,
    action: redact ? redact(episode.action) : episode.action,
    summary: redact ? redact(episode.summary) : episode.summary,
    why: episode.why ? (redact ? redact(episode.why) : episode.why) : null,
    projectName: episode.projectName,
    jobName: episode.jobName,
    issueId: episode.issueId,
    pullRequestId: episode.pullRequestId,
    detailedMemoryFile: episode.detailedMemoryFile,
    category: episode.category,
    skillsUsed: episode.skillsUsed.slice(),
    toolsUsed: episode.toolsUsed.slice(),
    tags: episode.tags.slice(),
    outcome: episode.outcome,
    successScore: episode.successScore ?? null,
    blockers: redactUnknown(episode.blockers, redact) as string[],
    errors: redactUnknown(episode.errors, redact) as string[],
    openQuestions: redactUnknown(episode.openQuestions, redact) as string[],
    relatedEpisodeIds: (episode.relatedEpisodeIds ?? []).slice(),
    location: episode.location ?? null,
    trajectory: episode.trajectory.map((step) => ({ at: step.at, kind: step.kind, label: step.label })),
  };
}

export function pickEpisodeFilters(args: Record<string, unknown>): EpisodeListFilters {
  return EpisodeListFiltersSchema.parse({
    sessionKey: args["sessionKey"],
    source: args["source"],
    outcome: args["outcome"],
    startedAtFrom: args["startedAtFrom"],
    startedAtTo: args["startedAtTo"],
    endedAtFrom: args["endedAtFrom"],
    endedAtTo: args["endedAtTo"],
    projectName: args["projectName"],
    jobName: args["jobName"],
    issueId: args["issueId"],
    pullRequestId: args["pullRequestId"],
    detailedMemoryFile: args["detailedMemoryFile"],
    category: args["category"],
    skillUsed: args["skillUsed"],
    limit: args["limit"],
  });
}

function summarizeCounts(values: Array<string | null | undefined>) {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
}

function topCounts(values: Array<string | null | undefined>) {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([ka, a], [kb, b]) => b - a || ka.localeCompare(kb))
    .map(([value, count]) => ({ value, count }));
}

function episodeNormalizeAction(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function episodeSuccessScore(outcome: EpisodeRecord["outcome"]): number {
  switch (outcome) {
    case "success": return 1;
    case "partial_success": return 0.6;
    case "failure": return 0;
    case "aborted": return 0.2;
  }
}

function episodeInferInitiator(source: EpisodeRecord["source"]): EpisodeRecord["initiator"] {
  if (source === "heartbeat") return "heartbeat";
  if (source === "system") return "system";
  return "user";
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleEpisodeRecent(
  args: Record<string, unknown>,
  deps: EpisodeMcpDeps,
) {
  const filters = pickEpisodeFilters(args);
  return toJsonContent(
    deps.listEpisodes(filters).map((ep) => sanitizeEpisodeRecord(ep, deps.redact)),
  );
}

export async function handleEpisodeSearch(
  args: Record<string, unknown>,
  deps: EpisodeMcpDeps,
) {
  const filters = pickEpisodeFilters(args);
  if (args["semantic"] && deps.searchEpisodesVector) {
    const candidates = await deps.searchEpisodesVector(
      (args["query"] as string) ?? "",
      args["maxResults"] as number | undefined,
    );
    const filtered = candidates.filter((ep) => matchesFilters(ep, filters));
    const sliced = filtered.slice(0, (args["maxResults"] as number | undefined) ?? filtered.length);
    return toJsonContent(sliced.map((ep) => ({
      score: 0,
      matchedFields: ["semantic"],
      matchedFilters: [] as string[],
      episode: sanitizeEpisodeRecord(ep, deps.redact),
    })));
  }
  const episodes = deps.listEpisodes(filters);
  const results = searchEpisodes(episodes, {
    query: args["query"] as string | undefined,
    filters,
    maxResults: args["maxResults"] as number | undefined,
  }).map((r) => ({
    score: r.score,
    matchedFields: r.matchedFields,
    matchedFilters: r.exactMatchedFilters,
    episode: sanitizeEpisodeRecord(r.episode, deps.redact),
  }));
  return toJsonContent(results);
}

export async function handleEpisodeStats(
  args: Record<string, unknown>,
  deps: EpisodeMcpDeps,
) {
  const filters = pickEpisodeFilters(args);
  const episodes = deps.listEpisodes(filters);
  const latestStartedAt = episodes.reduce<string | null>(
    (latest, ep) => latest == null || ep.startedAt > latest ? ep.startedAt : latest,
    null,
  );
  return toJsonContent({
    totalEpisodes: episodes.length,
    latestStartedAt,
    byOutcome: summarizeCounts(episodes.map((ep) => ep.outcome)),
    bySource: summarizeCounts(episodes.map((ep) => ep.source)),
    byCategory: summarizeCounts(episodes.map((ep) => ep.category)),
    topSkills: topCounts(episodes.flatMap((ep) => ep.skillsUsed)),
    topProjects: topCounts(episodes.map((ep) => ep.projectName)),
  });
}

export async function handleEpisodeWrite(
  args: Record<string, unknown>,
  deps: EpisodeMcpDeps,
) {
  if (!deps.insertEpisode) {
    return toJsonContent({ error: "episode_write is not available: insertEpisode dep not provided" });
  }

  const now = new Date().toISOString();
  const action = args["action"] as string;
  const outcome = args["outcome"] as EpisodeRecord["outcome"];
  const normalizedAction = episodeNormalizeAction(action);
  const successScore = episodeSuccessScore(outcome);
  const source = (args["source"] as EpisodeRecord["source"] | undefined) ?? "system";
  const initiator = (args["initiator"] as EpisodeRecord["initiator"] | undefined) ?? episodeInferInitiator(source);
  const sessionKey = (args["sessionKey"] as string | undefined) ?? `${source}--default`;

  const id = createHash("sha256")
    .update(normalizedAction + now)
    .digest("hex")
    .slice(0, 32);

  const trajectorySteps: EpisodeRecord["trajectory"] = ((args["trajectory"] as string[] | undefined) ?? []).map((label) => ({
    at: now,
    kind: "decision" as const,
    label,
  }));

  const episode: EpisodeRecord = {
    id,
    startedAt: now,
    endedAt: now,
    source,
    sessionKey,
    sessionId: null,
    initiator,
    action,
    normalizedAction,
    summary: args["summary"] as string,
    why: (args["why"] as string | undefined) ?? null,
    projectName: (args["projectName"] as string | undefined) ?? null,
    jobName: (args["jobName"] as string | undefined) ?? null,
    issueId: (args["issueId"] as string | undefined) ?? null,
    pullRequestId: (args["pullRequestId"] as string | undefined) ?? null,
    detailedMemoryFile: (args["detailedMemoryFile"] as string | undefined) ?? null,
    category: (args["category"] as string | undefined) ?? null,
    location: (args["location"] as string | undefined) ?? null,
    skillsUsed: (args["skillsUsed"] as string[] | undefined) ?? [],
    toolsUsed: (args["toolsUsed"] as string[] | undefined) ?? [],
    tags: (args["tags"] as string[] | undefined) ?? [],
    outcome,
    successScore,
    blockers: (args["blockers"] as string[] | undefined) ?? [],
    errors: (args["errors"] as string[] | undefined) ?? [],
    openQuestions: (args["openQuestions"] as string[] | undefined) ?? [],
    relatedEpisodeIds: (args["relatedEpisodeIds"] as string[] | undefined) ?? [],
    model: null,
    inputTokens: null,
    outputTokens: null,
    trajectory: trajectorySteps,
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

  await deps.insertEpisode(episode);
  return toJsonContent({ status: "inserted", id });
}
