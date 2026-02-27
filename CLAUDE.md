# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A secured, sandboxed personal assistant powered by the Claude Agent SDK for TypeScript. Two modes:
- **Terminal mode** (`pa terminal`): Interactive readline REPL
- **Daemon mode** (`pa daemon`): Headless service with Telegram/Slack adapters, heartbeat scheduler, and message queue

Installable globally via `npm run build && npm link`, providing the `pa` CLI command.

Node.js 22+ required. Uses ESM (`"type": "module"`).

## Commands

```bash
# Global CLI (after npm run build && npm link)
pa terminal              # Interactive terminal mode
pa daemon                # Headless daemon mode
pa init                  # Create default ~/.personal-assistant/settings.json
pa --config <path> ...   # Override settings.json location

# Development (from source)
npm run terminal         # Run interactive terminal mode (via tsx)
npm run daemon           # Run headless daemon mode (via tsx)
npm run build            # TypeScript compilation (tsc → dist/) + template copy
npm test                 # Run tests (vitest, watch mode)
npm run test:coverage    # Run tests with coverage (70% threshold on statements/branches/functions/lines)
npx vitest run src/path/to/file.test.ts   # Run a single test file
```

No linter is configured.

## Architecture

### Message Flow

```
Adapters (Telegram/Slack/Terminal) → Gateway Queue (FIFO, serial) → Agent Runner (SDK query()) → Router → Adapter.sendResponse()
```

Daemon mode initializes subsystems in order: config → workspace → memory system → MCP servers → agent options → queue/router → adapters → heartbeat → cron timer → processing loop.

### Source Layout (`src/`)

| Directory | Purpose |
|-----------|---------|
| `core/` | Config loading (Zod-validated `settings.json`), agent runner (SDK orchestration + session lifecycle), workspace bootstrap, logger (pino), central types |
| `adapters/` | Telegram (grammy) and Slack (@slack/bolt socket mode) integrations implementing the `Adapter` interface |
| `gateway/` | FIFO message queue with serial processing loop; router dispatches responses back to originating adapter |
| `session/` | JSONL-based conversation persistence per session key (`source--sourceId[--threadId]`), auto-compaction |
| `memory/` | Hybrid search: local embeddings (node-llama-cpp), vector store (sqlite-vec), file indexer with chunking, daily JSONL audit log |
| `security/` | Three-layer defense: SDK sandbox + filesystem path validation + bash command allowlist hook (PreToolUse) |
| `heartbeat/` | Periodic scheduler (node-cron within active hours), system event buffer, prompt generation |
| `cron/` | User-created scheduled jobs: CRUD tool, node-cron timer, JSON file persistence |
| `exec/` | Background process spawning with in-memory registry and completion events |
| `tools/` | MCP servers: `memory-server` (memory_search tool) and `assistant-server` (cron, exec, process tools) |
| `templates/` | Workspace seed files (AGENTS.md, SOUL.md, USER.md, MEMORY.md, HEARTBEAT.md) with Czech variants in `cs/` |

### Key Entry Points

- `cli.ts` — Global CLI entry point: parses `pa <command>` subcommands, resolves config directory
- `terminal.ts` — Terminal mode: readline REPL, `handleLine()` + `createTerminalSession()` + `runTerminalRepl()` exported for testing/reuse
- `daemon.ts` — Daemon mode: `startDaemon()` orchestrates all subsystems, graceful shutdown on SIGTERM/SIGINT
- `core/agent-runner.ts` — `buildAgentOptions()` constructs SDK options; `runAgentTurn()` runs a single conversation turn with session load/save/compact/audit

### Design Patterns

- **Factory functions** everywhere (`createMessageQueue()`, `createVectorStore()`, `createIndexer()`, etc.) with dependency injection through parameters
- **All types in `core/types.ts`** — Zod schemas for config validation with inferred TypeScript types; interfaces for adapters, messages, search results, cron jobs, sessions, audit entries
- **Tests co-located** with source files (`foo.ts` → `foo.test.ts`), plus `integration.test.ts` at src root
- **Conditional main execution**: entry points check `process.env["VITEST"]` to skip `main()` during tests

## Configuration

`~/.personal-assistant/settings.json` (create with `pa init`). Loaded once at startup (no hot-reload). Deep-merged over defaults, validated with Zod. Override location with `--config <path>` or `PA_CONFIG` env var.

Key sections: `security` (command allowlist, workspace/data paths, additional read/write dirs), `adapters` (telegram/slack), `heartbeat`, `gateway`, `agent` (model, maxTurns), `session` (maxHistoryMessages, compaction), `memory` (hybrid search weights/thresholds), `mcpServers`.

## Runtime Directories

- `~/.personal-assistant/workspace/` — Agent workspace (memory files, skills, daily logs)
- `~/.personal-assistant/data/` — Sessions (JSONL), vector DB (sqlite), cron jobs (JSON)

## Maintenance

Designs and plans of features to implement are stored in `docs/plans/active/` with date and short description. 
Completed plans are moved to `docs/plans/completed/`.
This serves as a living design document and implementation log for the project.
