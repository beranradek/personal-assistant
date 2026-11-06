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

### Measured: EmbeddingGemma Q8_0 vs QAT Q4_0 (laptop, 319 chunks of the real memory files, 15 Czech queries)

`hf:ggml-org/embeddinggemma-300m-qat-q4_0-GGUF/embeddinggemma-300M-qat-Q4_0.gguf` (278 MB). The check counts a query as a hit when the top
chunk (top 3) contains an expected phrase, so it is a rough signal, not a benchmark.

| | Q8_0 (current) | QAT Q4_0 |
|---|---|---|
| top-1 hits | 9 / 15 | 11 / 15 |
| top-3 hits | 12 / 15 | 13 / 15 |
| RSS after load | 728 MiB | 822 MiB |
| whole corpus (319 chunks) | 297 s | 413 s |
| one query | 1.57 s | 1.36 s |

The two models agree on the top-1 chunk for only 6 of 15 queries (average top-3 overlap 2.3 of 3). Q4_0 did not lower RAM here and was slower
to embed the corpus. Using it means a full re-embed (`vectors.db` rebuilt). Not enabled by default.

### Measured: GPU backend

node-llama-cpp picks Vulkan on this laptop even with `gpuLayers: 0`. Forcing the CPU (`getLlama({ gpu: false })`) was slower: 5.0 s per
2300-character chunk against 2.0 s with Vulkan, for about 85 MiB less RSS. The default is kept.

## Second review (all fixed)

- Indexer embeds in slices of 8 chunks (bounded worker timeout, search queries can interleave, shutdown aborts between slices); a chunk the
  model rejects on its own is skipped, a systemic failure is rethrown.
- Search waits at most 30 s for the embedding part, then uses the text fallback.
- integ-api child exits when its IPC channel closes (daemon crash), a busy public port no longer stops the daemon.
- `pa mcp-server` exits on stdin end and releases its model worker after 2 idle minutes at most.
- A worker that died while idle is replaced before the next call (`EmbeddingProvider.isAlive`), a worker that failed to spawn cannot hang `terminate()`.
- Terminal mode uses the same shared sync (`createConfiguredMemorySync`) as the daemon and `pa mcp-server`.

## Not done / follow-ups

- Several processes can each hold a model worker at the same time (daemon, one `pa mcp-server` per stdio client, terminal mode). The daemon's
  shared HTTP MCP server covers the Codex case. A shared worker over a socket with a lock file would give exactly one model, but it is not
  worth the extra code while that holds.
- Context size of the embedding context is unchanged (default).
