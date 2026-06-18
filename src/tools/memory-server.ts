import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { SearchResult } from "../core/types.js";
import {
  EpisodeListFiltersSchema,
  EpisodeOutcomeSchema,
  EpisodeSourceSchema,
  type EpisodeListFilters,
  type EpisodeRecord,
} from "../memory/episodes/types.js";

type EpisodicSearchResult = {
  score: number;
  matchedFields: string[];
  episode: ReturnType<typeof sanitizeEpisodeRecord>;
};

const EpisodeToolFiltersSchema = {
  sessionKey: z.string().optional().describe("Exact session key filter"),
  source: EpisodeSourceSchema.optional().describe("Exact source filter"),
  outcome: EpisodeOutcomeSchema.optional().describe("Exact outcome filter"),
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
    evidenceIncomplete: redactUnknown(episode.evidenceIncomplete, redact) as string[],
    trajectoryStepCount: episode.trajectory.length,
    trajectoryKinds: [...new Set(episode.trajectory.map((step) => step.kind))].sort(),
  };
}

function pickEpisodeFilters(args: Record<string, unknown>): EpisodeListFilters {
  return EpisodeListFiltersSchema.parse({
    sessionKey: args.sessionKey,
    source: args.source,
    outcome: args.outcome,
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

function searchableFields(episode: EpisodeRecord): Array<[string, string[]]> {
  return [
    ["action", [episode.action]],
    ["summary", [episode.summary]],
    ["projectName", [episode.projectName ?? ""]],
    ["jobName", [episode.jobName ?? ""]],
    ["issueId", [episode.issueId ?? ""]],
    ["pullRequestId", [episode.pullRequestId ?? ""]],
    ["category", [episode.category ?? ""]],
    ["source", [episode.source]],
    ["outcome", [episode.outcome]],
    ["tags", episode.tags],
    ["skillsUsed", episode.skillsUsed],
    ["toolsUsed", episode.toolsUsed],
    ["errors", episode.errors],
    ["blockers", episode.blockers],
  ];
}

function scoreEpisodeMatch(
  episode: EpisodeRecord,
  query: string,
  redact?: (text: string) => string,
): EpisodicSearchResult | null {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return { score: 0, matchedFields: [], episode: sanitizeEpisodeRecord(episode, redact) };
  }

  const matchedFields = new Set<string>();
  let score = 0;

  for (const [field, values] of searchableFields(episode)) {
    for (const rawValue of values) {
      const value = rawValue.toLowerCase();
      if (value === normalizedQuery) {
        matchedFields.add(field);
        score += 8;
      } else if (value.includes(normalizedQuery)) {
        matchedFields.add(field);
        score += 4;
      } else {
        const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean);
        const matchedTerms = queryTerms.filter((term) => value.includes(term));
        if (matchedTerms.length > 0) {
          matchedFields.add(field);
          score += matchedTerms.length;
        }
      }
    }
  }

  if (matchedFields.size === 0) return null;
  return {
    score,
    matchedFields: [...matchedFields].sort(),
    episode: sanitizeEpisodeRecord(episode, redact),
  };
}

/**
 * Create an MCP server that exposes memory lookup tools.
 *
 * `memory_search` covers semantic/keyword long-term memory.
 * Optional episodic tools are enabled when `listEpisodes` is provided.
 */
export function createMemoryServer(deps: {
  search: (query: string, maxResults?: number) => Promise<SearchResult[]>;
  listEpisodes?: (filters?: EpisodeListFilters) => EpisodeRecord[];
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
        "Search episodic memory deterministically across action, summary, tags, tools, errors, and identity fields. Supports combining a text query with exact filters.",
        {
          query: z.string().optional().describe("Case-insensitive text query"),
          maxResults: z.number().int().positive().max(1000).optional().describe("Max matches to return"),
          ...EpisodeToolFiltersSchema,
        },
        async (args) => {
          const filters = pickEpisodeFilters(args);
          const episodes = deps.listEpisodes!(filters);
          const results = args.query?.trim()
            ? episodes
                .map((episode) => scoreEpisodeMatch(episode, args.query!, deps.redact))
                .filter((value): value is EpisodicSearchResult => value != null)
                .sort((left, right) => {
                  if (right.score !== left.score) return right.score - left.score;
                  return right.episode.startedAt.localeCompare(left.episode.startedAt);
                })
                .slice(0, args.maxResults ?? episodes.length)
            : episodes.map((episode) => ({
                score: 0,
                matchedFields: [],
                episode: sanitizeEpisodeRecord(episode, deps.redact),
              })).slice(0, args.maxResults ?? episodes.length);
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

  return createSdkMcpServer({
    name: "memory",
    version: "1.0.0",
    tools: tools as any,
  });
}
