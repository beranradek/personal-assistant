# Claude Code Companion Mode - Plan

**Date:** 2026-11-03
**Status:** Implemented — 2026-11-03

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
- Gmail, Calendar and Slack use PA MCP proxy tools (the integ-api service and credentials remain local to PA).

## Capability mapping

| Capability | Plain Claude Code source |
|---|---|
| Context files | SessionStart hook running `pa claude-context` (new) |
| Skills | `.claude/skills` in workspace (works today) |
| memory_search, episode_*, cron_*, exec, process | `pa mcp-server` via workspace `.mcp.json` |
| Habit tools | `pa mcp-server` (to add) |
| Integrations | PA MCP proxy tools (`integ_gmail`, `integ_calendar`, `integ_slack`) |
| User MCP servers (context7, chrome-devtools) | workspace `.mcp.json` |

## Known gaps (accepted or to document)

1. **Security.** Addressed as defense-in-depth on 2026-11-04: a generated `PreToolUse` command hook delegates Bash and
   file-tool decisions to PA's existing allowlist and path validators. `pa claude` additionally uses `--restricted`,
   passes only configured directories via `--add-dir`, and loads launcher settings outside the workspace. Bare `claude`
   uses the same project hook when started with `PA_CONFIG=<config-dir>` but is not an OS isolation boundary.
2. **Cron execution.** Jobs are only fired by the daemon. Jobs made in plain Claude Code run only if the daemon runs.
3. **No PA sessions, compaction, audit log or reflection.** Claude Code has its own sessions.
4. **Memory use.** Each `pa mcp-server` process loads the embedding model (about 314 MB). Prefer the shared HTTP MCP server
   (see task 4) when the daemon runs.

## Security and resource implementation gates

- Generate configuration only on explicit opt-in and never overwrite existing `.mcp.json` or `.claude/settings.json`.
  Do not copy credentials or another user's MCP configuration; configuration may contain environment-variable references only.
- Do not translate PA's `security.allowedCommands` mechanically into Claude Code auto-approval. Start with Bash prompts for
  mutations and external side effects; any allowlist must be narrow, read-only and workspace-scoped.
- Authorize PA MCP tools explicitly by tool name and risk class. Read-only calls may be allowed deliberately; `exec`,
  `cron_create`/`cron_update`/`cron_remove`, and other state-changing tools must remain confirmation-gated.
- `claude-context` reads only the fixed root context files, distinguishes a missing file from a read error, and enforces a
  documented aggregate output limit so a bad local file cannot exhaust the hook/session context.
- Before advertising parity, either use the existing localhost HTTP MCP server when available or make stdio MCP initialize
  the embedding service lazily. A new Claude session must not silently add a ~314 MB model load on this VPS.
- The shared endpoint stays bound to `127.0.0.1`; test both this binding and failure behaviour when its port is occupied.

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
  - MCP server `pa` -> `pa mcp-server`; preserve user-managed servers without merging or copying secrets.
  - SessionStart hook -> `pa claude-context --hook-json`.
  - Permissions: deny reads/writes outside workspace and `additionalReadDirs`/`additionalWriteDirs`; default Bash and
    state-changing MCP calls to confirmation. Do not use PA's command allowlist as a blanket auto-allow rule.
- Option: `pa init --claude-code` copies the templates into the workspace without overwriting existing files.
- Add a "Claude Code companion mode" section to README.md with the gap list above.
- Update the Czech AGENTS.md note "files are given in your system message": say they can also come from the SessionStart hook.

### 4. HTTP MCP and model-resource handling

- Today the shared HTTP MCP server starts only for `backend: "codex"`. Add config `mcp.httpServer.enabled` to start it for
  any backend. `.mcp.json` can then use `{"type":"http","url":"http://127.0.0.1:47392/mcp"}` and avoid one model load per session.
- If the endpoint is unavailable, document the stdio resource cost or make embedding initialization lazy before making the
  stdio template the default.
- Check the endpoint path, bind-to-localhost behaviour, and occupied-port failure.

### 5. Verification (E2E)

- Fresh `claude` session in the workspace: confirm the context is present (ask for a fact from USER.md).
- Call `memory_search`, `episode_recent`, `habit_status`, `cron_list` through MCP.
- Create a cron job in plain Claude Code. Confirm the daemon fires it.
- Call `integ_calendar` through MCP.
- Confirm no orphan `pa mcp-server` processes after the session ends.

## Out of scope

- Session sync between Claude Code and PA session JSONL.

## Delivery note

- `pa claude` supplies generated settings/MCP config and starts Claude Code in `--restricted` mode. Bare `claude` is also
  supported when the caller exports `PA_CONFIG=<config-dir>` and starts in the initialized workspace; that path relies on
  the same PA PreToolUse policy but does not add Claude's restricted containment layer.
- The generated stdio MCP configuration is an explicit fallback when the localhost HTTP endpoint is unavailable. It is
  not the default because it starts an embedding model for that session.
