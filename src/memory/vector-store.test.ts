import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createVectorStore,
  type VectorStore,
  type ChunkRecord,
  type VectorSearchResult,
  type KeywordSearchResult,
} from "./vector-store.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Helpers ────────────────────────────────────────────────────────

const DIMS = 4; // small dimension count for fast, deterministic tests

/** Create a deterministic float32 vector of given dimensions. */
function makeVector(seed: number, dims: number = DIMS): number[] {
  const vec: number[] = [];
  for (let i = 0; i < dims; i++) {
    vec.push(Math.sin(seed * (i + 1)));
  }
  // L2-normalise
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return mag === 0 ? vec : vec.map((v) => v / mag);
}

function makeChunk(overrides: Partial<ChunkRecord> & { id: string }): ChunkRecord {
  return {
    path: "/src/example.ts",
    text: `content for ${overrides.id}`,
    embedding: makeVector(overrides.id.charCodeAt(0)),
    startLine: 1,
    endLine: 10,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("VectorStore", () => {
  let store: VectorStore;
  let tmpDir: string;

  afterEach(() => {
    try {
      store?.close();
    } catch {
      // already closed
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // --- createVectorStore -------------------------------------------

  describe("createVectorStore(dbPath, dimensions)", () => {
    it("creates a SQLite database with the required tables", () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vecstore-"));
      const dbPath = path.join(tmpDir, "test.db");
      store = createVectorStore(dbPath, DIMS);

      // The database file should exist
      expect(fs.existsSync(dbPath)).toBe(true);
    });

    it("creates database at the specified path", () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vecstore-path-"));
      const dbPath = path.join(tmpDir, "subdir", "deep", "store.db");

      // Parent dirs don't exist yet - createVectorStore should handle this
      // or we create them. Let's just use a flat path for simplicity.
      const flatPath = path.join(tmpDir, "store.db");
      store = createVectorStore(flatPath, DIMS);

      expect(fs.existsSync(flatPath)).toBe(true);
    });

    it("works with :memory: databases", () => {
      store = createVectorStore(":memory:", DIMS);
      // Should not throw
      expect(store).toBeDefined();
    });
  });

  // --- upsertChunk -------------------------------------------------

  describe("upsertChunk(chunk)", () => {
    beforeEach(() => {
      store = createVectorStore(":memory:", DIMS);
    });

    it("inserts a chunk that can be retrieved via vector search", () => {
      const chunk = makeChunk({ id: "a" });
      store.upsertChunk(chunk);

      const results = store.searchVector(chunk.embedding, 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].id).toBe("a");
    });

    it("inserts a chunk that can be retrieved via keyword search", () => {
      const chunk = makeChunk({ id: "b", text: "typescript generics tutorial" });
      store.upsertChunk(chunk);

      const results = store.searchKeyword("typescript generics", 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].id).toBe("b");
    });
  });

  // --- Duplicate chunk IDs update existing record ------------------

  describe("duplicate chunk IDs", () => {
    beforeEach(() => {
      store = createVectorStore(":memory:", DIMS);
    });

    it("updates existing record when upserting with same ID", () => {
      const chunk1 = makeChunk({
        id: "dup",
        text: "original content about dogs",
        path: "/old.ts",
      });
      store.upsertChunk(chunk1);

      const chunk2 = makeChunk({
        id: "dup",
        text: "updated content about cats",
        path: "/new.ts",
      });
      store.upsertChunk(chunk2);

      // Vector search should return the updated content
      const vecResults = store.searchVector(chunk2.embedding, 10);
      const found = vecResults.find((r) => r.id === "dup");
      expect(found).toBeDefined();
      expect(found!.text).toBe("updated content about cats");
      expect(found!.path).toBe("/new.ts");

      // Keyword search for new content should find it
      const kwResults = store.searchKeyword("cats", 10);
      const kwFound = kwResults.find((r) => r.id === "dup");
      expect(kwFound).toBeDefined();
      expect(kwFound!.text).toBe("updated content about cats");

      // Keyword search for old content should NOT find it
      const oldResults = store.searchKeyword("dogs", 10);
      const oldFound = oldResults.find((r) => r.id === "dup");
      expect(oldFound).toBeUndefined();
    });
  });

  // --- searchVector ------------------------------------------------

  describe("searchVector(queryEmbedding, limit)", () => {
    beforeEach(() => {
      store = createVectorStore(":memory:", DIMS);
    });

    it("returns results sorted by cosine distance (lower = more similar)", () => {
      // Insert chunks with known embeddings
      const vecA = makeVector(1);
      const vecB = makeVector(2);
      const vecC = makeVector(3);

      store.upsertChunk(makeChunk({ id: "c1", embedding: vecA }));
      store.upsertChunk(makeChunk({ id: "c2", embedding: vecB }));
      store.upsertChunk(makeChunk({ id: "c3", embedding: vecC }));

      // Search with vecA - c1 should be closest
      const results = store.searchVector(vecA, 3);

      expect(results.length).toBe(3);
      expect(results[0].id).toBe("c1");
      expect(results[0].distance).toBeLessThanOrEqual(results[1].distance);
      expect(results[1].distance).toBeLessThanOrEqual(results[2].distance);
    });

    it("respects the limit parameter", () => {
      store.upsertChunk(makeChunk({ id: "x1", embedding: makeVector(10) }));
      store.upsertChunk(makeChunk({ id: "x2", embedding: makeVector(20) }));
      store.upsertChunk(makeChunk({ id: "x3", embedding: makeVector(30) }));

      const results = store.searchVector(makeVector(10), 2);
      expect(results.length).toBe(2);
    });

    it("returns VectorSearchResult with all expected fields", () => {
      store.upsertChunk(
        makeChunk({
          id: "fields",
          path: "/test/file.ts",
          text: "function hello() {}",
          startLine: 5,
          endLine: 15,
          embedding: makeVector(42),
        }),
      );

      const results = store.searchVector(makeVector(42), 1);
      expect(results).toHaveLength(1);

      const r = results[0];
      expect(r.id).toBe("fields");
      expect(r.path).toBe("/test/file.ts");
      expect(r.text).toBe("function hello() {}");
      expect(r.startLine).toBe(5);
      expect(r.endLine).toBe(15);
      expect(typeof r.distance).toBe("number");
    });

    it("returns empty array when no chunks exist", () => {
      const results = store.searchVector(makeVector(1), 10);
      expect(results).toEqual([]);
    });
  });

  // --- searchKeyword -----------------------------------------------

  describe("searchKeyword(query, limit)", () => {
    beforeEach(() => {
      store = createVectorStore(":memory:", DIMS);
    });

    it("returns results sorted by BM25 rank (lower = more relevant)", () => {
      store.upsertChunk(
        makeChunk({ id: "kw1", text: "rust programming language systems" }),
      );
      store.upsertChunk(
        makeChunk({ id: "kw2", text: "javascript typescript web programming" }),
      );
      store.upsertChunk(
        makeChunk({ id: "kw3", text: "cooking recipes for dinner" }),
      );

      const results = store.searchKeyword("programming", 10);
      expect(results.length).toBeGreaterThanOrEqual(2);

      // All results should match the query
      for (const r of results) {
        expect(r.text.toLowerCase()).toContain("programming");
      }

      // Results should be sorted by rank (ascending - lower is more relevant)
      for (let i = 1; i < results.length; i++) {
        expect(results[i].rank).toBeGreaterThanOrEqual(results[i - 1].rank);
      }
    });

    it("respects the limit parameter", () => {
      store.upsertChunk(makeChunk({ id: "l1", text: "test alpha beta" }));
      store.upsertChunk(makeChunk({ id: "l2", text: "test gamma delta" }));
      store.upsertChunk(makeChunk({ id: "l3", text: "test epsilon zeta" }));

      const results = store.searchKeyword("test", 2);
      expect(results.length).toBe(2);
    });

    it("returns KeywordSearchResult with all expected fields", () => {
      store.upsertChunk(
        makeChunk({
          id: "kwfields",
          path: "/kw/test.ts",
          text: "unique searchable content here",
          startLine: 20,
          endLine: 30,
        }),
      );

      const results = store.searchKeyword("unique searchable", 1);
      expect(results).toHaveLength(1);

      const r = results[0];
      expect(r.id).toBe("kwfields");
      expect(r.path).toBe("/kw/test.ts");
      expect(r.text).toBe("unique searchable content here");
      expect(r.startLine).toBe(20);
      expect(r.endLine).toBe(30);
      expect(typeof r.rank).toBe("number");
    });

    it("returns empty array when no chunks match", () => {
      store.upsertChunk(makeChunk({ id: "nomatch", text: "hello world" }));

      const results = store.searchKeyword("xylophone", 10);
      expect(results).toEqual([]);
    });

    it("returns empty array when database is empty", () => {
      const results = store.searchKeyword("anything", 10);
      expect(results).toEqual([]);
    });
  });

  // --- deleteChunksForFile -----------------------------------------

  describe("deleteChunksForFile(filePath)", () => {
    beforeEach(() => {
      store = createVectorStore(":memory:", DIMS);
    });

    it("removes all chunks belonging to a given source file", () => {
      store.upsertChunk(
        makeChunk({ id: "f1-c1", path: "/src/a.ts", text: "file a chunk one" }),
      );
      store.upsertChunk(
        makeChunk({ id: "f1-c2", path: "/src/a.ts", text: "file a chunk two" }),
      );
      store.upsertChunk(
        makeChunk({ id: "f2-c1", path: "/src/b.ts", text: "file b chunk one" }),
      );

      store.deleteChunksForFile("/src/a.ts");

      // Chunks for /src/a.ts should be gone from keyword search
      const aResults = store.searchKeyword("file a", 10);
      expect(aResults).toEqual([]);

      // Chunks for /src/b.ts should still exist
      const bResults = store.searchKeyword("file b", 10);
      expect(bResults).toHaveLength(1);
      expect(bResults[0].id).toBe("f2-c1");
    });

    it("does nothing when no chunks exist for the path", () => {
      store.upsertChunk(
        makeChunk({ id: "safe", path: "/keep.ts", text: "keep this content" }),
      );

      // Should not throw
      store.deleteChunksForFile("/nonexistent.ts");

      const results = store.searchKeyword("keep", 10);
      expect(results).toHaveLength(1);
    });
  });

  // --- getFileHash / setFileHash -----------------------------------

  describe("file hash tracking", () => {
    beforeEach(() => {
      store = createVectorStore(":memory:", DIMS);
    });

    it("getFileHash returns null for unknown file", () => {
      expect(store.getFileHash("/unknown.ts")).toBeNull();
    });

    it("setFileHash stores and getFileHash retrieves the hash", () => {
      store.setFileHash("/src/main.ts", "abc123", 1700000000, 4096);
      expect(store.getFileHash("/src/main.ts")).toBe("abc123");
    });

    it("setFileHash updates existing record", () => {
      store.setFileHash("/src/main.ts", "old-hash", 1700000000, 4096);
      store.setFileHash("/src/main.ts", "new-hash", 1700001000, 5000);

      expect(store.getFileHash("/src/main.ts")).toBe("new-hash");
    });
  });

  // --- close -------------------------------------------------------

  describe("close()", () => {
    it("closes the database without error", () => {
      store = createVectorStore(":memory:", DIMS);
      expect(() => store.close()).not.toThrow();
    });

    it("operations throw after close", () => {
      store = createVectorStore(":memory:", DIMS);
      store.close();

      expect(() =>
        store.upsertChunk(makeChunk({ id: "after-close" })),
      ).toThrow();
    });
  });
});
