# Agent Memory

This document describes all memory systems available to the personal assistant, how they work together, and when to use each one.

## Overview

The assistant has five distinct memory layers, each with a different scope, write path, and lifetime:

| Layer | What it stores | Written by | Read via | Database / File |
|-------|---------------|-----------|---------|-----------------|
| Semantic memory | Facts, preferences, workflows | Agent (Bash/Write/Edit) | `memory_search` | `vectors.db` + workspace `.md` files |
| Episodic memory | Completed task records | Agent (`episode_write`) | `episode_search`, `episode_recent`, `episode_stats` | `episodes.db` |
| Daily audit log | Per-turn interaction trace | System (automatic) | Reflection pipeline | `workspace/daily/YYYY-MM-DD.jsonl` |
| Conversation history | SDK message history | System (automatic) | Loaded at turn start | `data/sessions/<key>.jsonl` |
| Reflections | AI-synthesized summaries | Cron (daily/weekly) | `memory_search` (indexed) | Workspace files |

---

## Semantic Memory

**Purpose:** Long-term structured knowledge — user preferences, recurring workflows, project notes, key decisions.

### Structure

Files live under `~/.personal-assistant/workspace/`:

| File | Content |
|------|---------|
| `MEMORY.md` | Primary long-term memory (indexed automatically) |
| `USER.md` | User profile, communication preferences, schedule |
| `SOUL.md` | Agent personality and behavior rules |
| `AGENTS.md` | Tool guidance, workspace conventions |
| `memory/` | Additional topic files (created by the agent) |
| `.claude/skills/` | Reusable workflow descriptions (skills) |

All markdown files in `workspace/` and any configured `extraPaths` are chunked and indexed into `vectors.db` on startup and whenever the file watcher detects changes.

### Use cases

- "Remember my preference for X" → write to MEMORY.md or USER.md
- "What do I know about project Y?" → `memory_search`
- "Update my skill for Z" → edit the relevant skill file

### Writing

The agent writes directly to workspace files using standard file tools (Write, Edit, Append). There is no tool wrapper — the agent uses `~/.personal-assistant/workspace/` as its working directory for memory files.

After writing, the indexer re-embeds the changed chunks automatically. The search index stays consistent.

### Reading

```
memory_search({ query: "deploy heroku", maxResults: 5 })
```

Uses hybrid scoring: cosine similarity (vectors) + BM25-style keyword match, weighted by `memory.search.hybridWeights` in settings. Results include a recency boost. Returns file path, text chunk, and score.

### Consolidation

The agent reviews and merges memory files manually. Daily/weekly reflections (see below) summarize recent events and write conclusions back to workspace files, which are then re-indexed.

### TTL

No automatic cleanup. Files persist until the agent or user deletes them. Workspace files are the agent's source of truth for everything worth keeping long-term.

---

## Episodic Memory

**Purpose:** Structured records of completed tasks — what was done, how it went, what was learned.

### Structure

Each episode is a structured record stored in `~/.personal-assistant/data/episodes.db` (SQLite, schema v2):

```
action         — one-line task description (normalized)
summary        — narrative of what happened, key decisions, result
outcome        — success | partial_success | failure | aborted
successScore   — derived (1.0 / 0.6 / 0.0 / 0.2)
why            — motivation / request context
trajectory     — key decisions and pivots (3–7 items)
tags, category, projectName, jobName, issueId, pullRequestId
toolsUsed, skillsUsed
blockers, errors, openQuestions
relatedEpisodeIds — links to prior related episodes
location       — primary artifact (file path, URL, or file:line)
source         — telegram | slack | terminal | github | heartbeat | system
initiator      — user | heartbeat | system
sessionKey, sessionId
startedAt, endedAt
semanticEmbeddingText — pre-built embedding string (used for vector search)
```

### Use cases

- "What happened last time I deployed this app?" → `episode_search` with query + project filter
- "Show recent failures" → `episode_recent` with `outcome: "failure"`
- "How often do I work on X?" → `episode_stats`
- Find semantically similar past tasks → `episode_search` with `semantic: true`

### Writing

The agent calls `episode_write` at meaningful task boundaries — not after every turn. Typical triggers: a GitHub issue is resolved, a deploy completes (success or failure), a research task concludes, a debugging session ends.

```
episode_write({
  action: "Fix login redirect after OAuth callback",
  summary: "Identified missing return_to param in OAuth handler...",
  outcome: "success",
  projectName: "myapp",
  trajectory: ["Reproduced bug", "Traced to OAuth middleware", "Fixed return_to param", "Deployed to staging"],
  toolsUsed: ["Bash", "Edit"],
  tags: ["oauth", "bug-fix"]
})
```

On write, the episode is stored in `episodes.db` and its `semanticEmbeddingText` is embedded into `vectors.db` with source key `episode:<id>` for vector search.

### Reading

```
episode_search({ query: "deploy staging", maxResults: 5 })           // keyword
episode_search({ query: "deploy staging", semantic: true })           // vector similarity
episode_search({ query: "oauth", outcome: "failure" })               // keyword + filter
episode_recent({ projectName: "myapp", limit: 10 })                  // recent by filter
episode_stats({ projectName: "myapp" })                              // counts + top dimensions
```

Use `semantic: true` when you want to find episodes describing similar tasks even if the wording differs. Use exact filters (`outcome`, `projectName`, etc.) to narrow keyword results.

### Consolidation

Episodes are immutable once written. For follow-up tasks, set `relatedEpisodeIds` to link to prior episodes. There is no automatic merging.

### TTL

No automatic cleanup. Episodes persist indefinitely. The `episode_stats` tool helps identify patterns over time.

---

## Daily Audit Log

**Purpose:** Complete interaction trace for each day — turns, tool calls, errors, timing.

### Structure

JSONL files at `~/.personal-assistant/workspace/daily/YYYY-MM-DD.jsonl`. Each line is a JSON object representing one audit entry (turn start, tool call, tool result, turn end, error, etc.).

### Use cases

- Source material for daily/weekly reflections
- Debugging unexpected agent behavior
- Context when writing episodic memory

### Writing

Automatic — the system writes one entry per turn event. The agent does not call this directly.

### Reading

The reflection pipeline reads audit logs to generate daily and weekly summaries. The agent can also read these files directly if needed for analysis.

### Consolidation

The reflection cron job reads audit logs, summarizes them into workspace memory files, and the summaries are then indexed for `memory_search`. Raw audit logs are retained for `memory.dailyLogRetentionDays` (default: 90 days) then pruned automatically.

### TTL

90 days by default (configurable via `memory.dailyLogRetentionDays`).

---

## Conversation History

**Purpose:** Per-session message history for SDK context resumption.

### Structure

JSONL files at `~/.personal-assistant/data/sessions/<session-key>.jsonl`. Session key format: `<source>--<sourceId>[--threadId]`. Each file holds the raw SDK message history for that conversation.

### Use cases

- Resuming a conversation where it left off
- Context within a multi-turn task

### Writing

Automatic — the system saves each turn's messages. The agent does not manage this directly.

### Reading

Loaded at turn start. The SDK resumes the conversation from the last saved state.

### Compaction

When the context window fills, the SDK auto-compacts older messages. Optionally, an AI-generated summary is inserted before compaction to preserve key context (`session.compactionSummaryPrompt` in settings). Maximum retained messages: `session.maxHistoryMessages` (default: 100).

### TTL

No automatic cleanup. Session files accumulate. Use `/clear` to reset a conversation (deletes the session file for that conversation).

---

## Reflections

**Purpose:** AI-synthesized summaries of recent activity, indexed for `memory_search`.

### Structure

Written as markdown files in the workspace (configurable paths). Content includes summaries of the day's work, patterns noticed, open questions, and insights worth keeping.

### Use cases

- "What did I work on last week?" → `memory_search` will surface reflection summaries
- Building on prior context at the start of a new session

### Writing

Cron-driven:
- **Daily** (default: 7:00 AM on weekdays): reads the previous day's audit log, generates a structured summary, writes it to a workspace file
- **Weekly** (default: Monday 7:05 AM): synthesizes the week's daily reflections into a higher-level summary

Reflection files are immediately indexed, so `memory_search` can find them.

### Consolidation

Each daily reflection overwrites the previous day's file (keyed by date). Weekly summaries accumulate. Older summaries are retained indefinitely as part of the indexed workspace.

### TTL

Daily reflection files: retained for `reflection.dailyRetentionDays` (default: 21 days). The weekly summary and indexed workspace content persist until explicitly removed.

---

## Summary

| System | Good for | Persists | Searched by |
|--------|----------|----------|-------------|
| Semantic (workspace files) | Preferences, know-how, notes | Indefinitely | `memory_search` |
| Episodic (episodes.db) | Task records, outcomes, patterns | Indefinitely | `episode_search`, `episode_recent`, `episode_stats` |
| Audit log | Interaction trace, debugging | 90 days | Reflection pipeline |
| Session history | Conversation context | Until `/clear` | Automatic (SDK) |
| Reflections | Activity summaries | 21 days (daily) | `memory_search` |

For detailed tool reference, see [docs/agent-tools.md](agent-tools.md).
