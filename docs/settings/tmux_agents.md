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
| `allowedRoots` | `[]` | Where agents may start. Elsewhere: `ROOT_NOT_ALLOWED` (lists them). Also in `agent_session_list` |
| `trustedRoots` | `[]` | Entries of `allowedRoots` that may lie under a directory the assistant can write (see below) |
| `enabledKinds` | `["claude"]` | Agent kinds that may start. Only `claude` exists |
| `agentBinaries` | `{}` | Optional override: absolute path of the agent program per kind (`~` allowed). Normally not needed, see below |
| `allowPermissionBypass` | `false` | Allow `permissionMode: "bypass"` (also needs `confirmBypass: true` in the call) |
| `allowAnswerPrompts` | `false` | Allow `send` to answer a permission prompt of the agent (never a trust dialog) |
| `maxSessions` | `3` | Maximum running sessions (counted from the registry and from tmux) |
| `minStartIntervalMs` | `10000` | Minimum time between two starts |
| `minSendIntervalMs` | `1500` | Minimum time between two messages to one session |
| `maxInputChars` | `4000` | Maximum length of a message |
| `defaultOutputLines` / `maxOutputLines` | `80` / `300` | Screen lines returned by `read` without `lines` / the upper limit |
| `maxWaitMs` | `120000` | Upper limit for `waitForIdleMs` |
| `stopGraceMs` | `10000` | Time for a graceful `/exit` before the kill |
| `idleReapMinutes` | `0` | Stop idle sessions without input for this long (never one with an attached client). `0` = off |
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
- **The HTTP MCP server has no authentication.** It listens on `127.0.0.1` only. It requires a `Host` of `127.0.0.1:<port>` or
  `localhost:<port>` and, when an `Origin` header is present, an `Origin` equal to that host (a page from another local port is
  refused). Any local process can still call it, as it can already call `exec`.
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

## Agents view: the assistant and its agents on one screen

```bash
pa agents-view                                  # assistant (default command: pa claude) on the left, agents on the right
pa agents-view --assistant "pa terminal"        # another assistant command
pa agents-view --session work                   # use (or create) your tmux session `work` instead of `amy`
pa agents-view --no-attach                      # create the layout only
```

One command opens a window of YOUR OWN tmux (not the agents' dedicated server): the assistant runs in the left half and every agent
session that the assistant starts appears as a read-only pane (`attach -r`) stacked on the right. Panes appear when a session starts
and disappear when it ends (the nested attach exits). Each pane border shows the session name.

- Outside tmux it creates (or reuses) the session `amy` and attaches. Inside tmux without `--session` it adds a window `amy` to the
  current session and selects it. Running the command again reuses the existing view (idempotent).
- A hidden window `amy-ctl` runs the controller (`pa agents-view --watch <window>`, polls every 2 s). It ends when the view window or
  the assistant pane is gone; closing the assistant pane closes the view window. The agent sessions are never touched.
- Close a mirror pane by hand (`Ctrl-b x`) and it stays closed while that session lives. The session keeps running.
- `--assistant` is a shell command line for your tmux (like `tmux new-window "<command>"`); it is typed by you, never by the assistant.
- The mirror panes are nested tmux clients: press the prefix (`Ctrl-b`) twice to send it to the inner tmux (for example
  `Ctrl-b Ctrl-b d` detaches the mirror). The inner status line is visible at the bottom of each mirror pane.
- To type into an agent, use the `pa-tmux attach -t <session>` alias from the section above in another terminal.
- The view needs `tmuxAgents.enabled: true` (otherwise it opens but no agent panes appear) and `tmux` 3.x.
- It is a user command, not an assistant tool: the assistant cannot run it, and it uses its own tmux runner for your tmux (fixed
  subcommand allowlist, no shell, except the `--assistant` command that tmux itself runs).

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

The Claude Code settings template already contains these entries, so a new `init` for Claude Code sets them. `init` never overwrites
an existing settings file; for an existing install add the snippet by hand.

## Behaviour notes

- **Unrecognized screen.** `send` refuses with `UNKNOWN_STATE` while the screen matches no known state (the agent may start or
  show a dialog). A numbered menu or an "Esc to cancel" footer counts as `waiting_permission`. The caller reads the screen, then
  retries with `allowUnknownState: true`; that flag never overrides a dialog. A graceful `stop` is refused the same way (it types
  `/exit` and Enter); use a forced stop with `userConfirmed` after you looked at the screen.
- **Waiting for the answer.** `waitForIdleMs` can return early when the agent shows no busy phase within about 2 seconds and the
  screen stays unchanged. Check with `agent_session_status` or `agent_session_read` when the result looks incomplete.
- **Input guard.** No line of a message may start with `!`, `#` or `/` (a pasted line can be submitted on its own when the
  agent does not use bracketed paste). Only `/clear` and `/compact` pass, as a single line.
- **Stop and recover verify the kill.** After `kill-session` the service checks that the session is gone. If not, the call fails
  with `TMUX_ERROR` and the record stays `running` (no hidden orphan).
- **Registry.** Stopped and lost records are dropped 7 days after they ended. The registry lock of a dead process is taken over
  after 2 seconds (10 seconds for a live pid).
- **tmux config and socket directory.** Every tmux call runs with `-f /dev/null -u`, so `~/.tmux.conf` is ignored and tmux uses
  UTF-8 without a UTF-8 `LANG`. The socket directory must be owned by the daemon user and not writable by group or others,
  or the first call fails.

## Agent program and `PATH`

tmux and so the agent get only the allowlisted environment, including the `PATH` of the daemon. A systemd user service often has a
short `PATH` without `~/.local/bin`, where the native `claude` installer puts the program. The service therefore finds the program
itself and needs no setting. `start` resolves it BEFORE it creates a session, in this order:

1. `tmuxAgents.agentBinaries.<kind>`: an optional override (absolute path, `~` allowed). It must be an executable file; there is no
   fallback when it is not.
2. The `PATH` of the daemon.
3. The usual install locations of the kind. For `claude`: `~/.local/bin/claude`, `~/.claude/local/claude`,
   `~/.npm-global/bin/claude`, `~/.bun/bin/claude`, `~/.volta/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`
   (`~` is the home directory of the daemon user). The first executable regular file wins; symlinks are followed.

The agent runs with the resolved absolute path. When the directory of the program is not on the daemon `PATH`, the agent gets it first
on its own `PATH` (through `/usr/bin/env`, so that wrappers and siblings of the program are found). The result is cached and checked
again on every start; a failure is not cached, so a program installed later is found without a restart. The resolved path is logged
once at INFO (`Agent program resolved`). If nothing is found, `start` fails with `AGENT_BINARY_NOT_FOUND`, which lists the searched
`PATH` and locations. Only then set the override:

```json
"tmuxAgents": { "agentBinaries": { "claude": "~/.local/bin/claude" } }
```

Find the path with `which claude`. If a session still ends right after start (not logged in, wrong flags, crash),
`start` marks it `lost` and the hint contains the exact command: run it by hand in the project directory to see the error.

## Skill

The skill template `src/templates/skills/tmux-agents/SKILL.md` is copied to
`<workspace>/.claude/skills/tmux-agents/SKILL.md` together with the `integrations` skill when the workspace is prepared
(at daemon start; an existing file is never overwritten). While the feature is disabled the skill only tells the assistant
how to enable it. Make sure `tmux` and `claude` are on the `PATH` that the daemon sees.

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
