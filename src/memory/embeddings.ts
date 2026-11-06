import { createProcessEmbeddingProvider, isEmbeddingWorkerBroken } from "./embedding-process.js";

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
  /** node-llama-cpp model URI (`hf:...`) or file path. Empty/undefined = built-in default. */
  modelUri?: string;
}): Promise<EmbeddingProvider> {
  // Imported on demand: the heavy native library is only loaded in the process that runs the model.
  const { getLlama, resolveModelFile } = await import("node-llama-cpp");
  const modelPath =
    options?.modelPath ??
    (await resolveModelFile(options?.modelUri?.trim() || DEFAULT_MODEL_URI));

  const llama = await getLlama();
  const model = await llama.loadModel({
    modelPath,
    useMmap: true,
    gpuLayers: 0,
  });
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

// ─── Lazy provider (load on first use, unload when idle) ─────────────

export interface LazyEmbeddingProvider extends EmbeddingProvider {
  /** True while the underlying model is loaded in memory. */
  isLoaded(): boolean;
}

/**
 * Wrap an expensive embedding provider so the model is loaded only when embedding work is
 * requested and released again after `idleUnloadMs` without work.
 *
 * `dimensions` must be known up front (the vector table is created before any embedding runs).
 * When the model loads, its real dimension is checked against it.
 */
export function createLazyEmbeddingProvider(options: {
  dimensions: number;
  create: () => Promise<EmbeddingProvider>;
  /** Unload after this idle time in ms. 0/undefined = never unload once loaded. */
  idleUnloadMs?: number;
  onLoad?: () => void;
  onUnload?: () => void;
}): LazyEmbeddingProvider {
  const idleUnloadMs = options.idleUnloadMs ?? 0;
  let inner: EmbeddingProvider | null = null;
  let loading: Promise<EmbeddingProvider> | null = null;
  let inflight = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const unload = async (): Promise<void> => {
    if (!inner || inflight > 0) return;
    const provider = inner;
    inner = null;
    await provider.close();
    options.onUnload?.();
  };

  const scheduleIdleUnload = () => {
    clearIdleTimer();
    if (idleUnloadMs <= 0 || !inner || inflight > 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      unload().catch(() => undefined);
    }, idleUnloadMs);
    idleTimer.unref();
  };

  const acquire = async (): Promise<EmbeddingProvider> => {
    if (closed) throw new Error("Embedding provider is closed");
    if (inner) return inner;
    if (!loading) {
      loading = options
        .create()
        .then(async (provider) => {
          if (provider.dimensions !== options.dimensions) {
            await provider.close();
            throw new Error(
              `Embedding model has ${provider.dimensions} dimensions but memory.embedding.dimensions is ` +
                `${options.dimensions}. Fix the setting (and rebuild vectors.db when changing the model).`,
            );
          }
          if (closed) {
            await provider.close();
            throw new Error("Embedding provider is closed");
          }
          inner = provider;
          options.onLoad?.();
          return provider;
        })
        .finally(() => {
          loading = null;
        });
    }
    return loading;
  };

  const run = async <T>(work: (provider: EmbeddingProvider) => Promise<T>): Promise<T> => {
    inflight++;
    clearIdleTimer();
    let provider: EmbeddingProvider | null = null;
    try {
      provider = await acquire();
      return await work(provider);
    } catch (err) {
      // A dead or stuck worker cannot recover: drop it so the next call starts a fresh one.
      if (provider && inner === provider && isEmbeddingWorkerBroken(err)) {
        inner = null;
        await provider.close().catch(() => undefined);
        options.onUnload?.();
      }
      throw err;
    } finally {
      inflight--;
      scheduleIdleUnload();
    }
  };

  return {
    dimensions: options.dimensions,
    isLoaded: () => inner !== null,
    embed: (text) => run((p) => p.embed(text)),
    embedBatch: (texts) => run((p) => p.embedBatch(texts)),
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearIdleTimer();
      if (loading) await loading.catch(() => undefined);
      if (inner) {
        const provider = inner;
        inner = null;
        await provider.close();
        options.onUnload?.();
      }
    },
  };
}

/**
 * Build the embedding provider described by `memory.embedding` settings: lazy (load on first use,
 * unload when idle) or eager (load now). `create` is injectable for tests.
 */
export async function createConfiguredEmbeddingProvider(
  settings: {
    lazyLoad: boolean;
    isolate?: boolean;
    idleUnloadMinutes: number;
    dimensions: number;
    model: string;
  },
  options?: {
    /** Overrides the model loader (tests). Takes precedence over `isolate`. */
    create?: typeof createEmbeddingProvider;
    onLoad?: () => void;
    onUnload?: () => void;
  },
): Promise<EmbeddingProvider> {
  // Lazy + isolate: the model runs in a worker process that exits when idle, which returns all of
  // its memory to the OS. In-process dispose leaves most of it allocated.
  const create =
    options?.create ?? (settings.lazyLoad && settings.isolate ? createProcessEmbeddingProvider : createEmbeddingProvider);
  const createFromSettings = () => create({ modelUri: settings.model });
  if (!settings.lazyLoad) return createFromSettings();
  return createLazyEmbeddingProvider({
    dimensions: settings.dimensions,
    create: createFromSettings,
    idleUnloadMs: Math.round(settings.idleUnloadMinutes * 60_000),
    onLoad: options?.onLoad,
    onUnload: options?.onUnload,
  });
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
