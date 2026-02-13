import { describe, it, expect } from "vitest";
import {
  createMockEmbeddingProvider,
  type EmbeddingProvider,
} from "./embeddings.js";

/**
 * Helper: compute L2 magnitude of a vector.
 */
function magnitude(vec: number[]): number {
  return Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
}

describe("EmbeddingProvider (mock)", () => {
  let provider: EmbeddingProvider;

  it("createMockEmbeddingProvider() returns an object with embed, embedBatch, dimensions, close", () => {
    provider = createMockEmbeddingProvider();
    expect(typeof provider.embed).toBe("function");
    expect(typeof provider.embedBatch).toBe("function");
    expect(typeof provider.dimensions).toBe("number");
    expect(typeof provider.close).toBe("function");
  });

  it("provider reports correct default dimensions (768)", () => {
    provider = createMockEmbeddingProvider();
    expect(provider.dimensions).toBe(768);
  });

  it("provider reports custom dimensions when specified", () => {
    provider = createMockEmbeddingProvider(384);
    expect(provider.dimensions).toBe(384);
  });

  describe("embed(text)", () => {
    it("returns a number array of expected dimensions", async () => {
      provider = createMockEmbeddingProvider();
      const embedding = await provider.embed("hello world");

      expect(Array.isArray(embedding)).toBe(true);
      expect(embedding).toHaveLength(768);
      for (const val of embedding) {
        expect(typeof val).toBe("number");
        expect(Number.isFinite(val)).toBe(true);
      }
    });

    it("returns a number array of custom dimensions", async () => {
      provider = createMockEmbeddingProvider(256);
      const embedding = await provider.embed("test");

      expect(embedding).toHaveLength(256);
    });

    it("returns deterministic vectors for the same input", async () => {
      provider = createMockEmbeddingProvider();
      const a = await provider.embed("deterministic test");
      const b = await provider.embed("deterministic test");

      expect(a).toEqual(b);
    });

    it("returns different vectors for different inputs", async () => {
      provider = createMockEmbeddingProvider();
      const a = await provider.embed("hello");
      const b = await provider.embed("goodbye");

      expect(a).not.toEqual(b);
    });

    it("returns L2-normalized vectors (magnitude ~1.0)", async () => {
      provider = createMockEmbeddingProvider();
      const embedding = await provider.embed("normalize me");

      const mag = magnitude(embedding);
      expect(mag).toBeCloseTo(1.0, 5);
    });
  });

  describe("embedBatch(texts)", () => {
    it("returns array of number arrays", async () => {
      provider = createMockEmbeddingProvider();
      const texts = ["first", "second", "third"];
      const embeddings = await provider.embedBatch(texts);

      expect(Array.isArray(embeddings)).toBe(true);
      expect(embeddings).toHaveLength(3);
      for (const emb of embeddings) {
        expect(Array.isArray(emb)).toBe(true);
        expect(emb).toHaveLength(768);
      }
    });

    it("returns empty array for empty input", async () => {
      provider = createMockEmbeddingProvider();
      const embeddings = await provider.embedBatch([]);

      expect(embeddings).toEqual([]);
    });

    it("batch results match individual embed calls", async () => {
      provider = createMockEmbeddingProvider();
      const texts = ["alpha", "beta"];

      const batchResults = await provider.embedBatch(texts);
      const individualResults = await Promise.all(
        texts.map((t) => provider.embed(t)),
      );

      expect(batchResults).toEqual(individualResults);
    });

    it("all batch embeddings are L2-normalized", async () => {
      provider = createMockEmbeddingProvider();
      const texts = ["one", "two", "three", "four"];
      const embeddings = await provider.embedBatch(texts);

      for (const emb of embeddings) {
        const mag = magnitude(emb);
        expect(mag).toBeCloseTo(1.0, 5);
      }
    });
  });

  describe("close()", () => {
    it("cleans up resources without error", async () => {
      provider = createMockEmbeddingProvider();
      await expect(provider.close()).resolves.toBeUndefined();
    });

    it("can be called multiple times without error", async () => {
      provider = createMockEmbeddingProvider();
      await provider.close();
      await expect(provider.close()).resolves.toBeUndefined();
    });
  });
});
