/**
 * Embedding worker process.
 *
 * Forked by `createProcessEmbeddingProvider` so the GGUF model lives in its own process. The
 * native allocator does not return the model's memory to the OS after `dispose()`, so the only
 * reliable way to free it is to let this process exit when it is idle.
 *
 * Protocol (Node IPC): the parent sends `{ id, op, text?, texts? }` and gets
 * `{ id, ok: true, dimensions? | vector? | vectors? }` or `{ id, ok: false, error }` back.
 * The worker exits when the IPC channel closes (parent died or called kill).
 */

import { createEmbeddingProvider, type EmbeddingProvider } from "./embeddings.js";

type WorkerRequest = {
  id: number;
  op: "init" | "embed" | "embedBatch";
  text?: string;
  texts?: string[];
};

type WorkerResponse =
  | { id: number; ok: true; dimensions?: number; vector?: number[]; vectors?: number[][] }
  | { id: number; ok: false; error: string };

function send(response: WorkerResponse): void {
  process.send?.(response);
}

let providerPromise: Promise<EmbeddingProvider> | null = null;

async function getProvider(): Promise<EmbeddingProvider> {
  providerPromise ??= createEmbeddingProvider({ modelUri: process.env["PA_EMBEDDING_MODEL"] ?? "" });
  try {
    return await providerPromise;
  } catch (err) {
    providerPromise = null; // allow a retry after a failed load
    throw err;
  }
}

process.on("message", (message: WorkerRequest) => {
  void (async () => {
    try {
      const provider = await getProvider();
      if (message.op === "init") {
        send({ id: message.id, ok: true, dimensions: provider.dimensions });
      } else if (message.op === "embed") {
        send({ id: message.id, ok: true, vector: await provider.embed(message.text ?? "") });
      } else if (message.op === "embedBatch") {
        send({ id: message.id, ok: true, vectors: await provider.embedBatch(message.texts ?? []) });
      } else {
        send({ id: message.id, ok: false, error: `unknown op: ${String((message as WorkerRequest).op)}` });
      }
    } catch (err) {
      send({ id: message.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
});

process.on("disconnect", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
