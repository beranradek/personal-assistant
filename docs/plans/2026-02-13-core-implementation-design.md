# Personal Assistant - Core Implementation Design

## Overview

A secure, sandboxed personal assistant powered by Claude Agent SDK for TypeScript. Simplified clone of OpenClaw, single-agent, single-user. Two execution modes: standalone terminal and headless daemon with Telegram/Slack adapters and heartbeat.

## Architecture

Two modes, shared core:

```
┌─────────────────────────────────────────────────────────┐
│                    Shared Core                          │
│  ┌─────────┐ ┌──────────┐ ┌────────┐ ┌──────────────┐  │
│  │ Security │ │  Memory  │ │ Skills │ │    Config     │  │
│  │ (hooks)  │ │ (files + │ │(.claude│ │ (settings.json│  │
│  │          │ │  SQLite) │ │/skills)│ │   + MCP)     │  │
│  └─────────┘ └──────────┘ └────────┘ └──────────────┘  │
│  ┌─────────────────────────────────────────────────┐    │
│  │              Agent Runner                       │    │
│  │  (builds prompt, calls SDK query(), streams)    │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘

Mode A: npm run terminal          Mode B: npm run daemon
┌──────────────┐                  ┌──────────────────────┐
│   Terminal    │                  │  Gateway (queue)     │
│  (readline)   │                  │  ┌────────────────┐  │
│  Direct call  │                  │  │ Message Queue   │  │
│  to Agent     │                  │  │ (FIFO, serial)  │  │
│  Runner       │                  │  └───┬────────────┘  │
└──────────────┘                  │      │               │
                                  │  ┌───┴──┐ ┌───────┐  │
                                  │  │Telegr.│ │ Slack │  │
                                  │  └───────┘ └───────┘  │
                                  │  ┌─────────────────┐  │
                                  │  │ Heartbeat (cron) │  │
                                  │  └─────────────────┘  │
                                  └──────────────────────┘
```

- **Terminal** calls Agent Runner directly (single user, synchronous)
- **Daemon** serializes all adapter messages through a FIFO queue (one agent turn at a time)
- Both modes share Agent Runner, Security, Memory, Skills, and Config
- Follows OpenClaw's pattern: clean separation of concerns

## Project Structure

```
personal-assistant/                    # App code (agent cannot modify)
├── src/
│   ├── terminal.ts                    # Mode A: standalone readline REPL
│   ├── daemon.ts                      # Mode B: gateway + adapters + heartbeat
│   │
│   ├── core/
│   │   ├── agent-runner.ts            # Builds prompt, calls SDK query(), streams
│   │   ├── config.ts                  # Loads settings.json, typed config
│   │   ├── workspace.ts              # ensureWorkspace(), writeFileIfMissing()
│   │   ├── types.ts                   # Shared type definitions
│   │   └── logger.ts                  # Structured logging (pino)
│   │
│   ├── security/
│   │   ├── bash-hook.ts               # PreToolUse hook: allowlist + path validation
│   │   ├── allowed-commands.ts        # Command allowlist (from settings.json)
│   │   └── path-validator.ts          # Path sandboxing within allowed dirs
│   │
│   ├── memory/
│   │   ├── files.ts                   # Read/concat AGENTS.md, SOUL.md, USER.md, MEMORY.md
│   │   ├── daily-log.ts              # Append to daily/ session logs
│   │   ├── vector-store.ts           # SQLite-vec storage + indexing
│   │   ├── embeddings.ts             # node-llama-cpp + EmbeddingGemma-300M
│   │   ├── indexer.ts                # Chunking, file watching, sync triggers
│   │   └── hybrid-search.ts          # 0.7 vector + 0.3 BM25 (FTS5)
│   │
│   ├── gateway/
│   │   ├── queue.ts                   # FIFO message queue, serialized turns, max size
│   │   └── router.ts                 # Routes responses back to source adapter
│   │
│   ├── adapters/
│   │   ├── types.ts                   # Adapter interface
│   │   ├── telegram.ts               # Grammy, webhook/polling
│   │   └── slack.ts                  # Bolt.js, socket mode
│   │
│   ├── heartbeat/
│   │   ├── scheduler.ts              # node-cron timer, active hours check
│   │   ├── prompts.ts                # Three prompt variants (standard/exec/cron)
│   │   └── system-events.ts         # In-memory event queue (FIFO, max 20)
│   │
│   ├── cron/
│   │   ├── tool.ts                    # Cron tool (add/list/update/remove)
│   │   ├── store.ts                   # JSON persistence (atomic write)
│   │   ├── timer.ts                   # Job scheduler, next-run calculation
│   │   └── types.ts                   # CronJob, CronSchedule, CronPayload
│   │
│   ├── exec/
│   │   ├── tool.ts                    # Exec tool (background command execution)
│   │   ├── process-registry.ts       # In-memory process tracking (30min TTL)
│   │   └── types.ts                   # ProcessSession, ExecOptions
│   │
│   ├── session/
│   │   ├── store.ts                   # JSONL transcript read/write
│   │   ├── manager.ts                # Session lifecycle, key routing, history loading
│   │   ├── compactor.ts              # History compaction when over threshold
│   │   └── types.ts                   # Session, SessionMessage, SessionKey types
│   │
│   ├── tools/
│   │   ├── memory-server.ts          # SDK MCP server: memory_search tool
│   │   └── assistant-server.ts       # SDK MCP server: cron, exec, process tools
│   │
│   └── templates/                     # Seed files for first-run workspace init
│       ├── AGENTS.md
│       ├── SOUL.md
│       ├── USER.md
│       ├── MEMORY.md
│       └── HEARTBEAT.md
│
├── settings.json                      # App config (outside workspace sandbox)
├── package.json
├── tsconfig.json
└── vitest.config.ts

~/.personal-assistant/                 # User data (persists across reinstalls)
├── workspace/                         # Agent's sandbox - can read/write here
│   ├── AGENTS.md                      # Agent behavior (seeded from template)
│   ├── SOUL.md                        # Agent personality (seeded from template)
│   ├── USER.md                        # User profile (seeded from template)
│   ├── MEMORY.md                      # Long-term memory (seeded from template)
│   ├── HEARTBEAT.md                   # Heartbeat instructions (seeded from template)
│   ├── daily/                         # Audit logs (YYYY-MM-DD.jsonl) - infinite, with tool calls
│   └── .claude/
│       └── skills/                    # Agent's skills
│
└── data/
    ├── memory.sqlite                  # SQLite-vec + FTS5 database
    ├── cron-jobs.json                # Persisted cron jobs
    └── sessions/                      # JSONL session transcripts (per session key)
        ├── terminal--default.jsonl
        ├── telegram--123456.jsonl
        └── slack--C123--thread_ts.jsonl
```

## Security

Three layers of defense:

### Layer 1: SDK Sandbox
```typescript
sandbox: { enabled: true, autoAllowBashIfSandboxed: true }
```

### Layer 2: Filesystem Permissions
```typescript
permissions: {
  allow: [
    "Read(./**)", "Write(./**)", "Edit(./**)",
    "Glob(./**)", "Grep(./**)",
    "Bash(*)", "WebFetch(*)", "WebSearch"
  ]
}
```
Agent restricted to workspace (cwd). Additional dirs configurable.

### Layer 3: PreToolUse Bash Hook
- Extract all commands from shell string (pipes, chains, substitutions)
- Validate each command against allowlist from settings.json
- **Path validation on all file-manipulating commands** (cp, mv, mkdir, rmdir, rm, touch, chmod, ln, tee, curl -o, unzip -d, git clone, output redirection >/>>) - all source and destination paths resolved to absolute and validated against workspace + whitelisted directories
- Extra validation for dangerous commands (rm, kill, pkill, chmod)
- **Exec tool uses the same security validation** - command names checked against allowlist, paths validated

### Self-protection
- settings.json outside workspace - agent cannot modify its config
- src/ outside workspace - agent cannot modify its code
- data/ outside workspace - agent accesses SQLite through memory module only

## Memory System

### System Prompt Construction
Memory files concatenated and appended to Claude Code preset for prompt caching:
```typescript
systemPrompt: {
  type: "preset",
  preset: "claude_code",
  append: concat(AGENTS.md, SOUL.md, USER.md, MEMORY.md, HEARTBEAT.md)
}
```
Static content cached across turns by Anthropic API.

### Daily Audit Logs
Each interaction appends to `workspace/daily/YYYY-MM-DD.jsonl` with structured entries including timestamp, source adapter, session key, user message, assistant response, tool calls (name + input + result), and errors. Agent does NOT read these by default. See Session Management section for details.

### Hybrid Search (RAG)

**Indexing**: MEMORY.md + memory/*.md + configurable extra paths
- Chunk: 400 tokens, 80-token overlap
- Embed: node-llama-cpp + EmbeddingGemma-300M-Q8_0 (local, no API calls)
- Store: SQLite-vec (vectors) + FTS5 (text)

**Search**: 0.7 x vector (cosine) + 0.3 x keyword (BM25), minScore 0.35, top 6 results

**Sync triggers**: File watcher (debounced 1.5s), sync before search if dirty, background warmup on session start

**Exposed as tool**: `memory_search(query, maxResults?)` via SDK MCP server

## Adapters & Gateway

### Adapter Interface
```typescript
interface Adapter {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendResponse(message: AdapterMessage): Promise<void>;
}
```

### Telegram (Grammy)
- Polling mode by default, webhook optional
- Message chunking (4096 char limit)
- Private bot - allowed user IDs in settings.json

### Slack (Bolt.js)
- Socket mode (no public URL)
- Thread support (each thread = conversation)

### Gateway Queue
- In-memory async FIFO, configurable max size (default: 20)
- One agent turn at a time - serialized processing
- Messages exceeding limit get "Messages limit reached" error response
- Router delivers response back to source adapter using source + sourceId

## Session Management

Multi-turn conversation persistence following OpenClaw's pattern. Each adapter/sender combination maintains its own session with full conversation history.

### Session Keys
Per-adapter, per-sender routing:
- Terminal: `terminal--default`
- Telegram: `telegram--{userId}`
- Slack: `slack--{channelId}--{threadTs}`

File-safe separators (`--`) used in session key and JSONL filenames.

### Session Transcripts (JSONL)
Each session key maps to a JSONL file in `~/.personal-assistant/data/sessions/`:
- One JSON object per line: `{ role, content, timestamp, toolName?, error? }`
- Roles: `user`, `assistant`, `tool_use`, `tool_result`
- Append-only during session; rewritten only during compaction
- Session loaded on each new agent turn; recent history injected into SDK

### History Loading & Injection
Fresh SDK `query()` call per turn (no SDK session resume):
1. Load JSONL transcript for session key
2. Sanitize: strip large tool result payloads (`details`), usage/cost metadata
3. Truncate: keep last N messages (configurable `maxHistoryMessages`, default 100)
4. Pass truncated history as `messages` to SDK `query()` or via `replaceMessages()`
5. After agent turn completes, append all new messages (user + assistant + tool calls) to JSONL

This follows OpenClaw's approach: manually manage sessions rather than relying on SDK resume.

### History Compaction
When transcript exceeds `maxHistoryMessages` threshold:
- Keep last N messages intact
- Archive full transcript as `.bak` before rewriting
- Append compaction metadata entry: `{ type: "compaction", timestamp, messagesBefore, messagesAfter }`
- Compaction runs automatically before loading history when threshold exceeded

### Audit Logs (Daily)
Infinite append-only logs at `workspace/daily/YYYY-MM-DD.jsonl`:
- Every interaction: timestamp, source adapter, session key, user message, assistant response
- Tool calls: tool name, input, output/result, duration
- Errors: error message, stack trace, context
- Agent does NOT read audit logs by default (not in system prompt, not indexed)
- Purpose: debugging, tuning, audit trail for all agent activity

Separate from session transcripts: audit logs are per-day across all sessions, transcripts are per-session across all days.

## Heartbeat, Cron & Async Exec

### System Event Queue
In-memory FIFO, max 20 events per session. Shared by cron and exec.

### Heartbeat
- Fires every N minutes (default: 30, configurable)
- Active hours check (default: 8-21, configurable)
- Checks system event queue for pending events:
  - Exec completion → EXEC_EVENT_PROMPT
  - Cron event → CRON_EVENT_PROMPT with event text
  - Neither → standard HEARTBEAT_PROMPT ("Read HEARTBEAT.md...")
- Agentic approach: agent reads HEARTBEAT.md and uses tools to check things
- Agent responds with notification text or "HEARTBEAT_OK" (logged, not delivered)
- Delivery to configured channel ("last", "telegram", or "slack")

### Cron Tool (agent-created reminders)
- Agent manages jobs via `cron` tool: add, list, update, remove
- Schedule types: cron expression, one-shot (ISO-8601), interval (everyMs)
- Persisted to `~/.personal-assistant/data/cron-jobs.json` (atomic write)
- Job fires → enqueue system event → trigger heartbeat immediately → deliver

### Exec Tool (background commands)
- Agent runs long commands via `exec` tool with `yieldMs` or `background` flag
- **Command validation**: same allowlist + path validation as bash hook
- Process registry: in-memory, 30-minute TTL, tracks pid/output/exit
- Process exits → enqueue system event → trigger heartbeat → agent relays result
- Agent checks status via `process` tool

## Skills

Native Claude Code `.claude/skills/` in workspace. SDK discovers and loads them automatically via `settingSources: ["project"]`. No custom skill loading code needed. Agent can create new skills by writing `.md` files to the skills directory.

## Custom Tools (SDK MCP Servers)

| Tool | Server | Purpose |
|------|--------|---------|
| `memory_search` | `memory` | Hybrid search over workspace memory files |
| `cron` | `assistant` | Create/list/update/remove scheduled reminders |
| `exec` | `assistant` | Run commands in background with completion notification |
| `process` | `assistant` | Check status of background processes |

All in-process SDK MCP servers. Passed to SDK alongside user-configured external MCP servers.

## Configuration (settings.json)

```json
{
  "security": {
    "allowedCommands": ["ls", "cat", "grep", "node", "npm", "git", "..."],
    "commandsNeedingExtraValidation": ["rm", "rmdir", "kill", "chmod", "curl"],
    "workspace": "~/.personal-assistant/workspace",
    "dataDir": "~/.personal-assistant/data",
    "additionalReadDirs": [],
    "additionalWriteDirs": []
  },
  "adapters": {
    "telegram": {
      "enabled": false,
      "botToken": "",
      "allowedUserIds": [],
      "mode": "polling"
    },
    "slack": {
      "enabled": false,
      "botToken": "",
      "appToken": "",
      "socketMode": true
    }
  },
  "heartbeat": {
    "enabled": true,
    "intervalMinutes": 30,
    "activeHours": "8-21",
    "deliverTo": "last"
  },
  "gateway": {
    "maxQueueSize": 20
  },
  "agent": {
    "model": null,
    "maxTurns": 200
  },
  "session": {
    "maxHistoryMessages": 100,
    "compactionEnabled": true
  },
  "memory": {
    "search": {
      "enabled": true,
      "hybridWeights": { "vector": 0.7, "keyword": 0.3 },
      "minScore": 0.35,
      "maxResults": 6,
      "chunkTokens": 400,
      "chunkOverlap": 80
    },
    "extraPaths": []
  },
  "mcpServers": {}
}
```

Config loaded from app installation directory at startup. Not hot-reloaded.

## Entry Points

**Terminal** (`npm run terminal`): loadConfig → ensureWorkspace → readline loop → load session("terminal--default") → query() with history → stream to stdout → append to session + audit log

**Daemon** (`npm run daemon`): loadConfig → ensureWorkspace → start queue → start adapters → start cron → start heartbeat → process messages (load session per key → query() with history → route response → append to session + audit log) → graceful shutdown on SIGTERM/SIGINT

## Key Dependencies

- `@anthropic-ai/claude-agent-sdk` - Agent execution
- `grammy` - Telegram bot
- `@slack/bolt` - Slack bot (socket mode)
- `better-sqlite3` + `sqlite-vec` - Vector storage + FTS5
- `node-llama-cpp` - Local embeddings (EmbeddingGemma-300M)
- `node-cron` - Heartbeat scheduling
- `pino` - Structured logging
- `tsx` - TypeScript execution (dev)
- `vitest` - Testing

## References

- OpenClaw source: `/home/radek/dev/openclaw` (MIT license, blueprint)
- Claude Agent SDK: `@anthropic-ai/claude-agent-sdk`
- Spec: `feat/01-core-implementation/core-implementation-spec.md`
