# Personal Assistant - Core Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a secure, sandboxed personal assistant with terminal and daemon modes, powered by Claude Agent SDK.

**Architecture:** Two execution modes (standalone terminal + headless daemon) sharing a core of security hooks, memory system (hybrid search with sqlite-vec), and agent runner. Daemon mode serializes messages from Telegram/Slack/heartbeat through a FIFO queue.

**Tech Stack:** TypeScript, Claude Agent SDK, Grammy (Telegram), @slack/bolt (Slack), better-sqlite3 + sqlite-vec, node-llama-cpp, node-cron, pino, vitest

**Reference:** Design doc at `docs/plans/2026-02-13-core-implementation-design.md`. OpenClaw source at `/home/radek/dev/openclaw` (MIT, blueprint).

---

## Phase 1: Project Foundation

### Task 1: Project Setup

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/core/types.ts`

**Step 1: Initialize package.json**

```json
{
  "name": "personal-assistant",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "terminal": "tsx src/terminal.ts",
    "daemon": "tsx src/daemon.ts",
    "build": "tsc",
    "test": "vitest",
    "test:coverage": "vitest --coverage"
  },
  "engines": {
    "node": ">=22.0.0"
  }
}
```

**Step 2: Install dependencies**

Run:
```bash
npm install @anthropic-ai/claude-agent-sdk grammy @slack/bolt better-sqlite3 sqlite-vec node-llama-cpp node-cron pino zod
npm install -D typescript tsx vitest @vitest/coverage-v8 @types/better-sqlite3 @types/node
```

**Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

**Step 4: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      thresholds: { statements: 70, branches: 70, functions: 70, lines: 70 },
    },
  },
});
```

**Step 5: Create shared types**

Create `src/core/types.ts` with all shared interfaces:
- `Config` (full settings.json shape)
- `AdapterMessage` (source, sourceId, text, metadata)
- `Adapter` interface (name, start, stop, sendResponse)
- `SearchResult` (path, snippet, startLine, endLine, score)
- `SystemEvent` (text, timestamp)
- `CronJob`, `CronSchedule`, `CronPayload` types
- `ProcessSession` type

Use zod schemas for runtime validation where config is loaded.

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: project setup with dependencies and shared types"
```

---

### Task 2: Configuration System

**Files:**
- Create: `src/core/config.ts`
- Create: `src/core/config.test.ts`
- Create: `settings.json`

**Step 1: Write failing tests for config loading**

Test cases:
- Loads settings.json from app directory and returns typed config
- Merges user settings over defaults (missing keys get defaults)
- Validates required fields (throws on invalid config)
- Resolves `~` in workspace/dataDir paths to absolute
- Returns full defaults when settings.json has empty object `{}`

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/config.test.ts`

**Step 3: Implement config.ts**

- `DEFAULTS` constant with all default values from design doc
- `loadConfig(appDir: string): Config` - reads settings.json, deep-merges with defaults, validates with zod schema, resolves paths
- `resolveUserPath(p: string): string` - expands `~` to `os.homedir()`

**Step 4: Create settings.json with sensible defaults**

Use the full config from the design doc. Adapters disabled. Heartbeat enabled with 8-21 active hours. Full command allowlist.

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/core/config.test.ts`

**Step 6: Commit**

```bash
git add src/core/config.ts src/core/config.test.ts settings.json
git commit -m "feat: configuration system with defaults and validation"
```

---

### Task 3: Logger

**Files:**
- Create: `src/core/logger.ts`

**Step 1: Implement logger**

Thin wrapper around pino:
```typescript
import pino from "pino";

export const logger = pino({
  transport: { target: "pino-pretty", options: { colorize: true } },
});

export function createLogger(name: string) {
  return logger.child({ module: name });
}
```

**Step 2: Commit**

```bash
git add src/core/logger.ts
git commit -m "feat: structured logging with pino"
```

---

### Task 4: Workspace Management

**Files:**
- Create: `src/core/workspace.ts`
- Create: `src/core/workspace.test.ts`
- Create: `src/templates/AGENTS.md`
- Create: `src/templates/SOUL.md`
- Create: `src/templates/USER.md`
- Create: `src/templates/MEMORY.md`
- Create: `src/templates/HEARTBEAT.md`

**Step 1: Write failing tests**

Test cases:
- `ensureWorkspace()` creates workspace directory if missing
- Creates all template files on first run (AGENTS.md, SOUL.md, USER.md, MEMORY.md, HEARTBEAT.md)
- Does NOT overwrite existing files on subsequent runs (write-exclusive)
- Creates `daily/` subdirectory
- Creates `.claude/skills/` subdirectory
- Creates data directory if missing

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/workspace.test.ts`

**Step 3: Create template files**

Write initial template content for each markdown file. Reference OpenClaw templates at `/home/radek/dev/openclaw/docs/reference/templates/` for structure and tone. Keep templates concise - they're starting points the user will customize.

**Step 4: Implement workspace.ts**

- `writeFileIfMissing(filePath: string, content: string): Promise<void>` - uses `fs.writeFile` with flag `"wx"` (write-exclusive), catches EEXIST silently
- `ensureWorkspace(config: Config): Promise<void>` - creates dirs, copies templates, idempotent
- `resolveTemplatePath(filename: string): string` - resolves template from `src/templates/`

**Step 5: Run tests, verify pass**

Run: `npx vitest run src/core/workspace.test.ts`

**Step 6: Commit**

```bash
git add src/core/workspace.ts src/core/workspace.test.ts src/templates/
git commit -m "feat: workspace initialization with template seeding"
```

---

## Phase 2: Security

### Task 5: Path Validator

**Files:**
- Create: `src/security/path-validator.ts`
- Create: `src/security/path-validator.test.ts`

**Step 1: Write failing tests**

Test cases:
- Path within workspace returns valid
- Path outside workspace returns invalid with reason
- Resolves symlinks before checking (no symlink escape)
- `../` traversal blocked
- `~` expansion works correctly
- `/tmp` allowed when `allowTmp: true`
- Additional read dirs are respected (path within additionalReadDirs returns valid)
- Additional write dirs are respected
- Absolute paths outside all allowed dirs blocked

**Step 2: Run tests to verify they fail**

**Step 3: Implement path-validator.ts**

Port from `feat/01-core-implementation/examples/security.py` `validate_path_within_project()`:
- `validatePath(path: string, workspaceDir: string, options: { allowTmp?: boolean, additionalReadDirs?: string[], additionalWriteDirs?: string[], operation?: string }): { valid: boolean, reason?: string }`
- Resolves to absolute, checks `path.startsWith(allowedDir)`

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/security/path-validator.ts src/security/path-validator.test.ts
git commit -m "feat: path validation for filesystem sandboxing"
```

---

### Task 6: Command Extraction & Validation

**Files:**
- Create: `src/security/allowed-commands.ts`
- Create: `src/security/allowed-commands.test.ts`

**Step 1: Write failing tests**

Test cases:
- `extractCommands("ls -la")` returns `["ls"]`
- `extractCommands("ls | grep foo")` returns `["ls", "grep"]`
- `extractCommands("echo hello && cat file")` returns `["echo", "cat"]`
- `extractCommands("$(whoami)")` returns `["whoami"]` (substitution)
- `extractCommands("for x in a b; do echo $x; done")` skips shell keywords
- `extractCommands("VAR=val node app.js")` skips variable assignment
- `validateCommand("ls", allowlist)` returns allowed
- `validateCommand("wget", allowlist)` returns blocked
- `validateRmCommand("rm -rf /")` returns blocked
- `validateKillCommand("kill 1")` returns blocked (PID 1)
- `extractFilePathsFromCommand("cp a.txt /etc/shadow")` returns both paths

**Step 2: Run tests to verify they fail**

**Step 3: Implement allowed-commands.ts**

Port from `feat/01-core-implementation/examples/security.py`:
- `extractCommands(commandString: string): string[]` - handles pipes, chains, substitutions
- `extractSubstitutionCommands(commandString: string): string[]` - `$(...)`, backticks, `<(...)`
- `splitCommandSegments(commandString: string): string[]` - split on `&&`, `||`, `;`
- `validateCommand(cmd: string, allowlist: Set<string>): { allowed: boolean, reason?: string }`
- `validateRmCommand(segment: string)`, `validateKillCommand(segment: string)`, etc.
- `extractFilePathsFromCommand(commandString: string): string[]` - for path validation

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/security/allowed-commands.ts src/security/allowed-commands.test.ts
git commit -m "feat: command extraction and allowlist validation"
```

---

### Task 7: Bash Security Hook

**Files:**
- Create: `src/security/bash-hook.ts`
- Create: `src/security/bash-hook.test.ts`

**Step 1: Write failing tests**

Test cases:
- Allowed simple command passes: `ls -la`
- Blocked command returns `{ decision: "block" }`: `wget http://evil.com`
- Piped commands all validated: `cat file | grep x` (both must be allowed)
- Path outside workspace blocked: `cat /etc/passwd`
- Path within workspace allowed: `cat ./myfile.txt`
- `cp` validates both source and destination paths
- `mv` validates both source and destination paths
- Output redirection validates target path: `echo x > /etc/cron`
- Non-Bash tool calls pass through unchanged (returns `{}`)
- Empty command returns `{}`
- Unparseable command blocked (fail-safe)

**Step 2: Run tests to verify they fail**

**Step 3: Implement bash-hook.ts**

```typescript
export async function bashSecurityHook(
  input: { tool_name: string; tool_input: Record<string, unknown> },
  toolUseId: string | undefined,
  context: { signal: AbortSignal; workspaceDir: string; config: Config }
): Promise<Record<string, unknown>>
```

Combines command extraction + allowlist validation + path validation. Returns `{}` to allow or `{ decision: "block", reason: "..." }` to block.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/security/bash-hook.ts src/security/bash-hook.test.ts
git commit -m "feat: PreToolUse bash security hook"
```

---

## Phase 3: Memory System

### Task 8: Memory File Reader

**Files:**
- Create: `src/memory/files.ts`
- Create: `src/memory/files.test.ts`

**Step 1: Write failing tests**

Test cases:
- `readMemoryFiles(workspaceDir)` returns concatenated content of AGENTS.md + SOUL.md + USER.md + MEMORY.md
- `readMemoryFiles(workspaceDir, { includeHeartbeat: true })` also includes HEARTBEAT.md
- Missing files are skipped gracefully (no error)
- Files separated by `\n\n---\n\n`
- `readMemoryFile(workspaceDir, "AGENTS.md")` reads single file

**Step 2: Run tests to verify they fail**

**Step 3: Implement files.ts**

- `readMemoryFiles(workspaceDir: string, options?: { includeHeartbeat?: boolean }): Promise<string>`
- `readMemoryFile(workspaceDir: string, filename: string): Promise<string | null>`

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/memory/files.ts src/memory/files.test.ts
git commit -m "feat: memory file reader for system prompt construction"
```

---

### Task 9: Daily Session Logs

**Files:**
- Create: `src/memory/daily-log.ts`
- Create: `src/memory/daily-log.test.ts`

**Step 1: Write failing tests**

Test cases:
- `appendDailyLog(workspaceDir, entry)` creates `daily/YYYY-MM-DD.md` if missing
- Appends entry with timestamp, source, user message, assistant response
- Multiple appends go to same file on same day
- Next day creates new file

**Step 2: Run tests, verify fail**

**Step 3: Implement daily-log.ts**

- `appendDailyLog(workspaceDir: string, entry: { source: string, userMessage: string, assistantResponse: string }): Promise<void>`
- Format: `## HH:MM - {source}\n**User:** {msg}\n**Assistant:** {response}\n\n`

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/memory/daily-log.ts src/memory/daily-log.test.ts
git commit -m "feat: daily session log appender"
```

---

### Task 10: Embeddings (node-llama-cpp)

**Files:**
- Create: `src/memory/embeddings.ts`
- Create: `src/memory/embeddings.test.ts`

**Step 1: Write failing tests**

Test cases:
- `createEmbeddingProvider()` initializes node-llama-cpp with EmbeddingGemma-300M
- `embed(text)` returns a Float32Array of expected dimensions
- `embedBatch(texts)` returns array of embeddings
- Embeddings are L2-normalized (magnitude ~1.0)
- Empty text returns zero vector or throws

**Step 2: Run tests, verify fail**

Note: These tests will need the GGUF model file. For CI, mock the embedding provider. For local, the model auto-downloads from Hugging Face on first use.

**Step 3: Implement embeddings.ts**

```typescript
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  dimensions: number;
  close(): Promise<void>;
}

export async function createEmbeddingProvider(): Promise<EmbeddingProvider>
```

Uses node-llama-cpp to load `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf`. Lazy initialization (download on first use). L2-normalize all outputs.

Reference: `/home/radek/dev/openclaw/src/memory/embeddings.ts` lines 82-128 for the node-llama-cpp pattern.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/memory/embeddings.ts src/memory/embeddings.test.ts
git commit -m "feat: local embeddings with node-llama-cpp and EmbeddingGemma-300M"
```

---

### Task 11: Vector Store (SQLite-vec + FTS5)

**Files:**
- Create: `src/memory/vector-store.ts`
- Create: `src/memory/vector-store.test.ts`

**Step 1: Write failing tests**

Test cases:
- `createVectorStore(dbPath, dimensions)` creates SQLite database with tables
- `upsertChunk(id, text, embedding, metadata)` inserts chunk
- `searchVector(queryEmbedding, limit)` returns results sorted by cosine similarity
- `searchKeyword(query, limit)` returns results sorted by BM25 rank
- Duplicate chunk IDs update existing record
- `deleteChunksForFile(path)` removes all chunks for a given source file
- `getFileHash(path)` returns stored hash for a file
- Database created at specified path

**Step 2: Run tests, verify fail**

**Step 3: Implement vector-store.ts**

Tables:
- `chunks` (id TEXT PK, path TEXT, text TEXT, embedding BLOB, start_line INT, end_line INT, hash TEXT, model TEXT, updated_at TEXT)
- `chunks_vec` (virtual, vec0, embedding FLOAT[N]) - sqlite-vec
- `chunks_fts` (virtual, FTS5, text) - for BM25
- `files` (path TEXT PK, hash TEXT, mtime INT, size INT)

Reference: `/home/radek/dev/openclaw/src/memory/manager.ts` for table schemas and query patterns.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/memory/vector-store.ts src/memory/vector-store.test.ts
git commit -m "feat: vector store with sqlite-vec and FTS5"
```

---

### Task 12: Content Indexer (Chunking & Sync)

**Files:**
- Create: `src/memory/indexer.ts`
- Create: `src/memory/indexer.test.ts`

**Step 1: Write failing tests**

Test cases:
- `chunkText(text, { tokens: 400, overlap: 80 })` splits into chunks with overlap
- Chunks preserve line numbers (startLine, endLine)
- Short text returns single chunk
- `syncFiles(workspaceDir, vectorStore, embeddingProvider)` indexes MEMORY.md + memory/*.md
- Only re-indexes files whose hash changed since last sync
- Removes chunks for deleted files
- Respects `extraPaths` config
- `isDirty` flag set when files change

**Step 2: Run tests, verify fail**

**Step 3: Implement indexer.ts**

- `chunkText(text: string, options: { tokens: number, overlap: number }): Chunk[]`
- `syncFiles(workspaceDir: string, store: VectorStore, embedder: EmbeddingProvider, config: MemoryConfig): Promise<void>`
- `createFileWatcher(workspaceDir: string, onChange: () => void): FSWatcher` - debounced 1.5s
- `Indexer` class that manages dirty state, sync, and file watching

Reference: `/home/radek/dev/openclaw/src/memory/manager.ts` lines 166-247 for chunking, and the sync logic.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/memory/indexer.ts src/memory/indexer.test.ts
git commit -m "feat: content indexer with chunking and file watching"
```

---

### Task 13: Hybrid Search

**Files:**
- Create: `src/memory/hybrid-search.ts`
- Create: `src/memory/hybrid-search.test.ts`

**Step 1: Write failing tests**

Test cases:
- `hybridSearch(query, store, embedder, config)` returns merged results
- Vector-only results scored at 0.7x weight
- Keyword-only results scored at 0.3x weight
- Results appearing in both get combined score
- Results below `minScore` (0.35) filtered out
- Returns max `maxResults` (6) results sorted by score descending
- BM25 rank correctly normalized to 0-1 range

**Step 2: Run tests, verify fail**

**Step 3: Implement hybrid-search.ts**

```typescript
export async function hybridSearch(
  query: string,
  store: VectorStore,
  embedder: EmbeddingProvider,
  config: { vectorWeight: number, keywordWeight: number, minScore: number, maxResults: number }
): Promise<SearchResult[]>
```

Reference: `/home/radek/dev/openclaw/src/memory/hybrid.ts` lines 41-115 for merge logic.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/memory/hybrid-search.ts src/memory/hybrid-search.test.ts
git commit -m "feat: hybrid search combining vector and BM25"
```

---

### Task 14: Memory Search MCP Server

**Files:**
- Create: `src/tools/memory-server.ts`
- Create: `src/tools/memory-server.test.ts`

**Step 1: Write failing tests**

Test cases:
- `createMemoryServer()` returns an SDK MCP server instance
- Server exposes `memory_search` tool
- Tool accepts `query` (required) and `maxResults` (optional) params
- Tool returns JSON with results array containing path, snippet, startLine, endLine

**Step 2: Run tests, verify fail**

**Step 3: Implement memory-server.ts**

```typescript
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export function createMemoryServer(deps: {
  search: (query: string, maxResults?: number) => Promise<SearchResult[]>
}) {
  return createSdkMcpServer({
    name: "memory",
    version: "1.0.0",
    tools: [
      tool("memory_search", "Search long-term memory for past decisions, preferences, and context", {
        query: z.string().describe("Search query"),
        maxResults: z.number().optional().describe("Max results (default 6)")
      }, async (args) => {
        const results = await deps.search(args.query, args.maxResults);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      })
    ]
  });
}
```

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/tools/memory-server.ts src/tools/memory-server.test.ts
git commit -m "feat: memory_search SDK MCP server tool"
```

---

## Phase 4: Agent Runner & Terminal

### Task 15: Agent Runner

**Files:**
- Create: `src/core/agent-runner.ts`
- Create: `src/core/agent-runner.test.ts`

**Step 1: Write failing tests**

Test cases:
- `buildAgentOptions(config, workspaceDir, memoryContent, mcpServers)` returns valid Options object
- System prompt uses `preset: "claude_code"` with `append: memoryContent`
- `cwd` set to workspace directory
- Security hook registered as PreToolUse hook for Bash
- `allowedTools` includes standard tools from design
- MCP servers include memory + assistant + user-configured
- `settingSources` includes `["project"]` for skills
- Sandbox enabled with `autoAllowBashIfSandboxed: true`

**Step 2: Run tests, verify fail**

**Step 3: Implement agent-runner.ts**

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

export function buildAgentOptions(
  config: Config,
  workspaceDir: string,
  memoryContent: string,
  mcpServers: Record<string, unknown>
): Options

export async function* runAgent(
  message: string,
  options: Options
): AsyncGenerator<AgentMessage>
```

The `runAgent` function wraps `query()` and yields streaming messages. It handles the async generator from the SDK.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/core/agent-runner.ts src/core/agent-runner.test.ts
git commit -m "feat: agent runner with SDK integration"
```

---

### Task 16: Terminal Mode

**Files:**
- Create: `src/terminal.ts`
- Create: `src/terminal.test.ts`

**Step 1: Write failing tests**

Test cases:
- Terminal startup calls `loadConfig()` and `ensureWorkspace()`
- Reads memory files for system prompt
- Sends user input to agent runner
- Streams agent response to stdout
- Appends interaction to daily log
- Handles Ctrl+C gracefully (closes readline, exits)

**Step 2: Run tests, verify fail**

**Step 3: Implement terminal.ts**

```typescript
async function main() {
  const config = loadConfig(resolveAppDir());
  await ensureWorkspace(config);

  const memoryContent = await readMemoryFiles(config.security.workspace);
  const memoryServer = createMemoryServer({ search: ... });
  const options = buildAgentOptions(config, config.security.workspace, memoryContent, {
    memory: { type: "sdk", instance: memoryServer },
    ...config.mcpServers
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("You> ");
  rl.prompt();

  rl.on("line", async (input) => {
    for await (const msg of runAgent(input, options)) {
      // Stream to stdout
    }
    rl.prompt();
  });

  rl.on("close", () => process.exit(0));
}
```

**Step 4: Manual test - run terminal**

Run: `npm run terminal`
Type a message, verify agent responds. Ctrl+C to exit.

**Step 5: Commit**

```bash
git add src/terminal.ts src/terminal.test.ts
git commit -m "feat: standalone terminal mode"
```

---

## Phase 5: Heartbeat & System Events

### Task 17: System Event Queue

**Files:**
- Create: `src/heartbeat/system-events.ts`
- Create: `src/heartbeat/system-events.test.ts`

**Step 1: Write failing tests**

Test cases:
- `enqueueSystemEvent(text, sessionKey)` adds event
- `peekSystemEvents(sessionKey)` returns events without draining
- `drainSystemEvents(sessionKey)` returns and clears events
- Max 20 events (FIFO - oldest dropped when full)
- Different session keys have separate queues
- Empty queue returns empty array

**Step 2: Run tests, verify fail**

**Step 3: Implement system-events.ts**

In-memory Map<string, SystemEvent[]> with max 20 entries per key.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/heartbeat/system-events.ts src/heartbeat/system-events.test.ts
git commit -m "feat: in-memory system event queue"
```

---

### Task 18: Heartbeat Prompts

**Files:**
- Create: `src/heartbeat/prompts.ts`
- Create: `src/heartbeat/prompts.test.ts`

**Step 1: Write failing tests**

Test cases:
- `resolveHeartbeatPrompt(events)` returns standard prompt when no events
- Returns EXEC_EVENT_PROMPT when exec completion event present
- Returns CRON_EVENT_PROMPT with event text when cron event present
- Standard prompt includes current time and timezone
- `isHeartbeatOk(response)` detects "HEARTBEAT_OK" variants

**Step 2: Run tests, verify fail**

**Step 3: Implement prompts.ts**

Three prompt constants + `resolveHeartbeatPrompt()` + `isHeartbeatOk()`. Reference OpenClaw at `/home/radek/dev/openclaw/src/auto-reply/heartbeat.ts`.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/heartbeat/prompts.ts src/heartbeat/prompts.test.ts
git commit -m "feat: heartbeat prompt resolution"
```

---

### Task 19: Heartbeat Scheduler

**Files:**
- Create: `src/heartbeat/scheduler.ts`
- Create: `src/heartbeat/scheduler.test.ts`

**Step 1: Write failing tests**

Test cases:
- `createHeartbeatScheduler(config, onHeartbeat)` starts cron timer
- Fires at configured interval
- Skips when outside active hours (parse "8-21" format)
- `isWithinActiveHours("8-21")` returns correct boolean based on current hour
- `stop()` cancels the timer
- Calls `onHeartbeat()` callback when firing

**Step 2: Run tests, verify fail**

**Step 3: Implement scheduler.ts**

Uses `node-cron` for interval-based scheduling. Checks active hours before each invocation. Calls callback which will enqueue a heartbeat message to the gateway queue.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/heartbeat/scheduler.ts src/heartbeat/scheduler.test.ts
git commit -m "feat: heartbeat scheduler with active hours"
```

---

## Phase 6: Cron & Exec Tools

### Task 20: Cron Types & Store

**Files:**
- Create: `src/cron/types.ts`
- Create: `src/cron/store.ts`
- Create: `src/cron/store.test.ts`

**Step 1: Write failing tests**

Test cases:
- `loadCronStore(path)` reads and parses jobs.json
- Returns empty jobs array if file doesn't exist
- `saveCronStore(path, store)` writes atomically (tmp + rename)
- Round-trips correctly (save then load)
- Handles corrupt file gracefully (returns empty)

**Step 2: Run tests, verify fail**

**Step 3: Implement types.ts and store.ts**

Types from design: `CronSchedule` (at/every/cron), `CronPayload` (systemEvent/agentTurn), `CronDelivery`, `CronJob`, `CronJobState`.

Store: atomic write with tmp file + `fs.rename()` + `.bak` backup.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/cron/types.ts src/cron/store.ts src/cron/store.test.ts
git commit -m "feat: cron job types and persistent store"
```

---

### Task 21: Cron Timer

**Files:**
- Create: `src/cron/timer.ts`
- Create: `src/cron/timer.test.ts`

**Step 1: Write failing tests**

Test cases:
- `nextRunAt(job)` calculates correct next fire time for each schedule kind
- Cron expression `"0 9 * * 1-5"` fires at 9 AM weekdays
- One-shot `{ kind: "at", at: "..." }` fires at specified time
- Interval `{ kind: "every", everyMs: 60000 }` fires every minute
- `armTimer(jobs, onFire)` sets timeout for next due job
- Fires correct job when timer expires
- One-shot jobs with `deleteAfterRun` removed after firing
- Error backoff (exponential) on job failure

**Step 2: Run tests, verify fail**

**Step 3: Implement timer.ts**

Reference: `/home/radek/dev/openclaw/src/cron/service/timer.ts` for the timer pattern.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/cron/timer.ts src/cron/timer.test.ts
git commit -m "feat: cron job timer and scheduling"
```

---

### Task 22: Cron Tool (SDK MCP Server)

**Files:**
- Create: `src/cron/tool.ts`
- Create: `src/cron/tool.test.ts`

**Step 1: Write failing tests**

Test cases:
- `add` action creates a new job and persists it
- `list` action returns all jobs
- `update` action modifies an existing job
- `remove` action deletes a job
- Invalid job (missing name/schedule) returns error
- Job IDs are unique UUIDs

**Step 2: Run tests, verify fail**

**Step 3: Implement tool.ts**

Tool definition using `createSdkMcpServer` + `tool()`. Actions: add, list, update, remove. Each action validates input, updates store, re-arms timer.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/cron/tool.ts src/cron/tool.test.ts
git commit -m "feat: cron management tool for agent"
```

---

### Task 23: Exec Tool & Process Registry

**Files:**
- Create: `src/exec/types.ts`
- Create: `src/exec/process-registry.ts`
- Create: `src/exec/process-registry.test.ts`
- Create: `src/exec/tool.ts`
- Create: `src/exec/tool.test.ts`

**Step 1: Write failing tests for process registry**

Test cases:
- `addSession(session)` registers a process
- `getSession(id)` retrieves by ID
- `markExited(session, exitCode, signal)` updates state
- Sessions auto-cleaned after 30 minutes TTL
- `listSessions()` returns all active sessions

**Step 2: Write failing tests for exec tool**

Test cases:
- Exec spawns child process with given command
- **Command validated against allowlist** (blocked command returns error)
- **Paths validated against workspace** (command writing outside workspace blocked)
- `background: true` returns immediately with session ID
- `yieldMs: 5000` waits 5s then returns if still running
- Process exit enqueues system event
- Process exit triggers heartbeat wake
- `process` action `status` returns current state of background process

**Step 3: Run all tests, verify fail**

**Step 4: Implement types.ts, process-registry.ts, tool.ts**

Process registry: in-memory Map, sweeper interval for TTL cleanup.

Exec tool: spawns child_process, manages background state, integrates with system event queue.

Reference: `/home/radek/dev/openclaw/src/agents/bash-tools.exec.ts` and `/home/radek/dev/openclaw/src/agents/bash-process-registry.ts`.

**Step 5: Run tests, verify pass**

**Step 6: Commit**

```bash
git add src/exec/
git commit -m "feat: exec tool with background execution and process registry"
```

---

### Task 24: Assistant MCP Server (Cron + Exec + Process)

**Files:**
- Create: `src/tools/assistant-server.ts`
- Create: `src/tools/assistant-server.test.ts`

**Step 1: Write failing tests**

Test cases:
- `createAssistantServer(deps)` returns SDK MCP server
- Server exposes `cron`, `exec`, and `process` tools
- Each tool delegates to its respective module

**Step 2: Run tests, verify fail**

**Step 3: Implement assistant-server.ts**

Combines cron tool + exec tool + process tool into a single SDK MCP server using `createSdkMcpServer()`.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/tools/assistant-server.ts src/tools/assistant-server.test.ts
git commit -m "feat: assistant SDK MCP server combining cron, exec, process tools"
```

---

## Phase 7: Gateway & Adapters

### Task 25: Gateway Queue & Router

**Files:**
- Create: `src/gateway/queue.ts`
- Create: `src/gateway/router.ts`
- Create: `src/gateway/queue.test.ts`

**Step 1: Write failing tests**

Test cases:
- `enqueue(message)` adds message to queue, returns `{ accepted: true }`
- Queue at max size rejects with `{ accepted: false }`
- `processNext()` dequeues and processes one message via agent runner
- Messages processed in FIFO order
- Only one message processed at a time (serial)
- Router delivers response back to source adapter
- Router handles unknown adapter gracefully (logs warning)

**Step 2: Run tests, verify fail**

**Step 3: Implement queue.ts and router.ts**

Queue: async FIFO with configurable maxSize. `processLoop()` runs continuously, awaiting next message.

Router: Map of adapter name → adapter instance. `route(response)` looks up adapter by source and calls `sendResponse()`.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/gateway/queue.ts src/gateway/router.ts src/gateway/queue.test.ts
git commit -m "feat: gateway message queue and response router"
```

---

### Task 26: Adapter Types & Interface

**Files:**
- Create: `src/adapters/types.ts`

**Step 1: Implement adapter interface**

Already defined in `src/core/types.ts` but create the adapter-specific types file with:
- `AdapterMessage` (source, sourceId, text, metadata with userName, threadId, attachments)
- Helper functions for creating messages from different adapter formats

**Step 2: Commit**

```bash
git add src/adapters/types.ts
git commit -m "feat: adapter type definitions"
```

---

### Task 27: Telegram Adapter

**Files:**
- Create: `src/adapters/telegram.ts`
- Create: `src/adapters/telegram.test.ts`

**Step 1: Write failing tests**

Test cases:
- `createTelegramAdapter(config, onMessage)` creates adapter
- Filters messages by `allowedUserIds`
- Converts Grammy context to `AdapterMessage`
- `sendResponse()` sends text back via bot API
- Long messages chunked at 4096 chars
- `start()` begins polling, `stop()` stops bot

**Step 2: Run tests, verify fail**

**Step 3: Implement telegram.ts**

Uses Grammy library. Polling mode by default. Message handler extracts text, filters by user ID, creates `AdapterMessage`, calls `onMessage` callback (which enqueues to gateway).

Reference: `/home/radek/dev/openclaw/src/telegram/bot.ts` for Grammy patterns.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/adapters/telegram.ts src/adapters/telegram.test.ts
git commit -m "feat: Telegram adapter with Grammy"
```

---

### Task 28: Slack Adapter

**Files:**
- Create: `src/adapters/slack.ts`
- Create: `src/adapters/slack.test.ts`

**Step 1: Write failing tests**

Test cases:
- `createSlackAdapter(config, onMessage)` creates adapter
- Converts Slack event to `AdapterMessage` with thread support
- `sendResponse()` replies in correct thread
- `start()` connects via socket mode, `stop()` disconnects
- Ignores bot's own messages

**Step 2: Run tests, verify fail**

**Step 3: Implement slack.ts**

Uses @slack/bolt in Socket Mode. Message handler extracts text + thread_ts, creates `AdapterMessage`, calls `onMessage`.

Reference: `/home/radek/dev/openclaw/src/slack/` for Bolt.js patterns.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/adapters/slack.ts src/adapters/slack.test.ts
git commit -m "feat: Slack adapter with Bolt.js socket mode"
```

---

## Phase 8: Daemon Mode & Integration

### Task 29: Daemon Mode

**Files:**
- Create: `src/daemon.ts`
- Create: `src/daemon.test.ts`

**Step 1: Write failing tests**

Test cases:
- Daemon startup initializes config, workspace, queue, router
- Starts enabled adapters only (skips disabled)
- Starts heartbeat scheduler if enabled
- Loads persisted cron jobs and arms timer
- SIGTERM triggers graceful shutdown (stop adapters, wait for current turn, close DB)
- SIGINT triggers graceful shutdown

**Step 2: Run tests, verify fail**

**Step 3: Implement daemon.ts**

```typescript
async function main() {
  const config = loadConfig(resolveAppDir());
  await ensureWorkspace(config);

  // Initialize memory
  const indexer = await createIndexer(config);
  await indexer.sync();

  // Create MCP servers
  const memoryServer = createMemoryServer({ search: ... });
  const assistantServer = createAssistantServer({ ... });

  // Build agent options
  const memoryContent = await readMemoryFiles(config.security.workspace);
  const agentOptions = buildAgentOptions(config, ...);

  // Create gateway
  const queue = createMessageQueue(config.gateway.maxQueueSize);
  const router = createRouter();

  // Start adapters
  if (config.adapters.telegram.enabled) {
    const telegram = createTelegramAdapter(config, (msg) => queue.enqueue(msg));
    router.register("telegram", telegram);
    await telegram.start();
  }
  if (config.adapters.slack.enabled) {
    const slack = createSlackAdapter(config, (msg) => queue.enqueue(msg));
    router.register("slack", slack);
    await slack.start();
  }

  // Start heartbeat
  const heartbeat = createHeartbeatScheduler(config, (msg) => queue.enqueue(msg));

  // Load cron jobs
  const cronStore = await loadCronStore(config);
  armCronTimer(cronStore, ...);

  // Process queue loop
  queue.processLoop(async (msg) => {
    const response = await runAgentTurn(msg, agentOptions);
    await router.route(response);
    await appendDailyLog(config.security.workspace, ...);
  });

  // Graceful shutdown
  const shutdown = async () => { /* stop all, close DB, exit */ };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
```

**Step 4: Manual test**

Run: `npm run daemon`
Send a Telegram message (if configured), verify response.
Wait for heartbeat interval, verify it fires.

**Step 5: Commit**

```bash
git add src/daemon.ts src/daemon.test.ts
git commit -m "feat: daemon mode with gateway, adapters, and heartbeat"
```

---

## Phase 9: Documentation & Polish

### Task 30: Workspace Templates (Final Content)

**Files:**
- Modify: `src/templates/AGENTS.md`
- Modify: `src/templates/SOUL.md`
- Modify: `src/templates/USER.md`
- Modify: `src/templates/MEMORY.md`
- Modify: `src/templates/HEARTBEAT.md`

Write meaningful default content for each template:
- **AGENTS.md**: Agent behavior rules, available tools (memory_search, cron, exec, process), skill-creator instructions
- **SOUL.md**: Personality placeholder for user to customize
- **USER.md**: User profile placeholder
- **MEMORY.md**: Empty with instructions on what to store here
- **HEARTBEAT.md**: Example checks (calendar, messages, reminders)

Reference: `/home/radek/dev/openclaw/docs/reference/templates/` for tone and structure.

**Commit:**
```bash
git add src/templates/
git commit -m "feat: workspace template content"
```

---

### Task 31: README Documentation

**Files:**
- Create: `README.md`

Write concise documentation covering:
- What it is
- Prerequisites (Node.js 22+, Claude Code CLI authenticated)
- Installation (`git clone`, `npm install`)
- Quick start (`npm run terminal`)
- Configuration (`settings.json` reference)
- Workspace files (what each markdown file does)
- Daemon mode setup (Telegram bot token, Slack app token)
- Heartbeat configuration
- Skills (how to add)
- MCP servers (how to configure)
- Security model (3 layers)

Keep it practical, not exhaustive.

**Commit:**
```bash
git add README.md
git commit -m "docs: README with installation and configuration guide"
```

---

### Task 32: Integration Tests

**Files:**
- Create: `src/integration.test.ts`

End-to-end tests (may need mocking for SDK):
- Config → workspace → memory files → agent options (verify full pipeline)
- Security hook blocks dangerous command in full pipeline
- Hybrid search returns results for indexed content
- Queue processes messages in order
- System events flow from enqueue → heartbeat → prompt resolution

**Commit:**
```bash
git add src/integration.test.ts
git commit -m "test: integration tests for core pipeline"
```

---

## Phase 10: Session Management

### Task 33: Session Types & JSONL Store

**Files:**
- Create: `src/session/types.ts`
- Create: `src/session/store.ts`
- Create: `src/session/store.test.ts`

**Step 1: Write failing tests for JSONL store**

Test cases:
- `appendMessage(sessionPath, message)` appends one JSON line to file
- Creates file if missing
- `loadTranscript(sessionPath)` reads all messages from JSONL
- Returns empty array for non-existent file
- Handles corrupt lines gracefully (skip, log warning)
- Messages have: `role`, `content`, `timestamp`, optional `toolName`, `error`
- `rewriteTranscript(sessionPath, messages)` atomically replaces file content (tmp + rename)
- Creates `.bak` backup before rewrite

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/session/store.test.ts`

**Step 3: Implement types.ts and store.ts**

```typescript
// types.ts
export interface SessionMessage {
  role: "user" | "assistant" | "tool_use" | "tool_result";
  content: string | ContentBlock[];
  timestamp: string; // ISO-8601
  toolName?: string;
  error?: string;
}

export interface CompactionEntry {
  type: "compaction";
  timestamp: string;
  messagesBefore: number;
  messagesAfter: number;
}

export type TranscriptLine = SessionMessage | CompactionEntry;

export function sessionKeyToPath(dataDir: string, sessionKey: string): string {
  return path.join(dataDir, "sessions", `${sessionKey}.jsonl`);
}
```

```typescript
// store.ts
export async function appendMessage(sessionPath: string, message: SessionMessage): Promise<void>
export async function appendMessages(sessionPath: string, messages: SessionMessage[]): Promise<void>
export async function loadTranscript(sessionPath: string): Promise<SessionMessage[]>
export async function rewriteTranscript(sessionPath: string, messages: SessionMessage[]): Promise<void>
```

Atomic rewrite: write to `${path}.tmp`, rename over original. Backup to `${path}.bak` before rewrite.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/session/types.ts src/session/store.ts src/session/store.test.ts
git commit -m "feat: session JSONL transcript store"
```

---

### Task 34: Session Manager

**Files:**
- Create: `src/session/manager.ts`
- Create: `src/session/manager.test.ts`

**Step 1: Write failing tests**

Test cases:
- `resolveSessionKey(source, sourceId, threadId?)` returns correct key format:
  - Terminal: `terminal--default`
  - Telegram: `telegram--{userId}`
  - Slack: `slack--{channelId}--{threadTs}`
- `loadHistory(sessionKey, config)` loads transcript and returns sanitized messages
- Sanitizes: strips large `details` fields from tool results
- Truncates: returns only last `maxHistoryMessages` messages
- `saveInteraction(sessionKey, messages)` appends all messages from one agent turn
- Handles non-existent session (returns empty history)
- Creates sessions directory if missing

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/session/manager.test.ts`

**Step 3: Implement manager.ts**

```typescript
export function resolveSessionKey(source: string, sourceId: string, threadId?: string): string

export async function loadHistory(
  sessionKey: string,
  config: Config
): Promise<SessionMessage[]>

export async function saveInteraction(
  sessionKey: string,
  messages: SessionMessage[],
  config: Config
): Promise<void>
```

`loadHistory` flow:
1. Resolve session key to file path
2. Load JSONL transcript
3. Filter to `SessionMessage` entries (skip compaction entries)
4. Sanitize: strip large tool result details
5. Truncate to last `maxHistoryMessages`
6. Return messages array ready for SDK injection

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/session/manager.ts src/session/manager.test.ts
git commit -m "feat: session manager with history loading and key routing"
```

---

### Task 35: History Compaction

**Files:**
- Create: `src/session/compactor.ts`
- Create: `src/session/compactor.test.ts`

**Step 1: Write failing tests**

Test cases:
- `compactIfNeeded(sessionPath, threshold)` does nothing when under threshold
- Compacts when over threshold: keeps last `threshold` messages, removes older ones
- Creates `.bak` archive before rewriting
- Appends compaction metadata entry with `messagesBefore` and `messagesAfter`
- `compactIfNeeded` returns `{ compacted: boolean, messagesBefore?: number, messagesAfter?: number }`
- Preserves message order after compaction
- Handles empty transcript (no-op)

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/session/compactor.test.ts`

**Step 3: Implement compactor.ts**

```typescript
export async function compactIfNeeded(
  sessionPath: string,
  threshold: number
): Promise<{ compacted: boolean; messagesBefore?: number; messagesAfter?: number }>
```

Flow:
1. Load transcript
2. Count messages (excluding compaction entries)
3. If under threshold, return `{ compacted: false }`
4. Keep last `threshold` messages
5. Archive full transcript as `.bak`
6. Rewrite with kept messages + compaction metadata entry
7. Return stats

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/session/compactor.ts src/session/compactor.test.ts
git commit -m "feat: session history compaction"
```

---

### Task 36: Audit Log (Enhanced Daily Log)

**Files:**
- Modify: `src/memory/daily-log.ts` (from Task 9)
- Modify: `src/memory/daily-log.test.ts`

**Step 1: Write failing tests for enhanced audit log**

Test cases:
- `appendAuditEntry(workspaceDir, entry)` creates `daily/YYYY-MM-DD.jsonl` if missing
- Appends JSONL entry with: timestamp, source, sessionKey, type
- Type `"interaction"`: userMessage, assistantResponse
- Type `"tool_call"`: toolName, toolInput, toolResult, durationMs
- Type `"error"`: errorMessage, stack, context
- Multiple entries on same day go to same file
- Next day creates new file
- Format is JSONL (one JSON per line), NOT markdown

**Step 2: Run tests to verify they fail**

**Step 3: Implement enhanced daily-log.ts**

```typescript
export interface AuditEntry {
  timestamp: string;
  source: string;
  sessionKey: string;
  type: "interaction" | "tool_call" | "error";
  // Interaction fields
  userMessage?: string;
  assistantResponse?: string;
  // Tool call fields
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  durationMs?: number;
  // Error fields
  errorMessage?: string;
  stack?: string;
  context?: string;
}

export async function appendAuditEntry(workspaceDir: string, entry: AuditEntry): Promise<void>
```

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add src/memory/daily-log.ts src/memory/daily-log.test.ts
git commit -m "feat: JSONL audit log with tool calls and errors"
```

---

### Task 37: Session Integration with Agent Runner

**Files:**
- Modify: `src/core/agent-runner.ts` (from Task 15)
- Modify: `src/core/agent-runner.test.ts`

**Step 1: Write failing tests for session-aware agent runner**

Test cases:
- `runAgentTurn(message, sessionKey, options, config)` loads history before query
- Passes loaded history as messages to SDK query
- After agent turn, saves all new messages to session transcript
- After agent turn, appends audit entries (interaction + tool calls)
- Calls compaction check after saving
- Empty history (new session) works correctly
- Agent runner returns response text + all messages for audit logging

**Step 2: Run tests to verify they fail**

**Step 3: Update agent-runner.ts**

Update `runAgent` to accept session key and config, integrate with session manager:

```typescript
export async function runAgentTurn(
  message: string,
  sessionKey: string,
  options: AgentOptions,
  config: Config
): Promise<AgentTurnResult> {
  // 1. Load session history
  const history = await loadHistory(sessionKey, config);

  // 2. Run SDK query with history
  const result = await query({
    prompt: message,
    options: { ...options, messages: history }
  });

  // 3. Collect all messages from this turn (user + assistant + tool calls)
  const turnMessages = collectTurnMessages(message, result);

  // 4. Save to session transcript
  await saveInteraction(sessionKey, turnMessages, config);

  // 5. Compact if needed
  const sessionPath = sessionKeyToPath(config.security.dataDir, sessionKey);
  await compactIfNeeded(sessionPath, config.session.maxHistoryMessages);

  // 6. Append audit entries
  await appendAuditEntries(config.security.workspace, sessionKey, turnMessages);

  return { response: extractResponse(result), messages: turnMessages };
}
```

**Step 4: Run tests, verify pass**

**Step 5: Update terminal.ts and daemon.ts to use session-aware agent runner**

Terminal uses session key `terminal--default`. Daemon derives session key from `AdapterMessage.source` and `AdapterMessage.sourceId`.

**Step 6: Commit**

```bash
git add src/core/agent-runner.ts src/core/agent-runner.test.ts src/terminal.ts src/daemon.ts
git commit -m "feat: session-aware agent runner with history and audit logging"
```

---

## Task Dependency Graph

```
Phase 1: Foundation
  Task 1 (setup) → Task 2 (config) → Task 3 (logger) → Task 4 (workspace)

Phase 2: Security
  Task 2 → Task 5 (path validator) → Task 6 (command validation) → Task 7 (bash hook)

Phase 3: Memory
  Task 4 → Task 8 (file reader) → Task 9 (daily log/audit)
  Task 8 → Task 10 (embeddings) → Task 11 (vector store) → Task 12 (indexer) → Task 13 (hybrid search) → Task 14 (memory MCP server)

Phase 4: Agent & Terminal
  Task 7 + Task 8 + Task 14 + Task 37 → Task 15 (agent runner) → Task 16 (terminal)

Phase 5: Heartbeat
  Task 15 → Task 17 (system events) → Task 18 (prompts) → Task 19 (scheduler)

Phase 6: Cron & Exec
  Task 17 → Task 20 (cron store) → Task 21 (cron timer) → Task 22 (cron tool)
  Task 17 → Task 23 (exec tool)
  Task 22 + Task 23 → Task 24 (assistant MCP server)

Phase 7: Adapters
  Task 15 → Task 25 (queue + router) → Task 26 (adapter types) → Task 27 (telegram) → Task 28 (slack)

Phase 8: Daemon
  Task 19 + Task 24 + Task 25 + Task 27 + Task 28 → Task 29 (daemon)

Phase 9: Polish
  Task 29 → Task 30 (templates) → Task 31 (README) → Task 32 (integration tests)

Phase 10: Session Management (can run in parallel with Phases 2-3)
  Task 2 → Task 33 (session store) → Task 34 (session manager) → Task 35 (compaction)
  Task 9 → Task 36 (audit log enhancement) — updates daily-log to JSONL with tool calls
  Task 34 + Task 36 → Task 37 (session integration) — updates agent runner, terminal, daemon
```

**Note:** Phase 10 tasks should ideally be implemented **before** Phase 4 (Agent Runner), as the agent runner depends on session management (Task 37). The phase numbering reflects when they were added to the plan, not execution order.

## Parallel Execution Opportunities

These tasks can run in parallel within their phase:
- Tasks 5, 8 (security + memory files - independent)
- Tasks 10, 9 (embeddings + daily log - independent)
- Tasks 27, 28 (telegram + slack - independent)
- Tasks 20-22, 23 (cron + exec - independent, share system events)
- Tasks 33, 36 (session store + audit log - independent, both from Phase 10)
