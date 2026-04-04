import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { chunkText, createIndexer, preprocessContent, type Chunk, type Indexer } from "./indexer.js";
import { createVectorStore, type VectorStore } from "./vector-store.js";
import { createMockEmbeddingProvider, type EmbeddingProvider } from "./embeddings.js";

// ─── preprocessContent ───────────────────────────────────────────────

describe("preprocessContent", () => {
  it("returns raw content unchanged for .md files", () => {
    const raw = "# Hello\nsome content";
    expect(preprocessContent("/path/to/file.md", raw)).toBe(raw);
  });

  it("returns raw content unchanged for .ts files", () => {
    const raw = "const x = 1;";
    expect(preprocessContent("/path/to/file.ts", raw)).toBe(raw);
  });

  it("extracts user and assistant messages from .jsonl interaction entries", () => {
    const entry = JSON.stringify({
      timestamp: "2026-04-01T10:00:00Z",
      type: "interaction",
      source: "terminal",
      sessionKey: "abc",
      userMessage: "What is the weather?",
      assistantResponse: "It's sunny today.",
    });
    const result = preprocessContent("/path/daily/2026-04-01.jsonl", entry);

    expect(result).toContain("user: What is the weather?");
    expect(result).toContain("assistant: It's sunny today.");
    expect(result).toContain("2026-04-01T10:00:00Z");
  });

  it("skips tool_call entries from .jsonl files", () => {
    const entry = JSON.stringify({
      timestamp: "2026-04-01T10:00:00Z",
      type: "tool_call",
      source: "terminal",
      sessionKey: "abc",
      toolName: "bash",
      toolInput: { command: "ls" },
      toolResult: { output: "file.txt" },
    });
    const result = preprocessContent("/path/daily/2026-04-01.jsonl", entry);

    expect(result).toBe("");
  });

  it("skips error entries from .jsonl files", () => {
    const entry = JSON.stringify({
      timestamp: "2026-04-01T10:00:00Z",
      type: "error",
      source: "terminal",
      sessionKey: "abc",
      errorMessage: "Something failed",
    });
    const result = preprocessContent("/path/daily/2026-04-01.jsonl", entry);

    expect(result).toBe("");
  });

  it("skips malformed JSONL lines", () => {
    const raw = "not valid json\n" + JSON.stringify({ timestamp: "2026-04-01T10:00:00Z", type: "interaction", source: "t", sessionKey: "k", userMessage: "hi", assistantResponse: "hello" });
    const result = preprocessContent("/path/daily/2026-04-01.jsonl", raw);

    expect(result).toContain("user: hi");
    expect(result).toContain("assistant: hello");
    expect(result).not.toContain("not valid json");
  });

  it("handles empty .jsonl file", () => {
    expect(preprocessContent("/path/daily/2026-04-01.jsonl", "")).toBe("");
  });
});

// ─── chunkText ───────────────────────────────────────────────────────

describe("chunkText", () => {
  it("splits text into chunks with overlap", () => {
    // Create text long enough to require multiple chunks.
    // tokens=20 => ~80 chars per chunk, overlap=5 => ~20 chars overlap.
    // Use short lines (~8 chars each) so overlap can backtrack whole lines.
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) {
      lines.push(`line ${i}`); // ~7 chars each
    }
    const text = lines.join("\n");

    const chunks = chunkText(text, { tokens: 20, overlap: 5 });

    expect(chunks.length).toBeGreaterThan(1);

    // Verify overlap: the start of each subsequent chunk should overlap
    // with the end of the previous chunk (startLine <= prev endLine).
    let hasOverlap = false;
    for (let i = 1; i < chunks.length; i++) {
      if (chunks[i].startLine <= chunks[i - 1].endLine) {
        hasOverlap = true;
      }
    }
    expect(hasOverlap).toBe(true);
  });

  it("preserves line numbers (startLine, endLine) 1-indexed", () => {
    const text = "Line one\nLine two\nLine three\nLine four\nLine five";
    // Use a very large token limit so everything fits in one chunk
    const chunks = chunkText(text, { tokens: 1000, overlap: 0 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(5);
  });

  it("preserves correct line numbers across multiple chunks", () => {
    // Each line ~30 chars; tokens=10 => 40 chars per chunk
    const lines = [
      "AAAAAAAAAA AAAAAAAAAA AAAAAAAAAA", // ~31 chars
      "BBBBBBBBBB BBBBBBBBBB BBBBBBBBBB",
      "CCCCCCCCCC CCCCCCCCCC CCCCCCCCCC",
      "DDDDDDDDDD DDDDDDDDDD DDDDDDDDDD",
      "EEEEEEEEEE EEEEEEEEEE EEEEEEEEEE",
    ];
    const text = lines.join("\n");

    const chunks = chunkText(text, { tokens: 10, overlap: 0 });

    // First chunk should start at line 1
    expect(chunks[0].startLine).toBe(1);
    // All line numbers should be continuous and 1-indexed
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThanOrEqual(1);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }
  });

  it("returns a single chunk for short text", () => {
    const text = "Hello, world!";
    const chunks = chunkText(text, { tokens: 400, overlap: 80 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("Hello, world!");
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(1);
  });

  it("returns empty array for empty text", () => {
    const chunks = chunkText("", { tokens: 400, overlap: 80 });
    expect(chunks).toEqual([]);
  });

  it("handles text with default options (tokens: 400, overlap: 80)", () => {
    // Build text that would be around 2000 chars (500 tokens)
    const lines: string[] = [];
    for (let i = 1; i <= 60; i++) {
      lines.push(`This is line number ${i} with enough filler.`);
    }
    const text = lines.join("\n");

    const chunks = chunkText(text, { tokens: 400, overlap: 80 });

    expect(chunks.length).toBeGreaterThan(1);
    // All chunks should have valid text
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  it("chunk text content matches original lines", () => {
    const text = "alpha\nbeta\ngamma\ndelta";
    const chunks = chunkText(text, { tokens: 1000, overlap: 0 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(text);
  });

  it("does not loop infinitely when chunk fits inside the overlap window", () => {
    // Build short lines where several consecutive lines total less than
    // overlapChars (320). This previously caused the backtrack to reset
    // lineIdx to chunkStartIdx, producing an infinite loop.
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(`short line ${i}`); // ~14 chars each
    }
    const text = lines.join("\n");

    const chunks = chunkText(text, { tokens: 400, overlap: 80 });

    // Must terminate and produce a reasonable number of chunks
    expect(chunks.length).toBeLessThan(200);
    expect(chunks.length).toBeGreaterThan(0);
    // Last chunk must cover the final line
    expect(chunks[chunks.length - 1].endLine).toBe(200);
  });
});

// ─── createIndexer / syncFiles ───────────────────────────────────────

describe("Indexer", () => {
  const DIMS = 4;
  let store: VectorStore;
  let embedder: EmbeddingProvider;
  let indexer: Indexer;
  let tmpDir: string;

  beforeEach(() => {
    store = createVectorStore(":memory:", DIMS);
    embedder = createMockEmbeddingProvider(DIMS);
    indexer = createIndexer(store, embedder);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "indexer-"));
  });

  afterEach(() => {
    try {
      indexer?.close();
    } catch {
      // already closed
    }
    try {
      store?.close();
    } catch {
      // already closed
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Helper to create a temp file with known content
  function createTempFile(name: string, content: string): string {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  describe("syncFiles(filePaths)", () => {
    it("indexes files that need updating", async () => {
      const file = createTempFile("hello.ts", "export const x = 1;\nexport const y = 2;");

      await indexer.syncFiles([file]);

      // The file should now be tracked with a hash
      const hash = store.getFileHash(file);
      expect(hash).not.toBeNull();

      // Should be searchable via keyword
      const results = store.searchKeyword("export const", 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].path).toBe(file);
    });

    it("only re-indexes files whose hash changed since last sync", async () => {
      const file = createTempFile("stable.ts", "const a = 1;");

      // First sync
      await indexer.syncFiles([file]);
      const hashBefore = store.getFileHash(file);

      // Second sync without changes - should skip (hash same)
      await indexer.syncFiles([file]);
      const hashAfter = store.getFileHash(file);

      expect(hashBefore).toBe(hashAfter);
    });

    it("re-indexes files when content changes", async () => {
      const file = createTempFile("changing.ts", "version one content");

      await indexer.syncFiles([file]);

      const hashBefore = store.getFileHash(file);

      // Modify the file
      fs.writeFileSync(file, "version two different content", "utf-8");

      await indexer.syncFiles([file]);

      const hashAfter = store.getFileHash(file);
      expect(hashAfter).not.toBe(hashBefore);

      // Search should find the new content
      const results = store.searchKeyword("version two different", 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("removes chunks for deleted files", async () => {
      const fileA = createTempFile("a.ts", "file A searchable content");
      const fileB = createTempFile("b.ts", "file B searchable content");

      // Index both files
      await indexer.syncFiles([fileA, fileB]);

      // Both should be searchable
      expect(store.searchKeyword("file A searchable", 10).length).toBeGreaterThanOrEqual(1);
      expect(store.searchKeyword("file B searchable", 10).length).toBeGreaterThanOrEqual(1);

      // Now sync with only fileA - fileB should be removed
      await indexer.syncFiles([fileA]);

      // fileA should still be searchable
      const aResults = store.searchKeyword("file A searchable", 10);
      expect(aResults.length).toBeGreaterThanOrEqual(1);

      // fileB should be removed
      const bResults = store.searchKeyword("file B searchable", 10);
      expect(bResults).toEqual([]);

      // fileB hash should be removed
      expect(store.getFileHash(fileB)).toBeNull();
    });

    it("handles multiple files in a single sync call", async () => {
      const file1 = createTempFile("one.ts", "content one alpha");
      const file2 = createTempFile("two.ts", "content two beta");
      const file3 = createTempFile("three.ts", "content three gamma");

      await indexer.syncFiles([file1, file2, file3]);

      expect(store.getFileHash(file1)).not.toBeNull();
      expect(store.getFileHash(file2)).not.toBeNull();
      expect(store.getFileHash(file3)).not.toBeNull();
    });
  });

  describe("isDirty / markDirty / syncIfDirty", () => {
    it("isDirty is false initially", () => {
      expect(indexer.isDirty()).toBe(false);
    });

    it("markDirty sets isDirty flag", () => {
      indexer.markDirty();
      expect(indexer.isDirty()).toBe(true);
    });

    it("syncIfDirty syncs when dirty and clears the flag", async () => {
      const file = createTempFile("dirty.ts", "dirty file unique content");

      indexer.markDirty();
      expect(indexer.isDirty()).toBe(true);

      await indexer.syncIfDirty([file]);

      expect(indexer.isDirty()).toBe(false);
      expect(store.getFileHash(file)).not.toBeNull();
    });

    it("syncIfDirty does nothing when not dirty", async () => {
      const file = createTempFile("clean.ts", "clean file content");

      // Not dirty, so syncIfDirty should be a no-op
      await indexer.syncIfDirty([file]);

      expect(store.getFileHash(file)).toBeNull();
    });
  });

  describe("close()", () => {
    it("closes without error", () => {
      expect(() => indexer.close()).not.toThrow();
    });
  });
});
