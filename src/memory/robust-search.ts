import * as fs from "node:fs/promises";
import { hybridSearch, type HybridSearchConfig } from "./hybrid-search.js";
import { collectMemoryFiles } from "./collect-files.js";
import type { SearchResult } from "../core/types.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { VectorStore } from "./vector-store.js";

function stripDiacritics(input: string): string {
  return input.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function normaliseForMatch(input: string): string {
  return stripDiacritics(input).toLowerCase();
}

function extractTokens(query: string): string[] {
  const tokens = normaliseForMatch(query).match(/[\p{L}\p{N}]+/gu) ?? [];
  // Keep only moderately-informative tokens; short tokens are noisy.
  const filtered = tokens.filter((t) => t.length >= 3);
  return filtered.length > 0 ? filtered : tokens;
}

async function grepLikeFallbackSearch(
  query: string,
  filePaths: string[],
  maxResults: number,
): Promise<SearchResult[]> {
  const tokens = extractTokens(query);
  if (tokens.length === 0) return [];

  const results: SearchResult[] = [];

  for (const filePath of filePaths) {
    if (results.length >= maxResults) break;

    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (results.length >= maxResults) break;

      const line = lines[i] ?? "";
      const hay = normaliseForMatch(line);
      const ok = tokens.every((t) => hay.includes(t));
      if (!ok) continue;

      results.push({
        path: filePath,
        snippet: line.trim(),
        startLine: i + 1,
        endLine: i + 1,
        // Low, but non-zero: these results are lexical fallbacks and may not
        // be as relevant as indexed hybrid matches.
        score: 0.01,
      });
    }
  }

  return results;
}

export function createRobustMemorySearch(deps: {
  workspaceDir: string;
  extraPaths: string[];
  store: VectorStore;
  embedder: EmbeddingProvider;
  config: HybridSearchConfig;
}) {
  return async (query: string, maxResults?: number): Promise<SearchResult[]> => {
    const results = await hybridSearch(query, deps.store, deps.embedder, {
      ...deps.config,
      maxResults: maxResults ?? deps.config.maxResults,
    });

    if (results.length > 0) return results;

    const files = collectMemoryFiles(deps.workspaceDir, deps.extraPaths);
    return grepLikeFallbackSearch(
      query,
      files,
      maxResults ?? deps.config.maxResults,
    );
  };
}

