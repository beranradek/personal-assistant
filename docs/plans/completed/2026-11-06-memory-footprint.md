# Lower idle memory of the daemon (2026-11-06)

## Problem

`pa-daemon` held about 740 MiB (main process) + 150 MiB (`integapi serve` child) while idle. The main part is the local
EmbeddingGemma-300M GGUF model (node-llama-cpp), loaded at startup and kept for the whole run. It also reindexed on every file
change (watcher) and every 10 minutes.

## Measured (laptop, node 24, real model)

| Step | RSS |
|------|-----|
| process start | 128 MiB |
| after first embed (model loaded) | 716 MiB |
| after a 20-chunk batch | 1248 MiB |
| after in-process `dispose()` | 941 MiB (about 800 MiB stays allocated) |
| isolated worker process, loaded | 709-771 MiB (parent stays at 86 MiB) |
| isolated worker after idle | worker gone, parent 87 MiB |

In-process unload alone is not enough, so the model runs in a worker process that exits when idle.

## Implemented

- `memory.embedding`: `lazyLoad`, `isolate`, `idleUnloadMinutes`, `dimensions`, `model` (src/core/types.ts).
- `createLazyEmbeddingProvider` (load on first call, unload after idle, never during a call, retry after a failed load,
  dimension check) and `createProcessEmbeddingProvider` + `embedding-worker.ts` (IPC worker; a dead or stuck worker is replaced).
- Indexer skips files by size and mtime before reading or hashing them (`VectorStore.getFileMeta`).
- `createMemorySync`: one shared sync run; `memory_search` first indexes changed knowledge files (size/mtime check on every search,
  no pruning, daily logs excluded, waits at most 15 s). A failed run does not count as a recent sync.
- `memory_search` falls back to the plain-text search when the embedding model cannot load.
- The indexer embeds a changed file before it replaces its old chunks, so a dead worker leaves the previous index intact.
- Daemon: startup sync (cheap when nothing changed), background interval `memory.sync.intervalMinutes` (default 30, 0 = off), watcher
  is opt-in (`memory.sync.watch`).
- `pa mcp-server` (stdio, per Codex turn) uses the same lazy provider and sync-before-search.
- `integApi.lazyStart`: `createLazyIntegApiSupervisor` (TCP forwarder, child started on first connection, stopped when idle).
  `integapi serve` honours `PA_INTEG_API_PORT`.
- Dependencies updated: node-llama-cpp 3.22.3, @openai/codex-sdk 0.167, vitest/coverage 5.1, marked 18, marked-terminal 8.

## Embedding model alternatives (research, not applied)

Sources: Hugging Face model cards (checked 2026-11-06). Czech quality was not verified for any model.

- EmbeddingGemma QAT Q4_0 (`hf:ggml-org/embeddinggemma-300m-qat-q4_0-GGUF/embeddinggemma-300M-qat-Q4_0.gguf`): 278 MB file against 334 MB,
  768 dims, MMTEB v2 60.62 against 60.93 (Q8_0 QAT). Same dimension, so vectors.db keeps its schema, but all files must be re-embedded.
- Matryoshka truncation of EmbeddingGemma: 512 dims -0.4 points, 256 dims -1.5 points (MTEB multilingual v2). Needs a new `float[N]` table.
- jina-embeddings-v5-text-nano-retrieval Q4_K_M (157 MB, 768 dims, MMTEB 65.5): smallest, but CC-BY-NC-4.0 licence, Czech not listed and
  node-llama-cpp support for its architecture is unverified.
- Larger candidates (Qwen3-Embedding-0.6B, jina v5 small, bge-m3, nomic-embed-text-v2-moe) do not reduce RAM.
- Most RSS is runtime overhead (compute buffers, 2048-token context), not the weights, so a smaller context may help more than a
  smaller quantisation (not measured).
- Before switching, compare recall@5 on a small Czech query set (current model, Q4_0, jina nano).

## Not done / follow-ups

- Terminal mode (`createTerminalSessionFromConfig`) still syncs at startup and on every watcher event.
- Context size of the embedding context is unchanged (default).
