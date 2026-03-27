import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRobustMemorySearch } from "./robust-search.js";
import type { VectorStore } from "./vector-store.js";
import type { EmbeddingProvider } from "./embeddings.js";

function createEmptyStore(): VectorStore {
  return {
    upsertChunk() {},
    searchVector() {
      return [];
    },
    searchKeyword() {
      return [];
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

function createMockEmbedder(): EmbeddingProvider {
  return {
    dimensions: 4,
    async embed() {
      return [0, 0, 0, 0];
    },
    async embedBatch(texts: string[]) {
      return texts.map(() => [0, 0, 0, 0]);
    },
    async close() {},
  };
}

describe("createRobustMemorySearch", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let store: VectorStore;
  let embedder: EmbeddingProvider;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "robust-search-"));
    workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(path.join(workspaceDir, "memory"), { recursive: true });

    store = createEmptyStore();
    embedder = createMockEmbedder();
  });

  afterEach(async () => {
    store.close();
    await embedder.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("falls back to grep-like file scanning when hybrid returns no results", async () => {
    const notePath = path.join(workspaceDir, "memory", "note.md");
    fs.writeFileSync(notePath, "Zdroje dobře využitelného vápníku\n");
    fs.writeFileSync(path.join(workspaceDir, "MEMORY.md"), "# Memory\n");

    const search = createRobustMemorySearch({
      workspaceDir,
      extraPaths: [],
      store,
      embedder,
      config: { vectorWeight: 0.7, keywordWeight: 0.3, minScore: 0.35, maxResults: 6 },
    });

    const results = await search("vapnik");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe(notePath);
    expect(results[0].startLine).toBe(1);
  });
});

