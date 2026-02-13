import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SearchResult } from "../core/types.js";

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
});
