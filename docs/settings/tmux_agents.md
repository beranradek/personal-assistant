# Tmux agent sessions

Optional tool group `agent_session_*`. The assistant can start, watch, talk to and stop project coding agents (Claude Code) in
tmux sessions that this server owns. You can see the assistant and all its agents on one screen with `pa agents-view`.
It is **off by default**: with `tmuxAgents.enabled=false` the tools are not registered at all.

Use it to hand a coding task in a project directory to a long-lived agent (for example "list the TODOs in ~/agent-projects/x") and
to follow or steer the work yourself.

```
assistant (Telegram, terminal, Claude Code)
   |  agent_session_* tools (MCP)
   v
TmuxAgentService  --registry.json, audit.jsonl-->  <dataDir>/tmux-agents/
   |  tmux -S <socket> ... (fixed subcommands, no shell)
   v
dedicated tmux server (own socket) --> sessions pa-<project>-<4 hex> --> claude
   ^
   |  attach (read-write or read-only)
pa agents-view (YOUR tmux: assistant pane left, one pane per agent right)  /  pa-tmux attach
```

## 1. Quick start

1. Add to `~/.personal-assistant/settings.json` and restart the daemon (`scripts/restart-pa-daemon.sh --restart`):

   ```json
   "tmuxAgents": {
     "enabled": true,
     "allowedRoots": ["~/agent-projects"],
     "maxSessions": 2
   },
   "mcp": { "httpServer": { "enabled": true } }
   ```

   Choose `allowedRoots` OUTSIDE every directory the assistant can write (see Security). `mcp.httpServer.enabled` is needed only
   for Claude Code and Codex (`mcp__pa__*` tools); the Claude backend registers the tools in process.
2. Check the daemon log for `Tmux agent sessions enabled` (socket, roots, limits) and that there is no WARN about `tmux` in
   `security.allowedCommands`.
3. The skill is copied by the daemon at start to `<workspace>/.claude/skills/tmux-agents/SKILL.md` (an existing file is never
   overwritten, see "Skill").
4. Claude Code only: the settings template already allows the seven non-destructive tools, so a new `init` sets them. For an existing
   install add this to the Claude Code settings (`stop` and `recover` keep asking):

   ```json
   { "permissions": { "allow": [
     "mcp__pa__agent_session_list", "mcp__pa__agent_session_status", "mcp__pa__agent_session_read",
     "mcp__pa__agent_session_attach", "mcp__pa__agent_session_start", "mcp__pa__agent_session_send",
     "mcp__pa__agent_session_interrupt"
   ] } }
   ```
5. Add the alias for your own terminal to `~/.zshrc` (path: `<security.dataDir>/tmux-agents/tmux.sock`, or `tmuxAgents.socketPath`):

   ```bash
   alias pa-tmux='tmux -S ~/.personal-assistant/data/tmux-agents/tmux.sock'
   ```
6. Try: "start a Claude agent for project X in ~/agent-projects/X, ask it to list the TODOs, then stop it". Look at it with
   `pa-tmux ls` and `pa-tmux attach -t pa-x-1a2b` (add `-r` for read-only), or open `pa agents-view` first. Detach with `Ctrl-b d`.

## 2. Configuration reference (`tmuxAgents`)

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `false` | Register the tools and start the service |
| `tmuxBinary` | `"tmux"` | tmux executable |
| `socketPath` | `""` | `""` = `<security.dataDir>/tmux-agents/tmux.sock`; else an absolute path, below about 100 characters |
| `sessionPrefix` | `"pa-"` | Fixed; only sessions with this prefix and a registry record are ours |
| `allowedRoots` | `[]` | Absolute directories (`~` allowed) where agents may start; else `ROOT_NOT_ALLOWED`. Shown by `list` |
| `trustedRoots` | `[]` | Subset of `allowedRoots` that may lie under a directory the assistant can write |
| `enabledKinds` | `["claude"]` | Agent kinds that may start (only `claude` exists) |
| `agentBinaries` | `{}` | Optional override: absolute path of the agent program per kind (`~` allowed). Normally not needed |
| `allowPermissionBypass` | `false` | Allow `permissionMode: "bypass"` (the call also needs `confirmBypass: true`) |
| `allowAnswerPrompts` | `false` | Allow `send` to answer a permission prompt (never a trust dialog) |
| `maxSessions` | `3` (1-10) | Maximum running sessions, counted from the registry and from tmux |
| `minStartIntervalMs` | `10000` | Minimum time between two starts |
| `minSendIntervalMs` | `1500` | Minimum time between two messages to one session |
| `maxInputChars` | `4000` (max 20000) | Maximum length of a message |
| `defaultOutputLines` / `maxOutputLines` | `80` / `300` | Lines returned by `read` without `lines` / upper limit |
| `maxWaitMs` | `120000` (max 300000) | Upper limit for `waitForIdleMs` |
| `stopGraceMs` | `10000` (1000-60000) | Time for a graceful `/exit` before the kill |
| `idleReapMinutes` | `0` | Stop idle sessions without input for this long (never one with an attached client). `0` = off |
| `envAllowlist` | `[]` | Extra environment variable names passed to every agent |

Base environment of every agent: `PATH, HOME, LANG, LC_ALL, TERM, USER, LOGNAME, SHELL, TMPDIR` plus `envAllowlist`.
Permission modes of an agent: `default`, `acceptEdits`, `plan`, `bypass`. The agent command is `claude --setting-sources user`
(project settings are not loaded), plus `--permission-mode ...` or `--dangerously-skip-permissions`.

Files (in `<security.dataDir>/tmux-agents/`, directory 0700, files of the service 0600): `tmux.sock`, `registry.json` (records),
`audit.jsonl` (action, session, lengths and hashes of messages, never the text), `view.log` (errors of the `agents-view` controller).

## 3. Tools

Default channel to an agent is `agent_session_send` (plus `read` and `status`): the server checks input, rate and state.

- `agent_session_start`: `project`, `directory`, `kind`, `permissionMode`, `confirmBypass`. Waits about 3 s and returns the state,
  `attachCommand` and a `hint`. Errors: `ROOT_NOT_ALLOWED`, `ROOT_NOT_TRUSTED`, `TOO_MANY_SESSIONS`, `AGENT_BINARY_NOT_FOUND`,
  `BYPASS_NOT_ALLOWED`.
- `agent_session_list`: sessions of this server (`includeStopped`) plus `allowedRoots`. Never lists foreign tmux sessions.
- `agent_session_status`: alive, state `busy`, `idle`, `waiting_permission`, `waiting_trust` or `unknown`, with `signal`,
  `confidence` and `evidence`.
- `agent_session_read`: last `lines` of the screen, redacted, `untrusted: true`.
- `agent_session_send`: `text`, `waitForIdleMs`, `queueWhileBusy`, `answerPermissionPrompt`, `allowUnknownState`. Returns `newOutput`
  (the reply only; `source: "hook"` = the complete final answer to exactly this message, `source: "screen"` = visible pane
  only, may be incomplete; see "Exact answers" below).
  Errors: `BUSY`, `WAITING_PERMISSION`, `WAITING_TRUST`, `UNKNOWN_STATE`, `RATE_LIMITED`, `INVALID_INPUT`.
- `agent_session_interrupt`: Ctrl-C.
- `agent_session_stop`: graceful `/exit`, kill after `stopGraceMs`. Refused while busy, waiting or unrecognized; `force` needs
  `userConfirmed: true`.
- `agent_session_recover`: forced restart: kill, then a NEW session in the same directory, kind and mode (all start gates again).
  Work is lost. Needs `userConfirmed`.
- `agent_session_attach`: returns the shell command to attach yourself (`readOnly` by default). Never run by the tool.

Error codes: `INVALID_INPUT`, `ROOT_NOT_ALLOWED`, `ROOT_NOT_TRUSTED`, `TOO_MANY_SESSIONS`, `RATE_LIMITED`, `NOT_FOUND`, `NOT_OWNED`,
`BUSY`, `WAITING_PERMISSION`, `WAITING_TRUST`, `UNKNOWN_STATE`, `BYPASS_NOT_ALLOWED`, `AGENT_BINARY_NOT_FOUND`, `TMUX_ERROR`, `TIMEOUT`.

**Input rules.** No line of a message may start with `!` (shell line), `#` (memory note) or `/` (slash command; `/clear` and `/compact`
pass as a single line), and no control characters. A message is typed as one line, or pasted (bracketed paste) when it has several.
`UNKNOWN_STATE`: the screen matches no known state, the agent may be starting or show a dialog. Read the screen, then retry with
`allowUnknownState: true` (never to answer a dialog). A numbered menu or "Esc to cancel" counts as `waiting_permission`.

**Peer messaging (Claude Code `ListAgents`, `SendMessage`) is not the default.** Verified in a real run: an assistant started with
`--dangerously-skip-permissions` messaged an agent in default mode, and Claude Code HELD the message in the agent session ("Held peer
message ... permission mode class doesn't match") until a person approves it there. That is a deliberate safety feature. Do NOT set
`crossSessionInbound` to `"accept"` to get around it: the agent would then take instructions from any session of the same user.
You can approve a single held message by hand in the agent pane. Peer messaging is sensible only when both sessions run in the
same permission mode.

### Exact answers (`source: "hook"`)

The screen of a fullscreen Claude Code agent is only a viewport (tmux keeps no history for it), so a long answer does not fit and
the viewport may be scrolled away from its end. `send` therefore reads the answer from the agent's own hooks:

- The service writes `<dataDir>/tmux-agents/answers/<session>.settings.json` per session and starts the agent with
  `--settings <that file>` (together with `--setting-sources user`, so project hooks stay off, D20). The file defines a
  `UserPromptSubmit` and a `Stop` hook; both append their JSON payload to `<session>.jsonl` next to it. The hook commands are fixed
  by the service and contain no user or agent text.
- Both payloads carry the same `prompt_id`. `send` notes the size of the file before it types, finds the first new prompt with
  exactly the text it sent, and returns the `last_assistant_message` of the `Stop` record with the same `prompt_id`. An answer to a
  message typed by someone else in the pane, an older answer or the answer of another session is never returned.
- No prompt record (hooks did not run, a slash command) or no `Stop` record (the turn was interrupted) gives the screen fallback with
  `source: "screen"`. The result still passes through the redactor and is marked `untrusted`.
- Both files are deleted when the session ends. The answer file holds agent output in clear text: it is private to the daemon user
  (directory `0700`, settings `0600`).
- Verified with real Claude Code 2.1.319 in tmux: `PA_E2E_REAL_CLAUDE=1 PA_E2E_PROJECT_DIR=<trusted project> npx vitest run
  src/tmux-agents/real-claude.e2e.test.ts` (a 150-line answer comes back complete; the next answer is not mixed with it).
- The hook input fields come from the Claude Code docs (hooks reference: `Stop` has `last_assistant_message`). The transcript file
  format is NOT used: the docs call it internal and unstable.

## 4. `pa agents-view`: the assistant and its agents on one screen

```bash
pa agents-view                                  # assistant (default command: pa claude) left, agents right
pa agents-view --assistant "claude --dangerously-skip-permissions"
pa agents-view --assistant-cwd ~/dev/myproj     # assistant pane starts here (default: the current directory)
pa agents-view -i --assistant "myalias"         # --interactive-shell: your aliases work
pa agents-view --read-only                      # agent panes read-only (default: you can type into them)
pa agents-view --session work                   # your tmux session `work` instead of `amy`
pa agents-view --no-attach                      # create the layout only
```

| Option | Meaning |
|--------|---------|
| `--assistant <cmd>` | Shell command line of the left pane (default `pa claude`). You type it; the assistant never does |
| `--assistant-cwd <dir>` | Existing directory for the assistant pane only (default: the current one); `claude` finds `.mcp.json` there |
| `-i`, `--interactive-shell` | Run the command as `$SHELL -i -c "<cmd>"` so rc files and aliases load (verified with zsh and bash only) |
| `--read-only` | Agent panes use `attach -r` |
| `--session <name>` | Use or create this tmux session (default `amy`) |
| `--no-attach` | Do not attach or switch to the view |

How it works. It opens a window of YOUR OWN tmux (not the agents' server): the assistant on the left (50 % width, tmux 3.3 or
newer; older tmux keeps its default and prints a note), and every agent session as a stacked pane on the right (a nested
`tmux attach` to the agents' server; the pane border shows the session name). A hidden window `amy-ctl-<n>` runs a controller
(`pa agents-view --watch <window>`, every 2 s) that adds a pane for each session the registry has as running. A pane disappears
when its session ends. A pane you close by hand (`Ctrl-b x`) is not re-added while that session lives. The controller ends with the
view window or the assistant pane (closing the assistant pane closes the view, never the agents). One session that cannot get a
pane (for example no space) does not block the others; only failing to list sessions five times in a row stops it. Errors go to
`view.log`. Windows are found by tags (`@pa_view`, `@pa_ctl`), never by name, so your own window called `amy` is left alone.
Outside tmux it creates or reuses the session and attaches; inside tmux it adds a window to the current session. Running it again
reuses the view (the options of the first run stay).

Typing. Agent panes are writable by default; focus decides which pane gets the keys. The agent has ONE input line: text you type is
not overwritten and the assistant's `agent_session_send` appends to it, so type while the agent is idle or the assistant is not sending.
Panes are nested tmux clients: press the prefix twice (`Ctrl-b Ctrl-b d`) to reach the inner tmux. With two clients attached, the
agent window follows the most recently active one (`window-size latest`); to restore the size use
`pa-tmux resize-window -t <session>: -x 200 -y 50`. Your own typing is your action; the guards of the tools apply to the assistant only.

The assistant command.
- tmux runs `--assistant` through `$SHELL -c`, a non-interactive shell: **aliases are not available** ("command not found"). Use the
  full command, a script on `PATH` (for example `~/.local/bin/clauded`), or `-i` (start is slower: it waits for your rc files, about
  1 s extra with a slow rc; everything the rc prints appears in the pane).
- A plain `claude` is not the `pa claude` companion (no launcher-owned settings). It sees `mcp__pa__agent_session_*` only if the `.mcp.json`
  of its directory provides the `pa` MCP server and `mcp.httpServer.enabled` is true.
- With bypass permissions there are no confirmation prompts, not even for `stop` and `recover`; only the server-side guards remain.

Troubleshooting.
- `The --assistant command "<word>" was not found on PATH`: most likely an alias; use `-i`, the full command or a script. The check
  runs before anything is created, and is skipped with `-i`, shell syntax, a path, `NAME=value` or a shell builtin.
- `The assistant command exited immediately, so there is no view`: wrong command, arguments, failing rc file or not logged in. Run the
  same command by hand. Nothing is left behind.
- No agent panes: check `tmuxAgents.enabled`, `view.log`, and that the sessions are in the registry (`agent_session_list`).

The view is a user command, not an assistant tool, and **refuses to run without a terminal** (stdin and stdout must be a TTY; the
controller needs `TMUX_PANE`). The assistant's Bash tool has none, so it cannot open a view or run a shell command through
`--assistant`. It uses its own tmux runner for your tmux (fixed subcommand allowlist, no shell except the `--assistant` command)
and never changes options of the agents' server. While the view shows a session, that session counts as attached, so the idle
reaper skips it.

## 5. Security

- **The agent is a privilege jump.** The daemon, tmux and the agent run outside the Agent SDK sandbox; a started agent can run any
  command you can, once approved. Hence three gates for bypass (setting, `permissionMode`, `confirmBypass`), answering prompts off
  by default, and the skill asks you first. Literals such as `confirmBypass` and `userConfirmed` are written by the model: a speed
  bump. The real barriers are the settings and, in Claude Code, the permission prompt.
- **`allowedRoots` outside every directory the assistant can write** (`security.workspace`, `security.additionalWriteDirs`).
  Otherwise the assistant could plant `.claude/settings.json` (a hook or `Bash(*)`) in a project and start an agent there, which
  equals `exec`. A directory under a writable one is refused (`ROOT_NOT_TRUSTED`) unless its root is also in `trustedRoots`.
  A directory containing `#` is refused. Prefer one dedicated directory such as `~/agent-projects`.
- **Remove `tmux` from `security.allowedCommands`** (and from the Claude Code hook allowlist); the tools run tmux themselves. With
  `tmux` allowed the assistant could bypass all guards through Bash. The daemon logs a WARN when it finds it.
- **`pa` is in the default `allowedCommands` as a whole**, so subcommands are not filtered. `pa agents-view` is protected by the
  terminal requirement only; a deny rule in the Bash validator is a follow-up.
- **Output is untrusted data** (prompt injection): redacted with the conservative patterns (long hashes may be masked,
  `redacted: true`) and marked `untrusted`. The assistant never follows instructions found in it.
- **Not protected:** the agent's own tools in bypass or auto mode; `~/.claude/settings.json` of the user is loaded by every agent
  (keep it free of broad allow rules); the HTTP MCP server has no authentication (127.0.0.1 only; `Host` must be `127.0.0.1:<port>` or
  `localhost:<port>`, an `Origin` header must equal that host; any local process can still call it, as it can call `exec`).
- **tmux isolation:** every call runs with `-f /dev/null -u -S <socket>` (no `~/.tmux.conf`, UTF-8), ids (`$N`, `%N`) as targets, a fixed
  subcommand allowlist, never `kill-server`. The socket directory must be owned by the daemon user and not group or world writable.
  The environment is fixed when the tmux server starts: after changing `envAllowlist` stop all sessions (the server exits with the last).
- **Operator checklist:** `systemctl --user show pa-daemon.service -p KillMode`; with `control-group` a daemon restart kills the
  tmux server (use `KillMode=process`, or accept that sessions end; reconcile marks them `lost`). Check that
  `~/.personal-assistant/bin/codex-watchdog.sh` does not kill `claude` or `tmux`.

## 6. Behaviour notes and limits

- **Agent program.** Resolved BEFORE a session is created: `agentBinaries.<kind>` (no fallback when set), then the daemon `PATH`, then
  usual install locations (for `claude`: `~/.local/bin`, `~/.claude/local`, `~/.npm-global/bin`, `~/.bun/bin`, `~/.volta/bin`,
  `/usr/local/bin`, `/opt/homebrew/bin`). The agent runs by absolute path with the program's directory appended to its `PATH`; a path
  containing `=` is refused. Not found: `AGENT_BINARY_NOT_FOUND` lists what was searched; then set the override
  (`"agentBinaries": { "claude": "~/.local/bin/claude" }`, find it with `which claude`). A session that ends right after start is marked
  `lost` and the `hint` has the exact command to run by hand.
- **Daemon restarts.** Sessions live in tmux. At start the service compares the registry with live sessions: survivors adopted,
  vanished ones `lost`, foreign `pa-` sessions only logged. Stopped and lost records are dropped 7 days after they ended. A registry
  lock of a dead process is taken over after 2 s (10 s for a live pid).
- **Stop and recover verify the kill** (`has-session` afterwards); if the session survives the call fails with `TMUX_ERROR` and the
  record stays `running`. A graceful `stop` types `/exit` and Enter, so it is refused on an unrecognized screen.
- **Skill.** Template `src/templates/skills/tmux-agents/SKILL.md` is copied next to `integrations`; an existing workspace copy is never
  overwritten and `version` is not compared, so after a skill change copy it by hand:
  `cp <repo>/src/templates/skills/tmux-agents/SKILL.md ~/.personal-assistant/workspace/.claude/skills/tmux-agents/SKILL.md`.
- **Limits.** Busy/idle detection reads the screen and depends on the Claude Code layout (tested with 2.1.319); the permission prompt
  and trust dialog texts are guesses (a numbered menu or "Esc to cancel" is caught generically). `waitForIdleMs` can return early
  when the agent shows no busy phase within about 2 s; check with `status` or `read` when a result looks incomplete. With
  `source: "screen"` a long reply is cut to the visible pane (Claude Code fullscreen keeps no tmux history); `read` and the state checks
  send Ctrl+End first when the viewport shows `(ctrl+End)` (scrolled away from the end). Only kind `claude` exists (a new kind needs an
  entry in `src/tmux-agents/kinds.ts` and a detector in `screen.ts`). tmux eats a trailing `;` of an argument; the service sends
  trailing semicolons as hex keys.
- **Acceptance example** (manual proof 2026-11-05; the tools give the same result): `new-session -d` starts the server and the session;
  `capture-pane -p` shows the screen; busy has a spinner line and `esc to interrupt`, idle shows `✻ ... done HH:MM` and an empty `❯`
  prompt; text and Enter in two `send-keys` calls work; `/exit` ends Claude Code, the last session removes the tmux server.
