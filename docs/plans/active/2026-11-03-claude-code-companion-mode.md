# Claude Code Companion Mode - Plan

**Date:** 2026-11-03
**Status:** Active

## Goal

Let the user run a regular `claude` CLI session from `~/.personal-assistant/workspace` and get capabilities close to the
PA reached through Slack or `pa terminal`. No new agent runner. Plain Claude Code is the host. PA supplies context and tools.

## Current state (verified)

- `buildAgentOptions()` (`src/core/agent-runner.ts`) uses the `claude_code` preset, `cwd` = workspace and
  `settingSources: ["user","project","local"]`. Skills in `workspace/.claude/skills` already load in plain Claude Code.
- `readMemoryFiles()` (`src/memory/files.ts`) joins AGENTS.md, SOUL.md, USER.md, MEMORY.md (+ HEARTBEAT.md) for `systemPrompt.append`.
- The `memory` and `assistant` MCP servers are in-process SDK servers. Plain Claude Code cannot use them.
- `pa mcp-server` (`src/tools/stdio-mcp-server.ts`) is a stdio MCP server made for the Codex backend. It exposes
  `memory_search`, `episode_*`, `cron_*`, `exec`, `process`. It does not expose habit tools.
- Gmail, Calendar and Slack lookups use the `pa integapi` CLI (needs the integ-api server, which the daemon forks).

## Capability mapping

| Capability | Plain Claude Code source |
|---|---|
| Context files | SessionStart hook running `pa claude-context` (new) |
| Skills | `.claude/skills` in workspace (works today) |
| memory_search, episode_*, cron_*, exec, process | `pa mcp-server` via workspace `.mcp.json` |
| Habit tools | `pa mcp-server` (to add) |
| Integrations | `pa integapi ...` via Bash |
| User MCP servers (context7, chrome-devtools) | workspace `.mcp.json` |

## Known gaps (accepted or to document)

1. **Security.** The Bash allowlist hook, file path hook and sandbox are PA code. They do not apply. Replace them with
   Claude Code permissions and sandbox settings in workspace `.claude/settings.json`.
2. **Cron execution.** Jobs are only fired by the daemon. Jobs made in plain Claude Code run only if the daemon runs.
3. **No PA sessions, compaction, audit log or reflection.** Claude Code has its own sessions.
4. **Memory use.** Each `pa mcp-server` process loads the embedding model (about 314 MB). Prefer the shared HTTP MCP server
   (see task 4) when the daemon runs.

## Tasks

### 1. `pa claude-context` command

- Add `claude-context` to `VALID_COMMANDS` in `src/cli.ts`.
- Print the output of `readMemoryFiles(workspace, { includeHeartbeat: false })` to stdout.
- Option `--hook-json`: print the SessionStart hook JSON format
  (`{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}`).
- Reuse the config loader and workspace path. Do not load the embedding model or open the DB.
- Test: output equals `readMemoryFiles()`, missing files are skipped, JSON output is valid.

### 2. Habit tools in `pa mcp-server`

- Add `habit_check` and `habit_status` to `BASE_TOOL_DEFINITIONS` and the call handler in `stdio-mcp-server.ts`.
- Reuse `markHabit()` and `loadHabits()` with the same disabled-config behavior as in `daemon.ts`.
- Pass handlers through `StdioMcpServerDeps` (same pattern as `handleExec`). Wire them in `startMcpServer()` in `cli.ts`.
- Test: tool list contains both tools. Disabled config returns the error message.

### 3. Workspace config templates and docs

- Add `src/templates/claude-code/` with `.mcp.json` and `.claude/settings.json` examples:
  - MCP server `pa` -> `pa mcp-server`, plus user servers.
  - SessionStart hook -> `pa claude-context --hook-json`.
  - Permissions: deny reads/writes outside workspace and `additionalReadDirs`/`additionalWriteDirs`; Bash allowlist from
    `security.allowedCommands`.
- Option: `pa init --claude-code` copies the templates into the workspace without overwriting existing files.
- Add a "Claude Code companion mode" section to README.md with the gap list above.
- Update the Czech AGENTS.md note "files are given in your system message": say they can also come from the SessionStart hook.

### 4. HTTP MCP option (optional)

- Today the shared HTTP MCP server starts only for `backend: "codex"`. Add config `mcp.httpServer.enabled` to start it for
  any backend. `.mcp.json` can then use `{"type":"http","url":"http://127.0.0.1:47392/mcp"}` and avoid one model load per session.
- Check the endpoint path and add a bind-to-localhost test.

### 5. Verification (E2E)

- Fresh `claude` session in the workspace: confirm the context is present (ask for a fact from USER.md).
- Call `memory_search`, `episode_recent`, `habit_status`, `cron_list` through MCP.
- Create a cron job in plain Claude Code. Confirm the daemon fires it.
- Run `pa integapi calendar today` through Bash.
- Confirm no orphan `pa mcp-server` processes after the session ends.

## Out of scope

- Running PA security hooks inside plain Claude Code (needs a Claude Code plugin; revisit later).
- Session sync between Claude Code and PA session JSONL.
