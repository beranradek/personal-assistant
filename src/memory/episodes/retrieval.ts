import type { EpisodeListFilters, EpisodeRecord } from "./types.js";

export type EpisodeRetrievalMode = "exact_episodic" | "semantic_episodic";

export type EpisodeRetrievalMatch = {
  score: number;
  matchedFields: string[];
  exactMatchedFilters: string[];
  episode: EpisodeRecord;
};

const EPISODE_FILTER_KEYS = [
  "sessionKey",
  "source",
  "outcome",
  "startedAtFrom",
  "startedAtTo",
  "endedAtFrom",
  "endedAtTo",
  "projectName",
  "jobName",
  "issueId",
  "pullRequestId",
  "detailedMemoryFile",
  "category",
  "skillUsed",
] as const satisfies ReadonlyArray<keyof EpisodeListFilters>;

const EXACT_IDENTITY_FILTER_KEYS = [
  "sessionKey",
  "issueId",
  "pullRequestId",
] as const satisfies ReadonlyArray<keyof EpisodeListFilters>;

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

function matchesFilters(episode: EpisodeRecord, filters?: EpisodeListFilters): boolean {
  if (!filters) return true;
  if (filters.sessionKey && episode.sessionKey !== filters.sessionKey) return false;
  if (filters.source && episode.source !== filters.source) return false;
  if (filters.outcome && episode.outcome !== filters.outcome) return false;
  if (filters.startedAtFrom && episode.startedAt < filters.startedAtFrom) return false;
  if (filters.startedAtTo && episode.startedAt > filters.startedAtTo) return false;
  if (filters.endedAtFrom && episode.endedAt < filters.endedAtFrom) return false;
  if (filters.endedAtTo && episode.endedAt > filters.endedAtTo) return false;
  if (filters.projectName && episode.projectName !== filters.projectName) return false;
  if (filters.jobName && episode.jobName !== filters.jobName) return false;
  if (filters.issueId && episode.issueId !== filters.issueId) return false;
  if (filters.pullRequestId && episode.pullRequestId !== filters.pullRequestId) return false;
  if (filters.detailedMemoryFile && episode.detailedMemoryFile !== filters.detailedMemoryFile) return false;
  if (filters.category && episode.category !== filters.category) return false;
  if (filters.skillUsed && !episode.skillsUsed.includes(filters.skillUsed)) return false;
  return true;
}

function exactMatchedFilters(filters?: EpisodeListFilters): string[] {
  if (!filters) return [];
  return EPISODE_FILTER_KEYS.filter((key) => {
    const value = filters[key];
    return value !== undefined && value !== null && value !== "";
  });
}

export function inferEpisodeRetrievalMode(args: {
  query?: string | null;
  filters?: EpisodeListFilters;
}): EpisodeRetrievalMode {
  const matchedFilters = exactMatchedFilters(args.filters);
  if (matchedFilters.some((key) =>
    (EXACT_IDENTITY_FILTER_KEYS as readonly string[]).includes(key),
  )) {
    return "exact_episodic";
  }
  if (args.filters?.projectName && args.filters?.jobName) {
    return "exact_episodic";
  }
  return "semantic_episodic";
}

export function searchEpisodes(
  episodes: EpisodeRecord[],
  args: {
    query?: string | null;
    filters?: EpisodeListFilters;
    maxResults?: number;
  },
): EpisodeRetrievalMatch[] {
  const filteredEpisodes = episodes.filter((episode) => matchesFilters(episode, args.filters));
  const matchedFilters = exactMatchedFilters(args.filters);
  const normalizedQuery = args.query?.trim().toLowerCase() ?? "";

  const results = normalizedQuery
    ? filteredEpisodes
        .map((episode): EpisodeRetrievalMatch | null => {
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
            exactMatchedFilters: matchedFilters,
            episode,
          };
        })
        .filter((value): value is EpisodeRetrievalMatch => value != null)
        .sort((left, right) => {
          if (right.score !== left.score) return right.score - left.score;
          return right.episode.startedAt.localeCompare(left.episode.startedAt);
        })
    : filteredEpisodes.map((episode) => ({
        score: 0,
        matchedFields: [],
        exactMatchedFilters: matchedFilters,
        episode,
      }));

  return results.slice(0, args.maxResults ?? args.filters?.limit ?? results.length);
}
