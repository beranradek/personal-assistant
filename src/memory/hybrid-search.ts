import { SearchResult } from "../core/types.js";
import { EmbeddingProvider } from "./embeddings.js";
import {
  VectorStore,
  VectorSearchResult,
  KeywordSearchResult,
} from "./vector-store.js";

// ─── Public interface ────────────────────────────────────────────────

export interface HybridSearchConfig {
  /** Weight for vector (semantic) search scores. Default: 0.7 */
  vectorWeight: number;
  /** Weight for keyword (BM25) search scores. Default: 0.3 */
  keywordWeight: number;
  /**
   * Minimum combined score to include in results. Default: 0.35
   *
   * Note: This is treated as a soft threshold. If it would filter out all
   * candidates, the top candidates are returned anyway to avoid empty results
   * for keyword-only queries (where keywordWeight < minScore).
   */
  minScore: number;
  /** Maximum number of results to return. Default: 6 */
  maxResults: number;
  /**
   * Maximum additive score boost for content from recent files.
   * Applied via exponential decay: boost = recencyBoost * 0.5^(daysAgo/halfLifeDays).
   * Set to 0 to disable. Default: 0.1
   */
  recencyBoost?: number;
  /**
   * Days for the recency boost to halve (exponential decay half-life).
   * Default: 7 (week-old content receives half the maximum boost).
   */
  recencyHalfLifeDays?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Normalise a cosine distance (range 0..2 for unit vectors) to a
 * similarity score in [0, 1].  Lower distance = higher similarity.
 *
 * score = 1 - distance, clamped to [0, 1].
 */
function vectorDistanceToScore(distance: number): number {
  return Math.max(0, Math.min(1, 1 - distance));
}

/**
 * Normalise BM25 ranks to scores in [0, 1].
 *
 * FTS5 BM25 ranks are negative (more negative = more relevant).
 * We normalise by dividing each absolute rank by the maximum absolute
 * rank so the most relevant result gets 1.0 and less relevant results
 * get proportionally lower scores.
 */
function normaliseBm25Ranks(
  results: KeywordSearchResult[],
): Map<string, number> {
  const scores = new Map<string, number>();
  if (results.length === 0) return scores;

  const maxAbsRank = Math.max(...results.map((r) => Math.abs(r.rank)));

  if (maxAbsRank === 0) {
    // All ranks are zero – give every result a score of 1
    for (const r of results) {
      scores.set(r.id, 1);
    }
    return scores;
  }

  for (const r of results) {
    scores.set(r.id, Math.abs(r.rank) / maxAbsRank);
  }
  return scores;
}

// ─── Recency boost ───────────────────────────────────────────────────

/**
 * Extract a YYYY-MM-DD date string from a file path, if present.
 * Matches patterns like:
 *   - memory/reflection-2026-04-07.md
 *   - daily/2026-04-07.jsonl
 * Returns null if no date pattern is found.
 */
export function extractDateFromPath(filePath: string): string | null {
  const m = filePath.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1]! : null;
}

/**
 * Compute the recency boost for a file path.
 *
 * Uses exponential decay: boost = maxBoost * 0.5^(daysAgo / halfLifeDays)
 * Files without a recognisable date in their path receive no boost (0).
 *
 * @param filePath      - Path of the source file
 * @param maxBoost      - Maximum boost value (for today's files)
 * @param halfLifeDays  - Days for the boost to halve
 * @param now           - Reference date for computing age (defaults to current date)
 */
export function computeRecencyBoost(
  filePath: string,
  maxBoost: number,
  halfLifeDays: number,
  now?: Date,
): number {
  if (maxBoost <= 0) return 0;

  const dateStr = extractDateFromPath(filePath);
  if (!dateStr) return 0;

  const fileDate = new Date(dateStr + "T00:00:00.000Z");
  if (isNaN(fileDate.getTime())) return 0;

  const today = now ?? new Date();
  const todayUtc = new Date(
    Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()),
  );
  const daysAgo = Math.max(
    0,
    (todayUtc.getTime() - fileDate.getTime()) / 86_400_000,
  );

  return maxBoost * Math.pow(0.5, daysAgo / halfLifeDays);
}

// ─── Core function ───────────────────────────────────────────────────

/**
 * Perform a hybrid search combining vector (semantic) similarity and
 * BM25 keyword relevance.
 *
 * Algorithm:
 *  1. Embed the query.
 *  2. Run vector search and keyword search in parallel (each fetching
 *     2x maxResults candidates for better merging coverage).
 *  3. Normalise scores from both result sets to [0, 1].
 *  4. Merge by chunk ID, computing:
 *       finalScore = vectorWeight * vectorScore + keywordWeight * keywordScore
 *  5. Filter out results below minScore (soft threshold; see config).
 *  6. Sort descending by score.
 *  7. Return at most maxResults as SearchResult[].
 */
export async function hybridSearch(
  query: string,
  store: VectorStore,
  embedder: EmbeddingProvider,
  config: HybridSearchConfig,
): Promise<SearchResult[]> {
  // Empty query → empty results
  if (!query || query.trim().length === 0) {
    return [];
  }

  const candidateLimit = config.maxResults * 2;

  // Step 1: Embed the query
  const queryEmbedding = await embedder.embed(query);

  // Steps 2-3: Run both searches
  const vectorResults: VectorSearchResult[] = store.searchVector(
    queryEmbedding,
    candidateLimit,
  );
  const keywordResults: KeywordSearchResult[] = store.searchKeyword(
    query,
    candidateLimit,
  );

  // Step 4: Normalise vector distances to similarity scores
  const vectorScores = new Map<string, number>();
  for (const r of vectorResults) {
    vectorScores.set(r.id, vectorDistanceToScore(r.distance));
  }

  // Step 5: Normalise BM25 ranks to [0, 1]
  const keywordScores = normaliseBm25Ranks(keywordResults);

  // Collect all chunk metadata keyed by ID (from whichever search found it)
  type ChunkMeta = {
    id: string;
    path: string;
    text: string;
    startLine: number;
    endLine: number;
  };
  const chunkMap = new Map<string, ChunkMeta>();

  for (const r of vectorResults) {
    if (!chunkMap.has(r.id)) {
      chunkMap.set(r.id, {
        id: r.id,
        path: r.path,
        text: r.text,
        startLine: r.startLine,
        endLine: r.endLine,
      });
    }
  }
  for (const r of keywordResults) {
    if (!chunkMap.has(r.id)) {
      chunkMap.set(r.id, {
        id: r.id,
        path: r.path,
        text: r.text,
        startLine: r.startLine,
        endLine: r.endLine,
      });
    }
  }

  // Step 6: Merge scores
  const allIds = new Set([...vectorScores.keys(), ...keywordScores.keys()]);
  const merged: Array<SearchResult & { _id: string }> = [];

  const maxBoost = config.recencyBoost ?? 0.1;
  const halfLife = config.recencyHalfLifeDays ?? 7;

  for (const id of allIds) {
    const vScore = vectorScores.get(id) ?? 0;
    const kScore = keywordScores.get(id) ?? 0;
    const meta = chunkMap.get(id)!;
    const recency = computeRecencyBoost(meta.path, maxBoost, halfLife);
    const finalScore =
      config.vectorWeight * vScore + config.keywordWeight * kScore + recency;

    merged.push({
      _id: id,
      path: meta.path,
      snippet: meta.text,
      startLine: meta.startLine,
      endLine: meta.endLine,
      score: finalScore,
    });
  }

  // Step 7: Filter by minScore
  let filtered = merged.filter((r) => r.score >= config.minScore);

  // If the threshold filters everything out but we have keyword candidates,
  // return the best candidates anyway. This avoids "no results" failures for
  // keyword-only queries (where keywordWeight < minScore) without returning
  // low-signal vector-only neighbors.
  if (filtered.length === 0 && merged.length > 0 && keywordResults.length > 0) {
    filtered = merged.filter((r) => keywordScores.has(r._id));
  }

  // Step 8: Sort by score descending
  filtered.sort((a, b) => b.score - a.score);

  // Step 9: Return top maxResults as SearchResult[]
  return filtered.slice(0, config.maxResults).map(({ _id, ...rest }) => rest);
}
