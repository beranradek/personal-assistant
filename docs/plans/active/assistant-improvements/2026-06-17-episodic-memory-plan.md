# Personal Assistant — Episodic Memory Plan

**Date:** 2026-06-17  
**Status:** Research-backed draft, intended for iterative refinement in later heartbeat cycles

## Goal

Add a real **episodic memory layer** to `personal-assistant` so the agent can:

- remember specific past tasks and outcomes, not just facts in markdown
- recall prior runs by task identity (`project`, `job`, `issue`, `PR`, `action`, `skill`)
- avoid repeating the same failed tool strategies
- consolidate useful episodes into semantic memory and procedural memory over time
- stay locally auditable and compatible with the current security model

## Current state in `personal-assistant`

The project already has good building blocks, but not a full episodic memory system:

- **Semantic memory**:
  - `memory_search` MCP tool over indexed files, [src/tools/memory-server.ts](/home/radek/.personal-assistant/workspace/dev/personal-assistant/src/tools/memory-server.ts:1)
  - hybrid vector + keyword retrieval, [src/memory/hybrid-search.ts](/home/radek/.personal-assistant/workspace/dev/personal-assistant/src/memory/hybrid-search.ts:1)
  - SQLite + `sqlite-vec` + FTS5 store, [src/memory/vector-store.ts](/home/radek/.personal-assistant/workspace/dev/personal-assistant/src/memory/vector-store.ts:1)
  - indexing of `MEMORY.md`, `memory/*.md`, and optionally daily logs, [src/memory/collect-files.ts](/home/radek/.personal-assistant/workspace/dev/personal-assistant/src/memory/collect-files.ts:1)

- **Audit history**:
  - raw JSONL interaction/tool/error entries, [src/memory/daily-log.ts](/home/radek/.personal-assistant/workspace/dev/personal-assistant/src/memory/daily-log.ts:1)
  - schema is per-entry, not per-episode, [src/core/types.ts](/home/radek/.personal-assistant/workspace/dev/personal-assistant/src/core/types.ts:424)

- **Reflection / consolidation**:
  - daily reflection pipeline, [src/memory/daily-reflection.ts](/home/radek/.personal-assistant/workspace/dev/personal-assistant/src/memory/daily-reflection.ts:1)
  - weekly synthesis, [src/memory/weekly-reflection.ts](/home/radek/.personal-assistant/workspace/dev/personal-assistant/src/memory/weekly-reflection.ts:1)

- **Procedural memory**:
  - `skills/` in workspace, plus skill creation and reuse rules

### Gap summary

What is missing today:

1. No first-class `episode` entity.
2. No persistent task trajectory (`state-action-observation` or equivalent step log).
3. No exact retrieval by work identity (`project`, `job`, `issueId`, `pullRequestId`, `skillUsed`).
4. No episode outcome model (`success`, `partial_success`, `error`, evidence, blockers).
5. No explicit promotion pipeline from episode → semantic memory / skill update.
6. Current audit entries preserve `sessionKey` and `source`, but do not persist richer work-identity fields (`job`, `project`, `issueId`, `pullRequestId`) even when some adapters already know them at enqueue time.

## External findings

## 1. The user-provided “Claude Mythos / missing OS” design

The 5-step lifecycle in Radek's prompt is sound and maps well to the needs of `personal-assistant`:

1. episode formation
2. experience encoding
3. storage + indexing
4. recall + retrieval
5. consolidation + reflection

Important design signals from that model:

- the unit of memory should be a **meaningful bounded experience**, not raw keystrokes
- episodes need explicit metadata: **what, when, where, why, initiator**
- retrieval should support both **exact identity match** and **partial similarity match**
- consolidation should promote stable lessons into semantic/procedural memory

Note:
- direct full-text access to the Medium page was blocked by Cloudflare in this environment
- the plan below uses the detailed lifecycle description from the user prompt plus corroborating public sources below rather than pretending full direct extraction succeeded

## 2. AgentMem

AgentMem cleanly separates:

- semantic memory
- episodic memory
- structured key-value memory

Evidence:
- three memory types in Python SDK, [memory.py](/home/radek/.personal-assistant/workspace/tmp/AgentMem/sdk/python/agentmem/memory.py:1)
- episodic API is append-only and simple: `log_episode(action, result_summary, tags)` and `episodes(last_n)`, [memory.py](/home/radek/.personal-assistant/workspace/tmp/AgentMem/sdk/python/agentmem/memory.py:172)

What to borrow:

- explicit memory-tier split
- separate exact structured store from semantic store
- simple recent-episodes API as a baseline

What is insufficient for `personal-assistant`:

- episode schema is too thin for assistant work
- no strong support for project/job/issue/PR identity
- no trajectory, evidence, blocker, or consolidation layer

## 3. Hermes Agent

Hermes combines:

- built-in always-on memory
- raw session recall via `session_search`
- external memory provider plugin system

Evidence:
- repo positioning around closed learning loop and session search, [GitHub README](/home/radek/.personal-assistant/workspace/tmp/hermes-agent-clone/README.md)
  source summary also visible in official GitHub page: [GitHub README lines 506-514](https://github.com/NousResearch/hermes-agent)
- `session_search` returns actual messages from SQLite / FTS5 without LLM summarization, [tools/session_search_tool.py](/home/radek/.personal-assistant/workspace/tmp/hermes-agent-clone/tools/session_search_tool.py:1)
- official docs distinguish curated memory vs. session search over all sessions, [Hermes memory docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- memory providers commit on `on_session_end`, visible across provider hooks and runtime integration, e.g. [run_agent.py references](/home/radek/.personal-assistant/workspace/tmp/hermes-agent-clone/run_agent.py:3010)

What to borrow:

- keep **raw session recall** separate from curated memory
- use a **session-end / task-boundary commit hook**
- support local exact search over transcripts without LLM in the loop

What not to copy directly:

- plugin-heavy provider model is larger than `personal-assistant` needs right now
- `session_search` is useful, but still not a structured episodic layer by itself

## 4. OpenExp

OpenExp is important because it treats memory as **reusable experience trajectories**:

- record the session trace
- replay matching trajectories later
- stop reasoning from scratch

Evidence:
- [openexp.ai](https://openexp.ai/) lines 35-55 describe record/share/replay and matching trajectories

What to borrow:

- outcome-oriented episode reuse
- trajectory as a reusable artifact, not just an audit residue

This is especially relevant for:

- deployments
- repeated debugging patterns
- recurring admin workflows
- issue/PR handling

## 5. A-Mem

A-Mem focuses on dynamic organization and memory evolution:

- structured note generation
- contextual tags
- linking to historical memories
- continuous refinement

Evidence:
- [WujiangXu/A-mem README lines 269-294](https://github.com/WujiangXu/A-mem)

What to borrow:

- link episodes to each other and to semantic notes
- make consolidation an explicit background process, not a manual afterthought

What not to copy directly:

- Zettelkasten-style graph evolution is useful, but too heavy for phase 1
- the first implementation should favor reliable local retrieval over ambitious autonomous graph editing

## 6. MemoryOS

MemoryOS proposes an OS-like hierarchy:

- short-term memory
- mid-term memory
- long-term personal memory

Evidence:
- abstract: [Memory OS of AI Agent](https://arxiv.org/abs/2506.06326) lines 38-41

What to borrow:

- memory as a **system architecture concern**, not just retrieval
- distinct stores with explicit transitions

Mapping to `personal-assistant`:

- short-term = current turn / session context
- mid-term = episodic store (recent task episodes)
- long-term = semantic memory files + distilled user/project knowledge

## 7. Position paper: episodic memory as the missing piece

The strongest conceptual framing comes from:

- [Position: Episodic Memory is the Missing Piece for Long-Term LLM Agents](https://arxiv.org/abs/2502.06975)

It highlights five defining properties:

- long-term
- explicit
- single-shot
- instance-specific
- contextual relations

This is a very good fit for `personal-assistant`, because the assistant handles:

- one-off tasks worth remembering after a single run
- user-specific and project-specific context
- long-lived work threads with blockers and follow-ups

## 8. Data-foundations perspective

The paper:

- [Is Agent Memory a Database? Rethinking Data Foundations for Long-Term AI Agent Memory](https://arxiv.org/abs/2605.26252)

pushes an important systems lesson:

- vector retrieval alone is too weak
- agent memory needs temporal, dependency-aware, stateful data management semantics

What to borrow:

- exact IDs and relations matter
- temporal and provenance fields are not optional
- memory retrieval should sometimes drive state updates and consolidation decisions

## 9. AdMem / E-mem

These reinforce two useful directions:

- [AdMem](https://arxiv.org/abs/2606.06787): unified semantic + episodic + procedural memory with reward/critic loops
- [E-mem](https://arxiv.org/abs/2601.21714): preserve access to richer episodic context instead of over-compressing too early

Takeaway:

- phase 1 should preserve enough raw evidence for later replay
- phase 2+ can add scoring / critic / reward-like consolidation

## 10. Mem0

Mem0's current docs reinforce that memory layers should be separated by lifetime and scope rather than pushed into one generic store.

Evidence:

- [Mem0 memory types](https://docs.mem0.ai/core-concepts/memory-types) explicitly separates conversation, session, user, and organizational layers and recommends using `run_id` for short-lived task-scoped context

What to borrow:

- model **session/task memory** explicitly in addition to long-lived memory
- keep retrieval layer-aware instead of treating every memory object equally

Mapping to `personal-assistant`:

- conversation = current model/tool context
- session = current task/job run state
- episodic = completed task experiences
- semantic = distilled long-lived notes in markdown

## 11. Hindsight

Hindsight adds useful pressure in one direction: memory should help the agent learn from outcomes, not just remember similar text.

Evidence:

- [Hindsight GitHub README](https://github.com/vectorize-io/hindsight) frames the system as "learn, not just remember"
- [Hindsight paper abstract](https://arxiv.org/abs/2512.12818) describes four logical networks for facts, experiences, summaries, and evolving beliefs with retain/recall/reflect operations

What to borrow:

- keep **experiences** separate from **facts**
- make reflection a first-class operation in the architecture
- derive summaries/beliefs from episodes, not from raw logs alone

## 12. MemMachine

MemMachine contributes the strongest recent evidence for a ground-truth-preserving design.

Evidence:

- [MemMachine](https://arxiv.org/abs/2604.04853) stores full conversational episodes and reports larger gains from retrieval-stage optimizations than from ingestion-stage chunking tweaks

What to borrow:

- preserve raw evidence and link episode records back to it
- avoid aggressive lossy summarization at ingestion time
- invest early in retrieval routing, formatting, and provenance

## Proposed design for `personal-assistant`

### Design principles

1. Local-first and auditable.
2. Reuse current SQLite/FTS/vector infrastructure where possible.
3. Keep raw audit logs as source-of-truth evidence.
4. Introduce a first-class episodic store rather than overloading `MEMORY.md`.
5. Support both exact retrieval and semantic retrieval.
6. Consolidate gradually; do not require full autonomy on day 1.
7. Separate current task/session state from completed episodic memory.
8. Prefer ground-truth preservation and better retrieval over heavier early summarization.

### Memory stack after the change

1. **Raw audit log**
   - existing `daily/*.jsonl`
   - append-only evidence

2. **Session/task state** (new, thin layer)
   - active job/task scoped state
   - recent tool outcomes, open blockers, unresolved decisions
   - expires or closes when the task boundary is reached

3. **Episodic store** (new)
   - one row/document per meaningful task episode
   - structured metadata + summary + step trace + outcome

4. **Semantic memory**
   - existing indexed markdown memory files
   - receives distilled decisions, lessons, stable facts

5. **Procedural memory**
   - existing `skills/`
   - receives promoted repeatable workflows

Why add a separate session/task layer:

- in-progress work should not be treated as validated past experience
- temporary blockers and partial tool outputs are useful during a run, but often too noisy for long-lived episodic recall
- this aligns better with both Mem0's session concept and the current heartbeat/job workflow

### Episode schema v1

```ts
type EpisodeOutcome = "success" | "partial_success" | "failure" | "aborted";

interface EpisodeRecord {
  id: string;
  startedAt: string;
  endedAt: string;
  source: "telegram" | "slack" | "terminal" | "heartbeat" | "system";
  sessionKey: string;
  sessionId?: string | null;
  initiator: "user" | "heartbeat" | "system";

  action: string;
  normalizedAction: string;
  summary: string;
  why: string | null;

  projectName?: string | null;
  jobName?: string | null;
  issueId?: string | null;
  pullRequestId?: string | null;
  detailedMemoryFile?: string | null;
  category?: string | null;

  skillsUsed: string[];
  toolsUsed: string[];
  tags: string[];

  outcome: EpisodeOutcome;
  successScore?: number | null;
  blockers: string[];
  errors: string[];
  evidenceIncomplete: string[];

  trajectory: Array<{
    at: string;
    kind: "state" | "action" | "observation" | "tool_call" | "tool_result" | "decision";
    label: string;
    data?: unknown;
  }>;

  semanticEmbeddingText: string;
}
```

### Storage model

Phase 1 recommendation:

- keep `daily/*.jsonl` as source evidence
- add new SQLite DB, e.g. `{dataDir}/episodes.db`
- use:
  - relational tables for exact filters and time ordering
  - FTS5 for exact-ish text and metadata search
  - vector index for semantic retrieval

Suggested tables:

- `episodes`
- `episode_steps`
- `episode_links`
- `episode_promotions`

Why separate DB instead of reusing the current chunk index directly:

- current memory DB is file-chunk oriented, not entity oriented
- episodes need relational identity, filters, and per-step storage
- overloading `chunks` would become brittle quickly

### Retrieval API

Add a new MCP server or extend the current one with episodic tools:

- `episode_search`
  - query text
  - optional exact filters: `action`, `projectName`, `jobName`, `issueId`, `pullRequestId`, `skill`
  - `maxResults`
  - `includeRecentFallback`

- `episode_recent`
  - recent episodes by exact identity fields

- `episode_stats`
  - count exact matches, last success/failure, recurring blockers

- `episode_get_context`
  - optimized convenience lookup for "what happened last time on this same kind of task?"

Example return shape:

```json
{
  "exactMatchCount": 7,
  "episodes": [...],
  "relatedEpisodes": [...],
  "commonBlockers": ["missing VPN", "stale branch", "rate-limited API"]
}
```

### Episode formation

Do not create an episode for every single interaction line.

Phase 1 heuristic boundaries:

- explicit task completion
- explicit implementation/research/review unit
- heartbeat work item completion
- issue/PR handling cycle
- background process completion
- significant failure requiring user-visible explanation

Additionally:

- keep lightweight session/task state updates between boundaries
- avoid creating a full episode for every small conversational turn

Phase 2:

- add lightweight episode boundary detection using labels from audit entries and tool traces

### Encoding strategy

At episode close:

1. gather relevant audit entries from the current turn / task window
2. extract structured metadata deterministically where possible
3. use LLM only for:
   - compact summary
   - `why`
   - blockers
   - candidate tags
   - semantic embedding text

Important:

- deterministic extraction first
- LLM enrichment second
- raw evidence retained always
- retrieval formatting and provenance may matter more than richer ingestion in v1

### Consolidation strategy

Daily/weekly reflection should evolve from:

- raw conversation curation

to:

- reflection over episode records plus raw evidence links

Promotion rules:

- **semantic promotion** when the lesson/fact is stable and reusable
- **procedural promotion** when the same successful pattern recurs and is step-like
- **no promotion** for noisy one-off incidents

## Implementation roadmap

### Phase 0 — research and interfaces

- finish source review and fill remaining gaps
- define episode schema and retrieval API
- identify where current backends can emit richer structured audit events
- decide whether to extend `AuditEntrySchema` directly or add a parallel lightweight task-context event so issue/job/project identity is not lost before episode formation

### Phase 1 — episodic foundation

- new `src/memory/episodes/` module
- SQLite schema + repository layer
- lightweight session/task state layer
- deterministic episode creation API
- internal recording from selected boundaries
- CLI/debug commands for listing episodes

### Phase 2 — retrieval tools

- MCP episodic tools
- exact + hybrid search
- recency-aware ranking
- identity-based matching and counts

### Phase 3 — reflection integration

- daily reflection reads episodes first
- semantic promotion writes curated markdown
- procedural promotion writes skill suggestions / drafts

### Phase 4 — adaptive learning

- blocker pattern mining
- “don’t repeat this failed path” hints
- recurrence-based skill candidate generation

## Evaluation criteria

Success should not be measured only by “more stored data”.

Primary metrics:

- fewer repeated failed tool strategies
- better recall of prior project-specific decisions
- lower need for user to restate past context
- higher success on repeated workflows
- bounded retrieval cost and bounded storage growth

Suggested tests:

- replay known repeated tasks from `daily/*.jsonl`
- exact identity retrieval tests (`project + issueId`)
- semantic near-match retrieval tests
- consolidation correctness tests
- retention / pruning tests

## Risks and guardrails

1. **Over-storage / noise accumulation**
   - mitigate with bounded episode creation and retention policies

2. **LLM hallucination in encoding**
   - keep raw evidence references
   - deterministic metadata extraction first

3. **Prompt injection persistence**
   - scan episodic summaries before retrieval/injection
   - mark untrusted user content vs system-derived metadata

4. **Cost blow-up**
   - exact retrieval and FTS first
   - vector/LLM enrichment only where useful

5. **Schema rigidity**
   - use versioned schema with additive evolution

## Recommended next research passes

Later heartbeat cycles should still cover:

- Hindsight memory implementation details and evaluation claims
- Mem0 paper + provider design tradeoffs
- MemoryOS codebase, not only paper abstract
- EverMemOS / MemState / Zep / Mirix / HeLa-Mem / MemBench / LongMemEval
- whether graph edges are worth phase 1 or should wait for phase 3
- whether episodic retrieval should support anti-pattern recall (“what failed last time?”) as first-class API
- whether current `daily/*.jsonl` carries enough identity fields to derive task/session linkage automatically

## Immediate recommendation

Implement **episodic memory as a new local entity-oriented store next to the current file-oriented semantic memory**, not as a rewrite of `memory_search`.

That gives the best tradeoff:

- lowest disruption
- good auditability
- strong fit to current architecture
- clean path from “search notes” to “recall past runs”

## Newly validated implementation constraint

After re-checking current source code on 2026-06-17:

- `AuditEntrySchema` stores `timestamp`, `source`, `sessionKey`, interaction/tool/error payloads, and optional text fields
- it does **not** store explicit work identity such as `jobName`, `projectName`, `issueId`, or `pullRequestId`
- some adapters already have richer metadata earlier in the pipeline, but that identity is not preserved into daily audit entries today

Consequence:

- v1 episodic memory can derive some grouping from `sessionKey`
- but robust exact retrieval by job/project/issue will require either:
  - extending audit logging to carry structured task identity, or
  - persisting task-context records in parallel before episode synthesis

This should be treated as an explicit phase-0 design decision, not left implicit.

## Source set used in this draft

- `personal-assistant` source code:
  - [src/memory/vector-store.ts](/home/radek/.personal-assistant/workspace/dev/personal-assistant/src/memory/vector-store.ts:1)
  - [src/memory/indexer.ts](/home/radek/.personal-assistant/workspace/dev/personal-assistant/src/memory/indexer.ts:1)
  - [src/memory/collect-files.ts](/home/radek/.personal-assistant/workspace/dev/personal-assistant/src/memory/collect-files.ts:1)
  - [src/memory/daily-log.ts](/home/radek/.personal-assistant/workspace/dev/personal-assistant/src/memory/daily-log.ts:1)
  - [src/memory/daily-reflection.ts](/home/radek/.personal-assistant/workspace/dev/personal-assistant/src/memory/daily-reflection.ts:1)
  - [src/memory/weekly-reflection.ts](/home/radek/.personal-assistant/workspace/dev/personal-assistant/src/memory/weekly-reflection.ts:1)
  - [src/tools/memory-server.ts](/home/radek/.personal-assistant/workspace/dev/personal-assistant/src/tools/memory-server.ts:1)

- requested external sources:
  - user-provided episodic-memory lifecycle description
  - requested Medium article title/context; direct body access was blocked by Cloudflare in this environment
  - AgentMem source, especially [sdk/python/agentmem/memory.py](/home/radek/.personal-assistant/workspace/tmp/AgentMem/sdk/python/agentmem/memory.py:1)
  - Hermes source, especially [tools/session_search_tool.py](/home/radek/.personal-assistant/workspace/tmp/hermes-agent-clone/tools/session_search_tool.py:1)

- additional research:
  - [Position: Episodic Memory is the Missing Piece for Long-Term LLM Agents](https://arxiv.org/abs/2502.06975)
  - [Memory OS of AI Agent](https://arxiv.org/abs/2506.06326)
  - [A-Mem: Agentic Memory for LLM Agents](https://github.com/WujiangXu/A-mem)
  - [OpenExp](https://openexp.ai/)
  - [E-mem: Multi-agent based Episodic Context Reconstruction for LLM Agent Memory](https://arxiv.org/abs/2601.21714)
  - [AdMem: Advanced Memory for Task-solving Agents](https://arxiv.org/abs/2606.06787)
  - [Is Agent Memory a Database? Rethinking Data Foundations for Long-Term AI Agent Memory](https://arxiv.org/abs/2605.26252)
