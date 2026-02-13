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
  /** Minimum combined score to include in results. Default: 0.35 */
  minScore: number;
  /** Maximum number of results to return. Default: 6 */
  maxResults: number;
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
 *  5. Filter out results below minScore.
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

  for (const id of allIds) {
    const vScore = vectorScores.get(id) ?? 0;
    const kScore = keywordScores.get(id) ?? 0;
    const finalScore =
      config.vectorWeight * vScore + config.keywordWeight * kScore;

    const meta = chunkMap.get(id)!;
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
  const filtered = merged.filter((r) => r.score >= config.minScore);

  // Step 8: Sort by score descending
  filtered.sort((a, b) => b.score - a.score);

  // Step 9: Return top maxResults as SearchResult[]
  return filtered.slice(0, config.maxResults).map(({ _id, ...rest }) => rest);
}
