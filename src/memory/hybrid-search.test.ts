import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { hybridSearch, type HybridSearchConfig } from "./hybrid-search.js";
import {
  createVectorStore,
  type VectorStore,
  type VectorSearchResult,
  type KeywordSearchResult,
} from "./vector-store.js";
import { type EmbeddingProvider } from "./embeddings.js";

// ─── Helpers ────────────────────────────────────────────────────────

const DIMS = 4;

function defaultConfig(
  overrides?: Partial<HybridSearchConfig>,
): HybridSearchConfig {
  return {
    vectorWeight: 0.7,
    keywordWeight: 0.3,
    minScore: 0.35,
    maxResults: 6,
    ...overrides,
  };
}

/**
 * Create a mock VectorStore with controllable search results.
 * This lets us test the merging algorithm deterministically without
 * relying on actual vector similarity or BM25 scoring.
 */
function createMockStore(opts: {
  vectorResults?: VectorSearchResult[];
  keywordResults?: KeywordSearchResult[];
}): VectorStore {
  return {
    upsertChunk() {},
    searchVector(
      _queryEmbedding: number[],
      _limit: number,
    ): VectorSearchResult[] {
      return opts.vectorResults ?? [];
    },
    searchKeyword(_query: string, _limit: number): KeywordSearchResult[] {
      return opts.keywordResults ?? [];
    },
    deleteChunksForFile() {},
    getFileHash() {
      return null;
    },
    setFileHash() {},
    getTrackedFilePaths() {
      return [];
    },
    deleteFileHash() {},
    close() {},
  };
}

/** Create a mock embedding provider that returns a fixed vector. */
function createMockEmbedder(): EmbeddingProvider {
  const fixedVector = Array.from({ length: DIMS }, () => 0.5);
  return {
    dimensions: DIMS,
    async embed(_text: string): Promise<number[]> {
      return fixedVector;
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      return texts.map(() => [...fixedVector]);
    },
    async close(): Promise<void> {},
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("hybridSearch", () => {
  let embedder: EmbeddingProvider;

  beforeEach(() => {
    embedder = createMockEmbedder();
  });

  afterEach(async () => {
    await embedder?.close();
  });

  // --- Core functionality ---

  it("returns merged results from vector and keyword search", async () => {
    const store = createMockStore({
      vectorResults: [
        { id: "c1", path: "/a.ts", text: "vector match", startLine: 1, endLine: 5, distance: 0.2 },
        { id: "c2", path: "/b.ts", text: "another vector", startLine: 1, endLine: 5, distance: 0.5 },
      ],
      keywordResults: [
        { id: "c1", path: "/a.ts", text: "vector match", startLine: 1, endLine: 5, rank: -2.0 },
        { id: "c3", path: "/c.ts", text: "keyword only", startLine: 1, endLine: 5, rank: -1.0 },
      ],
    });

    const results = await hybridSearch(
      "test query",
      store,
      embedder,
      defaultConfig({ minScore: 0 }),
    );

    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r).toHaveProperty("path");
      expect(r).toHaveProperty("snippet");
      expect(r).toHaveProperty("startLine");
      expect(r).toHaveProperty("endLine");
      expect(r).toHaveProperty("score");
      expect(typeof r.score).toBe("number");
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  // --- Weighting ---

  it("scores vector-only results at vectorWeight (0.7x)", async () => {
    // c2 appears only in vector results (distance 0.3 => similarity 0.7)
    const store = createMockStore({
      vectorResults: [
        { id: "c2", path: "/b.ts", text: "vector only", startLine: 1, endLine: 5, distance: 0.3 },
      ],
      keywordResults: [],
    });

    const results = await hybridSearch(
      "test query",
      store,
      embedder,
      defaultConfig({ minScore: 0 }),
    );

    expect(results).toHaveLength(1);
    // vectorScore = 1 - 0.3 = 0.7, finalScore = 0.7 * 0.7 + 0.3 * 0 = 0.49
    expect(results[0].score).toBeCloseTo(0.49, 5);
  });

  it("scores keyword-only results at keywordWeight (0.3x)", async () => {
    // c3 appears only in keyword results (rank -1.5, only result so normalised to 1.0)
    const store = createMockStore({
      vectorResults: [],
      keywordResults: [
        { id: "c3", path: "/c.ts", text: "keyword only", startLine: 1, endLine: 5, rank: -1.5 },
      ],
    });

    const results = await hybridSearch(
      "test query",
      store,
      embedder,
      defaultConfig({ minScore: 0 }),
    );

    expect(results).toHaveLength(1);
    // keywordScore = 1.0 (only result), finalScore = 0.7 * 0 + 0.3 * 1.0 = 0.3
    expect(results[0].score).toBeCloseTo(0.3, 5);
  });

  it("gives combined score to results appearing in both searches", async () => {
    // c1 appears in both vector (distance 0.2 => sim 0.8) and keyword (most relevant)
    const store = createMockStore({
      vectorResults: [
        { id: "c1", path: "/a.ts", text: "both match", startLine: 1, endLine: 5, distance: 0.2 },
        { id: "c2", path: "/b.ts", text: "vector only", startLine: 1, endLine: 5, distance: 0.4 },
      ],
      keywordResults: [
        { id: "c1", path: "/a.ts", text: "both match", startLine: 1, endLine: 5, rank: -2.0 },
        { id: "c3", path: "/c.ts", text: "keyword only", startLine: 1, endLine: 5, rank: -1.0 },
      ],
    });

    const results = await hybridSearch(
      "test query",
      store,
      embedder,
      defaultConfig({ minScore: 0 }),
    );

    // c1 combined score: 0.7 * (1 - 0.2) + 0.3 * (2.0/2.0) = 0.7 * 0.8 + 0.3 * 1.0 = 0.56 + 0.30 = 0.86
    const c1 = results.find((r) => r.path === "/a.ts");
    expect(c1).toBeDefined();
    expect(c1!.score).toBeCloseTo(0.86, 5);

    // c2 vector-only: 0.7 * (1 - 0.4) = 0.7 * 0.6 = 0.42
    const c2 = results.find((r) => r.path === "/b.ts");
    expect(c2).toBeDefined();
    expect(c2!.score).toBeCloseTo(0.42, 5);

    // c3 keyword-only: 0.3 * (1.0/2.0) = 0.3 * 0.5 = 0.15
    const c3 = results.find((r) => r.path === "/c.ts");
    expect(c3).toBeDefined();
    expect(c3!.score).toBeCloseTo(0.15, 5);

    // Combined result should have higher score than either single-source result
    expect(c1!.score).toBeGreaterThan(c2!.score);
    expect(c1!.score).toBeGreaterThan(c3!.score);
  });

  // --- Filtering ---

  it("filters out results below minScore (0.35)", async () => {
    const store = createMockStore({
      vectorResults: [
        { id: "c1", path: "/a.ts", text: "high score", startLine: 1, endLine: 5, distance: 0.1 },
        { id: "c2", path: "/b.ts", text: "low score", startLine: 1, endLine: 5, distance: 0.9 },
      ],
      keywordResults: [
        { id: "c3", path: "/c.ts", text: "mid keyword", startLine: 1, endLine: 5, rank: -1.0 },
      ],
    });

    const results = await hybridSearch(
      "test query",
      store,
      embedder,
      defaultConfig({ minScore: 0.35 }),
    );

    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0.35);
    }

    // c1: 0.7 * 0.9 = 0.63 (above threshold)
    // c2: 0.7 * 0.1 = 0.07 (below threshold, filtered)
    // c3: 0.3 * 1.0 = 0.3 (below threshold, filtered)
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("/a.ts");
  });

  // --- Limiting ---

  it("returns max maxResults (6) results sorted by score descending", async () => {
    // Create 10 vector results with varying distances
    const vectorResults: VectorSearchResult[] = [];
    for (let i = 0; i < 10; i++) {
      vectorResults.push({
        id: `c${i}`,
        path: `/src/file-${i}.ts`,
        text: `content ${i}`,
        startLine: 1,
        endLine: 5,
        distance: 0.1 * (i + 1), // 0.1, 0.2, ..., 1.0
      });
    }

    const store = createMockStore({ vectorResults, keywordResults: [] });

    const config = defaultConfig({ maxResults: 6, minScore: 0 });
    const results = await hybridSearch("test query", store, embedder, config);

    expect(results).toHaveLength(6);

    // Verify sorted by score descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  // --- BM25 normalization ---

  it("normalizes BM25 ranks correctly to 0-1 range", async () => {
    // Multiple keyword results with different ranks
    const store = createMockStore({
      vectorResults: [],
      keywordResults: [
        { id: "k1", path: "/k1.ts", text: "most relevant", startLine: 1, endLine: 5, rank: -3.0 },
        { id: "k2", path: "/k2.ts", text: "mid relevant", startLine: 1, endLine: 5, rank: -1.5 },
        { id: "k3", path: "/k3.ts", text: "least relevant", startLine: 1, endLine: 5, rank: -0.5 },
      ],
    });

    const results = await hybridSearch(
      "test query",
      store,
      embedder,
      defaultConfig({ minScore: 0 }),
    );

    // maxAbsRank = 3.0
    // k1: keywordScore = 3.0/3.0 = 1.0, finalScore = 0.3 * 1.0 = 0.30
    // k2: keywordScore = 1.5/3.0 = 0.5, finalScore = 0.3 * 0.5 = 0.15
    // k3: keywordScore = 0.5/3.0 = 0.1667, finalScore = 0.3 * 0.1667 = 0.05

    expect(results).toHaveLength(3);

    // Verify all scores in 0-1 range
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }

    // The most relevant keyword result should have the highest score
    expect(results[0].path).toBe("/k1.ts");
    expect(results[0].score).toBeCloseTo(0.3, 5);

    // Second: k2
    expect(results[1].path).toBe("/k2.ts");
    expect(results[1].score).toBeCloseTo(0.15, 5);

    // Third: k3
    expect(results[2].path).toBe("/k3.ts");
    expect(results[2].score).toBeCloseTo(0.05, 5);
  });

  // --- Edge cases ---

  it("returns empty results for empty query", async () => {
    const store = createMockStore({
      vectorResults: [
        { id: "c1", path: "/a.ts", text: "anything", startLine: 1, endLine: 5, distance: 0.1 },
      ],
    });

    const results = await hybridSearch("", store, embedder, defaultConfig());
    expect(results).toEqual([]);
  });

  it("returns empty results when nothing matches", async () => {
    const store = createMockStore({
      vectorResults: [],
      keywordResults: [],
    });

    const results = await hybridSearch(
      "xyzzyplugh42 nonexistent",
      store,
      embedder,
      defaultConfig(),
    );

    expect(results).toEqual([]);
  });

  // --- Integration test with real VectorStore ---

  describe("with real in-memory VectorStore", () => {
    let realStore: VectorStore;

    beforeEach(() => {
      realStore = createVectorStore(":memory:", DIMS);
    });

    afterEach(() => {
      realStore?.close();
    });

    it("performs end-to-end hybrid search with indexed data", async () => {
      // Use a simple embedding: place the vector at known positions
      const makeVec = (seed: number): number[] => {
        const v = Array.from({ length: DIMS }, (_, i) => Math.sin(seed * (i + 1)));
        const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
        return mag === 0 ? v : v.map((x) => x / mag);
      };

      // Index chunks
      realStore.upsertChunk({
        id: "ts1",
        path: "/src/util.ts",
        text: "typescript utility functions helper",
        embedding: makeVec(1),
        startLine: 1,
        endLine: 10,
      });
      realStore.upsertChunk({
        id: "ts2",
        path: "/src/types.ts",
        text: "typescript types interface definition",
        embedding: makeVec(2),
        startLine: 1,
        endLine: 10,
      });
      realStore.upsertChunk({
        id: "py1",
        path: "/src/main.py",
        text: "python main entry point script",
        embedding: makeVec(3),
        startLine: 1,
        endLine: 10,
      });

      // Create an embedder that returns the same kind of vector for the query
      const queryVec = makeVec(1); // similar to ts1
      const testEmbedder: EmbeddingProvider = {
        dimensions: DIMS,
        async embed() {
          return queryVec;
        },
        async embedBatch(texts: string[]) {
          return texts.map(() => [...queryVec]);
        },
        async close() {},
      };

      const results = await hybridSearch(
        "typescript",
        realStore,
        testEmbedder,
        defaultConfig({ minScore: 0 }),
      );

      expect(results.length).toBeGreaterThan(0);

      // All scores should be valid
      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
      }

      // Results should be sorted by score descending
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });
  });
});
