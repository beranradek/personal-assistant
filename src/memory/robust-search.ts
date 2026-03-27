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

  const candidates: Array<SearchResult & { _matchCount: number; _matchRatio: number }> = [];

  // For broad multi-term queries, requiring *all* tokens to appear in a single
  // line often yields no matches. Use a small minimum-match threshold and rank
  // by how many tokens match.
  let minMatch = 1;
  if (tokens.length >= 4) minMatch = 2;
  if (tokens.length >= 8) minMatch = 3;

  for (const filePath of filePaths) {
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const hay = normaliseForMatch(line);
      let matchCount = 0;
      for (const token of tokens) {
        if (hay.includes(token)) matchCount++;
      }
      if (matchCount < minMatch) continue;

      const matchRatio = tokens.length > 0 ? matchCount / tokens.length : 0;
      candidates.push({
        path: filePath,
        snippet: line.trim(),
        startLine: i + 1,
        endLine: i + 1,
        // Low, but non-zero: lexical fallbacks should sort below indexed hits,
        // but remain useful as a "better than nothing" result.
        score: 0.01 + Math.min(0.09, matchRatio * 0.09),
        _matchCount: matchCount,
        _matchRatio: matchRatio,
      });
    }
  }

  candidates.sort((a, b) => {
    if (b._matchCount !== a._matchCount) return b._matchCount - a._matchCount;
    if (b._matchRatio !== a._matchRatio) return b._matchRatio - a._matchRatio;
    // Prefer earlier occurrences when tied
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.startLine - b.startLine;
  });

  // Deduplicate identical snippets (common with repeated headings)
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const c of candidates) {
    if (results.length >= maxResults) break;
    const key = `${c.path}:${c.startLine}:${c.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Strip internal ranking fields
    const { _matchCount: _mc, _matchRatio: _mr, ...rest } = c;
    results.push(rest);
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
