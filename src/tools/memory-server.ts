import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { SearchResult } from "../core/types.js";
import {
  EpisodeInitiatorSchema,
  EpisodeOutcomeSchema,
  EpisodeSourceSchema,
  type EpisodeListFilters,
  type EpisodeRecord,
} from "../memory/episodes/types.js";
import {
  handleEpisodeRecent,
  handleEpisodeSearch,
  handleEpisodeStats,
  handleEpisodeWrite,
  type EpisodeMcpDeps,
} from "./episode-mcp-tools.js";

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
    const episodeDeps: EpisodeMcpDeps = {
      listEpisodes: deps.listEpisodes,
      insertEpisode: deps.insertEpisode,
      searchEpisodesVector: deps.searchEpisodesVector,
      redact: deps.redact,
    };

    tools.push(
      tool(
        "episode_recent",
        "List recent episodic memory records using exact filters such as project, job, issue, source, or outcome.",
        {
          ...EpisodeToolFiltersSchema,
          limit: z.number().int().positive().max(1000).optional().describe("Max episodes to return"),
        },
        (args) => handleEpisodeRecent(args, episodeDeps),
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
        (args) => handleEpisodeSearch(args, episodeDeps),
      ),
      tool(
        "episode_stats",
        "Summarize episodic memory counts and top dimensions for a filtered subset of episodes.",
        { ...EpisodeToolFiltersSchema },
        (args) => handleEpisodeStats(args, episodeDeps),
      ),
    );
  }

  if (deps.insertEpisode) {
    const episodeDeps: EpisodeMcpDeps = {
      listEpisodes: deps.listEpisodes ?? (() => []),
      insertEpisode: deps.insertEpisode,
      searchEpisodesVector: deps.searchEpisodesVector,
      redact: deps.redact,
    };

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
        (args) => handleEpisodeWrite(args, episodeDeps),
      ),
    );
  }

  return createSdkMcpServer({
    name: "memory",
    version: "1.0.0",
    tools: tools as any,
  });
}
