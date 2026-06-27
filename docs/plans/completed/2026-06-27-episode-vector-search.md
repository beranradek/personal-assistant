# Episodic Memory — Vector Search

**Status:** backlog  
**Depends on:** episodic memory (completed 2026-06-27)

## Problem

`semanticEmbeddingText` is already computed and stored in every episode record, but no embedder ever reads it. Episode retrieval today is purely keyword/filter-based (`episode_search` does substring match + exact filters). This means "find an episode similar to what I'm about to do" can miss relevant episodes when the words don't match exactly.

## Goal

Enable the agent to find episodes by semantic similarity — same way `memory_search` finds workspace files — so recurring tasks surface prior attempts even when phrased differently.

## How `semanticEmbeddingText` Should Be Used

Each episode already builds a compact embedding string:

```
action: Deploy staging | outcome: failure | summary: Heroku app required interactive prompt |
project: myapp | tags: deploy, heroku | blockers: interactive prompt blocks CI
```

This text captures the task identity and outcome in a form suited for embedding. At insert time, compute its vector and store it. At search time, embed the query and do cosine similarity against stored episode vectors.

## Design

### Storage

Store episode vectors in the existing `vectors.db` alongside workspace file chunks. Use a distinguishing `source` prefix to separate them:

- Workspace chunks: source = file path (e.g. `memory/MEMORY.md:0`)
- Episode vectors: source = `episode:<id>` (e.g. `episode:a3f9c2...`)

No new database needed. The vector store's `search()` already returns `path` (= source) and `score`.

### Embedding on insert

In `runtime-probes.ts` / `startup-services.ts`, pass the `embedder` alongside `insertEpisode`. Wrap `insertEpisode` to also embed and upsert into vectors.db:

```typescript
// startup-services.ts — wrap the store method
const insertEpisodeWithEmbedding = async (episode: EpisodeRecord) => {
  services.store.insertEpisode(episode); // episodes.db
  const embedding = await services.embedder.embed(episode.semanticEmbeddingText);
  services.vectorStore.upsert(`episode:${episode.id}`, embedding, episode.semanticEmbeddingText);
};
```

The embedder is already available in `initializeStartupMemoryServices` — no new dependency.

### Retrieval

Add `semantic` option to `episode_search` tool (boolean, default false). When true:

1. Embed the query text
2. Search `vectors.db` for top-N matches where source starts with `episode:`
3. Extract episode IDs from source strings
4. Load those episodes from `episodes.db` by ID
5. Merge with keyword results, deduplicate, re-rank by combined score

Keep the existing keyword path as the default — it's deterministic and fast.

### New tool parameter

```
episode_search({
  query: "deploy staging",
  semantic: true,           // enable vector similarity
  maxResults: 5,
})
```

The agent should use `semantic: true` for "find similar past tasks" and omit it for exact field matching.

## What Changes

| File | Change |
|------|--------|
| `src/memory/startup-services.ts` | Wrap `insertEpisode` to also embed into vectors.db |
| `src/memory/episodes/runtime-probes.ts` | Thread embedder through as new dep |
| `src/tools/memory-server.ts` | Add `semantic?: boolean` to `episode_search` input schema; add vector search branch |
| `src/memory/episodes/retrieval.ts` | Add `semanticSearch()` helper that takes pre-fetched vector results |
| `src/templates/AGENTS.md` | Document `semantic: true` in episode_search guidance |

## What Does NOT Change

- `semanticEmbeddingText` field — already correct, no schema change
- `episodes.db` — no new columns needed
- `vectors.db` — reuses existing table; episode vectors coexist with file chunk vectors
- `episode_write` tool interface — no new agent-facing fields

## Out of Scope

- Re-indexing existing episodes (start fresh — episodes.db is new)
- Filtering vector search by metadata before embedding (add later if needed)
- Separate vector store for episodes (premature; one db is simpler)

## Effort

Small — 3-4 files, no new schema, reuses existing embedder and vector store infrastructure. The embedding pipeline is already tested end-to-end for workspace files.
