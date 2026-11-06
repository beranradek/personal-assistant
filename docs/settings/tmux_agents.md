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
- **Typing into an agent yourself is your own action.** The writable panes of `pa agents-view` (and `pa-tmux attach`) let you answer
  permission prompts and trust dialogs and type anything, as in any terminal. The guards of the `agent_session_*` tools (input guard,
  prompt and trust refusals, rate limits) apply to the assistant only and are unchanged. Use `--read-only` to look without a risk of
  typing by mistake.
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
To see the assistant and all agents side by side without attaching by hand, use `pa agents-view` (next section).

## Agents view: the assistant and its agents on one screen

```bash
pa agents-view                                  # assistant (default command: pa claude) on the left, agents on the right
pa agents-view --assistant "claude"             # another assistant command (a full command, see below)
pa agents-view --assistant-cwd ~/dev/myproj     # start the assistant pane in this directory (default: the current directory)
pa agents-view -i --assistant "myalias"         # --interactive-shell: your aliases work (slower start, see below)
pa agents-view --read-only                      # agent panes are read-only (default: you can type into them)
pa agents-view --session work                   # use (or create) your tmux session `work` instead of `amy`
pa agents-view --no-attach                      # create the layout only
```

One command opens a window of YOUR OWN tmux (not the agents' dedicated server): the assistant runs in the left half and every agent
session that the assistant starts appears as a pane (a tmux client of the agents' server) stacked on the right. Panes appear when a
session starts and disappear when it ends (the nested attach exits). Each pane border shows the session name.

- Outside tmux it creates (or reuses) the session `amy` and attaches. Inside tmux without `--session` it adds a window `amy` to the
  current session and selects it. Running the command again reuses the existing view (idempotent); the options of the first run stay
  in effect (the controller was started with them).
- The view window is tagged (`@pa_view`), and the view is found by that tag, never by name: a window of yours that happens to be
  called `amy` is neither reused nor closed. A hidden window `amy-ctl-<n>` (tagged `@pa_ctl` with the id of its view window) runs the
  controller (`pa agents-view --watch <window>`, polls every 2 s). It ends when the view window or the assistant pane is gone;
  closing the assistant pane closes the view window (only a tagged one). The agent sessions are never touched.
- The controller shows only sessions that the service also has as running records in its registry (a `pa-...` session on the agents'
  server without a record is not ours and gets no pane). One session that cannot get a pane (for example "no space for new pane" in a
  small terminal) does not block the others: it is retried with a growing delay, and only failing to LIST sessions makes the controller
  give up after five ticks. Controller errors are written to `<security.dataDir>/tmux-agents/view.log` (mode 0600, one backup after
  256 KB); check it when panes do not appear.
- Close an agent pane by hand (`Ctrl-b x`) and it stays closed while that session lives. The session keeps running.
- The view needs `tmuxAgents.enabled: true` (otherwise it opens but no agent panes appear) and `tmux` 3.3 or newer for the 50 % wide
  assistant pane. On an older tmux (3.2a on Ubuntu 22.04) the view still works; it prints a note and the assistant pane keeps the
  default width of `main-vertical`.
- **While the view is open the idle reaper (`idleReapMinutes`) reaps nothing that is shown in it**, because every pane is a tmux
  client and the reaper skips sessions with an attached client. Close the pane, or the view, to let the reaper work again; the
  `maxSessions` limit still counts those sessions.
- It is a user command, not an assistant tool: no MCP tool reaches it, and it **refuses to run without a terminal** (stdin and
  stdout must be a TTY, also in the `--watch` mode, which needs `TMUX_PANE`). The assistant's Bash tool has no terminal, so it
  cannot start a view and so cannot run a shell command through `--assistant`. This is a guard on top of the Bash allowlist, which
  lists `pa` as a whole and does not look at its subcommands (a deny rule for `pa agents-view` in the Bash validator would be the
  stronger fix; it is tracked as a follow-up in the plan because `src/security/*` is out of scope here). The command uses its own tmux
  runner for your tmux (fixed subcommand allowlist, no shell, except the `--assistant` command that tmux itself runs). The view
  never changes options of the agents' tmux server.

### Typing into the agents

The agent panes are writable by default: click or select a pane (`Ctrl-b` and an arrow key, or the mouse when enabled) and type. Focus
decides which pane receives the keys: the assistant pane or one agent pane. Use `--read-only` for `attach -r` panes (keys typed there
do not reach the agent).

- The agent has ONE input line. Text you type by hand is not overwritten, and the assistant's `agent_session_send` appends its text
  after it. Type when the agent is idle or when the assistant is not sending to it. The guards of the assistant tools are
  unchanged: they apply to the assistant only, what you type yourself is your own action.
- The agent panes are nested tmux clients: press the prefix (`Ctrl-b`) twice to send it to the inner tmux (for example
  `Ctrl-b Ctrl-b d` detaches the inner client). The inner status line is visible at the bottom of each agent pane.
- Window size (checked on tmux 3.6 with the default `window-size latest`): an attached client, writable or read-only, sets the size of
  the agent's window to the size of its pane. With two clients the window follows the most recently active one, and it keeps the last
  size after the last client leaves. The assistant reads the screen with `capture-pane -J` (wrapped lines are joined), so a narrower
  window changes how many columns the agent draws, not how the assistant reads it. To get the original size back run
  `pa-tmux resize-window -t <session>: -x 200 -y 50` (this makes `window-size` manual for that one window, so later clients no
  longer resize it). The view itself never sets tmux options on the agents' server.

### The assistant command: directory, aliases, flags

- `--assistant-cwd <dir>` (default: the directory you run `pa agents-view` from) must be an existing directory; relative paths are
  resolved against the current directory. It is passed to tmux as `-c <dir>` for the assistant pane only, never for agent panes. Use
  it so that a plain `claude` finds `.mcp.json` in that directory (checked: the pane starts there).
- `--assistant` is a shell command line for your tmux (like `tmux new-window "<command>"`); you type it, the assistant never does.
  tmux runs it through the shell named by `$SHELL` with `-c` (checked with zsh, bash and sh): a NON-interactive shell, so `~/.zshrc` and
  `~/.bashrc` are not read and **aliases are not available** (checked: an alias gives "command not found"). Use the full command,
  for example `--assistant "claude --dangerously-skip-permissions"` (the flag is spelled `--dangerously-skip-permissions`), or a
  script on `PATH` such as `~/.local/bin/clauded`. Both are also the fastest start.
- `--interactive-shell` (short `-i`, default off) makes aliases work: the command runs as `<shell> -i -c "<command>"` with `$SHELL`
  (fallback `/bin/sh`), as separate arguments, so your rc files are loaded. Checked with zsh and bash (a temporary rc in a private
  `HOME`; your real rc files were never read); other shells are not verified (the command prints a note). Costs: the start waits for
  your rc files (measured with an rc that sleeps 1 s: the command started about 1.4 s later with zsh, 1.1 s with bash, against
  about 0.07 s without the flag); everything your rc prints appears in the assistant pane (checked); anything else your rc does
  (tools like nvm, prompts) happens too, and the interactive shell stays the parent process of the command (there is no `exec`: an
  alias is not expanded after `exec`, checked). No job-control warnings appeared in the tmux pane with zsh or bash.
- A plain `claude` is not the `pa claude` companion: it does not use the launcher-owned settings. It sees the tools
  `mcp__pa__agent_session_*` only when the `.mcp.json` of the start directory provides the `pa` MCP server and the daemon has
  `mcp.httpServer.enabled: true`.
- With bypass permissions (`--dangerously-skip-permissions`) there are no confirmation prompts, not even for `stop` and `recover`.
  Only the server-side guards remain (settings, roots, `confirmBypass`, input guard).

### Troubleshooting: the assistant command

- `The --assistant command "<word>" was not found on PATH ...`: the first word of a simple `--assistant` command is no program on the
  `PATH` of your shell, so it is most likely an alias or a function. `pa agents-view` refuses BEFORE it creates anything. Fix it with
  `--interactive-shell` (`-i`), the full command, or a script on `PATH` (see above). The check is skipped with `-i` and for commands
  with shell syntax (pipes, quotes, `;`, `$`, redirects), a path, a leading `NAME=value` or a shell builtin. It uses the `PATH` of
  your shell; a long running tmux server can have another one, so when the check is wrong for your setup use `-i` or the full path.
- `The assistant command exited immediately, so there is no view`: the command started but ended at once (wrong command, wrong
  arguments, a failing rc file, no login). tmux closes a window when its only pane ends, and a new tmux server exits with it, so
  nothing is left (the command removes what it had created). Run the same command by hand in a terminal to see its error.
  Earlier versions showed `tmux set-option failed: no server running ...` for this case.

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

The agent runs with the resolved absolute path. When the directory of the program is not on the daemon `PATH`, the agent gets it
APPENDED to its own `PATH` (through `/usr/bin/env`, so that wrappers and siblings of the program are found, while a directory such as
`~/.local/bin` cannot shadow system tools like `git`). A program path that contains `=` is refused (`env` would read it as an
assignment). The result is cached and checked
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
