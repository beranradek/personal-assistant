/**
 * End-to-end test for the memory indexing and search pipeline.
 *
 * Verifies the full flow: file on disk → collectMemoryFiles → indexer.syncFiles
 * → vector store (sqlite-vec + FTS5) → hybridSearch → results.
 *
 * Uses the mock embedding provider (deterministic vectors) so the test
 * doesn't need the real GGUF model, but exercises the real VectorStore
 * (in-memory SQLite with sqlite-vec and FTS5).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { collectMemoryFiles } from "./collect-files.js";
import { createIndexer } from "./indexer.js";
import { createVectorStore, type VectorStore } from "./vector-store.js";
import { createMockEmbeddingProvider, type EmbeddingProvider } from "./embeddings.js";
import { hybridSearch, type HybridSearchConfig } from "./hybrid-search.js";

// ─── Helpers ──────────────────────────────────────────────────────────

function defaultSearchConfig(
  overrides?: Partial<HybridSearchConfig>,
): HybridSearchConfig {
  return {
    vectorWeight: 0.7,
    keywordWeight: 0.3,
    minScore: 0.0, // use 0 to see all results in tests
    maxResults: 10,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("memory indexing e2e", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let memoryDir: string;
  let store: VectorStore;
  let embedder: EmbeddingProvider;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-e2e-"));
    workspaceDir = path.join(tmpDir, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });

    embedder = createMockEmbeddingProvider(128);
    store = createVectorStore(":memory:", embedder.dimensions);
  });

  afterEach(async () => {
    store?.close();
    await embedder?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("indexes a memory file and finds it via keyword search", async () => {
    // 1. Create a .md file in the memory directory
    const filePath = path.join(memoryDir, "zdroje-vapniku.md");
    fs.writeFileSync(
      filePath,
      [
        "# Zdroje vápníku",
        "",
        "Mléčné výrobky: mléko, jogurt, sýry",
        "Zelenina: brokolice, kapusta, bok choy",
        "Luštěniny a semínka: bílé fazole, sezam, chia",
      ].join("\n"),
    );

    // Also create MEMORY.md in workspace root
    fs.writeFileSync(
      path.join(workspaceDir, "MEMORY.md"),
      "# Memory Index\n\n- [Zdroje vápníku](memory/zdroje-vapniku.md)\n",
    );

    // 2. Collect memory files (same as daemon does)
    const files = collectMemoryFiles(workspaceDir, []);
    expect(files).toContain(filePath);
    expect(files).toContain(path.join(workspaceDir, "MEMORY.md"));

    // 3. Index via the indexer (same as daemon does)
    const indexer = createIndexer(store, embedder);
    await indexer.syncFiles(files);

    // 4. Search via keyword (FTS5) — should find "vapniku" / "vápníku"
    const keywordResults = store.searchKeyword("vapniku", 10);
    expect(keywordResults.length).toBeGreaterThan(0);
    const calciumMatch = keywordResults.find((r) => r.path === filePath);
    expect(calciumMatch, "calcium file should appear in keyword results").toBeDefined();
  });

  it("indexes a memory file and finds it via hybrid search", async () => {
    const filePath = path.join(memoryDir, "zdroje-vapniku.md");
    fs.writeFileSync(
      filePath,
      [
        "# Zdroje vápníku",
        "",
        "Mléčné výrobky: mléko, jogurt, sýry",
        "Zelenina: brokolice, kapusta, bok choy",
        "Luštěniny a semínka: bílé fazole, sezam, chia",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(workspaceDir, "MEMORY.md"),
      "# Memory Index\n",
    );

    const files = collectMemoryFiles(workspaceDir, []);
    const indexer = createIndexer(store, embedder);
    await indexer.syncFiles(files);

    // Hybrid search (vector + keyword) — mock embeddings are deterministic
    // so the vector part won't be semantically meaningful, but FTS5 keyword
    // match should still surface the result
    const results = await hybridSearch(
      "vapniku",
      store,
      embedder,
      defaultSearchConfig(),
    );

    expect(results.length).toBeGreaterThan(0);

    // At least one result should come from the calcium file
    const calciumResult = results.find((r) => r.path === filePath);
    expect(calciumResult).toBeDefined();
    expect(calciumResult!.snippet).toContain("vápníku");
    expect(calciumResult!.score).toBeGreaterThan(0);
  });

  it("re-indexes when file content changes", async () => {
    const filePath = path.join(memoryDir, "notes.md");
    fs.writeFileSync(filePath, "Original content about dogs\n");
    fs.writeFileSync(path.join(workspaceDir, "MEMORY.md"), "# Memory\n");

    const indexer = createIndexer(store, embedder);

    // First sync
    const files = collectMemoryFiles(workspaceDir, []);
    await indexer.syncFiles(files);

    const beforeResults = store.searchKeyword("dogs", 10);
    expect(beforeResults.length).toBeGreaterThan(0);

    // Modify the file
    fs.writeFileSync(filePath, "Updated content about cats\n");

    // Second sync — should detect the content change via hash
    await indexer.syncFiles(files);

    const afterDogs = store.searchKeyword("dogs", 10);
    expect(afterDogs.length).toBe(0);

    const afterCats = store.searchKeyword("cats", 10);
    expect(afterCats.length).toBeGreaterThan(0);
  });

  it("skips unchanged files (hash match)", async () => {
    const filePath = path.join(memoryDir, "stable.md");
    fs.writeFileSync(filePath, "Stable content\n");
    fs.writeFileSync(path.join(workspaceDir, "MEMORY.md"), "# Memory\n");

    const indexer = createIndexer(store, embedder);
    const files = collectMemoryFiles(workspaceDir, []);

    // First sync indexes the file
    await indexer.syncFiles(files);
    const results1 = store.searchKeyword("Stable", 10);
    expect(results1.length).toBeGreaterThan(0);

    // Second sync should skip (same hash) — still searchable
    await indexer.syncFiles(files);
    const results2 = store.searchKeyword("Stable", 10);
    expect(results2.length).toBeGreaterThan(0);
  });

  it("discovers new files added to memory/ after initial collection", async () => {
    fs.writeFileSync(path.join(workspaceDir, "MEMORY.md"), "# Memory\n");

    // Initial collection — no files in memory/
    const filesBefore = collectMemoryFiles(workspaceDir, []);
    expect(filesBefore).toHaveLength(1); // only MEMORY.md

    // Add a file to memory/
    const newFile = path.join(memoryDir, "new-topic.md");
    fs.writeFileSync(newFile, "New topic content about astronomy\n");

    // Re-collect — should find the new file
    const filesAfter = collectMemoryFiles(workspaceDir, []);
    expect(filesAfter).toContain(newFile);

    // Index and search
    const indexer = createIndexer(store, embedder);
    await indexer.syncFiles(filesAfter);

    const results = store.searchKeyword("astronomy", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe(newFile);
  });

  it("cleans up chunks when file is removed from sync list", async () => {
    const filePath = path.join(memoryDir, "temporary.md");
    fs.writeFileSync(filePath, "Temporary content about space\n");
    fs.writeFileSync(path.join(workspaceDir, "MEMORY.md"), "# Memory\n");

    const indexer = createIndexer(store, embedder);
    const files = collectMemoryFiles(workspaceDir, []);
    await indexer.syncFiles(files);

    // Verify it's indexed
    const before = store.searchKeyword("space", 10);
    expect(before.length).toBeGreaterThan(0);

    // Remove the file from disk
    fs.unlinkSync(filePath);

    // Re-collect and sync — file should be removed from index
    const filesAfter = collectMemoryFiles(workspaceDir, []);
    await indexer.syncFiles(filesAfter);

    const after = store.searchKeyword("space", 10);
    expect(after.length).toBe(0);
  });

  it("indexes and searches Czech text with diacritics via FTS5", async () => {
    const filePath = path.join(memoryDir, "cesky.md");
    fs.writeFileSync(
      filePath,
      [
        "# Poznámky",
        "",
        "Řepa je zdravá zelenina bohatá na železo.",
        "Špenát obsahuje mnoho vitamínů a minerálů.",
        "Česnek je přírodní antibiotikum.",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(workspaceDir, "MEMORY.md"), "# Memory\n");

    const indexer = createIndexer(store, embedder);
    const files = collectMemoryFiles(workspaceDir, []);
    await indexer.syncFiles(files);

    // Search with diacritics
    const withDiacritics = store.searchKeyword("železo", 10);
    expect(withDiacritics.length).toBeGreaterThan(0);

    // Search without diacritics (FTS5 unicode61 tokenizer should handle this)
    const withoutDiacritics = store.searchKeyword("zelezo", 10);
    // Note: default FTS5 unicode61 tokenizer normalizes diacritics
    // If this fails, it means diacritics normalization is not working
    expect(withoutDiacritics.length).toBeGreaterThan(
      0,
      "FTS5 should match 'zelezo' against 'železo' via unicode61 diacritics folding",
    );
  });

  it("keyword-only match scores below default minScore 0.35 — content is indexed but filtered", async () => {
    // Documents a known characteristic: with mock embeddings (no real semantic
    // similarity), keyword-only matches score at most 0.3 (keywordWeight * 1.0),
    // which is below the default minScore of 0.35. In production, the real
    // embedding model's vector component adds to the score. If it doesn't
    // (e.g. poor language support), results get filtered out.
    const filePath = path.join(memoryDir, "topic.md");
    fs.writeFileSync(
      filePath,
      "Calcium is an essential mineral for bone health. " +
        "Good sources include milk, cheese, yogurt, broccoli, and kale.\n",
    );
    fs.writeFileSync(path.join(workspaceDir, "MEMORY.md"), "# Memory\n");

    const indexer = createIndexer(store, embedder);
    const files = collectMemoryFiles(workspaceDir, []);
    await indexer.syncFiles(files);

    // With minScore 0 the content IS found (proves indexing works)
    const allResults = await hybridSearch(
      "calcium",
      store,
      embedder,
      defaultSearchConfig({ minScore: 0.0 }),
    );
    expect(allResults.length).toBeGreaterThan(0);
    expect(allResults.find((r) => r.path === filePath)).toBeDefined();

    // With default minScore 0.35, keyword-only score (max 0.3) is filtered out.
    // The mock embedder produces pseudo-random vectors, so vector similarity
    // is unpredictable — assert only that any returned results meet the threshold.
    const filtered = await hybridSearch(
      "calcium",
      store,
      embedder,
      defaultSearchConfig({ minScore: 0.35 }),
    );
    for (const r of filtered) {
      expect(r.score).toBeGreaterThanOrEqual(0.35);
    }
  });
});
