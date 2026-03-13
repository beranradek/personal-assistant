# Codex Agent Backend — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add configurable Codex agent backend support alongside the existing Claude backend, enabling users to choose between Claude and OpenAI models via `settings.json`.

**Architecture:** A new `AgentBackend` interface normalizes both backends into the same `StreamEvent` async generator. The gateway queue, terminal handler, and processing message accumulator consume `StreamEvent` identically regardless of backend.

**Tech Stack:** TypeScript, `@openai/codex-sdk`, Vitest

**Companion Design Doc:** `2026-03-02-codex-backend-design.md`

---

### Task 1: Add Codex Config Schema to Types

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/config.ts`
- Modify: `src/core/config.test.ts`

**Step 1: Write the failing test**

In `src/core/config.test.ts`, add assertions for the new config fields:

```typescript
// In the "returns full defaults" test:
expect(config.agent.backend).toBe("claude");
expect(config.codex.sandboxMode).toBe("workspace-write");
expect(config.codex.approvalPolicy).toBe("never");
expect(config.codex.networkAccess).toBe(false);
expect(config.codex.skipGitRepoCheck).toBe(true);
expect(config.codex.codexPath).toBeNull();
expect(config.codex.apiKey).toBeNull();
expect(config.codex.baseUrl).toBeNull();
expect(config.codex.reasoningEffort).toBeNull();
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/config.test.ts`

**Step 3: Write implementation**

In `src/core/types.ts`:

1. Add `backend` field to `AgentConfigSchema`:
```typescript
export const AgentConfigSchema = z.object({
  backend: z.enum(["claude", "codex"]).default("claude"),
  model: z.string().nullable(),
  maxTurns: z.number().int().positive(),
});
```

2. Add new `CodexConfigSchema`:
```typescript
export const CodexConfigSchema = z.object({
  codexPath: z.string().nullable().default(null),
  apiKey: z.string().nullable().default(null),
  baseUrl: z.string().nullable().default(null),
  sandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
  approvalPolicy: z.enum(["never", "on-request", "on-failure", "untrusted"]).default("never"),
  networkAccess: z.boolean().default(false),
  reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).nullable().default(null),
  skipGitRepoCheck: z.boolean().default(true),
  configOverrides: z.record(z.string(), z.unknown()).default({}),
});
```

3. Add `codex` to `ConfigSchema`:
```typescript
export const ConfigSchema = z.object({
  // ... existing fields ...
  codex: CodexConfigSchema,
});
```

In `src/core/config.ts`, add codex defaults to `DEFAULTS`:
```typescript
codex: {
  codexPath: null,
  apiKey: null,
  baseUrl: null,
  sandboxMode: "workspace-write",
  approvalPolicy: "never",
  networkAccess: false,
  reasoningEffort: null,
  skipGitRepoCheck: true,
  configOverrides: {},
},
```

Also add `backend: "claude"` to the existing `agent` defaults.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/config.test.ts`

**Step 5: Update other test files**

Search for all test files that construct a full `Config` object inline and add the new `codex` field + `backend` to `agent`. These are likely:
- `src/gateway/queue.test.ts` (makeConfig helper)
- `src/security/bash-hook.test.ts`
- `src/security/file-tool-hook.test.ts`
- Any integration tests

Run: `npm test` to find all failures and fix.

---

### Task 2: Create AgentBackend Interface

**Files:**
- Create: `src/backends/interface.ts`

**Step 1: Create the interface file**

```typescript
/**
 * Agent Backend Interface
 * =======================
 *
 * Abstracts the agent execution layer so that both Claude Agent SDK and
 * Codex SDK can be used interchangeably. Both backends produce the same
 * StreamEvent async generator consumed by the gateway queue and terminal.
 */

import type { StreamEvent } from "../core/agent-runner.js";
import type { SessionMessage } from "../core/types.js";

export type { StreamEvent };

/**
 * An agent backend that can execute turns and produce streaming events.
 */
export interface AgentBackend {
  /** Human-readable backend name (e.g. "claude", "codex"). */
  readonly name: string;

  /**
   * Execute a single agent turn, yielding StreamEvent objects.
   *
   * The generator must:
   * 1. Emit tool_start/tool_input/text_delta events as the turn progresses
   * 2. Save the interaction to the session transcript
   * 3. Append an audit entry to the daily log
   * 4. Yield a final `result` event (or `error` event on failure)
   *
   * Callers (gateway queue, terminal handler) consume this identically
   * regardless of which backend is active.
   */
  runTurn(
    message: string,
    sessionKey: string,
  ): AsyncGenerator<StreamEvent>;

  /**
   * Execute a single agent turn without streaming.
   * Returns the collected response text.
   * Used by non-streaming code paths.
   */
  runTurnSync(
    message: string,
    sessionKey: string,
  ): Promise<{ response: string; messages: SessionMessage[]; partial: boolean }>;

  /**
   * Clear the session for the given key.
   * Called by the /clear command to reset conversation state.
   */
  clearSession(sessionKey: string): void;

  /**
   * Clean up resources (close SDK transports, etc.).
   * Called during graceful shutdown.
   */
  close?(): Promise<void>;
}
```

No test needed — this is a pure type definition.

---

### Task 3: Extract Claude Backend from Agent Runner

**Files:**
- Create: `src/backends/claude.ts`
- Create: `src/backends/claude.test.ts`
- Modify: `src/core/agent-runner.ts` (keep `buildAgentOptions`, `StreamEvent`, `AgentOptions` exports)

**Step 1: Write the failing test**

Create `src/backends/claude.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createClaudeBackend } from "./claude.js";

describe("createClaudeBackend", () => {
  it("returns a backend with name 'claude'", () => {
    const backend = createClaudeBackend(/* mock agentOptions */, /* mock config */);
    expect(backend.name).toBe("claude");
  });

  it("has runTurn, runTurnSync, clearSession methods", () => {
    const backend = createClaudeBackend(/* mock agentOptions */, /* mock config */);
    expect(typeof backend.runTurn).toBe("function");
    expect(typeof backend.runTurnSync).toBe("function");
    expect(typeof backend.clearSession).toBe("function");
  });
});
```

**Step 2: Implement the Claude backend**

Create `src/backends/claude.ts` — a thin wrapper around existing functions:

```typescript
import type { AgentBackend } from "./interface.js";
import type { AgentOptions, StreamEvent } from "../core/agent-runner.js";
import type { Config } from "../core/types.js";
import {
  streamAgentTurn,
  runAgentTurn,
  clearSdkSession,
} from "../core/agent-runner.js";

export function createClaudeBackend(
  agentOptions: AgentOptions,
  config: Config,
): AgentBackend {
  return {
    name: "claude",

    async *runTurn(message: string, sessionKey: string): AsyncGenerator<StreamEvent> {
      yield* streamAgentTurn(message, sessionKey, agentOptions, config);
    },

    async runTurnSync(message: string, sessionKey: string) {
      return runAgentTurn(message, sessionKey, agentOptions, config);
    },

    clearSession(sessionKey: string): void {
      clearSdkSession(sessionKey);
    },
  };
}
```

The existing `agent-runner.ts` functions remain exported and unchanged.

**Step 3: Run tests**

Run: `npx vitest run src/backends/claude.test.ts`

---

### Task 4: Implement Codex Backend

**Files:**
- Create: `src/backends/codex.ts`
- Create: `src/backends/codex.test.ts`

**Step 1: Install the Codex SDK**

```bash
npm install @openai/codex-sdk
```

**Step 2: Write the failing test**

Create `src/backends/codex.test.ts` with structural tests:

```typescript
import { describe, it, expect } from "vitest";
import { createCodexBackend } from "./codex.js";

describe("createCodexBackend", () => {
  it("returns a backend with name 'codex'", () => {
    const backend = createCodexBackend(/* mock config */);
    expect(backend.name).toBe("codex");
  });

  it("has runTurn, runTurnSync, clearSession methods", () => {
    const backend = createCodexBackend(/* mock config */);
    expect(typeof backend.runTurn).toBe("function");
    expect(typeof backend.runTurnSync).toBe("function");
    expect(typeof backend.clearSession).toBe("function");
  });
});
```

**Step 3: Implement the Codex backend**

Create `src/backends/codex.ts`. Key responsibilities:

1. **Initialization:**
   - Create `Codex` instance with `CodexOptions` mapped from config
   - `config.codex.codexPath` → `codexPathOverride`
   - `config.codex.apiKey` → `apiKey`
   - `config.codex.baseUrl` → `baseUrl`
   - `config.codex.configOverrides` → merged into `config`
   - **Programmatic MCP server injection** — inject PA's stdio MCP server:
     ```typescript
     const codexConfig = {
       ...config.codex.configOverrides,
       mcp_servers: {
         "personal-assistant": {
           command: "pa",
           args: ["mcp-server", "--config", configDir],
           startup_timeout_sec: 30,
           tool_timeout_sec: 120,
         },
         // merge any user-defined MCP servers from configOverrides
         ...(config.codex.configOverrides?.mcp_servers ?? {}),
       },
     };
     const codex = new Codex({
       codexPathOverride: config.codex.codexPath ?? undefined,
       apiKey: config.codex.apiKey ?? undefined,
       baseUrl: config.codex.baseUrl ?? undefined,
       config: codexConfig,
     });
     ```
   - This makes PA's tools (memory_search, cron, exec, process) automatically available to Codex without the user editing `~/.codex/config.toml`
   - **Inject memory content as developer_instructions**:
     ```typescript
     const memoryContent = await readMemoryFiles(config.security.workspace);
     const codexConfig = {
       developer_instructions: memoryContent,
       mcp_servers: { /* ... as above ... */ },
       ...config.codex.configOverrides,
     };
     ```
   - This injects MEMORY.md + USER.md content into the Codex agent (additive to Codex's built-in instructions)
   - AGENTS.md/SOUL.md equivalents are provided as Codex skills in `~/.codex/skills/` (see Task 10)

2. **Thread management:**
   - `Map<string, string>` of session key → Codex thread ID
   - First turn: `codex.startThread(threadOptions)`
   - Subsequent turns: `codex.resumeThread(threadId, threadOptions)`
   - `ThreadOptions` built from config:
     - `model` from `config.agent.model`
     - `sandboxMode` from `config.codex.sandboxMode`
     - `workingDirectory` from `config.security.workspace`
     - `additionalDirectories` from `config.security.additionalReadDirs` + `config.security.additionalWriteDirs` (merged, deduplicated)
     - `approvalPolicy` from `config.codex.approvalPolicy`
     - `networkAccessEnabled` from `config.codex.networkAccess`
     - `modelReasoningEffort` from `config.codex.reasoningEffort`
     - `skipGitRepoCheck` from `config.codex.skipGitRepoCheck`

3. **Event mapping** — see design doc "Event Mapping: Codex → StreamEvent" section. The `runTurn` async generator:
   - Iterates `thread.runStreamed(message).events`
   - Captures `thread_id` from `thread.started`
   - Maps `item.started` → `tool_start` events
   - Maps `item.completed` → `tool_input` events
   - Maps `agent_message` items → `text_delta` events
   - Handles `turn.failed` and `error` → `error` events
   - On completion: saves session + audit (same as Claude backend)
   - Yields final `result` event

4. **Non-streaming (`runTurnSync`):**
   - Calls `thread.run(message)` (buffers all events)
   - Returns `{ response: turn.finalResponse, messages, partial: false }`

5. **Error handling:**
   - Catch Codex exec errors with clear messages
   - On stale thread resumption failure: clear thread ID, retry with fresh thread
   - Log `turn.failed` events with details

**Step 4: Run tests**

Run: `npx vitest run src/backends/codex.test.ts`

---

### Task 5: Create Backend Factory

**Files:**
- Create: `src/backends/factory.ts`
- Create: `src/backends/factory.test.ts`
- Create: `src/backends/index.ts` (barrel export)

**Step 1: Write tests**

```typescript
import { describe, it, expect } from "vitest";
import { createBackend } from "./factory.js";

describe("createBackend", () => {
  it("creates claude backend when config.agent.backend is 'claude'", () => {
    const backend = createBackend(configWithBackend("claude"), mockAgentOptions);
    expect(backend.name).toBe("claude");
  });

  it("creates codex backend when config.agent.backend is 'codex'", () => {
    const backend = createBackend(configWithBackend("codex"));
    expect(backend.name).toBe("codex");
  });

  it("throws when Claude backend is requested without agentOptions", () => {
    expect(() => createBackend(configWithBackend("claude"))).toThrow();
  });
});
```

**Step 2: Implement**

```typescript
import type { AgentBackend } from "./interface.js";
import type { AgentOptions } from "../core/agent-runner.js";
import type { Config } from "../core/types.js";
import { createClaudeBackend } from "./claude.js";
import { createCodexBackend } from "./codex.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("backend-factory");

export function createBackend(
  config: Config,
  agentOptions?: AgentOptions,
): AgentBackend {
  const backendType = config.agent.backend;
  log.info({ backend: backendType }, "Creating agent backend");

  switch (backendType) {
    case "claude":
      if (!agentOptions) {
        throw new Error("AgentOptions required for Claude backend");
      }
      return createClaudeBackend(agentOptions, config);
    case "codex":
      return createCodexBackend(config);
    default:
      throw new Error(`Unknown agent backend: ${backendType}`);
  }
}
```

Create `src/backends/index.ts`:
```typescript
export type { AgentBackend } from "./interface.js";
export { createBackend } from "./factory.js";
```

**Step 3: Run tests**

Run: `npx vitest run src/backends/factory.test.ts`

---

### Task 6: Update Gateway Queue to Use AgentBackend

**Files:**
- Modify: `src/gateway/queue.ts`
- Modify: `src/gateway/queue.test.ts`

**Step 1: Update the `MessageQueue` interface**

Change signatures to accept `AgentBackend`:

```typescript
import type { AgentBackend } from "../backends/interface.js";

export interface MessageQueue {
  enqueue(message: AdapterMessage): EnqueueResult;
  processNext(backend: AgentBackend, config: Config, router: Router): Promise<boolean>;
  size(): number;
  processLoop(backend: AgentBackend, config: Config, router: Router): Promise<void>;
  stop(): void;
}
```

**Step 2: Update `processNext()` implementation**

Replace:
- `streamAgentTurn(message.text, sessionKey, agentOptions, config)` → `backend.runTurn(message.text, sessionKey)`
- `runAgentTurn(message.text, sessionKey, agentOptions, config)` → `backend.runTurnSync(message.text, sessionKey)`
- `clearSdkSession(sessionKey)` → `backend.clearSession(sessionKey)`

Remove imports of `runAgentTurn`, `streamAgentTurn`, `clearSdkSession`.

The streaming path (processing message accumulator) and non-streaming path both work unchanged — they consume the same `StreamEvent` / result shape.

**Step 3: Update queue.test.ts**

Replace mock `AgentOptions` with mock `AgentBackend` in tests.

**Step 4: Run tests**

Run: `npx vitest run src/gateway/queue.test.ts`

---

### Task 7: Update Terminal Handler to Use AgentBackend

**Files:**
- Modify: `src/terminal/handler.ts`
- Modify: `src/terminal/handler.test.ts`
- Modify: `src/terminal/session.ts`

**Step 1: Update handler.ts signatures**

```typescript
import type { AgentBackend } from "../backends/interface.js";

export async function handleLine(
  input: string,
  sessionKey: string,
  backend: AgentBackend,
): Promise<HandleLineResult | null> {
  // Replace runAgentTurn → backend.runTurnSync
  // Replace clearSdkSession → backend.clearSession
}

export async function* handleLineStreaming(
  input: string,
  sessionKey: string,
  backend: AgentBackend,
): AsyncGenerator<StreamEvent> {
  // Replace streamAgentTurn → backend.runTurn
  // Replace clearSdkSession → backend.clearSession
}
```

**Step 2: Update session.ts**

Where `createTerminalSession()` builds agent options, also create the backend:

```typescript
import { createBackend } from "../backends/factory.js";

// After building agentOptions:
const backend = createBackend(config, agentOptions);
```

Pass `backend` to `handleLine`/`handleLineStreaming` calls.

**Step 3: Update handler.test.ts**

Replace mock `AgentOptions` + `Config` with mock `AgentBackend`.

**Step 4: Run tests**

Run: `npx vitest run src/terminal/handler.test.ts`

---

### Task 8: Update Daemon to Use AgentBackend

**Files:**
- Modify: `src/daemon.ts`

**Step 1: Update startDaemon()**

After building `agentOptions`, create the backend:

```typescript
import { createBackend } from "./backends/factory.js";

// ... existing agentOptions building ...

const backend = createBackend(config, agentOptions);
log.info({ backend: backend.name }, "Agent backend initialized");

if (config.agent.backend === "codex") {
  log.info(
    "Codex backend active — PA security hooks (bash allowlist, path validation) are " +
    "not used. Command security is enforced by Codex CLI sandbox (%s) and approval " +
    "policy (%s). PA tools (memory_search, cron, exec, process) are injected via " +
    "stdio MCP server. See CODEX.md for details.",
    config.codex.sandboxMode,
    config.codex.approvalPolicy,
  );
}

// Pass backend to queue instead of agentOptions
queue.processLoop(backend, config, router);
```

In shutdown handler:
```typescript
if (backend.close) {
  await backend.close();
}
```

**Step 2: Run tests**

Run: `npx vitest run src/daemon.test.ts` (if applicable) + `npm test`

---

### Task 9: Extend Processing Message Formatting for Codex Items

**Files:**
- Modify: `src/gateway/processing-message.ts`
- Modify: `src/gateway/processing-message.test.ts`

**Step 1: Write failing tests**

```typescript
describe("formatToolInput — Codex item types", () => {
  it("formats command_execution", () => {
    expect(formatToolInput("command_execution", { command: "git status" })).toBe("Running: git status");
  });

  it("formats file_change", () => {
    expect(formatToolInput("file_change", { changes: "update: src/index.ts" })).toContain("src/index.ts");
  });

  it("formats mcp: prefixed tool calls", () => {
    expect(formatToolInput("mcp:memory/memory_search", { arguments: { query: "tasks" } })).toContain("memory_search");
  });

  it("formats web_search", () => {
    expect(formatToolInput("web_search", { query: "TypeScript ESM" })).toContain("TypeScript ESM");
  });
});
```

**Step 2: Extend formatToolInput switch**

Add cases for `command_execution`, `file_change`, `web_search`, and a default handler for `mcp:*` tool names.

**Step 3: Run tests**

Run: `npx vitest run src/gateway/processing-message.test.ts`

---

### Task 10: Seed Codex Skills (Two-Tier Model)

**Files:**
- Create: `src/templates/codex-skills/personal-assistant.md` (core skill template)
- Modify: `src/core/workspace.ts` (add Codex skill seeding)
- Modify: `src/core/workspace.test.ts`

**Context:** Codex discovers skills from hardcoded directories only — paths cannot be injected via config. PA uses a two-tier skill model:

- **Tier 1 (immutable):** `~/.codex/skills/personal-assistant.md` — PA core skill, seeded by PA during initialization. Outside the workspace → protected by `workspace-write` sandbox (agent can't modify). Auto-discovered by Codex.
- **Tier 2 (agent-created):** `{workspace}/.agents/skills/*.md` — inside the workspace, writable by the agent. The agent can autonomously create, modify, and delete custom skills here. Codex auto-discovers them.

**Step 1: Create core skill template**

Create `src/templates/codex-skills/personal-assistant.md`:

```markdown
---
name: personal-assistant
description: Personal assistant workspace conventions, MCP tools, and behavioral guidelines
short_description: PA workspace and tools guide
---

# Personal Assistant

You are a personal assistant operating in a managed workspace.

## Available MCP Tools

- **memory_search** — Search long-term memory for past decisions, preferences, and context. Use before answering knowledge questions.
- **cron** — Manage scheduled jobs. Actions: ADD (with label, schedule, payload), LIST, UPDATE, REMOVE.
- **exec** — Run commands in the background with completion tracking.
- **process** — Check status of background processes (status, list).

## Workspace Conventions

- MEMORY.md contains your persistent memory — update it after important conversations.
- USER.md contains user preferences and profile information.
- Daily logs are maintained automatically in the workspace.

## Behavioral Guidelines

- Search memory before answering questions that may have prior context.
- Be concise and direct in responses.
- When scheduling tasks, confirm the schedule with the user before creating.

## Custom Skills

You can create your own reusable skills as SKILLS.md files in the `.agents/skills/` directory within your workspace. Each skill file should have YAML frontmatter with `name`, `description`, and `short_description` fields, followed by markdown content describing the skill's purpose and instructions.

Create skills when you notice recurring patterns, workflows, or specialized knowledge that would benefit from formalization. For example:
- A skill for a specific project's deployment process
- A skill for the user's preferred code review checklist
- A skill for domain-specific terminology and conventions

Example custom skill:

    ---
    name: deployment-workflow
    description: Step-by-step deployment process for production
    short_description: Production deployment steps
    ---

    # Deployment Workflow

    1. Run tests: `npm test`
    2. Build: `npm run build`
    3. Deploy: `npm run deploy`
```

(Tier 1 replaces what AGENTS.md + SOUL.md provide for the Claude backend. Tier 2 enables autonomous skill creation.)

**Step 2: Write failing tests**

```typescript
it("seeds Codex core skill to ~/.codex/skills/ when backend is codex", async () => {
  const codexSkillsDir = path.join(os.homedir(), ".codex", "skills");
  await ensureCodexSkills(config);
  expect(fs.existsSync(path.join(codexSkillsDir, "personal-assistant.md"))).toBe(true);
});

it("creates workspace .agents/skills/ directory for agent-created skills", async () => {
  const agentSkillsDir = path.join(config.security.workspace, ".agents", "skills");
  await ensureCodexSkills(config);
  expect(fs.existsSync(agentSkillsDir)).toBe(true);
});

it("does not overwrite existing core skill file", async () => {
  // Write custom content to ~/.codex/skills/personal-assistant.md,
  // call ensureCodexSkills again, verify not overwritten
});
```

**Step 3: Implement skill seeding**

Add `ensureCodexSkills(config)` to `workspace.ts` (or a new `codex-skills.ts`):
- Creates `~/.codex/skills/` if it doesn't exist
- Copies `personal-assistant.md` core skill template (same "don't overwrite existing" pattern as `ensureWorkspace`)
- Creates `{workspace}/.agents/skills/` directory if it doesn't exist (for agent-created skills)
- Called from `daemon.ts` and `terminal/session.ts` when `config.agent.backend === "codex"`

**Step 4: Run tests**

Run: `npx vitest run src/core/workspace.test.ts`

---

### Task 11: Create Standalone Stdio MCP Server (`pa mcp-server`)

**Files:**
- Create: `src/tools/stdio-mcp-server.ts`
- Create: `src/tools/stdio-mcp-server.test.ts`
- Modify: `src/cli.ts` (add `mcp-server` subcommand)

This makes PA's built-in tools (memory_search, cron, exec, process) available to the Codex agent via standard MCP protocol.

**Step 1: Install `@modelcontextprotocol/sdk`**

```bash
npm install @modelcontextprotocol/sdk
```

**Step 2: Write failing tests**

Create `src/tools/stdio-mcp-server.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { createStdioMcpServer } from "./stdio-mcp-server.js";

describe("createStdioMcpServer", () => {
  it("creates a server with the expected tools", async () => {
    const server = createStdioMcpServer({
      search: vi.fn().mockResolvedValue([]),
      handleCronAction: vi.fn().mockResolvedValue({ success: true, message: "ok" }),
      handleExec: vi.fn().mockResolvedValue({ success: true, output: "" }),
      getProcessSession: vi.fn().mockReturnValue(undefined),
      listProcessSessions: vi.fn().mockReturnValue([]),
    });
    expect(server).toBeDefined();
    // Verify server has the tools registered
  });
});
```

**Step 3: Implement `src/tools/stdio-mcp-server.ts`**

Uses `@modelcontextprotocol/sdk` (`Server` + `StdioServerTransport`):

```typescript
/**
 * Standalone Stdio MCP Server
 * ===========================
 *
 * Exposes PA's built-in tools over the standard MCP protocol (JSON-RPC
 * over stdio). Designed to be spawned by Codex CLI as a child process.
 *
 * Registered tools:
 *   - memory_search — hybrid vector + keyword search
 *   - cron — manage scheduled jobs
 *   - exec — run background commands
 *   - process — check background process status
 *
 * Usage: pa mcp-server [--config <path>]
 *
 * Configure in ~/.codex/config.toml:
 *   [mcp_servers.personal-assistant]
 *   command = "pa"
 *   args = ["mcp-server"]
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Same deps interface as assistant-server.ts + memory search
interface StdioMcpServerDeps {
  search: (query: string, maxResults?: number) => Promise<SearchResult[]>;
  handleCronAction: AssistantServerDeps["handleCronAction"];
  handleExec: AssistantServerDeps["handleExec"];
  getProcessSession: AssistantServerDeps["getProcessSession"];
  listProcessSessions: AssistantServerDeps["listProcessSessions"];
}

export function createStdioMcpServer(deps: StdioMcpServerDeps): Server {
  const server = new Server(
    { name: "personal-assistant", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  // Register memory_search — same schema as memory-server.ts
  server.tool("memory_search", { query: z.string(), maxResults: z.number().optional() },
    async ({ query, maxResults }) => {
      const results = await deps.search(query, maxResults);
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    },
  );

  // Register cron — same schema as assistant-server.ts
  server.tool("cron", { action: z.enum(["add","list","update","remove"]), params: z.record(z.unknown()).optional() },
    async ({ action, params }) => {
      const result = await deps.handleCronAction(action, params ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // Register exec
  server.tool("exec", { command: z.string(), background: z.boolean().optional(), yieldMs: z.number().optional() },
    async (args) => {
      const result = await deps.handleExec(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // Register process
  server.tool("process", { action: z.enum(["status","list"]), sessionId: z.string().optional() },
    async ({ action, sessionId }) => {
      if (action === "list") {
        return { content: [{ type: "text", text: JSON.stringify(deps.listProcessSessions(), null, 2) }] };
      }
      if (sessionId) {
        const session = deps.getProcessSession(sessionId);
        return { content: [{ type: "text", text: JSON.stringify(session ?? { error: "Not found" }, null, 2) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ error: "Missing sessionId" }) }] };
    },
  );

  return server;
}
```

**Step 4: Create the `pa mcp-server` entry point**

In `src/cli.ts`, add the `mcp-server` subcommand that:

1. Loads config (same `loadConfig(configDir)`)
2. Initializes memory system (embedder, vector store, indexer, sync)
3. Creates cron manager (same store path)
4. Sets up exec handler + process registry
5. Calls `createStdioMcpServer()` with all deps wired
6. Connects to `StdioServerTransport` — never use `console.log()` (corrupts JSON-RPC)
7. Handles SIGTERM/SIGINT for clean shutdown

```typescript
// In cli.ts command dispatcher:
case "mcp-server":
  await startMcpServer(configDir);
  break;
```

**Step 5: Run tests**

Run: `npx vitest run src/tools/stdio-mcp-server.test.ts`

---

### Task 12: Create CODEX.md Documentation

**Files:**
- Create: `CODEX.md` (project root)

This is a critical deliverable — users MUST understand the security differences before choosing the Codex backend. The document must cover:

**1. Overview**
- What the Codex backend is and when to use it
- How to enable it in settings.json

**2. Prerequisites**
- `@openai/codex` npm package with platform-specific binary
- `OPENAI_API_KEY` environment variable
- `~/.codex/config.toml` for MCP servers, skills, exec policy

**3. Security Differences (WARNING section, prominent, impossible to miss)**

Must include a table like:

| Feature | Claude Backend | Codex Backend |
|---------|---------------|---------------|
| **Command allowlist** | `security.allowedCommands` in settings.json — unknown commands **blocked before execution** | **Not supported in PA settings.** Use Codex's `execpolicy.txt` file instead (see below) |
| **Pre-execution hooks** | PA's PreToolUse hooks validate every Bash/file operation **before** it runs | **Not available.** Codex hooks fire **after** execution only — they cannot block commands |
| **Path restrictions** | `security.additionalReadDirs` / `additionalWriteDirs` with per-tool validation | Sandbox `writable_roots` via `workspace-write` mode + `additionalDirectories` in settings.json |
| **Dangerous command blocking** | Extra validators for rm, kill, chmod, curl (blocked before execution) | Must use `forbidden` rules in `execpolicy.txt` (blocked before execution) |
| **Sudo** | Blocked by default (`allowSudo: false` in settings.json) | **Not blocked by default** — add `forbidden sudo` to `execpolicy.txt` |
| **Unknown commands** | **Blocked** (not on allowlist) | With `approvalPolicy: "never"`: **all commands execute**. Sandbox is the only protection. |

**4. What "approvalPolicy: never" means**

Clear explanation that in daemon/headless mode this is the only viable option, and what the implications are.

**5. Recommended `execpolicy.txt` for daemon mode**

Provide a complete example `~/.codex/execpolicy.txt` that mirrors PA's security posture:

```
# Safe read-only commands (auto-approve)
allow cat
allow ls
allow grep
allow head
allow tail
# ... etc

# Dangerous commands (block unconditionally)
forbidden rm -rf /
forbidden sudo
forbidden kill -9 1
# ... etc
```

**6. PA Tools via MCP Server**

PA's built-in tools (memory_search, cron, exec, process) are **automatically available** when using the Codex backend. PA programmatically injects its `pa mcp-server` as an MCP server into the Codex CLI via `CodexOptions.config.mcp_servers` — no manual `~/.codex/config.toml` editing required.

The Codex CLI spawns `pa mcp-server` as a child process and connects via stdio JSON-RPC. The tools work identically to the Claude backend.

**7. Skills (Two-Tier Model)**

- **Tier 1 — PA Core Skills (`~/.codex/skills/`):**
  - PA automatically seeds its core skill here during initialization
  - Contains behavioral guidelines, MCP tool documentation, workspace conventions
  - Protected by `workspace-write` sandbox — agent cannot modify these
  - Equivalent to AGENTS.md/SOUL.md in the Claude backend
- **Tier 2 — Agent-Created Skills (`{workspace}/.agents/skills/`):**
  - The agent can autonomously create, modify, and delete custom skills here
  - Inside the workspace → writable under `workspace-write` sandbox
  - Codex auto-discovers these on each turn
  - Enables the agent to formalize recurring patterns, workflows, and specialized knowledge
- Configure skill visibility in `~/.codex/config.toml` `[[skills.config]]`

**8. Memory & System Instructions**

- PA's MEMORY.md/SOUL.md/USER.md are **not injected** into Codex prompts by default
- For custom instructions: set `developer_instructions` in config.toml or via `configOverrides` in settings.json

---

### Task 13: Add npm Dependencies

**Files:**
- Modify: `package.json`

```bash
npm install @openai/codex-sdk @modelcontextprotocol/sdk
```

Verify TypeScript compiles: `npm run build`

**Note:** `@modelcontextprotocol/sdk` may already be a transitive dependency of `@openai/codex-sdk`, but install it explicitly since PA uses it directly in `stdio-mcp-server.ts`.

---

### Task 14: Full Test Suite + Build Verification

**Step 1:** `npm test` — fix any failures
**Step 2:** `npm run build` — fix compilation errors
**Step 3:** `npm run test:coverage` — ensure 70% threshold maintained

---

## Dependency Graph

```
Task 1 (Config Schema)
  ↓
Task 2 (Backend Interface)
  ↓
Task 3 (Claude Backend) ──────────┐
  ↓                                │
Task 13 (npm install) ─────────────┤
  ↓                                │
Task 4 (Codex Backend) ────────────┤
  ↓                                │
Task 5 (Factory) ←─────────────────┘
  ↓
Task 6 (Gateway Queue) ←──── Task 9 (Processing Message, parallelizable)
  ↓
Task 7 (Terminal Handler)     Task 10 (Codex Skills seeding, parallelizable)
  ↓                                │
Task 8 (Daemon Integration) ←──── Task 11 (Stdio MCP Server)
  ↓
Task 12 (CODEX.md Documentation)
  ↓
Task 14 (Full verification)
```

Tasks 3 and 13 can be done in parallel.
Task 9 can be done in parallel with Tasks 6-8.
Task 10 (skills seeding) and Task 11 (stdio MCP server) can be done in parallel with Tasks 6-8.
Task 12 (CODEX.md) is after implementation because details inform the documentation.

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Codex CLI binary not available on platform | Backend creation fails fast with clear error message |
| No OPENAI_API_KEY set | Codex backend logs clear error on first turn, does not crash daemon |
| User unaware of security differences | CODEX.md prominently documents all differences; daemon logs warning on startup when Codex backend is active |
| Thread resumption fails (stale thread) | Catch error, clear thread ID, retry with fresh thread |
| `approvalPolicy: "never"` too permissive | CODEX.md recommends execpolicy.txt; daemon startup log warns about the active policy |
| Codex SDK API changes | Pin `@openai/codex-sdk` to specific version |
| MCP server + daemon concurrent file access | sqlite-vec supports concurrent readers; cron store uses file-level locking |
| MCP server not started when Codex needs it | Codex's `startup_timeout_sec` handles slow startup; errors are clear |
