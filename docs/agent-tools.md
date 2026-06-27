# Agent Tools

Built-in tools available to the personal assistant. The tool set depends on the active agent backend.

## Memory Tools (all backends)

These are exposed via the built-in `memory` MCP server and are available regardless of which agent backend is used.

| Tool | Description |
|------|-------------|
| `memory_search` | Hybrid vector + keyword search over workspace memory files. Use for facts, preferences, workflows, and reflections. |
| `episode_write` | Record a completed task as a structured episode in episodic memory. Call at meaningful task boundaries (not every turn). |
| `episode_search` | Search episodic memory by keyword query, exact filters (project, outcome, source, etc.), or semantic similarity (`semantic: true`). |
| `episode_recent` | List recent episodes filtered by project, job, source, outcome, or date range. |
| `episode_stats` | Summarize episode counts and top dimensions (outcomes, categories, projects, skills) for a filtered episode set. |

## Assistant Tools (all backends)

Exposed via the built-in `assistant` MCP server.

| Tool | Description |
|------|-------------|
| `cron` | Schedule one-shot or recurring jobs. Supports create, list, update, and delete operations. |
| `exec` | Spawn a background shell process with completion notification. Returns a process ID. |
| `process` | Check status of a background process by ID (running, exited, output). |

---

## Claude Code Backend

When the assistant runs on the **Claude** backend (via the Claude Agent SDK), standard Claude Code tools are available in addition to the MCP tools above. These are the same tools available in the Claude Code CLI.

### File System

| Tool | Description |
|------|-------------|
| `Read` | Read a file or range of lines |
| `Write` | Create or overwrite a file |
| `Edit` | Precise string-replacement edits |
| `MultiEdit` | Multiple edits in one call |
| `Glob` | Find files by glob pattern |
| `Grep` | Search file contents by regex |
| `LS` | List directory contents |

### Shell

| Tool | Description |
|------|-------------|
| `Bash` | Run a shell command (validated against the command allowlist in `settings.json`) |

### Web

| Tool | Description |
|------|-------------|
| `WebFetch` | Fetch a URL and return its content |
| `WebSearch` | Web search (when enabled) |

### Task Management

| Tool | Description |
|------|-------------|
| `TodoRead` | Read the current task list |
| `TodoWrite` | Create, update, or complete tasks |

### Notebooks

| Tool | Description |
|------|-------------|
| `NotebookRead` | Read a Jupyter notebook |
| `NotebookEdit` | Edit a Jupyter notebook cell |

### Agent

| Tool | Description |
|------|-------------|
| `Task` | Spawn a subagent to handle a subtask |

---

## Codex Backend

When the assistant runs on the **OpenAI Codex** backend (via `@openai/codex-sdk`), a different set of tools is available. These are the standard Codex CLI tools.

### File System

| Tool | Description |
|------|-------------|
| `read_file` | Read a file |
| `write_file` | Write a file |
| `apply_patch` | Apply a unified diff patch |
| `list_dir` | List directory entries |
| `search_files` | Recursive file content search |
| `find_files` | Find files by name pattern |

### Shell

| Tool | Description |
|------|-------------|
| `shell` | Execute a shell command in a sandboxed environment |

### Web

| Tool | Description |
|------|-------------|
| `fetch_url` | Fetch a URL and return its content |

> The Codex backend also receives the built-in memory and assistant MCP tools via the `mcpServers` configuration. MCP servers are loaded the same way regardless of backend.

---

## Security Constraints

All backends run under the same security model:

- **Filesystem**: The agent can read/write only within the workspace directory and any paths listed in `security.additionalReadDirs` / `security.additionalWriteDirs`.
- **Shell commands**: The Claude Code backend validates every `Bash` call against the `security.allowedCommands` allowlist. Commands not on the list are rejected before execution.
- **Script policy**: Inline script execution (heredocs, eval-style) is restricted by `security.scriptContentPolicy`.

The agent cannot modify its own source code, configuration files, or security settings.

---

## Adding Tools via MCP

Additional tools can be exposed to the agent by adding MCP servers to the `mcpServers` section of `settings.json`:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["path/to/server.js"]
    }
  }
}
```

Both the Claude Code and Codex backends pick up MCP server configurations from settings on startup.
