# Codex Backend

The personal assistant supports [OpenAI Codex](https://github.com/openai/codex) as an alternative agent backend. When enabled, the assistant uses Codex CLI instead of the Claude Agent SDK to execute agent turns.

## Prerequisites

- **Codex CLI** installed globally (`npm i -g @openai/codex`) or reachable via `codexPath` config
- **OpenAI API key** in `OPENAI_API_KEY` env var or `codex.apiKey` config
- Node.js 22+

## Quick Start

1. Set the backend in `settings.json`:

```json
{
  "agent": {
    "backend": "codex"
  }
}
```

2. Run:

```bash
pa terminal   # or pa daemon
```

## Configuration

All Codex-specific options live under `codex` in `settings.json`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `codexPath` | `string \| null` | `null` | Path to Codex CLI binary (null = use `codex` from PATH) |
| `apiKey` | `string \| null` | `null` | OpenAI API key (null = use `OPENAI_API_KEY` env var) |
| `baseUrl` | `string \| null` | `null` | Custom API base URL |
| `sandboxMode` | `"read-only" \| "workspace-write" \| "danger-full-access"` | `"workspace-write"` | Filesystem sandbox level |
| `approvalPolicy` | `"never" \| "on-request" \| "on-failure" \| "untrusted"` | `"never"` | When to request human approval |
| `networkAccess` | `boolean` | `false` | Allow network access during execution |
| `reasoningEffort` | `"minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| null` | `null` | Model reasoning effort (null = model default) |
| `skipGitRepoCheck` | `boolean` | `true` | Skip Codex's git repository validation |
| `configOverrides` | `object` | `{}` | Additional Codex SDK config (merged into CodexOptions.config) |

Example full configuration:

```json
{
  "agent": {
    "backend": "codex",
    "model": "o4-mini"
  },
  "codex": {
    "sandboxMode": "workspace-write",
    "approvalPolicy": "never",
    "networkAccess": false,
    "reasoningEffort": "high"
  }
}
```

## Architecture

### Backend Abstraction

Both Claude and Codex backends implement the `AgentBackend` interface (`src/backends/interface.ts`):

```
AgentBackend
├── claude  — wraps Claude Agent SDK (query/streamQuery)
└── codex   — wraps Codex SDK (startThread/resumeThread)
```

The factory at `src/backends/factory.ts` dispatches based on `config.agent.backend`.

### MCP Tool Injection

PA's built-in tools (memory_search, cron, exec, process) are exposed to Codex via a standalone stdio MCP server:

```
Codex CLI → (spawns) → pa mcp-server → (JSON-RPC over stdio) → PA tools
```

The MCP server is automatically injected into Codex's configuration. No manual setup needed.

### Two-Tier Skill Model

Codex uses markdown skill files for behavioral instructions:

- **Tier 1** (`~/.codex/skills/`): Core PA skills, seeded automatically. Contains workspace conventions, MCP tool descriptions, and behavioral guidelines. Not overwritten after initial creation.
- **Tier 2** (`{workspace}/.agents/skills/`): Agent-writable skills. The assistant can create its own reusable skills here during operation.

Skills are seeded on startup when `agent.backend` is `"codex"`.

### Session Management

Codex uses thread-based sessions. PA maps `sessionKey → threadId` in memory. Thread IDs are not persisted across restarts — a new thread starts on each daemon/terminal restart.

Session transcripts (user messages + assistant responses) are still saved to PA's JSONL session files and daily audit log, maintaining the same persistence guarantees as the Claude backend.

## Security Differences

| Concern | Claude Backend | Codex Backend |
|---------|---------------|---------------|
| Command execution | PA bash allowlist hook (PreToolUse) | Codex sandbox (`sandboxMode`) |
| File access | PA path validation hook | Codex sandbox (`sandboxMode`) |
| Network access | SDK sandbox | `networkAccess` flag |
| Human approval | Not applicable (commands are pre-validated) | `approvalPolicy` setting |

When using the Codex backend, PA's own security hooks (bash command allowlist, filesystem path validation) are **not used**. Security is delegated entirely to Codex CLI's sandbox and approval policy.

### Hardening with execpolicy.txt

In daemon mode, `approvalPolicy` defaults to `"never"` (required for headless operation — there is no human to approve). This means Codex can run any command the sandbox allows.

To restrict which commands Codex can execute, create an `execpolicy.txt` file in the workspace:

```
# ~/.personal-assistant/workspace/execpolicy.txt
#
# Lines starting with + are allowed, - are denied. Evaluated top to bottom,
# first match wins. See `codex --help` for full syntax.

# Allow PA's own tools
+ pa mcp-server

# Allow common safe commands
+ git *
+ ls *
+ cat *
+ head *
+ tail *
+ find *
+ grep *
+ wc *

# Allow package managers (read-only operations)
+ npm list *
+ npm info *

# Deny everything else by default
- *
```

Place this file at `{workspace}/execpolicy.txt`. Codex reads it automatically when `workingDirectory` points to the workspace.

For interactive terminal mode, you can use `approvalPolicy: "on-failure"` or `"untrusted"` to get prompted before potentially dangerous commands run.

## Switching Between Backends

Change `agent.backend` in `settings.json` and restart:

```json
{ "agent": { "backend": "claude" } }
```
```json
{ "agent": { "backend": "codex" } }
```

Session history from one backend is not transferable to the other. Switching backends effectively starts a fresh conversation.

## Multi-Agent Support

PA enables the Codex `multi_agent` feature flag by default. This gives the agent access to `spawn_agent`, `send_input`, `wait`, `close_agent`, and `spawn_agents_on_csv` tools for delegating work to subagents.

### Built-in Agent Types

Three roles are available out of the box:

| Role | Purpose | Sandbox |
|------|---------|---------|
| `default` | General-purpose subagent for bounded tasks | inherits parent |
| `explorer` | Read-only codebase exploration, tracing logic, answering architecture questions | read-only |
| `worker` | Implementation work — code changes in an assigned scope | inherits parent |

### Custom Agent Types

Define custom agent types in `~/.codex/config.toml` with TOML config files:

```toml
# ~/.codex/config.toml

[agents.architect]
description = "Software architecture specialist for system design and technical decisions"
config_file = ".codex/agents/architect.toml"

[agents.code-reviewer]
description = "Code review specialist for quality, security, and maintainability"
config_file = ".codex/agents/code-reviewer.toml"

[agents.planner]
description = "Planning specialist for breaking down complex features into steps"
config_file = ".codex/agents/planner.toml"
```

The `config_file` path is resolved **relative to the Codex working directory**, which PA sets to `config.security.workspace` (default `~/.personal-assistant/workspace/`). Place agent TOML files accordingly:

```
~/.personal-assistant/workspace/
└── .codex/
    └── agents/
        ├── architect.toml
        ├── code-reviewer.toml
        └── planner.toml
```

### Agent TOML Format

Each agent TOML file configures the subagent's behavior:

```toml
# .codex/agents/architect.toml
name = "architect"
description = "Software architecture specialist"
model = "gpt-5.4"
model_reasoning_effort = "high"
sandbox_mode = "read-only"
developer_instructions = """
You are a senior software architect.

## Your Role
- Design system architecture for new features
- Evaluate technical trade-offs
- Recommend patterns and best practices
"""
```

Available fields:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Agent display name |
| `description` | string | Short description (shown in spawn_agent tool) |
| `model` | string | Model override for this agent |
| `model_reasoning_effort` | string | Reasoning effort (`minimal`/`low`/`medium`/`high`/`xhigh`) |
| `sandbox_mode` | string | Sandbox level (`read-only`/`workspace-write`/`danger-full-access`) |
| `developer_instructions` | string | System prompt / behavioral instructions |

### Disabling Multi-Agent

To disable multi-agent support, override the feature flag in `settings.json`:

```json
{
  "codex": {
    "configOverrides": {
      "features": { "multi_agent": false }
    }
  }
}
```

User overrides in `configOverrides.features` take precedence over PA's default.

## Known Limitations

- **Memory refresh**: Memory files (MEMORY.md, USER.md) are re-read at the start of each turn and injected into Codex's `developer_instructions`. However, the Codex SDK applies these instructions at the process level, so mid-turn changes to memory files are not visible until the next turn.
- **No tool_progress parity**: The Claude backend emits native `tool_progress` events from the SDK. The Codex backend synthesizes these via a 1-second timer, so elapsed time display may be slightly less precise.
- **Thread persistence**: Thread IDs are kept in memory only. Restarting the daemon or terminal starts fresh threads (conversation context within Codex is lost, though PA's JSONL session transcripts are preserved).

## Troubleshooting

**"Codex CLI not found"**: Install globally (`npm i -g @openai/codex`) or set `codex.codexPath`.

**"OPENAI_API_KEY not set"**: Export the env var or set `codex.apiKey` in settings.

**MCP tools not available**: Ensure `pa` is in PATH (run `npm run build && npm link` from the project root).

**Thread resume failures**: These are logged as warnings and automatically recovered by starting a new thread. No action needed.
