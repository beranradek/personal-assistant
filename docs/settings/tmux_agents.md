# Tmux agent sessions

Optional tool group `agent_session_*`. It lets the assistant start, watch, talk to and stop project coding agents (Claude Code)
in tmux sessions that this server owns. It is **off by default**: with `tmuxAgents.enabled=false` the tools are not registered
at all.

| Tool | Purpose |
|------|---------|
| `agent_session_start` | Start an agent in a project directory (`project`, `directory`, `kind`, `permissionMode`) |
| `agent_session_list` | List sessions of this server (never foreign tmux sessions) |
| `agent_session_status` | Alive? busy, idle, waiting_permission, waiting_trust or unknown (screen heuristic with confidence) |
| `agent_session_read` | Last screen lines, redacted and marked as untrusted |
| `agent_session_send` | Type a message and press Enter; optionally wait until the agent is idle |
| `agent_session_interrupt` | Press Ctrl-C |
| `agent_session_stop` | Graceful `/exit`, kill after a grace period; `force` kills at once |
| `agent_session_recover` | Forced restart: kill the session and start a NEW one in the same directory, kind and mode. Work is lost |
| `agent_session_attach` | Return the shell command to look at the session in your own terminal (never run by the tool) |

## Settings

Add to `~/.personal-assistant/settings.json`, then restart the daemon:

```json
"tmuxAgents": {
  "enabled": true,
  "allowedRoots": ["~/agent-projects"],
  "trustedRoots": [],
  "maxSessions": 2,
  "allowPermissionBypass": false
}
```

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `false` | Register the tools |
| `tmuxBinary` | `"tmux"` | tmux executable |
| `socketPath` | `""` | `""` = `<security.dataDir>/tmux-agents/tmux.sock`; otherwise an absolute path, below about 100 characters |
| `allowedRoots` | `[]` | Directories where agents may start. A start outside them is refused (`ROOT_NOT_ALLOWED`) |
| `trustedRoots` | `[]` | Entries of `allowedRoots` that may lie under a directory the assistant can write (see below) |
| `enabledKinds` | `["claude"]` | Agent kinds that may start. Only `claude` exists |
| `allowPermissionBypass` | `false` | Allow `permissionMode: "bypass"` (also needs `confirmBypass: true` in the call) |
| `allowAnswerPrompts` | `false` | Allow `send` to answer a permission prompt of the agent (never a trust dialog) |
| `maxSessions` | `3` | Maximum running sessions (counted from the registry and from tmux) |
| `minStartIntervalMs` | `10000` | Minimum time between two starts |
| `minSendIntervalMs` | `1500` | Minimum time between two messages to one session |
| `maxInputChars` | `4000` | Maximum length of a message |
| `defaultOutputLines` / `maxOutputLines` | `80` / `300` | Screen lines returned by `read` |
| `maxWaitMs` | `120000` | Upper limit for `waitForIdleMs` |
| `stopGraceMs` | `10000` | Time for a graceful `/exit` before the kill |
| `idleReapMinutes` | `0` | Stop idle sessions without input for this long. `0` = off |
| `envAllowlist` | `[]` | Extra environment variable names passed to tmux and so to every agent |

## Security notes

- **The agent is a privilege jump.** The daemon, tmux and the agent run outside the Agent SDK sandbox. A started agent can run
  any command that you can, once it is approved. That is why bypass mode has three gates (setting, `permissionMode`,
  `confirmBypass`), why answering permission prompts is off by default, and why the skill asks you first.
- **Choose `allowedRoots` outside every directory the assistant can write** (`security.workspace` and
  `security.additionalWriteDirs`). Otherwise the assistant could plant `.claude/settings.json` (a hook or a `Bash(*)` allow rule)
  in a project and start an agent there: the trust level then equals `exec`. A directory under a writable one is refused
  (`ROOT_NOT_TRUSTED`) unless its root is also listed in `trustedRoots`. Prefer one dedicated directory such as `~/agent-projects`.
  Agents start with `--setting-sources user`, so project settings are not loaded either way.
- **Remove `tmux` from `security.allowedCommands`** (and from the Claude Code hook allowlist). The tools run tmux themselves.
  With `tmux` in the Bash allowlist the assistant could run `tmux new-session '<anything>'` and bypass all guards. The daemon
  logs a WARN at start when it finds `tmux` there.
- **Text sent to an agent** may not start with `!` (shell line), `#` (memory note) or `/` (slash command; `/clear` and `/compact`
  are allowed) and may not contain control characters.
- **Output is untrusted data** (prompt injection). It is redacted with the conservative patterns, so long hashes may be masked
  (`redacted: true`).
- **The HTTP MCP server has no authentication.** It listens on `127.0.0.1` only and checks the `Host` and `Origin` headers, but
  any local process can call it, as it can already call `exec`.
- **The assistant confirms with you through chat only.** Literals such as `confirmBypass` and `userConfirmed` are written by the
  model, so they are a speed bump. The real barriers are these settings and, in Claude Code, the permission prompt.
- **Environment changes need a tmux restart.** The agent environment is fixed when the tmux server starts (first session). After
  you change `envAllowlist` or the daemon environment, stop all agent sessions (the server exits with the last one).
- **`agent_session_recover` is a forced restart.** It sends Ctrl-C, kills the old session and starts a new one. Unfinished work in
  the old session is lost.

## Look at a session yourself: the `pa-tmux` alias

The agents run on their own tmux server (socket), so plain `tmux attach` does not see them. Add an alias to `~/.zshrc`
(or `~/.bashrc`):

```bash
alias pa-tmux='tmux -S ~/.personal-assistant/data/tmux-agents/tmux.sock'
```

The path is `<security.dataDir>/tmux-agents/tmux.sock`. Use your `security.dataDir`, or `tmuxAgents.socketPath` when you set it.
Then:

```bash
pa-tmux ls                          # list sessions (before the first start: "no server running")
pa-tmux attach -t pa-myproj-1a2b    # work in the session
pa-tmux attach -r -t pa-myproj-1a2b # read-only
```

`agent_session_attach` returns the same commands with the real socket path. Detach with `Ctrl-b d`.

## Claude Code companion

The tools reach Claude Code as `mcp__pa__agent_session_*` through the localhost HTTP MCP server. Enable it first:

```json
"mcp": { "httpServer": { "enabled": true } }
```

Without this flag the `mcp__pa__*` tools are absent in Claude Code (the Claude Agent SDK backend registers them in process).

In Claude Code every MCP tool asks for approval unless it is allowed. To let the assistant work with agents on its own and keep
the destructive tools confirmed, allow these in the Claude Code settings (`stop` and `recover` keep prompting):

```json
{
  "permissions": {
    "allow": [
      "mcp__pa__agent_session_list",
      "mcp__pa__agent_session_status",
      "mcp__pa__agent_session_read",
      "mcp__pa__agent_session_attach",
      "mcp__pa__agent_session_start",
      "mcp__pa__agent_session_send",
      "mcp__pa__agent_session_interrupt"
    ]
  }
}
```

The repository template for the Claude Code settings is not changed.

## Skill

The skill is a repository template and is not installed automatically. Copy it into the workspace when you enable the feature:

```bash
mkdir -p ~/.personal-assistant/workspace/.claude/skills/tmux-agents
cp src/templates/skills/tmux-agents/SKILL.md ~/.personal-assistant/workspace/.claude/skills/tmux-agents/SKILL.md
```

Make sure `tmux` and `claude` are on the `PATH` that the daemon sees.

## Sessions and daemon restarts

Sessions live in tmux, not in the daemon. At start the daemon compares its registry (`<dataDir>/tmux-agents/registry.json`) with the
live sessions: survivors are adopted, vanished ones are marked `lost`, foreign sessions are only logged. If `pa-daemon.service`
uses the default `KillMode=control-group`, `systemctl restart` also kills the tmux server. Check with
`systemctl --user show pa-daemon.service -p KillMode`; use `KillMode=process`, or accept that sessions end on restart.
An audit trail is written to `<dataDir>/tmux-agents/audit.jsonl` (lengths and hashes of messages, never the text).

## Known limits

- The busy/idle detection reads the screen and depends on the Claude Code layout. The permission prompt and trust dialog texts
  are guesses until real screens are captured. Every status has `signal`, `confidence` and `evidence`.
- Only kind `claude` exists. A new kind needs one entry in `src/tmux-agents/kinds.ts` and one detector in `screen.ts`.
- tmux eats a trailing `;` of an argument, so the service sends trailing semicolons as hex keys.

## Acceptance example

Manual proof of 2026-11-05 (the tools must give the same result): `tmux new-session -d` starts the server and the session;
`capture-pane -p` returns the screen; busy shows a spinner line and `esc to interrupt`; idle shows `✻ ... done HH:MM`, an empty
`❯` prompt and no `esc to interrupt`; text and Enter in two `send-keys` calls work; `/exit` ends Claude Code, the last session
removes the tmux server and no process is left.
