import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { EmbeddingProvider } from "./embeddings.js";

/** Error code set on failures that make the worker unusable (it died, timed out, or was killed). */
export const EMBEDDING_WORKER_BROKEN = "EMBEDDING_WORKER_BROKEN";

type WorkerResponse =
  | { id: number; ok: true; dimensions?: number; vector?: number[]; vectors?: number[][] }
  | { id: number; ok: false; error: string };

function brokenError(message: string): Error {
  return Object.assign(new Error(message), { code: EMBEDDING_WORKER_BROKEN });
}

export function isEmbeddingWorkerBroken(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === EMBEDDING_WORKER_BROKEN;
}

function defaultForkWorker(modelUri: string): ChildProcess {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const compiled = path.join(dir, "embedding-worker.js");
  const useCompiled = fs.existsSync(compiled);
  return fork(useCompiled ? compiled : path.join(dir, "embedding-worker.ts"), [], {
    // Running from source (tsx) needs the loader in the worker too.
    execArgv: useCompiled ? [] : ["--import", "tsx"],
    env: { ...process.env, PA_EMBEDDING_MODEL: modelUri },
    // stdout goes to stderr: in `pa mcp-server` our own stdout is the JSON-RPC stream and model
    // download/progress output must never reach it.
    stdio: ["ignore", 2, 2, "ipc"],
  });
}

/**
 * Embedding provider that runs the model in a separate worker process. `close()` kills the
 * worker, which returns ALL of the model's memory to the OS (an in-process dispose does not).
 */
export async function createProcessEmbeddingProvider(options?: {
  modelUri?: string;
  /** Start the worker process. Injectable for tests. */
  forkWorker?: () => ChildProcess;
  /** Longest wait for the model to load (it may be downloaded the first time). Default: 10 min. */
  initTimeoutMs?: number;
  /** Longest wait for one embedding request. Default: 5 min. */
  requestTimeoutMs?: number;
  /** Time the worker gets to exit after SIGTERM before SIGKILL. Default: 3 s. */
  killTimeoutMs?: number;
}): Promise<EmbeddingProvider> {
  const initTimeoutMs = options?.initTimeoutMs ?? 10 * 60_000;
  const requestTimeoutMs = options?.requestTimeoutMs ?? 5 * 60_000;
  const killTimeoutMs = options?.killTimeoutMs ?? 3_000;
  const child = (options?.forkWorker ?? (() => defaultForkWorker(options?.modelUri ?? "")))();

  type Pending = {
    resolve: (value: WorkerResponse & { ok: true }) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let broken: Error | null = null;
  let closed = false;
  let exited = false;

  const terminate = (): Promise<void> =>
    new Promise<void>((resolve) => {
      // A worker that failed to spawn has no pid and may never emit "exit".
      if (exited || child.pid === undefined) return resolve();
      const killTimer = setTimeout(() => child.kill("SIGKILL"), killTimeoutMs);
      killTimer.unref();
      const done = () => {
        clearTimeout(killTimer);
        resolve();
      };
      child.once("exit", done);
      child.once("error", done);
      child.kill("SIGTERM");
    });

  const fail = (err: Error) => {
    if (!broken) broken = err;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  };

  child.on("message", (raw) => {
    const message = raw as WorkerResponse;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message);
    else entry.reject(new Error(message.error));
  });
  child.once("exit", (code, signal) => {
    exited = true;
    fail(brokenError(`embedding worker exited (code ${code}, signal ${signal})`));
  });
  // `on`, not `once`: a second error event must not become an unhandled exception.
  child.on("error", (err) => fail(brokenError(`embedding worker error: ${err.message}`)));

  const request = (
    payload: { op: "init" } | { op: "embed"; text: string } | { op: "embedBatch"; texts: string[] },
    timeoutMs: number,
  ): Promise<WorkerResponse & { ok: true }> =>
    new Promise((resolve, reject) => {
      if (closed) return reject(brokenError("embedding worker is closed"));
      if (broken) return reject(broken);
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        const err = brokenError(`embedding worker did not answer within ${timeoutMs} ms`);
        reject(err);
        fail(err);
        void terminate();
      }, timeoutMs);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      child.send({ id, ...payload }, (err) => {
        if (err) fail(brokenError(`embedding worker is unreachable: ${err.message}`));
      });
    });

  let dimensions: number;
  try {
    const init = await request({ op: "init" }, initTimeoutMs);
    if (!init.dimensions) throw new Error("embedding worker did not report dimensions");
    dimensions = init.dimensions;
  } catch (err) {
    await terminate();
    throw err;
  }

  return {
    dimensions,
    isAlive: () => !closed && !exited && broken === null,
    async embed(text: string): Promise<number[]> {
      const response = await request({ op: "embed", text }, requestTimeoutMs);
      if (!response.vector) throw new Error("embedding worker returned no vector");
      return response.vector;
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const response = await request({ op: "embedBatch", texts }, requestTimeoutMs);
      if (!response.vectors) throw new Error("embedding worker returned no vectors");
      return response.vectors;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      fail(brokenError("embedding worker is closed"));
      await terminate();
    },
  };
}
