# Personal Assistant Improvements — Inspired by Second Brain Architecture

**Date:** 2026-04-03
**Status:** Draft
**Source:** Analysis of [second-brain-starter](https://github.com/coleam00/second-brain-starter) architecture vs current personal-assistant codebase

## Current State Summary

The personal assistant already has solid foundations:
- Hybrid memory search (vector 0.7 + keyword 0.3, sqlite-vec, FTS5, EmbeddingGemma-300M)
- Heartbeat scheduler with morning/evening prompts and active hours
- Session persistence with LLM-based compaction
- Multi-adapter support (Terminal, Telegram, Slack)
- Three-layer security (SDK sandbox, bash allowlist, path validation)
- Cron scheduling with multiple schedule types
- Background process execution with registry
- MCP servers for memory search and assistant tools

## Proposed Improvements (Priority Order)

### 1. Daily Reflection — Automated Memory Curation

**What:** A scheduled process that reviews yesterday's daily JSONL audit log, extracts key decisions/lessons/facts, and promotes worthy items into `MEMORY.md` or topic files under `memory/`.

**Why this matters:** Currently daily logs (`daily/YYYY-MM-DD.jsonl`) accumulate but are never curated. Over time, important context gets buried in raw logs. The memory system indexes MEMORY.md and `memory/*.md`, but nothing automatically feeds them. Without curation, the agent's long-term memory degrades — it can search old logs but the signal-to-noise ratio drops.

**How it works:**
1. New cron job fires daily (e.g., 7:00 AM before the first morning heartbeat)
2. Reads yesterday's `daily/YYYY-MM-DD.jsonl` entries
3. Sends entries to LLM with a curation prompt: "Extract key decisions, lessons learned, important facts, and active project updates. Ignore routine tool calls and trivial exchanges."
4. LLM returns structured items with categories (decision, lesson, fact, project-update)
5. Appends curated items to `MEMORY.md` under appropriate sections (or rather create specific topic files in `memory/` whenever more suitable)
6. Memory watcher triggers reindexing automatically

**Implementation:**
- New file: `src/memory/daily-reflection.ts`
  - `runDailyReflection(config, vectorStore)` — orchestrates the pipeline
  - Reads JSONL, filters to conversation entries, formats for LLM
  - Calls Anthropic API with curation prompt
  - Appends to MEMORY.md with timestamp markers
- New template: `src/templates/REFLECTION_PROMPT.md` — the curation system prompt
- Integration: Register as a built-in cron job in `daemon.ts` startup sequence (after memory init)
- Config: `reflection.enabled`, `reflection.schedule` (cron expression), `reflection.maxDailyLogEntries`

**Complexity:** Medium
**Dependencies:** Memory system, cron system, daily log

---

### 1b. Daily Log Indexing into Memory Search

**What:** Index daily JSONL audit logs (`daily/YYYY-MM-DD.jsonl`) into the vector store so they are searchable via hybrid memory search. Covers a configurable rolling window (default: last 3 months).

**Why this matters:** Currently `collectMemoryFiles()` only indexes `MEMORY.md` and `memory/*.md` files. Daily logs — which contain the richest record of conversations, decisions, and tool usage — are completely invisible to memory search. The agent can't answer "what did we discuss about X last month?" because that context lives in unindexed JSONL files. This is a low-effort, high-impact change: the indexer and vector store already exist, they just need to see the daily logs.

**How it works:**
1. `collectMemoryFiles()` is extended to also scan `{workspaceDir}/daily/` for `.jsonl` files
2. Only files within the configured retention window are included (e.g., last 90 days)
3. Files older than the window are skipped (not deleted — just not indexed)
4. The indexer already handles chunking and hash-based change detection, so previously indexed days are skipped automatically
5. JSONL entries are converted to a searchable text format before chunking (extract role, content, timestamp — skip raw tool call JSON noise)

**Implementation:**
- Modify `src/memory/collect-files.ts`:
  - New function `collectDailyLogFiles(workspaceDir, retentionDays)` — scans `daily/` dir, filters by date in filename, returns paths within window
  - `collectMemoryFiles()` calls this and includes results
- Modify `src/memory/indexer.ts`:
  - Add JSONL-aware text extraction: for `.jsonl` files, parse each line, extract meaningful text (role + content), skip tool_use/tool_result noise, join with timestamps
  - Existing chunking and hash-based dedup apply as-is
- Config: `memory.dailyLogRetentionDays` (default 90), `memory.indexDailyLogs` (boolean, default true)

**Complexity:** Low-Medium
**Dependencies:** Memory system (vector store, indexer, file collector)

---

### 2. Heartbeat State Diffing

**What:** Track what the heartbeat reported last time and only notify on actual changes — new events, changed statuses, resolved items.

**Why this matters:** The current heartbeat is stateless — every run evaluates from scratch. This leads to repeated notifications about the same things (e.g., "you have a meeting in 2 hours" every 30 minutes). The second brain's `build_snapshot() -> diff_snapshot()` pattern eliminates noise and makes notifications meaningful.

**How it works:**
1. Before each heartbeat run, load previous state from `{dataDir}/heartbeat-state.json`
2. After gathering current context (system events, time-of-day prompts), build a snapshot
3. Diff current vs previous snapshot
4. Include only the diff in the heartbeat prompt: "Since last check: [new items]. Unchanged: [summary]."
5. Save current snapshot as new state

**Implementation:**
- New file: `src/heartbeat/state.ts`
  - `HeartbeatState` type: `{ lastRun: ISO string, snapshot: Record<string, unknown>, notifiedItems: string[] }`
  - `loadState(dataDir)` / `saveState(dataDir, state)`
  - `diffState(previous, current)` — returns additions, removals, changes
- Modify `src/heartbeat/prompts.ts`:
  - `HEARTBEAT_PROMPT()` receives diff context instead of raw context
  - New section in prompt: "Changes since last heartbeat at {time}: ..."
- Config: `heartbeat.stateDiffing` (boolean, default true)

**Complexity:** Medium
**Dependencies:** Heartbeat system

---

### 2b. Automatic Git Pull/Push Around Heartbeat Sessions

**What:** Programmatically run `git pull` (with stash of local changes) before each heartbeat session, and `git push` after it completes. The agent is still responsible for making commits — only the pull/push plumbing is automated.

**Why this matters:** The workspace is a git repo synced across devices. Currently the agent has to manually pull before reading files and push after writing them, wasting tool calls and sometimes forgetting. Automating pull/push around heartbeat sessions means:
- The agent always works on the latest workspace state
- Changes made by the agent are automatically propagated
- The agent can focus on reasoning and commits, not git transport
- No risk of push conflicts going unnoticed (failures are logged)

**How it works:**
1. **Before heartbeat session starts:**
   - `git stash` any uncommitted local changes (if working tree is dirty)
   - `git pull --rebase` to get latest remote changes
   - `git stash pop` to restore local changes (if stashed)
   - If pull or stash pop fails (conflict), log warning and continue with local state — don't block the heartbeat
2. **After heartbeat session completes:**
   - `git push` to propagate any commits the agent made during the session
   - If push fails (e.g., remote has new commits), log warning — next heartbeat's pull will resolve it
3. The agent still makes commits via its normal Bash tool — this only automates transport

**Implementation:**
- New file: `src/heartbeat/git-sync.ts`
  - `pullWorkspace(workspaceDir)` — stash → pull --rebase → stash pop, returns `{ success: boolean, stashed: boolean, error?: string }`
  - `pushWorkspace(workspaceDir)` — git push, returns `{ success: boolean, error?: string }`
  - Both use `child_process.execFile` (not shell) for safety
  - All operations logged via pino logger
- Modify `src/heartbeat/scheduler.ts` (or wherever heartbeat session is orchestrated):
  - Call `pullWorkspace()` before enqueuing heartbeat message
  - Call `pushWorkspace()` after heartbeat turn completes
- Config: `heartbeat.gitSync.enabled` (boolean, default true), `heartbeat.gitSync.remote` (default "origin")

**Complexity:** Low
**Dependencies:** Heartbeat system, workspace is a git repo

---

### 3. Integration API — Secure Proxy for External Services

**What:** A separate `integ-api` service (HTTP server) that proxies all external service calls (Gmail, Calendar, and future integrations). The assistant interacts with it via a `pa integapi` CLI facade. Only the proxy holds auth secrets — the AI layer has zero access to credentials.

**Why this matters:** A personal assistant that can't see your email or calendar is fundamentally limited. But giving the LLM direct access to OAuth tokens and API keys is a security risk. The integ-api pattern solves both problems:
- **Security boundary**: Hard process-level isolation — the assistant process literally cannot reach secrets
- **Content filtering**: The proxy can redact sensitive data (account numbers, passwords in emails, etc.) before it reaches the LLM
- **Auditability**: Single chokepoint — all external API access logged in one place
- **Extensibility**: Adding a new integration = adding a new route, not restructuring the assistant

**Comparison with OpenClaw (~/dev/openclaw):** OpenClaw uses MCP servers spawned as child processes with credentials passed via environment variables. While effective, this means MCP server code technically has access to leak credentials, and there's no dedicated content filtering/anonymization layer. The integ-api approach is **superior** because:
1. Hard process boundary (separate service) vs soft isolation (child process env vars)
2. First-class content filtering at the proxy layer (OpenClaw only does basic result sanitization)
3. Single audit log for all external access (OpenClaw spreads across 90+ plugin extensions)
4. Simpler architecture — one HTTP service vs complex plugin registry with bundle manifests

**Architecture:**

```
Assistant (LLM layer)                    integ-api (proxy layer)
┌─────────────────────┐                  ┌───────────────────────────────────┐
│  Agent / Heartbeat   │                  │  HTTP server (localhost:19100)     │
│                     │  pa integapi     │                                   │
│  MCP tool calls  ───┼──── CLI ────────>│  ┌─────────┐  ┌──────────────┐   │
│                     │  (no secrets)    │  │  Auth    │  │  Inbound     │   │
│  Zero credential    │                  │  │  Manager │  │  Rate Limiter│   │
│  access             │<─── filtered ────│  └────┬────┘  └──────┬───────┘   │
│                     │     response     │       │              │            │
└─────────────────────┘                  │  ┌────v──────────────v────────┐   │
                                         │  │    Integration Modules     │   │
                                         │  │  ┌────────┐ ┌──────────┐  │   │
                                         │  │  │ Gmail  │ │ Calendar │  │   │
                                         │  │  └────────┘ └──────────┘  │   │
                                         │  │  ┌────────┐ ┌──────────┐  │   │
                                         │  │  │ (Slack)│ │ (Linear) │  │   │
                                         │  │  └────────┘ └──────────┘  │   │
                                         │  └───────────────────────────┘   │
                                         │       │                          │
                                         │  ┌────v──────────────────────┐   │
                                         │  │  Content Filter Pipeline  │   │
                                         │  │  redact → anonymize →     │   │
                                         │  │  truncate → structured    │   │
                                         │  └───────────────────────────┘   │
                                         │       │                          │
                                         │  ┌────v──────────────────────┐   │
                                         │  │  Audit Logger (JSONL)     │   │
                                         │  └───────────────────────────┘   │
                                         │                                   │
                                         │  Credentials: {dataDir}/integ-api/│
                                         └───────────────────────────────────┘
```

**Core features:**

#### 3a. Auth Manager with Profile Rotation/Fallback

Each integration registers auth profiles. The auth manager handles:
- **Token refresh**: On 401/403, auto-refresh OAuth token before retrying the request
- **Rotation**: Multiple credentials per service (e.g., personal + work Google accounts) — rotate on failure
- **Fallback**: If refresh fails, try next profile; if all fail, return structured error to caller
- **Cooldown**: After N consecutive failures, back off before retrying (prevent auth bombing)
- **Secure storage**: All credentials in `{dataDir}/integ-api/credentials/` with `0o600` permissions

```
Request → Auth Manager → try profile[0] → 401? → refresh token → retry
                                                    ↓ fail
                                          try profile[1] → 401? → refresh → retry
                                                                    ↓ fail
                                          return { error: "auth_failed", profiles_tried: 2 }
```

#### 3b. Integration Discovery

`GET /integ-api/integrations` (or `pa integapi list`) returns a structured manifest:

```json
{
  "integrations": [
    {
      "id": "gmail",
      "name": "Gmail",
      "status": "active",
      "capabilities": ["list", "read", "search"],
      "endpoints": [
        { "method": "GET", "path": "/gmail/messages", "params": ["query", "max", "labelIds"] },
        { "method": "GET", "path": "/gmail/messages/:id" },
        { "method": "GET", "path": "/gmail/labels" }
      ],
      "authProfile": "google-personal",
      "rateLimits": { "requestsPerMinute": 60 }
    },
    {
      "id": "calendar",
      "name": "Google Calendar",
      "status": "active",
      "capabilities": ["today", "week", "event", "free-busy"],
      ...
    }
  ]
}
```

The agent calls `pa integapi list` on startup or when it needs to know what's available. Each integration module self-registers its capabilities via an `IntegrationManifest` interface.

#### 3c. Rate Limiting (Dual Layer)

**Inbound rate limiter** (protects integ-api itself):
- Per-caller sliding window (e.g., 100 requests/minute from the assistant)
- Prevents runaway loops (e.g., heartbeat bug flooding Gmail API)
- Returns `429` with structured body: `{ "error": "rate_limited", "retryAfterMs": 5000 }`

**Outbound rate limiter** (per-service, respects provider limits):
- Each integration module declares its provider rate limits in the manifest
- Tracks request counts per service per time window
- On limit hit: queues or returns structured error — never sends raw API errors to the assistant
- Respects `Retry-After` headers from upstream APIs and propagates them

```typescript
// Structured error response — never raw API errors
interface IntegApiError {
  error: "rate_limited" | "auth_failed" | "service_unavailable" | "not_found";
  message: string;           // Human-readable for the agent
  retryAfterMs?: number;     // When to retry (rate limit / cooldown)
  service: string;           // Which integration failed
  profilesTried?: number;    // Auth rotation context
}
```

#### 3d. Modular Integration Architecture

Each integration is a self-contained module implementing a common interface:

```typescript
interface IntegrationModule {
  id: string;
  manifest: IntegrationManifest;       // Discovery metadata + rate limits
  authProfiles: AuthProfileConfig[];   // Credential configs
  routes: (router: SimpleRouter) => void; // Register HTTP endpoints
  healthCheck: () => Promise<boolean>; // Verify connectivity
}
```

Modules are packaged by feature but connected to the integ-api at startup:

```
src/integ-api/
├── server.ts                    # Node.js built-in http module, localhost-only (zero new deps)
├── auth/
│   ├── manager.ts               # Auth profile rotation, refresh, cooldown
│   └── store.ts                 # Credential storage (0o600 permissions)
├── middleware/
│   ├── inbound-rate-limiter.ts  # Per-caller rate limiting
│   ├── content-filter.ts        # Redact → anonymize → truncate pipeline
│   └── audit.ts                 # JSONL request/response logging
├── integrations/
│   ├── registry.ts              # Module registry + discovery endpoint
│   ├── types.ts                 # IntegrationModule interface
│   ├── gmail/
│   │   ├── index.ts             # Implements IntegrationModule
│   │   ├── routes.ts            # GET /gmail/messages, /gmail/messages/:id, etc.
│   │   └── rate-limits.ts       # Gmail API quota config
│   └── calendar/
│       ├── index.ts             # Implements IntegrationModule
│       ├── routes.ts            # GET /calendar/today, /calendar/week, etc.
│       └── rate-limits.ts       # Calendar API quota config
└── cli.ts                       # pa integapi CLI facade
```

Adding a future integration (e.g., Linear, Notion) = create a new folder under `integrations/`, implement `IntegrationModule`, register in `registry.ts`. No changes to core integ-api code.

**HTTP framework decision:** Use Node.js built-in `http` module with a thin custom router (~50 lines). The project has zero HTTP server dependencies today — no reason to add Express for what is essentially a localhost-only API with ~10 routes. A `SimpleRouter` class handles method+path matching, param extraction (`:id`), and JSON request/response helpers. If routing complexity grows significantly (15+ routes, nested middleware chains), Express can be added later as a drop-in replacement.

**How it works end-to-end:**
1. `integ-api` starts as a separate process (spawned by daemon or standalone via `pa integapi serve`)
2. Loads all integration modules from `integrations/registry.ts`
3. Each module registers routes, auth profiles, and rate limit config
4. Listens on `127.0.0.1:19100` (localhost only, no external exposure)
5. Request flow: inbound rate limiter → auth manager → integration route → outbound rate limiter → upstream API → content filter → audit log → response
6. `pa integapi` CLI wraps HTTP calls — the assistant's MCP tools invoke this CLI
7. Agent sees only filtered/sanitized data with structured errors

**CLI facade:**
- `pa integapi serve` — start the HTTP server
- `pa integapi list` — discover available integrations and capabilities
- `pa integapi health` — check connectivity of all integrations
- `pa integapi gmail list [--query "is:unread"] [--max 10]`
- `pa integapi gmail read <messageId>`
- `pa integapi gmail labels`
- `pa integapi calendar today`
- `pa integapi calendar week`
- `pa integapi calendar event <eventId>`
- `pa integapi auth google` — run OAuth2 setup flow (interactive)

**MCP integration:** New `src/tools/integ-server.ts` MCP server
- Tools call `pa integapi` CLI under the hood
- Agent sees only filtered/sanitized data with structured errors

**Config:**
- `integApi.enabled` (boolean)
- `integApi.port` (default 19100)
- `integApi.bind` (default "127.0.0.1")
- `integApi.inboundRateLimit` (requests per minute, default 100)
- `integApi.contentFilter.redactPatterns` (regex list for sensitive data)
- `integApi.contentFilter.maxBodyLength` (truncation limit)
- `integApi.services.gmail.enabled`, `integApi.services.gmail.scopes`
- `integApi.services.calendar.enabled`, `integApi.services.calendar.scopes`

**Complexity:** High
**Dependencies:** None (standalone service, but MCP integration needs existing tool infrastructure)

---

### 4. Draft Management System

**What:** The heartbeat detects messages/emails needing a reply and generates drafts in the user's voice. Drafts go through a lifecycle: active -> sent/expired.

**Why this matters:** One of the highest-value tasks for a personal assistant is reducing the cognitive load of replies. Even if the user rewrites the draft completely, having a starting point saves time and prevents messages from falling through the cracks. The lifecycle tracking ensures drafts don't pile up indefinitely.

**How it works:**
1. Heartbeat (or dedicated check) scans for items needing replies (requires Gmail/Slack integrations via integ-api)
2. For each item, generates a draft using the agent with user's voice context from SOUL.md + past sent drafts (RAG - using the same vector database as for memory - the agent should also memorize the drafts composed)
3. Stores draft as markdown in `workspace/drafts/active/YYYY-MM-DD_type_slug.md` (whole drafts dir and subdirs should be added to dirs indexed by current memory vector DB)
4. User reviews drafts via chat command or file browsing
5. Sent drafts move to `drafts/sent/` (future voice-matching RAG corpus)
6. Drafts older than configurable TTL move to `drafts/expired/`

**Prerequisites:** Improvement #3 (integ-api with Gmail/Calendar) for email drafts. Slack adapter already exists for Slack message drafts.

**Implementation:**
- New directory: `src/drafts/`
  - `manager.ts` — CRUD for draft files, lifecycle transitions
  - `scanner.ts` — Identifies items needing replies (queries Gmail/Slack)
  - `generator.ts` — Creates draft using agent with voice context
  - `cleaner.ts` — Expires old drafts (runs on heartbeat)
- New MCP tool: `draft_list`, `draft_read`, `draft_approve`, `draft_discard`
- New workspace directories: `workspace/drafts/{active,sent,expired}/`
- Draft file format: YAML frontmatter (type, source_id, recipient, subject, created, status) + original message + draft reply
- Config: `drafts.enabled`, `drafts.ttlHours` (default 24), `drafts.autoScan` (boolean)

**Complexity:** High
**Dependencies:** Improvement #3 (integ-api), memory search (for voice-matching RAG)

---

### 5. Habits Tracking

**What:** A `HABITS.md` file with 3-5 daily "pillars" (areas of improvement). The heartbeat tracks progress, auto-detects objective achievements, and nudges for unchecked items.

**Why this matters:** Inspired by James Clear's Atomic Habits — small daily consistency compounds. The assistant already runs heartbeats throughout the day; adding habit awareness costs almost nothing extra but provides genuine personal value. Auto-detection for objective pillars (e.g., "committed code today" via git, "exercised" via calendar event) reduces friction.

**How it works:**
1. `HABITS.md` defines pillars with detection rules (auto-detectable vs self-reported)
2. Morning heartbeat: archives yesterday's checklist to History section, creates fresh checklist
3. Throughout the day: heartbeat checks auto-detectable pillars (git activity, calendar events, etc.)
4. Evening heartbeat: suggests specific actions for unchecked pillars, gentle nudge
5. User can check off self-reported pillars via chat command

**Implementation:**
- New template: `src/templates/HABITS.md` — default pillars with detection rules
- New file: `src/heartbeat/habits.ts`
  - `checkHabits(config)` — evaluates auto-detection rules
  - `resetDaily(workspacePath)` — archives yesterday, creates fresh checklist
  - `formatHabitStatus()` — generates status string for heartbeat prompt
- Modify heartbeat prompts to include habit status
- New MCP tool: `habit_check` — mark a self-reported habit as done
- Config: `habits.enabled`, `habits.pillars[]` (override defaults)

**Complexity:** Medium
**Dependencies:** Heartbeat system, templates

---

### 6. Pre-Compaction Context Flush

**What:** Before the session compactor summarizes and truncates conversation history, flush key context (decisions, action items, important facts) to the daily log.

**Why this matters:** The current compactor (`src/session/compactor.ts`) uses LLM summarization to compress long sessions. This works well for continuing the conversation, but the full context of discarded messages is lost. A pre-compaction flush ensures nothing important disappears — it gets captured in the daily log before the compactor runs, and the daily reflection (Improvement #1) can later promote it to long-term memory.

**How it works:**
1. Before compaction runs, extract the messages that will be compacted away
2. Send them to a quick LLM call: "Extract key decisions, action items, and important facts from these messages"
3. Append extracted items to today's daily JSONL log with `source: "pre-compaction"`
4. Then proceed with normal compaction

**Implementation:**
- Modify `src/session/compactor.ts`:
  - New function `flushPreCompactionContext(messages, config)` called before compaction
  - Uses `dailyLog.append()` to save extracted context
  - Adds `source: "pre-compaction"` field to audit entries
- Config: `session.preCompactionFlush` (boolean, default true)

**Complexity:** Low-Medium
**Dependencies:** Session compactor, daily log

---

## Recommended Build Order

```
Phase 1: Daily Reflection (#1) + Pre-Compaction Flush (#6)
         -> Immediate value: memory stops being a write-only store
         -> Low risk, builds on existing systems

Phase 2: Heartbeat State Diffing (#2)
         -> Better heartbeat quality, less noise
         -> Independent of other improvements

Phase 3: Integration API (#3)
         -> Secure proxy for Gmail, Calendar, future services
         -> Hard credential isolation + content filtering
         -> Required for Phase 4

Phase 4: Draft Management (#4) + Habits Tracking (#5)
         -> Highest-value proactive features
         -> Depend on integrations for full power
```

## Clarifications

Q5: Integration API process isolation — for hard credential isolation, integ-api should ALWAYS run as separate child process from daemon (not in-process). Daemon spawns it, never loads credentials directly. Agree?
A5: Agree.

Q4: Habits auto-detection — should detection rules be limited to predefined safe commands (git, wc) or allow arbitrary user-configured shell commands? Arbitrary adds flexibility but expands attack surface.
A4: We should use generous safe whitelist.

Q3: Gmail access scope — Phase 3 uses gmail.readonly. Draft sending (Phase 4) would need gmail.send scope added later. Approved drafts initially just move to sent/ folder without actual sending. Agree?
A3: Agree.

Q2: Integration API HTTP framework — plan uses Node.js built-in http module (zero new deps) instead of Express. Project has no HTTP server deps currently. Start minimal, add Express later if needed?
A2: Ok, start minimal.

Q1: Daily Reflection writes — plan proposes always creating memory/reflection-YYYY-MM-DD.md files instead of appending to MEMORY.md, keeping MEMORY.md user-curated. Agree?
A1: Yes, agree. Separate files will be good for this specific feature.

## What Was Deliberately Excluded

- **Knowledge graph / entity extraction** — Over-engineering for the current scale. Hybrid search handles the use case well enough.
- **Obsidian sync** — The PA uses its own workspace; adding Obsidian as a viewer is a user concern, not a code concern.
- **Skills system overhaul** — The PA already supports MCP servers and workspace skills. No need to replicate the second brain's 22-skill framework.
- **Notification system rewrite** — Telegram/Slack adapters already deliver notifications. Adding desktop toast (notify-send) is trivial and doesn't need a plan.
- **Advanced query language for search** — The hybrid search works. Power-user query syntax is low ROI.
