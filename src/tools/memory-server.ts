import { createHash } from "node:crypto";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { SearchResult } from "../core/types.js";
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

const EpisodeToolFiltersSchema = {
  sessionKey: z.string().optional().describe("Exact session key filter"),
  source: EpisodeSourceSchema.optional().describe("Exact source filter"),
  outcome: EpisodeOutcomeSchema.optional().describe("Exact outcome filter"),
  startedAtFrom: z.string().optional().describe("Only include episodes starting at or after this ISO timestamp"),
  startedAtTo: z.string().optional().describe("Only include episodes starting at or before this ISO timestamp"),
  endedAtFrom: z.string().optional().describe("Only include episodes ending at or after this ISO timestamp"),
  endedAtTo: z.string().optional().describe("Only include episodes ending at or before this ISO timestamp"),
  projectName: z.string().optional().describe("Exact project name filter"),
  jobName: z.string().optional().describe("Exact job name filter"),
  issueId: z.string().optional().describe("Exact issue identifier filter"),
  pullRequestId: z.string().optional().describe("Exact pull request identifier filter"),
  detailedMemoryFile: z.string().optional().describe("Exact detailed memory file filter"),
  category: z.string().optional().describe("Exact category filter"),
  skillUsed: z.string().optional().describe("Exact skill usage filter"),
};

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
      Object.entries(value).map(([key, nestedValue]) => [key, redactUnknown(nestedValue, redact)]),
    );
  }
  return value;
}

function sanitizeEpisodeRecord(episode: EpisodeRecord, redact?: (text: string) => string) {
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
    trajectoryStepCount: episode.trajectory.length,
    trajectoryKinds: [...new Set(episode.trajectory.map((step) => step.kind))].sort(),
  };
}

function pickEpisodeFilters(args: Record<string, unknown>): EpisodeListFilters {
  return EpisodeListFiltersSchema.parse({
    sessionKey: args.sessionKey,
    source: args.source,
    outcome: args.outcome,
    startedAtFrom: args.startedAtFrom,
    startedAtTo: args.startedAtTo,
    endedAtFrom: args.endedAtFrom,
    endedAtTo: args.endedAtTo,
    projectName: args.projectName,
    jobName: args.jobName,
    issueId: args.issueId,
    pullRequestId: args.pullRequestId,
    detailedMemoryFile: args.detailedMemoryFile,
    category: args.category,
    skillUsed: args.skillUsed,
    limit: args.limit,
  });
}

function summarizeCounts(values: Array<string | null | undefined>) {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function topCounts(values: Array<string | null | undefined>) {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return left[0].localeCompare(right[0]);
    })
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

/**
 * Create an MCP server that exposes memory lookup tools.
 *
 * `memory_search` covers semantic/keyword long-term memory.
 * Optional episodic tools are enabled when `listEpisodes` is provided.
 * `episode_write` is enabled when `insertEpisode` is provided.
 */
export function createMemoryServer(deps: {
  search: (query: string, maxResults?: number) => Promise<SearchResult[]>;
  listEpisodes?: (filters?: EpisodeListFilters) => EpisodeRecord[];
  insertEpisode?: (episode: EpisodeRecord) => void | Promise<void>;
  searchEpisodesVector?: (query: string, maxResults?: number) => Promise<EpisodeRecord[]>;
  redact?: (text: string) => string;
}) {
  const tools: unknown[] = [];

  tools.push(
    tool(
      "memory_search",
      "Search long-term memory for past decisions, preferences, and context. Tip: overly broad multi-word queries can yield no results; try shortening to 1–3 key terms.",
      {
        query: z.string().describe("Search query"),
        maxResults: z
          .number()
          .optional()
          .describe("Max results (default 6)"),
      },
      async (args) => {
        const results = await deps.search(args.query, args.maxResults);
        return toJsonContent(results);
      },
    ),
  );

  if (deps.listEpisodes) {
    tools.push(
      tool(
        "episode_recent",
        "List recent episodic memory records using exact filters such as project, job, issue, source, or outcome.",
        {
          ...EpisodeToolFiltersSchema,
          limit: z.number().int().positive().max(1000).optional().describe("Max episodes to return"),
        },
        async (args) => {
          const filters = pickEpisodeFilters(args);
          return toJsonContent(
            deps.listEpisodes!(filters).map((episode) => sanitizeEpisodeRecord(episode, deps.redact)),
          );
        },
      ),
      tool(
        "episode_search",
        "Search episodic memory across action, summary, tags, tools, errors, and identity fields. Supports combining a text query with exact filters. Use semantic:true to find similar past tasks even if the wording differs.",
        {
          query: z.string().optional().describe("Case-insensitive text query"),
          maxResults: z.number().int().positive().max(1000).optional().describe("Max matches to return"),
          semantic: z.boolean().optional().describe("Use vector similarity search instead of keyword matching (slower but finds semantically related episodes)"),
          ...EpisodeToolFiltersSchema,
        },
        async (args) => {
          const filters = pickEpisodeFilters(args);
          if (args.semantic && deps.searchEpisodesVector) {
            const candidates = await deps.searchEpisodesVector(args.query ?? "", args.maxResults);
            const filtered = candidates.filter((ep) => matchesFilters(ep, filters));
            const sliced = filtered.slice(0, args.maxResults ?? filtered.length);
            return toJsonContent(sliced.map((episode) => ({
              score: 0,
              matchedFields: ["semantic"],
              matchedFilters: [] as string[],
              episode: sanitizeEpisodeRecord(episode, deps.redact),
            })));
          }
          const episodes = deps.listEpisodes!(filters);
          const results = searchEpisodes(episodes, {
            query: args.query,
            filters,
            maxResults: args.maxResults,
          }).map((result) => ({
            score: result.score,
            matchedFields: result.matchedFields,
            matchedFilters: result.exactMatchedFilters,
            episode: sanitizeEpisodeRecord(result.episode, deps.redact),
          }));
          return toJsonContent(results);
        },
      ),
      tool(
        "episode_stats",
        "Summarize episodic memory counts and top dimensions for a filtered subset of episodes.",
        {
          ...EpisodeToolFiltersSchema,
        },
        async (args) => {
          const filters = pickEpisodeFilters(args);
          const episodes = deps.listEpisodes!(filters);
          const latestStartedAt = episodes.reduce<string | null>(
            (latest, episode) => latest == null || episode.startedAt > latest ? episode.startedAt : latest,
            null,
          );
          return toJsonContent({
            totalEpisodes: episodes.length,
            latestStartedAt,
            byOutcome: summarizeCounts(episodes.map((episode) => episode.outcome)),
            bySource: summarizeCounts(episodes.map((episode) => episode.source)),
            byCategory: summarizeCounts(episodes.map((episode) => episode.category)),
            topSkills: topCounts(episodes.flatMap((episode) => episode.skillsUsed)),
            topProjects: topCounts(episodes.map((episode) => episode.projectName)),
          });
        },
      ),
    );
  }

  if (deps.insertEpisode) {
    tools.push(
      tool(
        "episode_write",
        "Record a completed task or job as a structured episode in episodic memory. Call this at meaningful task boundaries — not after every turn. Required: action, summary, outcome.",
        {
          action: z.string().describe("One-line description of what was attempted"),
          summary: z.string().describe("Narrative of what happened: key decisions, approach, and result"),
          outcome: EpisodeOutcomeSchema.describe("Task outcome: success | partial_success | failure | aborted"),
          why: z.string().optional().describe("Why this task was needed / the motivation"),
          initiator: EpisodeInitiatorSchema.optional().describe("Who initiated: user | heartbeat | system (system = self-initiated)"),
          source: EpisodeSourceSchema.optional().describe("Conversation source: telegram | slack | terminal | github | heartbeat | system"),
          sessionKey: z.string().optional().describe("Session key for this episode"),
          projectName: z.string().optional().describe("Project name if applicable"),
          jobName: z.string().optional().describe("Job or task name if applicable"),
          issueId: z.string().optional().describe("GitHub/Linear issue identifier"),
          pullRequestId: z.string().optional().describe("Pull request identifier"),
          category: z.string().optional().describe("Task category, e.g. github-issue, deploy, review"),
          location: z.string().optional().describe("Primary artifact location: file path, URL, or file:line"),
          blockers: z.array(z.string()).optional().describe("What blocked progress"),
          errors: z.array(z.string()).optional().describe("Key error messages (short)"),
          openQuestions: z.array(z.string()).optional().describe("Unresolved questions or evidence gaps"),
          toolsUsed: z.array(z.string()).optional().describe("Tools called during this task"),
          skillsUsed: z.array(z.string()).optional().describe("Skills applied"),
          tags: z.array(z.string()).optional().describe("Searchable labels"),
          trajectory: z.array(z.string()).optional().describe("Key decisions and pivots — not every turn, 3–7 items"),
          relatedEpisodeIds: z.array(z.string()).optional().describe("IDs of prior episodes this resolves or continues"),
        },
        async (args) => {
          const now = new Date().toISOString();
          const normalizedAction = episodeNormalizeAction(args.action);
          const successScore = episodeSuccessScore(args.outcome);
          const source = args.source ?? "system";
          const initiator = args.initiator ?? episodeInferInitiator(source);
          const sessionKey = args.sessionKey ?? `${source}--default`;

          const id = createHash("sha256")
            .update(normalizedAction + now)
            .digest("hex")
            .slice(0, 32);

          const trajectorySteps: EpisodeRecord["trajectory"] = (args.trajectory ?? []).map((label) => ({
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
            action: args.action,
            normalizedAction,
            summary: args.summary,
            why: args.why ?? null,
            projectName: args.projectName ?? null,
            jobName: args.jobName ?? null,
            issueId: args.issueId ?? null,
            pullRequestId: args.pullRequestId ?? null,
            detailedMemoryFile: null,
            category: args.category ?? null,
            location: args.location ?? null,
            skillsUsed: args.skillsUsed ?? [],
            toolsUsed: args.toolsUsed ?? [],
            tags: args.tags ?? [],
            outcome: args.outcome,
            successScore,
            blockers: args.blockers ?? [],
            errors: args.errors ?? [],
            openQuestions: args.openQuestions ?? [],
            relatedEpisodeIds: args.relatedEpisodeIds ?? [],
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

          await deps.insertEpisode!(episode);
          return toJsonContent({ status: "inserted", id });
        },
      ),
    );
  }

  return createSdkMcpServer({
    name: "memory",
    version: "1.0.0",
    tools: tools as any,
  });
}
