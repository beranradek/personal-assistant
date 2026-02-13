import { getLlama, resolveModelFile } from "node-llama-cpp";

// ─── Public interface ────────────────────────────────────────────────

/**
 * A provider that turns text into fixed-length embedding vectors.
 * All returned vectors are L2-normalised (magnitude === 1).
 */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  dimensions: number;
  close(): Promise<void>;
}

// ─── L2 normalisation helper ─────────────────────────────────────────

function l2Normalize(vec: number[]): number[] {
  const mag = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (mag === 0) return vec;
  return vec.map((v) => v / mag);
}

// ─── Real provider (node-llama-cpp + EmbeddingGemma-300M) ────────────

const DEFAULT_MODEL_URI =
  "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

/**
 * Create an embedding provider backed by a local GGUF model via
 * node-llama-cpp.
 *
 * On first call the model file is resolved (and downloaded if needed)
 * from HuggingFace. Subsequent calls reuse the cached file.
 */
export async function createEmbeddingProvider(options?: {
  modelPath?: string;
}): Promise<EmbeddingProvider> {
  const modelPath =
    options?.modelPath ?? (await resolveModelFile(DEFAULT_MODEL_URI));

  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath });
  const context = await model.createEmbeddingContext();
  const dimensions = model.embeddingVectorSize;

  let disposed = false;

  return {
    dimensions,

    async embed(text: string): Promise<number[]> {
      const result = await context.getEmbeddingFor(text);
      return l2Normalize(Array.from(result.vector));
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      const results: number[][] = [];
      for (const text of texts) {
        const result = await context.getEmbeddingFor(text);
        results.push(l2Normalize(Array.from(result.vector)));
      }
      return results;
    },

    async close(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await context.dispose();
      await model.dispose();
    },
  };
}

// ─── Mock provider (deterministic, for unit tests) ───────────────────

/**
 * Simple string hash that returns a 32-bit integer.
 * Used by the mock provider to generate deterministic pseudo-random vectors.
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return hash;
}

/**
 * Simple seeded pseudo-random number generator (mulberry32).
 * Returns values in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Create a mock embedding provider that returns deterministic, L2-normalised
 * vectors based on a hash of the input text.
 *
 * Useful for unit testing code that depends on embeddings without needing a
 * real GGUF model.
 *
 * @param dimensions - number of dimensions per vector (default: 768)
 */
export function createMockEmbeddingProvider(
  dimensions: number = 768,
): EmbeddingProvider {
  function generateVector(text: string): number[] {
    const seed = hashString(text);
    const rng = mulberry32(seed);
    const raw = Array.from({ length: dimensions }, () => rng() * 2 - 1);
    return l2Normalize(raw);
  }

  return {
    dimensions,

    async embed(text: string): Promise<number[]> {
      return generateVector(text);
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      return texts.map((text) => generateVector(text));
    },

    async close(): Promise<void> {
      // No resources to clean up in the mock
    },
  };
}
