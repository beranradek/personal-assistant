import * as fs from "node:fs/promises";
import { createLogger } from "../core/logger.js";
import { hybridSearch, type HybridSearchConfig } from "./hybrid-search.js";
import { collectMemoryFiles } from "./collect-files.js";
import type { SearchResult } from "../core/types.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { VectorStore } from "./vector-store.js";
import { readTextFileSafely } from "./text-file.js";
import {
  matchesMemoryFilters,
  parseMemoryMetadata,
  type MemorySearchFilters,
} from "./metadata.js";

const log = createLogger("robust-search");

/** Longest wait for the semantic (embedding) part of a search before the text fallback is used. */
const SEMANTIC_SEARCH_TIMEOUT_MS = 30_000;

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
  filters: MemorySearchFilters,
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
    const file = await readTextFileSafely(filePath);
    if (!file.ok) {
      continue;
    }
    const { content } = file;
    if (!matchesMemoryFilters(parseMemoryMetadata(content).metadata, filters)) {
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

function hasFilters(filters: MemorySearchFilters): boolean {
  return Boolean(filters.type || filters.tags?.length);
}

async function filterIndexedResults(
  results: SearchResult[],
  filters: MemorySearchFilters,
): Promise<SearchResult[]> {
  if (!hasFilters(filters)) return results;

  const matchesByPath = new Map<string, boolean>();
  const filtered: SearchResult[] = [];
  for (const result of results) {
    let matches = matchesByPath.get(result.path);
    if (matches === undefined) {
      const file = await readTextFileSafely(result.path);
      matches = file.ok && matchesMemoryFilters(parseMemoryMetadata(file.content).metadata, filters);
      matchesByPath.set(result.path, matches);
    }
    if (matches) filtered.push(result);
  }
  return filtered;
}

export function createRobustMemorySearch(deps: {
  workspaceDir: string;
  extraPaths: string[];
  store: VectorStore;
  embedder: EmbeddingProvider;
  config: HybridSearchConfig;
  /** Override of the semantic-search timeout (tests). */
  semanticTimeoutMs?: number;
}) {
  return async (
    query: string,
    maxResults?: number,
    filters: MemorySearchFilters = {},
  ): Promise<SearchResult[]> => {
    const resultLimit = maxResults ?? deps.config.maxResults;
    const candidateLimit = hasFilters(filters) ? resultLimit * 8 : resultLimit;
    // The embedding model loads on first use. If that fails (offline first download, missing file,
    // dead worker) fall back to the plain-text search instead of failing the whole tool call.
    // A model that is still loading (first download) must not block the tool call for minutes either.
    let results: SearchResult[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      results = await Promise.race([
        hybridSearch(query, deps.store, deps.embedder, { ...deps.config, maxResults: candidateLimit }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`semantic search did not finish within ${SEMANTIC_SEARCH_TIMEOUT_MS} ms`)),
            deps.semanticTimeoutMs ?? SEMANTIC_SEARCH_TIMEOUT_MS,
          );
          timer.unref();
        }),
      ]);
    } catch (err) {
      log.warn({ err }, "Semantic memory search unavailable, using text fallback");
    } finally {
      if (timer) clearTimeout(timer);
    }

    const indexedResults = await filterIndexedResults(results, filters);
    if (indexedResults.length >= resultLimit || (indexedResults.length > 0 && results.length > 0 && !hasFilters(filters))) {
      return indexedResults.slice(0, resultLimit);
    }

    const files = collectMemoryFiles(deps.workspaceDir, deps.extraPaths);
    const fallbackResults = await grepLikeFallbackSearch(
      query,
      files,
      resultLimit,
      filters,
    );
    return fallbackResults.length > 0 ? fallbackResults : indexedResults.slice(0, resultLimit);
  };
}
