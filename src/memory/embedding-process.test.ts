import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createProcessEmbeddingProvider, isEmbeddingWorkerBroken } from "./embedding-process.js";
import { createLazyEmbeddingProvider } from "./embeddings.js";

type Request = { id: number; op: "init" | "embed" | "embedBatch"; text?: string; texts?: string[] };

/** A scriptable stand-in for the worker child process. */
class FakeWorker extends EventEmitter {
  killed: NodeJS.Signals[] = [];
  requests: Request[] = [];
  /** Return a response for a request, or undefined to stay silent. */
  respond: (request: Request) => Record<string, unknown> | undefined = (request) => {
    if (request.op === "init") return { ok: true, dimensions: 3 };
    if (request.op === "embed") return { ok: true, vector: [1, 0, 0] };
    return { ok: true, vectors: (request.texts ?? []).map(() => [0, 1, 0]) };
  };

  send(message: Request, callback?: (err: Error | null) => void): boolean {
    this.requests.push(message);
    callback?.(null);
    const reply = this.respond(message);
    if (reply) queueMicrotask(() => this.emit("message", { id: message.id, ...reply }));
    return true;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed.push(signal);
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }

  asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

describe("createProcessEmbeddingProvider", () => {
  it("reports the dimensions from the worker and round-trips embed and embedBatch", async () => {
    const worker = new FakeWorker();
    const provider = await createProcessEmbeddingProvider({ forkWorker: () => worker.asChild() });
    expect(provider.dimensions).toBe(3);
    expect(await provider.embed("hello")).toEqual([1, 0, 0]);
    expect(await provider.embedBatch(["a", "b"])).toEqual([[0, 1, 0], [0, 1, 0]]);
    expect(await provider.embedBatch([])).toEqual([]);
    expect(worker.requests.map((r) => r.op)).toEqual(["init", "embed", "embedBatch"]);
    await provider.close();
  });

  it("rejects with the worker's error message without marking the worker broken", async () => {
    const worker = new FakeWorker();
    const provider = await createProcessEmbeddingProvider({ forkWorker: () => worker.asChild() });
    worker.respond = () => ({ ok: false, error: "context too long" });
    const error = await provider.embed("x").catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("context too long");
    expect(isEmbeddingWorkerBroken(error)).toBe(false);
    await provider.close();
  });

  it("marks the worker broken when it exits while a request is pending", async () => {
    const worker = new FakeWorker();
    const provider = await createProcessEmbeddingProvider({ forkWorker: () => worker.asChild() });
    worker.respond = () => undefined;
    const pending = provider.embed("x");
    worker.emit("exit", 1, null);
    const error = await pending.catch((err) => err);
    expect(isEmbeddingWorkerBroken(error)).toBe(true);
    await expect(provider.embed("y")).rejects.toThrow(/exited/);
  });

  it("close() sends SIGTERM to the worker and later calls fail", async () => {
    const worker = new FakeWorker();
    const provider = await createProcessEmbeddingProvider({ forkWorker: () => worker.asChild() });
    await provider.close();
    expect(worker.killed).toEqual(["SIGTERM"]);
    await provider.close();
    expect(worker.killed).toEqual(["SIGTERM"]);
    await expect(provider.embed("x")).rejects.toThrow();
  });

  it("kills the worker and rethrows when initialisation fails", async () => {
    const worker = new FakeWorker();
    worker.respond = () => ({ ok: false, error: "model file not found" });
    await expect(createProcessEmbeddingProvider({ forkWorker: () => worker.asChild() })).rejects.toThrow(
      "model file not found",
    );
    expect(worker.killed).toEqual(["SIGTERM"]);
  });

  it("times out an unanswered request, kills the worker and reports it broken", async () => {
    const worker = new FakeWorker();
    const provider = await createProcessEmbeddingProvider({
      forkWorker: () => worker.asChild(),
      requestTimeoutMs: 50,
    });
    worker.respond = () => undefined;
    const error = await provider.embed("x").catch((err) => err);
    expect(isEmbeddingWorkerBroken(error)).toBe(true);
    expect(worker.killed).toContain("SIGTERM");
  });
});

describe("lazy provider with an isolated worker", () => {
  it("starts a fresh worker after the previous one died", async () => {
    const workers: FakeWorker[] = [];
    const lazy = createLazyEmbeddingProvider({
      dimensions: 3,
      create: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return createProcessEmbeddingProvider({ forkWorker: () => worker.asChild() });
      },
    });

    await lazy.embed("a");
    expect(workers).toHaveLength(1);

    workers[0]!.respond = () => undefined;
    const pending = lazy.embed("b");
    workers[0]!.emit("exit", 137, null);
    await expect(pending).rejects.toThrow(/exited/);
    expect(lazy.isLoaded()).toBe(false);

    await expect(lazy.embed("c")).resolves.toEqual([1, 0, 0]);
    expect(workers).toHaveLength(2);
    await lazy.close();
  });

  it("kills the worker when idle, which frees the model memory", async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const lazy = createLazyEmbeddingProvider({
        dimensions: 3,
        idleUnloadMs: 1000,
        create: () => createProcessEmbeddingProvider({ forkWorker: () => worker.asChild() }),
      });
      await lazy.embed("a");
      expect(worker.killed).toEqual([]);
      await vi.advanceTimersByTimeAsync(1100);
      expect(worker.killed).toEqual(["SIGTERM"]);
      expect(lazy.isLoaded()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
