# Claude Code companion mode

Use this mode when a Claude Code session should use the same Personal Assistant
(PA) context and controlled tools as the PA terminal or adapters.

## Prerequisites

- The `pa` CLI and Claude Code CLI (`claude`) are installed and authenticated.
- PA has a valid configuration file. `PA_CONFIG` is the path to the directory
  containing `settings.json`; it is not configuration content and must never
  contain credentials.
- For the default MCP connection, enable PA's localhost HTTP MCP service:

  ```json
  { "mcp": { "httpServer": { "enabled": true } } }
  ```

  The service binds to `127.0.0.1:47392`. Keep the PA daemon running when the
  session needs scheduled jobs to fire.

## One-time setup

From an existing PA installation, run:

```bash
pa init --claude-code
```

With a non-default configuration directory:

```bash
PA_CONFIG=/path/to/pa-config pa init --claude-code
```

This adds non-overwriting workspace templates: `.mcp.json` for the local PA MCP
server and `.claude/settings.json` for the SessionStart and policy hooks. It also
stores the launcher-owned Claude settings in
`$PA_CONFIG/claude-code/settings.json` with owner-only permissions. If the HTTP
port is unavailable, the generated `.mcp-stdio-fallback.json` can be explicitly
used as the replacement MCP configuration after resolving the conflict.

## Run Claude Code

Recommended launcher:

```bash
pa claude
```

It exports `PA_CONFIG`, runs Claude with `--restricted`, supplies only PA's
configured read/write directories, and loads launcher-owned settings outside the
workspace. PA MCP mutations are permitted because PA validates them itself.

Direct Claude launch is also supported after the one-time setup:

```bash
cd /path/to/workspace
PA_CONFIG=/path/to/pa-config claude
```

The project hook then loads the same `settings.json`, context files, PA command
allowlist, and path policy. Claude can use PA MCP tools for memory, episodes,
cron, processes, habits, and Gmail/Calendar/Slack proxy operations; tokens stay
inside PA rather than in the Claude project.

## Remote mode (Telegram)

You can attach your phone to a live companion session through a Telegram bot. See
[claude_code_remote_session.md](claude_code_remote_session.md).

## Security expectations

Prefer `pa claude`. Its restricted mode and external launcher settings are
defense in depth, not an OS sandbox against a hostile prompt or arbitrary code
run by broadly allowed interpreters. A direct `claude` session is compatible,
but is not a security boundary. Avoid `--dangerously-skip-permissions` unless you
accept that no tool call needs approval (the PA security hook still runs). The
[remote session mode](claude_code_remote_session.md) is a deliberate case: there a Telegram
message becomes a prompt, so only use it with an allowlisted Telegram user. Do not put
credentials into generated files or replace an existing user-managed `.mcp.json`.

Calendar RSVP is an external side effect and still needs the user's explicit
instruction. Claude Code may keep its own protections for configuration and Git
files in restricted mode; PA does not bypass those safeguards.
