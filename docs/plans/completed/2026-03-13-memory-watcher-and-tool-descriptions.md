# Memory File Watcher + Stdio Tool Description Parity

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix memory reindexing so file changes are picked up live (not just at startup), and bring Codex stdio MCP server tool descriptions to parity with the Claude SDK definitions.

**Architecture:** Two independent fixes: (1) Add a `createMemoryWatcher()` that uses `node:fs.watch` to monitor workspace memory files (`MEMORY.md` + `memory/**/*.md`) and triggers reindexing on changes with debounce. Integrate into daemon, terminal session, and CLI mcp-server. (2) Copy the rich tool descriptions from `assistant-server.ts` into `stdio-mcp-server.ts` so Codex agents get the same documentation.

**Tech Stack:** Node.js `fs.watch` (recursive), existing indexer `syncFiles`, vitest for tests.

---

## Chunk 1: Memory File Watcher

### Task 1: Create `collectMemoryFiles` helper

Extract the duplicated memoryFiles logic from daemon.ts, session.ts, and cli.ts into a shared helper.

**Files:**
- Create: `src/memory/collect-files.ts`
- Create: `src/memory/collect-files.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// src/memory/collect-files.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { collectMemoryFiles } from "./collect-files.js";

describe("collectMemoryFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collect-mem-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("always includes MEMORY.md", () => {
    fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "index");
    const files = collectMemoryFiles(tmpDir, []);
    expect(files).toContain(path.join(tmpDir, "MEMORY.md"));
  });

  it("discovers .md files in memory/ subdirectory", () => {
    fs.mkdirSync(path.join(tmpDir, "memory"));
    fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "index");
    fs.writeFileSync(path.join(tmpDir, "memory", "note.md"), "note");
    const files = collectMemoryFiles(tmpDir, []);
    expect(files).toContain(path.join(tmpDir, "memory", "note.md"));
  });

  it("includes extraPaths resolved relative to workspace", () => {
    fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "index");
    fs.writeFileSync(path.join(tmpDir, "extra.md"), "extra");
    const files = collectMemoryFiles(tmpDir, ["extra.md"]);
    expect(files).toContain(path.join(tmpDir, "extra.md"));
  });

  it("includes absolute extraPaths as-is", () => {
    fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "index");
    const absPath = path.join(tmpDir, "abs.md");
    fs.writeFileSync(absPath, "abs");
    const files = collectMemoryFiles(tmpDir, [absPath]);
    expect(files).toContain(absPath);
  });

  it("returns empty memory/ list when directory does not exist", () => {
    fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "index");
    const files = collectMemoryFiles(tmpDir, []);
    // Should only have MEMORY.md, no crash
    expect(files).toEqual([path.join(tmpDir, "MEMORY.md")]);
  });

  it("deduplicates paths", () => {
    fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "index");
    const files = collectMemoryFiles(tmpDir, ["MEMORY.md"]);
    const memoryMdCount = files.filter((f) => f.endsWith("MEMORY.md")).length;
    expect(memoryMdCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/memory/collect-files.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `collectMemoryFiles`**

```typescript
// src/memory/collect-files.ts
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Collect all memory file paths to index:
 *  - MEMORY.md (always)
 *  - memory/*.md (auto-discovered)
 *  - extraPaths from config (resolved relative to workspace)
 *
 * Returns deduplicated absolute paths.
 */
export function collectMemoryFiles(
  workspaceDir: string,
  extraPaths: string[],
): string[] {
  const paths = new Set<string>();

  // Always include MEMORY.md
  paths.add(path.join(workspaceDir, "MEMORY.md"));

  // Auto-discover memory/*.md
  const memoryDir = path.join(workspaceDir, "memory");
  try {
    const entries = fs.readdirSync(memoryDir);
    for (const entry of entries) {
      if (entry.endsWith(".md")) {
        paths.add(path.join(memoryDir, entry));
      }
    }
  } catch {
    // memory/ directory doesn't exist — that's fine
  }

  // Add extra paths
  for (const p of extraPaths) {
    paths.add(p.startsWith("/") ? p : path.join(workspaceDir, p));
  }

  return [...paths];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/memory/collect-files.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/collect-files.ts src/memory/collect-files.test.ts
git commit -m "feat: add collectMemoryFiles helper to discover memory/*.md files"
```

---

### Task 2: Create `createMemoryWatcher`

**Files:**
- Create: `src/memory/watcher.ts`
- Create: `src/memory/watcher.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// src/memory/watcher.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createMemoryWatcher, type MemoryWatcher } from "./watcher.js";

describe("createMemoryWatcher", () => {
  let tmpDir: string;
  let watcher: MemoryWatcher | null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-watcher-"));
    fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "initial");
    fs.mkdirSync(path.join(tmpDir, "memory"));
    watcher = null;
  });

  afterEach(() => {
    watcher?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("calls onChanged when MEMORY.md changes", async () => {
    const onChanged = vi.fn();
    watcher = createMemoryWatcher(tmpDir, onChanged, { debounceMs: 50 });

    // Modify MEMORY.md
    fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "updated");

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 200));

    expect(onChanged).toHaveBeenCalled();
  });

  it("calls onChanged when a file in memory/ changes", async () => {
    const onChanged = vi.fn();
    watcher = createMemoryWatcher(tmpDir, onChanged, { debounceMs: 50 });

    fs.writeFileSync(path.join(tmpDir, "memory", "note.md"), "new note");

    await new Promise((r) => setTimeout(r, 200));

    expect(onChanged).toHaveBeenCalled();
  });

  it("debounces rapid changes into a single callback", async () => {
    const onChanged = vi.fn();
    watcher = createMemoryWatcher(tmpDir, onChanged, { debounceMs: 100 });

    // Rapid changes
    fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "v1");
    fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "v2");
    fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "v3");

    await new Promise((r) => setTimeout(r, 300));

    // Should have been called once (debounced), not three times
    expect(onChanged.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("close() stops watching", async () => {
    const onChanged = vi.fn();
    watcher = createMemoryWatcher(tmpDir, onChanged, { debounceMs: 50 });
    watcher.close();
    watcher = null;

    fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "after close");

    await new Promise((r) => setTimeout(r, 200));

    expect(onChanged).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/memory/watcher.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `createMemoryWatcher`**

```typescript
// src/memory/watcher.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../core/logger.js";

const log = createLogger("memory-watcher");

export interface MemoryWatcher {
  close(): void;
}

/**
 * Watch workspace memory files (MEMORY.md and memory/ directory) for changes.
 * Calls `onChanged` (debounced) when any .md file is created, modified, or deleted.
 */
export function createMemoryWatcher(
  workspaceDir: string,
  onChanged: () => void,
  options?: { debounceMs?: number },
): MemoryWatcher {
  const debounceMs = options?.debounceMs ?? 500;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const watchers: fs.FSWatcher[] = [];

  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChanged();
    }, debounceMs);
  };

  // Watch MEMORY.md directly
  const memoryMdPath = path.join(workspaceDir, "MEMORY.md");
  try {
    const w = fs.watch(memoryMdPath, () => trigger());
    watchers.push(w);
  } catch {
    log.debug("MEMORY.md not found, skipping watch");
  }

  // Watch memory/ directory (recursive for subdirs)
  const memoryDir = path.join(workspaceDir, "memory");
  try {
    const w = fs.watch(memoryDir, { recursive: true }, (_event, filename) => {
      if (filename && filename.endsWith(".md")) {
        trigger();
      }
    });
    watchers.push(w);
  } catch {
    log.debug("memory/ directory not found, skipping watch");
  }

  return {
    close() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const w of watchers) {
        w.close();
      }
      watchers.length = 0;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/memory/watcher.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/watcher.ts src/memory/watcher.test.ts
git commit -m "feat: add createMemoryWatcher for live memory file reindexing"
```

---

### Task 3: Integrate watcher + collectMemoryFiles into daemon, terminal session, and CLI

Replace duplicated `memoryFiles` logic with `collectMemoryFiles`, add watcher that triggers reindex on changes, and clean up watcher on shutdown.

**Files:**
- Modify: `src/daemon.ts` — use collectMemoryFiles, add watcher, close on shutdown
- Modify: `src/terminal/session.ts` — use collectMemoryFiles, add watcher, close on cleanup
- Modify: `src/cli.ts` — use collectMemoryFiles (no watcher needed for mcp-server, it's short-lived)

- [ ] **Step 1: Update `src/daemon.ts`**

Replace the `memoryFiles` construction (lines 72-75) with:
```typescript
import { collectMemoryFiles } from "./memory/collect-files.js";
import { createMemoryWatcher } from "./memory/watcher.js";

// In startDaemon(), after creating the indexer:
const memoryFiles = collectMemoryFiles(config.security.workspace, config.memory.extraPaths);
await indexer.syncFiles(memoryFiles);

// After the initial sync, start watching for changes
const memoryWatcher = createMemoryWatcher(config.security.workspace, async () => {
  const files = collectMemoryFiles(config.security.workspace, config.memory.extraPaths);
  log.info({ fileCount: files.length }, "Memory files changed, reindexing");
  await indexer.syncFiles(files);
});
```

In the shutdown function, add `memoryWatcher.close()` before closing the store.

- [ ] **Step 2: Update `src/terminal/session.ts`**

Replace the `memoryFiles` construction (lines 47-50) with:
```typescript
import { collectMemoryFiles } from "../memory/collect-files.js";
import { createMemoryWatcher } from "../memory/watcher.js";

// In createTerminalSession():
const memoryFiles = collectMemoryFiles(config.security.workspace, config.memory.extraPaths);
await indexer.syncFiles(memoryFiles);

const memoryWatcher = createMemoryWatcher(config.security.workspace, async () => {
  const files = collectMemoryFiles(config.security.workspace, config.memory.extraPaths);
  await indexer.syncFiles(files);
});
```

In the cleanup function, add `memoryWatcher.close()`.

- [ ] **Step 3: Update `src/cli.ts`**

Replace the `memoryFiles` construction (lines 119-122) with:
```typescript
import { collectMemoryFiles } from "./memory/collect-files.js";

const memoryFiles = collectMemoryFiles(config.security.workspace, config.memory.extraPaths);
await indexer.syncFiles(memoryFiles);
```

No watcher needed here — the mcp-server subprocess is short-lived per Codex session.

- [ ] **Step 4: Run all tests**

Run: `npm test -- --run`
Expected: PASS (existing tests should still pass, possibly with minor mock adjustments for new imports)

- [ ] **Step 5: Fix any test failures**

The daemon.test.ts and terminal.test.ts mock the old imports. Add mocks for the new modules:
```typescript
vi.mock("./memory/collect-files.js", () => ({
  collectMemoryFiles: vi.fn().mockReturnValue([]),
}));
vi.mock("./memory/watcher.js", () => ({
  createMemoryWatcher: vi.fn().mockReturnValue({ close: vi.fn() }),
}));
```

- [ ] **Step 6: Run tests again to confirm all pass**

Run: `npm test -- --run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/daemon.ts src/terminal/session.ts src/cli.ts src/daemon.test.ts src/terminal.test.ts
git commit -m "feat: integrate memory file watcher for live reindexing on file changes"
```

---

## Chunk 2: Stdio MCP Server Tool Description Parity

### Task 4: Copy rich tool descriptions to stdio-mcp-server.ts

The `TOOL_DEFINITIONS` in `stdio-mcp-server.ts` have minimal descriptions. Copy the rich descriptions from `assistant-server.ts` so Codex agents get the same documentation.

**Files:**
- Modify: `src/tools/stdio-mcp-server.ts`

- [ ] **Step 1: Update TOOL_DEFINITIONS with rich descriptions**

Replace the cron tool definition (lines 52-69) with rich description matching assistant-server.ts:

```typescript
{
  name: "cron",
  description: `Manage scheduled reminders and jobs. Actions:

ADD — create a new job. Required params:
  - label: string — human-readable name (e.g. "Daily standup reminder")
  - schedule: object — one of three types:
      { "type": "cron", "expression": "<cron expr>" } — standard 5-field cron (e.g. "30 9 * * 1-5" = weekdays 9:30 UTC)
      { "type": "oneshot", "iso": "<ISO 8601 datetime>" } — fires once (e.g. "2026-03-01T14:00:00Z")
      { "type": "interval", "everyMs": <milliseconds> } — repeating interval (e.g. 3600000 = every hour)
  - payload: { "text": "<message>" } — the text delivered when the job fires

LIST — returns all jobs. No params needed.

UPDATE — modify an existing job. Required params:
  - id: string — the job UUID (from add/list response)
  Optional: label, schedule, payload (same format as add), enabled (boolean)

REMOVE — delete a job. Required params:
  - id: string — the job UUID`,
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["add", "list", "update", "remove"],
        description: "Action to perform",
      },
      params: {
        type: "object",
        description:
          "Action parameters — see tool description for required fields per action",
      },
    },
    required: ["action"],
  },
},
```

Also enrich exec and process tool descriptions with parameter details:

```typescript
{
  name: "exec",
  description: "Run a command with optional background execution. Returns output, exit code, and session ID for background processes.",
  inputSchema: {
    type: "object" as const,
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      background: {
        type: "boolean",
        description: "Run in background (default: false). Returns a sessionId to check status later via the process tool.",
      },
      yieldMs: {
        type: "number",
        description: "Wait this many ms then return partial output (useful for long-running foreground commands)",
      },
    },
    required: ["command"],
  },
},
{
  name: "process",
  description: "Check status of background processes started via the exec tool.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["status", "list"],
        description: "Action: 'list' returns all sessions, 'status' returns details for a specific session (requires sessionId)",
      },
      sessionId: {
        type: "string",
        description: "Session ID (required for 'status' action, returned by exec when background=true)",
      },
    },
    required: ["action"],
  },
},
```

- [ ] **Step 2: Run existing stdio-mcp-server tests**

Run: `npx vitest run src/tools/stdio-mcp-server.test.ts`
Expected: PASS (descriptions changed but tests don't check description content, only structure)

- [ ] **Step 3: Run full test suite**

Run: `npm test -- --run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/tools/stdio-mcp-server.ts
git commit -m "fix: bring Codex stdio MCP tool descriptions to parity with Claude SDK definitions"
```

---

## Chunk 3: Final Verification

### Task 5: End-to-end verification

- [ ] **Step 1: Build the project**

Run: `npm run build`
Expected: No TypeScript errors

- [ ] **Step 2: Run full test suite with coverage**

Run: `npm run test:coverage`
Expected: PASS with coverage above 70% threshold

- [ ] **Step 3: Final commit (if any remaining changes)**

Move plan to completed:
```bash
mv docs/plans/active/2026-03-13-memory-watcher-and-tool-descriptions.md docs/plans/completed/
git add docs/plans/
git commit -m "docs: move memory-watcher plan to completed"
```
