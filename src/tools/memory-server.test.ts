import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SearchResult } from "../core/types.js";
import type { EpisodeRecord, EpisodeListFilters } from "../memory/episodes/types.js";

// ─── Mock the SDK ────────────────────────────────────────────────────
// The SDK bundles native dependencies, so we mock it at the module level
// and capture calls to verify behaviour.

const mockCreateSdkMcpServer = vi.fn(
  (opts: { name: string; version?: string; tools?: unknown[] }) => ({
    type: "sdk" as const,
    name: opts.name,
    instance: {} as unknown, // stand-in for McpServer
    _tools: opts.tools, // expose for test inspection
  }),
);

const mockTool = vi.fn(
  (
    name: string,
    description: string,
    inputSchema: unknown,
    handler: (...args: unknown[]) => Promise<unknown>,
  ) => ({
    name,
    description,
    inputSchema,
    handler,
  }),
);

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  tool: mockTool,
}));

// Import *after* mock registration so the mock takes effect.
const { createMemoryServer } = await import("./memory-server.js");

// ─── Helpers ─────────────────────────────────────────────────────────

function mockSearch(
  results: SearchResult[] = [],
): (query: string, maxResults?: number) => Promise<SearchResult[]> {
  return vi.fn(async () => results);
}

function mockListEpisodes(
  implementation?: (filters?: EpisodeListFilters) => EpisodeRecord[],
): (filters?: EpisodeListFilters) => EpisodeRecord[] {
  return vi.fn((filters?: EpisodeListFilters) => implementation?.(filters) ?? []);
}

const sampleResults: SearchResult[] = [
  {
    path: "notes/2024-preferences.md",
    snippet: "User prefers dark mode",
    startLine: 1,
    endLine: 3,
    score: 0.92,
  },
  {
    path: "decisions/arch.md",
    snippet: "Chose SQLite for persistence",
    startLine: 10,
    endLine: 15,
    score: 0.85,
  },
];

const sampleEpisodes: EpisodeRecord[] = [
  {
    id: "ep-2",
    startedAt: "2026-06-18T14:00:00.000Z",
    endedAt: "2026-06-18T14:05:00.000Z",
    source: "github",
    sessionKey: "github--owner/repo#12",
    sessionId: "github--owner/repo#12",
    initiator: "user",
    action: "Implement MCP episodic retrieval",
    normalizedAction: "implement mcp episodic retrieval",
    summary: "Added episode_search and episode_recent tools.",
    why: "Slice 5",
    projectName: "personal-assistant",
    jobName: "003-personal-assistant-episodic-memory",
    issueId: "owner/repo#12",
    pullRequestId: null,
    detailedMemoryFile: "memory/personal-assistant-episodic-memory.md",
    category: "coding",
    skillsUsed: ["tdd-workflow"],
    toolsUsed: ["functions.exec_command"],
    tags: ["github", "coding", "personal-assistant"],
    outcome: "success",
    successScore: 1,
    blockers: [],
    errors: [],
    openQuestions: [],
    trajectory: [],
    semanticEmbeddingText: "action: Implement MCP episodic retrieval",
  },
  {
    id: "ep-1",
    startedAt: "2026-06-18T13:00:00.000Z",
    endedAt: "2026-06-18T13:05:00.000Z",
    source: "heartbeat",
    sessionKey: "heartbeat--default",
    sessionId: "heartbeat--default",
    initiator: "heartbeat",
    action: "Continue with active job",
    normalizedAction: "continue with active job",
    summary: "Builder slice shipped.",
    why: null,
    projectName: "personal-assistant",
    jobName: "003-personal-assistant-episodic-memory",
    issueId: null,
    pullRequestId: null,
    detailedMemoryFile: "memory/personal-assistant-episodic-memory.md",
    category: "heartbeat",
    skillsUsed: ["heartbeat-runbook"],
    toolsUsed: ["functions.exec_command"],
    tags: ["heartbeat", "coding", "personal-assistant"],
    outcome: "partial_success",
    successScore: 0.6,
    blockers: [],
    errors: ["review finding"],
    openQuestions: [],
    trajectory: [],
    semanticEmbeddingText: "action: Continue with active job",
  },
];

const secretEpisode: EpisodeRecord = {
  ...sampleEpisodes[0],
  id: "ep-secret",
  action: "secret action",
  summary: "secret summary",
  why: "secret why",
  blockers: ["secret blocker"],
  errors: ["secret error"],
  openQuestions: ["secret evidence"],
  trajectory: [
    {
      at: "2026-06-18T14:01:00.000Z",
      kind: "action",
      label: "secret raw trajectory",
    },
  ],
  semanticEmbeddingText: "secret embedding text",
};

// ─── Tests ───────────────────────────────────────────────────────────

describe("createMemoryServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Shape tests ---

  it("returns an object with name 'memory'", () => {
    const server = createMemoryServer({ search: mockSearch() });
    expect(server).toHaveProperty("name", "memory");
  });

  it("returns an object with type 'sdk'", () => {
    const server = createMemoryServer({ search: mockSearch() });
    expect(server).toHaveProperty("type", "sdk");
  });

  it("returns an object with an instance property", () => {
    const server = createMemoryServer({ search: mockSearch() });
    expect(server).toHaveProperty("instance");
  });

  // --- Tool registration ---

  it("registers a memory_search tool via the tool() helper", () => {
    createMemoryServer({ search: mockSearch() });

    expect(mockTool).toHaveBeenCalledOnce();
    expect(mockTool.mock.calls[0][0]).toBe("memory_search");
  });

  it("passes the tool to createSdkMcpServer in the tools array", () => {
    createMemoryServer({ search: mockSearch() });

    const serverOpts = mockCreateSdkMcpServer.mock.calls[0][0];
    expect(serverOpts.tools).toHaveLength(1);
    expect(serverOpts.tools[0]).toHaveProperty("name", "memory_search");
  });

  it("registers episodic tools when listEpisodes dependency is provided", () => {
    createMemoryServer({ search: mockSearch(), listEpisodes: mockListEpisodes() });

    const toolNames = mockTool.mock.calls.map((call) => call[0]);
    expect(toolNames).toEqual([
      "memory_search",
      "episode_recent",
      "episode_search",
      "episode_stats",
    ]);
  });

  it("registers episode_write tool when insertEpisode dependency is provided", () => {
    createMemoryServer({
      search: mockSearch(),
      listEpisodes: mockListEpisodes(),
      insertEpisode: vi.fn(),
    });

    const toolNames = mockTool.mock.calls.map((call) => call[0]);
    expect(toolNames).toContain("episode_write");
  });

  it("does not register episode_write when insertEpisode is absent", () => {
    createMemoryServer({ search: mockSearch(), listEpisodes: mockListEpisodes() });

    const toolNames = mockTool.mock.calls.map((call) => call[0]);
    expect(toolNames).not.toContain("episode_write");
  });

  // --- Tool input schema ---

  it("memory_search tool has correct input schema shape", () => {
    createMemoryServer({ search: mockSearch() });

    const inputSchema = mockTool.mock.calls[0][2] as Record<string, unknown>;
    expect(inputSchema).toHaveProperty("query");
    expect(inputSchema).toHaveProperty("maxResults");
  });

  it("memory_search tool has a description mentioning long-term memory", () => {
    createMemoryServer({ search: mockSearch() });

    const description = mockTool.mock.calls[0][1] as string;
    expect(description.toLowerCase()).toContain("memory");
  });

  // --- Handler behaviour ---

  it("tool handler calls the provided search function with correct arguments", async () => {
    const search = mockSearch();
    createMemoryServer({ search });

    const handler = mockTool.mock.calls[0][3] as (
      args: { query: string; maxResults?: number },
      extra: unknown,
    ) => Promise<unknown>;

    await handler({ query: "dark mode preference", maxResults: 3 }, {});

    expect(search).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledWith("dark mode preference", 3);
  });

  it("tool handler passes undefined maxResults when not provided", async () => {
    const search = mockSearch();
    createMemoryServer({ search });

    const handler = mockTool.mock.calls[0][3] as (
      args: { query: string; maxResults?: number },
      extra: unknown,
    ) => Promise<unknown>;

    await handler({ query: "architecture decisions" }, {});

    expect(search).toHaveBeenCalledWith("architecture decisions", undefined);
  });

  it("tool handler returns formatted results with content array", async () => {
    const search = mockSearch(sampleResults);
    createMemoryServer({ search });

    const handler = mockTool.mock.calls[0][3] as (
      args: { query: string; maxResults?: number },
      extra: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;

    const result = await handler({ query: "preferences" }, {});

    expect(result).toHaveProperty("content");
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toHaveProperty("type", "text");
  });

  it("tool handler serialises search results as pretty JSON", async () => {
    const search = mockSearch(sampleResults);
    createMemoryServer({ search });

    const handler = mockTool.mock.calls[0][3] as (
      args: { query: string; maxResults?: number },
      extra: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;

    const result = await handler({ query: "preferences" }, {});

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(sampleResults);
  });

  it("tool handler returns empty array JSON when no results", async () => {
    const search = mockSearch([]);
    createMemoryServer({ search });

    const handler = mockTool.mock.calls[0][3] as (
      args: { query: string; maxResults?: number },
      extra: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;

    const result = await handler({ query: "nonexistent" }, {});

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([]);
  });

  it("episode_recent passes exact filters through to listEpisodes", async () => {
    const listEpisodes = mockListEpisodes(() => sampleEpisodes);
    createMemoryServer({ search: mockSearch(), listEpisodes });

    const handler = mockTool.mock.calls[1][3] as (
      args: EpisodeListFilters,
      extra: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;

    const result = await handler({ projectName: "personal-assistant", limit: 1 }, {});

    expect(listEpisodes).toHaveBeenCalledWith({
      projectName: "personal-assistant",
      limit: 1,
    });
    expect(JSON.parse(result.content[0].text)).toEqual([
      expect.objectContaining({
        id: "ep-2",
        action: "Implement MCP episodic retrieval",
        summary: "Added episode_search and episode_recent tools.",
        trajectory: [],
      }),
      expect.objectContaining({
        id: "ep-1",
        action: "Continue with active job",
        summary: "Builder slice shipped.",
        trajectory: [],
      }),
    ]);
  });

  it("episode_recent passes date-range filters through to listEpisodes", async () => {
    const listEpisodes = mockListEpisodes(() => sampleEpisodes);
    createMemoryServer({ search: mockSearch(), listEpisodes });

    const handler = mockTool.mock.calls[1][3] as (
      args: EpisodeListFilters,
      extra: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;

    await handler({
      startedAtFrom: "2026-06-18T00:00:00.000Z",
      startedAtTo: "2026-06-18T23:59:59.999Z",
      endedAtFrom: "2026-06-18T00:00:00.000Z",
      endedAtTo: "2026-06-18T23:59:59.999Z",
      limit: 5,
    }, {});

    expect(listEpisodes).toHaveBeenCalledWith({
      startedAtFrom: "2026-06-18T00:00:00.000Z",
      startedAtTo: "2026-06-18T23:59:59.999Z",
      endedAtFrom: "2026-06-18T00:00:00.000Z",
      endedAtTo: "2026-06-18T23:59:59.999Z",
      limit: 5,
    });
  });

  it("episode_recent omits raw trajectory data and redacts exposed strings", async () => {
    const listEpisodes = mockListEpisodes(() => [secretEpisode]);
    createMemoryServer({
      search: mockSearch(),
      listEpisodes,
      redact: (text) => text.replaceAll("secret", "[redacted]"),
    });

    const handler = mockTool.mock.calls[1][3] as (
      args: EpisodeListFilters,
      extra: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;

    const result = await handler({}, {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual([
      expect.objectContaining({
        id: "ep-secret",
        action: "[redacted] action",
        summary: "[redacted] summary",
        why: "[redacted] why",
        blockers: ["[redacted] blocker"],
        errors: ["[redacted] error"],
        openQuestions: ["[redacted] evidence"],
      }),
    ]);
    expect(parsed[0]).not.toHaveProperty("normalizedAction");
    expect(parsed[0]).not.toHaveProperty("semanticEmbeddingText");
    expect(parsed[0]).toHaveProperty("trajectory");
  });

  it("episode_search ranks deterministic text matches and respects exact filters", async () => {
    const listEpisodes = mockListEpisodes(() => sampleEpisodes);
    createMemoryServer({ search: mockSearch(), listEpisodes });

    const handler = mockTool.mock.calls[2][3] as (
      args: EpisodeListFilters & { query?: string; maxResults?: number },
      extra: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;

    const result = await handler(
      { query: "github retrieval", source: "github", maxResults: 5 },
      {},
    );

    expect(listEpisodes).toHaveBeenCalledWith({
      source: "github",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      score: expect.any(Number),
      episode: { id: "ep-2" },
    });
    expect(parsed[0].matchedFields).toEqual(
      expect.arrayContaining(["source", "action", "tags"]),
    );
  });

  it("episode_search forwards date-range filters alongside the text query", async () => {
    const listEpisodes = mockListEpisodes(() => sampleEpisodes);
    createMemoryServer({ search: mockSearch(), listEpisodes });

    const handler = mockTool.mock.calls[2][3] as (
      args: EpisodeListFilters & { query?: string; maxResults?: number },
      extra: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;

    await handler(
      {
        query: "retrieval",
        startedAtFrom: "2026-06-18T00:00:00.000Z",
        endedAtFrom: "2026-06-18T00:00:00.000Z",
        maxResults: 3,
      },
      {},
    );

    expect(listEpisodes).toHaveBeenCalledWith({
      startedAtFrom: "2026-06-18T00:00:00.000Z",
      endedAtFrom: "2026-06-18T00:00:00.000Z",
    });
  });

  it("episode_stats summarizes counts, top dimensions, and latest timestamp", async () => {
    const listEpisodes = mockListEpisodes(() => sampleEpisodes);
    createMemoryServer({ search: mockSearch(), listEpisodes });

    const handler = mockTool.mock.calls[3][3] as (
      args: EpisodeListFilters,
      extra: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;

    const result = await handler({ projectName: "personal-assistant" }, {});

    expect(listEpisodes).toHaveBeenCalledWith({
      projectName: "personal-assistant",
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      totalEpisodes: 2,
      latestStartedAt: "2026-06-18T14:00:00.000Z",
      byOutcome: {
        success: 1,
        partial_success: 1,
      },
      bySource: {
        github: 1,
        heartbeat: 1,
      },
      byCategory: {
        coding: 1,
        heartbeat: 1,
      },
      topSkills: [
        { value: "heartbeat-runbook", count: 1 },
        { value: "tdd-workflow", count: 1 },
      ],
      topProjects: [
        { value: "personal-assistant", count: 2 },
      ],
    });
  });

  it("episode_stats forwards date-range filters to listEpisodes", async () => {
    const listEpisodes = mockListEpisodes(() => sampleEpisodes);
    createMemoryServer({ search: mockSearch(), listEpisodes });

    const handler = mockTool.mock.calls[3][3] as (
      args: EpisodeListFilters,
      extra: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;

    await handler({
      startedAtFrom: "2026-06-18T00:00:00.000Z",
      startedAtTo: "2026-06-18T23:59:59.999Z",
      endedAtFrom: "2026-06-18T00:00:00.000Z",
      endedAtTo: "2026-06-18T23:59:59.999Z",
    }, {});

    expect(listEpisodes).toHaveBeenCalledWith({
      startedAtFrom: "2026-06-18T00:00:00.000Z",
      startedAtTo: "2026-06-18T23:59:59.999Z",
      endedAtFrom: "2026-06-18T00:00:00.000Z",
      endedAtTo: "2026-06-18T23:59:59.999Z",
    });
  });

  // ─── episode_write ────────────────────────────────────────────────────

  it("episode_write calls insertEpisode with a well-formed episode record", async () => {
    const insertEpisode = vi.fn();
    createMemoryServer({ search: mockSearch(), listEpisodes: mockListEpisodes(), insertEpisode });

    // episode_write is the 5th tool registered (index 4)
    const handler = mockTool.mock.calls[4][3] as (
      args: Record<string, unknown>,
      extra: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;

    const result = await handler(
      {
        action: "Fix auth bug in login flow",
        summary: "Found and fixed null-pointer in token validation. Tests pass.",
        outcome: "success",
        why: "Production errors in Sentry",
        initiator: "user",
        source: "github",
        sessionKey: "github--owner/repo#42",
        projectName: "myapp",
        issueId: "owner/repo#42",
        category: "debugging",
        location: "src/auth/token.ts:84",
        toolsUsed: ["Read", "Edit"],
        tags: ["auth", "bug"],
        trajectory: ["Identified null check missing at line 84", "Added guard and test"],
      },
      {},
    );

    expect(insertEpisode).toHaveBeenCalledOnce();
    const episode = insertEpisode.mock.calls[0][0] as EpisodeRecord;
    expect(episode).toMatchObject({
      action: "Fix auth bug in login flow",
      normalizedAction: "fix auth bug in login flow",
      summary: "Found and fixed null-pointer in token validation. Tests pass.",
      outcome: "success",
      successScore: 1,
      source: "github",
      sessionKey: "github--owner/repo#42",
      initiator: "user",
      projectName: "myapp",
      issueId: "owner/repo#42",
      category: "debugging",
      toolsUsed: ["Read", "Edit"],
      tags: ["auth", "bug"],
    });
    expect(episode.id).toHaveLength(32);
    expect(episode.trajectory).toHaveLength(2);
    expect(episode.trajectory[0]).toMatchObject({ kind: "decision", label: "Identified null check missing at line 84" });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ status: "inserted", id: episode.id });
  });

  it("episode_write applies defaults for optional source and initiator fields", async () => {
    const insertEpisode = vi.fn();
    createMemoryServer({ search: mockSearch(), listEpisodes: mockListEpisodes(), insertEpisode });

    const handler = mockTool.mock.calls[4][3] as (
      args: Record<string, unknown>,
      extra: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;

    await handler(
      { action: "Run daily cleanup", summary: "Done.", outcome: "success" },
      {},
    );

    const episode = insertEpisode.mock.calls[0][0] as EpisodeRecord;
    expect(episode.source).toBe("system");
    expect(episode.initiator).toBe("system");
    expect(episode.sessionKey).toBe("system--default");
    expect(episode.successScore).toBe(1);
    expect(episode.blockers).toEqual([]);
    expect(episode.errors).toEqual([]);
    expect(episode.trajectory).toEqual([]);
  });

  // ─── episode_search semantic ──────────────────────────────────────────

  it("episode_search with semantic:true calls searchEpisodesVector and returns results with semantic matchedFields", async () => {
    const searchEpisodesVector = vi.fn(async () => sampleEpisodes);
    createMemoryServer({ search: mockSearch(), listEpisodes: mockListEpisodes(), searchEpisodesVector });

    const handler = mockTool.mock.calls[2][3] as (
      args: Record<string, unknown>,
      extra: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;

    const result = await handler({ query: "deploy staging", semantic: true, maxResults: 5 }, {});

    expect(searchEpisodesVector).toHaveBeenCalledWith("deploy staging", 5);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(sampleEpisodes.length);
    expect(parsed[0]).toMatchObject({ matchedFields: ["semantic"], episode: { id: "ep-2" } });
  });

  it("episode_search without semantic uses keyword path and does not call searchEpisodesVector", async () => {
    const searchEpisodesVector = vi.fn(async () => []);
    const listEpisodes = mockListEpisodes(() => sampleEpisodes);
    createMemoryServer({ search: mockSearch(), listEpisodes, searchEpisodesVector });

    const handler = mockTool.mock.calls[2][3] as (
      args: Record<string, unknown>,
      extra: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;

    await handler({ query: "retrieval" }, {});

    expect(searchEpisodesVector).not.toHaveBeenCalled();
    expect(listEpisodes).toHaveBeenCalled();
  });
});
