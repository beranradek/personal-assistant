import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { SearchResult } from "../core/types.js";

/**
 * Create an MCP server that exposes a `memory_search` tool.
 *
 * The tool lets the agent search long-term memory (notes, decisions,
 * preferences, etc.) through the hybrid vector + keyword index.
 *
 * @param deps.search  The search function backed by the hybrid search index.
 */
export function createMemoryServer(deps: {
  search: (query: string, maxResults?: number) => Promise<SearchResult[]>;
}) {
  return createSdkMcpServer({
    name: "memory",
    version: "1.0.0",
    tools: [
      tool(
        "memory_search",
        "Search long-term memory for past decisions, preferences, and context",
        {
          query: z.string().describe("Search query"),
          maxResults: z
            .number()
            .optional()
            .describe("Max results (default 6)"),
        },
        async (args) => {
          const results = await deps.search(args.query, args.maxResults);
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(results, null, 2) },
            ],
          };
        },
      ),
    ],
  });
}
