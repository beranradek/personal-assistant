# Codex Agent Backend Support — Specification

**Date:** 2026-03-02
**Status:** Active

## Overview

Add configurable multi-backend support to the personal assistant, enabling the Codex agent (via `@openai/codex-sdk`) as an alternative to the existing Claude Agent SDK. The backend is selected per-instance via `settings.json` and affects how agent turns are executed, how responses are streamed, and how security is enforced.

## Motivation

The Codex SDK offers a fundamentally different execution model — a Rust CLI subprocess with built-in sandboxing, command execution, file patching, and MCP tool calling. Supporting it alongside Claude expands model flexibility (OpenAI models like o3, gpt-5.1, gpt-5.1-codex) and lets users choose the backend best suited to their workload.

## Architectural Analysis

### Codex SDK Characteristics

| Aspect | Detail |
|--------|--------|
| **Execution model** | Spawns `codex exec` subprocess per turn; communicates via stdin/stdout JSONL |
| **Streaming** | Item-based events: `thread.started`, `item.started`, `item.updated`, `item.completed`, `turn.completed`, `turn.failed`, `error` |
| **Item types** | `agent_message`, `command_execution`, `file_change`, `mcp_tool_call`, `reasoning`, `web_search`, `todo_list`, `error` |
| **Sandboxing** | CLI-enforced: `read-only`, `workspace-write`, `danger-full-access` (kernel-level on Linux) |
| **Command security** | Execution policy (`execpolicy.txt`) with allow/prompt/forbidden rules + built-in safety heuristics for known-safe read-only commands |
| **Hooks** | **Post-execution only** (`AfterAgent`, `AfterToolUse`) — for auditing/notifications, **cannot block** tool calls |
| **MCP servers** | Configured in `~/.codex/config.toml`; CLI manages connections, SDK reports `mcp_tool_call` items |
| **Skills** | Supported via `SKILLS.md` files with metadata (name, description, MCP dependencies, policy) |
| **Session management** | Thread IDs persisted in `~/.codex/sessions`; resumable via `codex.resumeThread(id)` |
| **Approval policies** | `never`, `on-request`, `on-failure` (deprecated), `untrusted` — CLI-enforced |
| **Working directory** | `ThreadOptions.workingDirectory` → `--cd` flag |
| **Additional writable dirs** | `ThreadOptions.additionalDirectories` → `--add-dir` flags → added to `writable_roots` in sandbox |
| **System prompt** | Custom instructions via `config.toml` `developer_instructions` or `model_instructions_file` |

### Security Model Comparison: Claude vs Codex

This is the most critical section — the two backends have **fundamentally different security architectures**.

#### Claude Agent SDK (current)

PA implements a **three-layer pre-execution defense-in-depth**:

1. **Command allowlist** (`security.allowedCommands` in settings.json) — only commands on the list can execute. Default: ~50 safe commands (ls, grep, git, npm, curl, etc.). Anything not listed is **blocked before execution**.

2. **Extra validation** (`security.commandsNeedingExtraValidation`) — commands like `rm`, `kill`, `chmod`, `curl` pass additional checks:
   - `rm`: blocks dangerous patterns (`/`, `/home`, `/etc`, recursive with wildcards)
   - `kill`: blocks PID 1, negative PIDs, system processes (< 100)

3. **Path validation** (`security/path-validator.ts`) — all file paths in tool calls are validated against `security.workspace`, `security.additionalReadDirs`, and `security.additionalWriteDirs`. Paths escaping these boundaries are **blocked**.

All three layers are enforced via **PreToolUse hooks** — the command is validated **before** it reaches the SDK subprocess. If any layer rejects, the tool call never executes.

#### Codex CLI

Codex uses a **sandbox + policy + execution-policy** model:

1. **Sandbox modes** (kernel-level isolation):
   - `read-only`: can read all files, no writes, no network
   - `workspace-write`: read all, write to `workingDirectory` + `additionalDirectories` (writable_roots), optional network
   - `danger-full-access`: no restrictions

2. **Approval policies** (who decides if a command runs):
   - `untrusted`: only known-safe read-only commands auto-approved (cat, ls, grep, head, wc, etc.); everything else **prompts for human approval**
   - `on-request`: model decides when to ask for approval
   - `never`: all commands auto-approved, failures returned to model
   - `reject`: fine-grained auto-rejection of specific prompt categories

3. **Execution policy** (`execpolicy.txt`, optional):
   - Prefix-rule based allowlisting: `allow git status`, `deny git reset --hard`, `forbidden rm -rf /`
   - Three decision types: `allow` (auto-approve), `prompt` (ask human), `forbidden` (block unconditionally)
   - Falls back to built-in safety heuristics when no rule matches

4. **Built-in safety heuristics** (auto-approve only):
   - Known safe: `cat`, `cd`, `cut`, `echo`, `grep`, `head`, `ls`, `pwd`, `stat`, `tail`, `wc`, `which`, `whoami`
   - Special restrictions: `find` (no `-exec`/`-delete`), `git` (read-only subcommands only), `rg` (no `--pre`)
   - Dangerous patterns always blocked: `rm -rf`, `sudo` (unless configured)

5. **Hooks** — **post-execution only** (`AfterToolUse`):
   - Fire **after** the command has already executed
   - Provide audit data (tool name, input, success/failure, duration, output preview)
   - Hook results: `Success`, `FailedContinue`, `FailedAbort` — but the command already ran
   - **Cannot block or prevent execution**

#### Critical Differences

| Security Concern | Claude (PA) | Codex |
|------------------|-------------|-------|
| **When is the command validated?** | **Before execution** (PreToolUse hook) | Sandbox enforces at kernel level; approval prompts are interactive |
| **Command allowlist** | Configurable list in settings.json | Execution policy file (`execpolicy.txt`) with allow/prompt/forbidden rules |
| **Unknown commands** | **Blocked** (not on allowlist) | Depends on approval policy: auto-approved (`never`), heuristic-checked (`untrusted`), or prompted (`on-request`) |
| **Path validation** | Explicit read/write directory lists | Sandbox `writable_roots` (workspace + additional dirs) |
| **Dangerous command blocking** | Extra validators for rm, kill, chmod | `forbidden` rules in execpolicy.txt + built-in heuristics |
| **Hooks that can block** | Yes (PreToolUse returns `{ decision: "block" }`) | **No** — hooks are post-execution audit only |
| **Sudo control** | `allowSudo: false` blocks `sudo` | No built-in sudo blocking (use execpolicy.txt `forbidden sudo`) |

#### Daemon Mode Implications

In daemon mode (headless, no interactive user):

- **Claude**: all security is automatic — allowlist + path validation + PreToolUse hooks
- **Codex with `approvalPolicy: "never"`**: all commands auto-approved → the sandbox is the **only** protection
- **Codex with `approvalPolicy: "untrusted"`**: only safe read-only commands run; everything else would need human approval → **agent hangs** in daemon mode
- **Recommended**: `approvalPolicy: "never"` + `sandboxMode: "workspace-write"` + an `execpolicy.txt` with `forbidden` rules for dangerous patterns

### Key Design Decisions

#### D1: Backend abstraction at the agent-runner level

Create an `AgentBackend` interface that both Claude and Codex implement. The interface produces a normalized `StreamEvent` async generator — the same type the gateway queue and terminal handler already consume. This means **zero changes to adapters, gateway queue, router, or processing message accumulator**.

#### D2: Security delegation for Codex

Codex's CLI enforces its own sandbox at the kernel level. PA's PreToolUse hooks **cannot be injected** into the Codex SDK — there is no pre-execution interception point in the SDK.

Configuration mapping:
- PA's `security.workspace` → Codex `workingDirectory`
- PA's `security.additionalReadDirs` + `security.additionalWriteDirs` → Codex `additionalDirectories` (becomes `writable_roots` in workspace-write sandbox)
- PA's `security.allowedCommands` → **not directly mapped** (user should create `execpolicy.txt` separately)
- `networkAccessEnabled: false` for tighter security

**This is a fundamentally different security model.** Users must understand that switching to Codex changes how commands are controlled. A dedicated `CODEX.md` document will clearly explain these differences.

#### D3: MCP servers — programmatic injection via CodexOptions.config

PA's in-process MCP servers (built with `createSdkMcpServer` from the Claude Agent SDK) cannot be passed directly to the Codex subprocess. However, Codex's `CodexOptions.config` parameter supports **arbitrary config overrides** including `mcp_servers` — the SDK flattens nested objects to dotted-path `--config` CLI flags that Codex CLI merges into its runtime config.

**Solution: `pa mcp-server` + programmatic registration**

1. Create a new CLI subcommand (`pa mcp-server`) that starts a standalone MCP server using `@modelcontextprotocol/sdk` with `StdioServerTransport`, exposing the same 4 tools:
   - `memory_search` — hybrid vector + keyword search over long-term memory
   - `cron` — manage scheduled jobs (ADD/LIST/UPDATE/REMOVE)
   - `exec` — run background commands with completion tracking
   - `process` — check status of background processes

2. When creating the Codex backend, PA **programmatically injects** the MCP server config:

```typescript
const codex = new Codex({
  config: {
    mcp_servers: {
      "personal-assistant": {
        command: "pa",
        args: ["mcp-server", "--config", configDir],
        startup_timeout_sec: 30,
        tool_timeout_sec: 120,
      },
    },
    // ... other config overrides
  },
});
```

The SDK serializes this to CLI flags like `--config mcp_servers.personal-assistant.command="pa"`, and Codex CLI spawns `pa mcp-server` as a child process, connecting via JSON-RPC stdio. **No manual `~/.codex/config.toml` editing required.**

**Architecture:**

The stdio MCP server is a separate process spawned by Codex CLI. It initializes its own subsystems:

| Subsystem | Sharing Strategy |
|-----------|-----------------|
| **Config** | Loads from same `settings.json` (read-only) |
| **Memory (vector store)** | Opens same `vectors.db` — sqlite supports concurrent readers safely |
| **Memory (embedder)** | Own instance of `node-llama-cpp` embedder (loaded on demand) |
| **Cron store** | Same `cron-jobs.json` with file-level locking (same pattern as session store) |
| **Exec registry** | Own in-memory registry — processes tracked per-process |

The tool handler code is already backend-agnostic (dependency-injected `deps.search`, `deps.handleCronAction`, etc.). The stdio MCP server just wires them with a different transport — `@modelcontextprotocol/sdk` instead of `createSdkMcpServer`.

**Claude backend** continues using the in-process MCP servers unchanged.

**User-configured MCP servers** from `settings.json` `mcpServers` section remain Claude-only. Users can add additional Codex-side MCP servers via `codex.configOverrides.mcp_servers` in settings.json or directly in `~/.codex/config.toml`.

#### D4: Skills — two-tier model (immutable core + agent-created)

Codex discovers skills from **hardcoded filesystem directories only** — skill paths **cannot** be injected programmatically via `CodexOptions.config`. The `[[skills.config]]` section only enables/disables already-discovered skills.

Discovery locations (in order):
1. `$PROJECT_ROOT/.agents/skills/` — project-level (**inside workspace** — agent CAN create/modify/delete under `workspace-write` sandbox)
2. `~/.codex/skills/` — Codex home (**outside workspace** — agent CANNOT modify under `workspace-write` sandbox)
3. `~/.agents/skills/` — user home (outside workspace — agent CANNOT modify)
4. Embedded system skills cache

This enables a **two-tier skill model**:

**Tier 1 — Immutable PA Core Skills (`~/.codex/skills/`)**

PA seeds its core skill(s) into `~/.codex/skills/` during initialization. This directory is:
- Outside the agent's workspace → protected by `workspace-write` sandbox
- Automatically discovered by Codex → no config needed
- Agent **cannot** create, modify, or delete skills here

The core skill defines PA's behavioral guidelines, MCP tool usage, workspace conventions — equivalent to AGENTS.md/SOUL.md for the Claude backend. It also explicitly instructs the agent that it can create custom skills (see Tier 2).

**Tier 2 — Agent-Created Custom Skills (`{workspace}/.agents/skills/`)**

The agent can autonomously create, modify, and delete its own skills in `{workspace}/.agents/skills/`. Under `workspace-write` sandbox, this directory is writable because it's inside the workspace. Codex auto-discovers skills here on each turn.

This enables the agent to:
- Create specialized skills as it learns the user's patterns and preferences
- Build task-specific workflows and checklists
- Extend its own capabilities without PA code changes

The PA core skill template explicitly tells the agent about this capability:
```markdown
## Custom Skills

You can create your own reusable skills as SKILLS.md files in `.agents/skills/` within your workspace.
Each skill file should have YAML frontmatter with `name`, `description`, and `short_description` fields.
Create skills when you notice recurring patterns or workflows that would benefit from formalization.
```

Each skill is a `SKILLS.md` file with frontmatter metadata:
```markdown
---
name: memory-management
description: Search and manage long-term memory
short_description: Memory search and management
---

# Memory Management

Use the `memory_search` MCP tool to find past decisions...
```

PA provides the seed core skill that teaches the Codex agent how to use PA's MCP tools (memory_search, cron, exec, process), the workspace conventions, behavioral guidelines equivalent to what AGENTS.md/SOUL.md provide for the Claude backend, and how to create its own custom skills.

#### D5: Session management

Each backend manages its own session cache:
- Claude: existing `sdkSessionIds` Map (session key → SDK session ID)
- Codex: new `codexThreadIds` Map (session key → Codex thread ID)

Both are cleared by the `/clear` command via the backend interface.

#### D6: System prompt / instructions — inject memory via developer_instructions

- **Claude**: `preset: "claude_code"` with memory content (`readMemoryFiles()`) appended to system prompt
- **Codex**: `developer_instructions` injected programmatically via `CodexOptions.config`

Three config fields are available for instruction injection:
- `instructions` — system instructions string (replaces Codex's built-in instructions — risky)
- `developer_instructions` — injected as a separate developer role message (additive, safe)
- `model_instructions_file` — path to a file (replaces built-in — risky)

**PA uses `developer_instructions`** to inject memory content (MEMORY.md, USER.md) into the Codex agent. This is additive — Codex keeps its own built-in instructions and PA's content is added alongside.

```typescript
const memoryContent = await readMemoryFiles(config.security.workspace);

const codex = new Codex({
  config: {
    developer_instructions: memoryContent,
    mcp_servers: { /* ... */ },
  },
});
```

AGENTS.md and SOUL.md equivalents are provided as Codex skills in `~/.codex/skills/` (see D4) rather than as instructions, since skills have richer metadata and can reference MCP tool dependencies.

## Configuration Schema

New `agent` config section in `settings.json`:

```typescript
export const AgentConfigSchema = z.object({
  backend: z.enum(["claude", "codex"]).default("claude"),
  model: z.string().nullable(),
  maxTurns: z.number().int().positive(),
});
```

New top-level `codex` config section:

```typescript
export const CodexConfigSchema = z.object({
  /** Path override to Codex CLI binary (optional) */
  codexPath: z.string().nullable().default(null),
  /** OpenAI API key env var name or literal (default: uses OPENAI_API_KEY from env) */
  apiKey: z.string().nullable().default(null),
  /** OpenAI base URL override */
  baseUrl: z.string().nullable().default(null),
  /** Sandbox mode: "read-only" | "workspace-write" | "danger-full-access" */
  sandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
  /** Approval policy: "never" | "on-request" | "on-failure" | "untrusted" */
  approvalPolicy: z.enum(["never", "on-request", "on-failure", "untrusted"]).default("never"),
  /** Allow network access in workspace-write sandbox */
  networkAccess: z.boolean().default(false),
  /** Reasoning effort: "minimal" | "low" | "medium" | "high" | "xhigh" */
  reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).nullable().default(null),
  /** Skip git repo check (needed if workspace is not a git repo) */
  skipGitRepoCheck: z.boolean().default(true),
  /** Additional Codex CLI config overrides (dotted-path key-value) */
  configOverrides: z.record(z.string(), z.unknown()).default({}),
});
```

Example `settings.json` with Codex backend:

```json
{
  "agent": {
    "backend": "codex",
    "model": "o3",
    "maxTurns": 200
  },
  "codex": {
    "sandboxMode": "workspace-write",
    "approvalPolicy": "never",
    "networkAccess": false,
    "skipGitRepoCheck": true,
    "reasoningEffort": "high"
  }
}
```

## Backend Interface

```typescript
export interface AgentBackend {
  /** Human-readable backend name for logging. */
  readonly name: string;

  /**
   * Execute a single agent turn, yielding StreamEvent objects.
   * This is the primary interface — both streaming and non-streaming
   * consumers use this.
   */
  runTurn(
    message: string,
    sessionKey: string,
  ): AsyncGenerator<StreamEvent>;

  /**
   * Clear the session for the given key (e.g. on /clear command).
   */
  clearSession(sessionKey: string): void;

  /**
   * Clean up resources (e.g. close SDK transport).
   * Called during graceful shutdown.
   */
  close?(): Promise<void>;
}
```

## Event Mapping: Codex → StreamEvent

The existing `StreamEvent` union accommodates all Codex item types with minimal extension:

| Codex Event | StreamEvent Mapping |
|-------------|-------------------|
| `item.started` + `command_execution` | `{ type: "tool_start", toolName: "command_execution" }` |
| `item.completed` + `command_execution` | `{ type: "tool_input", toolName: "command_execution", input: { command, exit_code, aggregated_output } }` |
| `item.started` + `file_change` | `{ type: "tool_start", toolName: "file_change" }` |
| `item.completed` + `file_change` | `{ type: "tool_input", toolName: "file_change", input: { changes: [...] } }` |
| `item.started` + `mcp_tool_call` | `{ type: "tool_start", toolName: "mcp:<server>/<tool>" }` |
| `item.completed` + `mcp_tool_call` | `{ type: "tool_input", toolName: "mcp:<server>/<tool>", input: { arguments, result/error } }` |
| `item.started` + `web_search` | `{ type: "tool_start", toolName: "web_search" }` |
| `item.completed` + `agent_message` | `{ type: "text_delta", text: item.text }` |
| `item.started` + `reasoning` | (ignored — internal reasoning) |
| `item.started/updated` + `todo_list` | (ignored — internal planning) |
| `turn.completed` | (triggers session save + audit) |
| `turn.failed` | `{ type: "error", error: message }` |
| `error` | `{ type: "error", error: message }` |

## Processing Message Format for Codex Items

The `formatToolInput()` function in `processing-message.ts` needs extension for Codex-specific item types:

```
🔧 Running: git status
🔧 File changes: update src/index.ts, add src/new.ts
🔧 MCP: memory/memory_search("recent tasks")
🔧 Searching web: "TypeScript ESM imports"
```

## Affected Components

| Component | Change |
|-----------|--------|
| `src/core/types.ts` | Add `backend` to AgentConfigSchema, add CodexConfigSchema, add to ConfigSchema |
| `src/core/config.ts` | Add codex defaults |
| `src/core/agent-runner.ts` | Extract Claude-specific logic; export `AgentBackend` interface |
| **New:** `src/backends/interface.ts` | `AgentBackend` interface + `StreamEvent` type (re-exported) |
| **New:** `src/backends/claude.ts` | `createClaudeBackend()` — wraps existing `streamAgentTurn()` logic |
| **New:** `src/backends/codex.ts` | `createCodexBackend()` — wraps Codex SDK Thread |
| **New:** `src/backends/factory.ts` | `createBackend()` factory function |
| **New:** `src/tools/stdio-mcp-server.ts` | Standalone MCP server entry point using `@modelcontextprotocol/sdk` with `StdioServerTransport` |
| `src/cli.ts` | Add `pa mcp-server` subcommand |
| `src/gateway/queue.ts` | Accept `AgentBackend` instead of `AgentOptions`; call `backend.runTurn()` |
| `src/gateway/processing-message.ts` | Extend `formatToolInput()` for Codex item types |
| `src/terminal/handler.ts` | Accept `AgentBackend` instead of `AgentOptions` |
| `src/terminal/session.ts` | Create backend from config |
| `src/daemon.ts` | Create backend from config; pass to queue |
| **New:** `CODEX.md` | User-facing documentation of Codex backend differences |

## Components NOT Changed

- **Adapters** (Telegram, Slack) — they consume `AdapterMessage`, not `StreamEvent`
- **Router** — routes `AdapterMessage`, backend-agnostic
- **Session store** (JSONL) — both backends save `SessionMessage` through the same path
- **Memory system** — embeddings, vector store, indexer are independent (used by both in-process Claude MCP and standalone stdio MCP)
- **MCP servers** (memory-server.ts, assistant-server.ts) — Claude-backend in-process wrappers unchanged; Codex uses the new stdio-mcp-server.ts
- **Security hooks** (bash-hook, file-tool-hook, path-validator) — Claude-backend only
- **Heartbeat, cron, exec** — backend-agnostic (they produce `AdapterMessage`)

## Streaming Flow (Codex)

```
User message → gateway queue → codexBackend.runTurn()
  → Codex.startThread() or resumeThread()
  → thread.runStreamed(message)
  → for await (event of events):
      map ThreadEvent → StreamEvent
      yield StreamEvent
  → save session + audit
  → yield final result StreamEvent
```

The gateway queue consumes `StreamEvent` identically for both backends — the processing message accumulator, final text extraction, and adapter routing all work unchanged.

## Limitations & Future Work

1. **No PA PreToolUse hooks for Codex** — Codex hooks are post-execution only. The sandbox + `execpolicy.txt` are the command control mechanisms. See CODEX.md for details.
2. **Stdio MCP server is a separate process** — the `pa mcp-server` process (spawned by Codex CLI) shares data files with the daemon but has its own embedder instance and exec registry. Background processes started via the Codex agent's MCP exec tool are tracked in the MCP server process, not the daemon.
3. **Skill paths not programmatically injectable** — skills must exist in filesystem discovery directories. PA seeds core skills to `~/.codex/skills/` during initialization. The agent can autonomously create custom skills in `{workspace}/.agents/skills/`.
4. **Single backend per instance** — no per-message backend selection. Could be added later with router-level backend dispatch.
5. **Codex CLI binary required** — `@openai/codex` must be installed with optional dependencies for the platform-specific binary.

Note: Both PA tools and memory content **are** available to the Codex backend:
- **Tools** (memory_search, cron, exec, process) — injected via `CodexOptions.config.mcp_servers`, served by `pa mcp-server` stdio process
- **Memory content** (MEMORY.md, USER.md) — injected via `CodexOptions.config.developer_instructions`
- **Behavioral guidelines** (AGENTS.md/SOUL.md equivalents) — provided as immutable Codex skill in `~/.codex/skills/`
- **Custom skills** — agent can autonomously create its own skills in `{workspace}/.agents/skills/`
