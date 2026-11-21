# Remote `/cc new` and `/cc exit` - spawn a Claude Code session from chat

Status: IMPLEMENTED (see section 10 for the spike results and the changes against this plan).

## 1. Goal

From Slack (`/cc new`, `/cc exit`) and Telegram (`/new`, `/exit`) the user can:

- `new [name]`: the daemon starts a NEW Claude Code session (default `claude --dangerously-skip-permissions`) in the PA workspace.
  The session registers in the bridge like any other, the chat is attached to it at once, and a terminal window shows it on the
  daemon machine (when a display exists).
- `exit [n|name]`: end a session that the daemon started, and destroy its process and terminal window.

Non-goals: Windows support; killing sessions that the user started by hand; any new way for the PA agent (MCP) to start sessions.

## 2. Findings (verified in the repo and on this machine)

| Topic | Fact |
|-------|------|
| Session registration | A session appears in the bridge on its first hook poll (`listen-start`, SessionStart). Pid = `claude` ancestor of the hook (`src/claude/process-tree.ts`). The bridge cannot tell who started the process. |
| Hooks for a new session | `pa init --claude-remote` merges the hooks into `<workspace>/.claude/settings.json`. A plain `claude` in the workspace loads them. |
| Daemon env | `pa-daemon.service` is a systemd USER unit. Its manager env has `WAYLAND_DISPLAY`, `DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR` now. They are imported at login, so the unit can start BEFORE them (boot, linger). |
| Terminals here | GNOME on Wayland. `gnome-terminal`, `ghostty`, `x-terminal-emulator`, `tmux` exist. |
| Slack ack | A slash command needs an ack in 3 s (`src/adapters/slack.ts`). Claude startup takes longer: `/cc new` must ack at once and post the result as a DM. |
| tmux helpers | `src/tmux-agents/tmux-exec.ts` (`execTmux`, allowlist, no shell) is reusable. `tmuxAgents` (Amy tools, `enabled` flag, kind table, own registry) is NOT reusable: different trust model. |
| First-run dialogs | `--dangerously-skip-permissions` shows a one-time accept dialog. A new folder shows a trust dialog (`hasTrustDialogAccepted`). Both block the hooks until a human answers. Must be checked in a spike. |

## 3. Approach

Run the session in a tmux session on a DEDICATED socket (`<dataDir>/remote-tmux.sock`, dir mode 0700). Show it by starting a
terminal emulator that runs `tmux -S <sock> attach -t <name>`.

Why tmux (and not a bare terminal window):

- The daemon can stop the session (`kill-session`, send `/exit`) with no window handle or pid tracking.
- Closing the window only detaches the tmux client. The session lives on and chat keeps working.
- `/exit` typed in the visible terminal ends claude, tmux session and window together. `SessionEnd` removes it from the bridge.
- Works headless (no display): the session still runs, the notice shows the attach command.
- One mechanism for Linux and macOS. Only the "open a window" step differs per OS.

Rejected: (a) spawn a terminal emulator with claude directly - no reliable way to end it, no headless mode, emulator-specific
pid behavior; (b) `node-pty` inside the daemon - no visible terminal, daemon death kills the session; (c) reuse `tmuxAgents` -
its tools are for the PA agent, and its permission model forbids bypass mode by default.

## 4. Components

1. `src/remote/spawner.ts` - `createSessionSpawner(deps)`. Own tmux allowlist: `new-session`, `has-session`, `list-sessions`,
   `list-panes`, `send-keys`, `kill-session`. Session names `pa-cc-<n>` (fixed prefix + counter, never user text).
   - `start({ name?, cwd })` -> `{ tmuxName, panePid }`. Argv comes from config as an ARRAY (no shell).
   - `stop(tmuxName)` -> graceful (`send-keys /exit Enter`, wait `stopGraceMs`), then `kill-session`.
   - `list()` -> live `pa-cc-*` sessions with pane pid. Ownership = "exists in our tmux server". No persistent registry,
     so a daemon restart loses nothing.
2. `src/remote/terminal-opener.ts` - `openTerminal(attachArgv)` with an OS table, spawned `detached`, `stdio: ignore`, `unref`.
   Linux order: configured command, `gnome-terminal --`, `ghostty -e`, `kitty`, `konsole -e`, `xterm -e`, `x-terminal-emulator -e`.
   macOS: `osascript` for Terminal.app (iTerm when configured). Env for the child is rebuilt: `DISPLAY`, `WAYLAND_DISPLAY`,
   `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR` from `process.env`, else from `systemctl --user show-environment`.
   Failure never fails `new`: reply "started, no window: `tmux -S <sock> attach -t pa-cc-1`".
3. Bridge: owner mapping. New method `bridge.adoptSpawned(panePid, tmuxName)`: the first registered session whose pid is the pane
   pid or a descendant (use `process-tree.ts`) gets `spawned: { tmuxName }`. `RemoteSessionInfo` gets `spawned?: true`.
   `status` marks it `[started by PA]`. Alternative if the pid match is unreliable: pass `PA_REMOTE_SPAWN_ID` in the env and
   let the hook send it with the first poll (small hook change). Decide in the spike.
4. Control: `RemoteControlAction` gets `new` and `exit`. Flow of `new`: spawner start -> open terminal -> wait for registration
   (`newSession.registerTimeoutMs`, default 45 s) -> `attach` for the asking chat -> DM "Started and attached: ...".
   Timeout: notice "Session did not register (trust dialog? run: tmux ... attach)", kill nothing, keep it for the user.
5. Routers: Slack `/cc new [name]`, `/cc exit [n|name]` (ack at once with "Starting...", result by DM). Telegram `/new`, `/exit`.
   Help texts, Slack manifest `usage_hint`, docs updated.
6. Config `claudeCode.remote.newSession` (Zod, in `core/types.ts`):

   | Key | Default | Meaning |
   |-----|---------|---------|
   | `enabled` | `false` | Separate opt-in: it makes a no-permission-prompt session from a chat message |
   | `command` | `["claude", "--dangerously-skip-permissions"]` | Argv array. No shell, no placeholders |
   | `cwd` | `security.workspace` | Fixed directory. Chat text can never set it |
   | `maxSessions` | `3` | Limit of live spawned sessions |
   | `minStartIntervalMs` | `10000` | Anti-spam |
   | `registerTimeoutMs` | `45000` | Wait for the first poll |
   | `stopGraceMs` | `8000` | Wait after `/exit` before `kill-session` |
   | `terminal.mode` | `auto` | `auto`, `none`, or `custom` |
   | `terminal.command` | unset | Argv array with `{attach}` placeholder for `custom` |

## 5. Security

- `new` is for chat users in `allowedUserIds` only (same gate as the whole bridge). A DM that attaches can then run commands in a
  no-prompt session: the docs already warn about it. `newSession.enabled: false` by default, own opt-in.
- NOT exposed as MCP tool and NOT as a `/remote/control` action for the PA agent: a prompt-injected agent must not be able to
  start a bypass-permission session. Allowed callers: chat routers and local CLI `pa remote new|exit` (terminal only, like `agents-view`).
  Implementation: the bridge exposes `spawnControl` to routers directly; the HTTP route keeps `attach|detach|status`.
- Session name: chat text is only a label (cleaned, `REMOTE_MAX_NAME_CHARS`). tmux name is `pa-cc-<n>`.
- tmux: own socket, `-f /dev/null`, subcommand allowlist, no argument ending in `;`. Env is an allowlist (never the whole daemon env,
  never `PA_REMOTE_HOOKS=off`).
- `exit` works only on sessions that the spawner lists. It never kills a foreign pid.
- Audit: daemon log line per `new` and `exit` with chat key, tmux name, pid.

## 6. Failure and edge cases

| Case | Behavior |
|------|----------|
| `claude` not on the daemon PATH | `new` fails at once: "claude not found" (pre-flight like `tmux-agents/binary.ts`) |
| tmux not installed | `new` fails with a clear message |
| Dialog blocks the session | register timeout notice, session kept |
| No display | Headless session, notice with the attach command |
| User closes the window | Session lives, status unchanged. `/cc exit` still works |
| Daemon restart | tmux sessions survive, re-register on the next poll. `exit` still works (ownership from tmux) |
| `exit` while a turn runs | `/exit` is typed into the pane: may queue behind the turn. After `stopGraceMs`, `kill-session` |
| Two `new` in a row | `minStartIntervalMs` and `maxSessions` |
| Spawned session is attached to the other channel | `new` always creates a free session, so no conflict |

## 7. Tests

- Unit: spawner with fake `execFile` (argv, allowlist, naming, limits, graceful vs kill), terminal opener with a fake spawn (order,
  env rebuild, failure path), bridge `adoptSpawned`, routers (ack first, DM result), config schema.
- Integration: `*.tmux.test.ts` pattern of `tmux-agents` against real tmux with a fake `claude` script that runs the hook flow.
- E2E (manual, real Slack + real `claude`): checklist added to `docs/settings/claude_code_remote_slack.md` and the Telegram guide:
  `/cc new` shows a window, the DM gets "attached", a message gets an answer, `/cc exit` closes the window, `/cc status` is clean.
  Include pixel check of the window (title, size) and the closed-window and no-display cases.

## 8. Steps

0. Spike (throwaway): real `claude --dangerously-skip-permissions` in tmux on a fresh socket - pid match, first-run dialogs, hook
   registration time, `/exit` behavior, `gnome-terminal -- tmux attach` from the systemd unit env.
1. Config schema + tests. 2. Spawner + tests. 3. Terminal opener + tests. 4. Bridge adopt + control `new|exit` + tests.
5. Routers (Slack, Telegram) + CLI `pa remote new|exit` + tests. 6. Docs, manifest hint, checklists. 7. Real E2E.

## 9. Decisions and open questions

Decided by the user (2026-11-21):

1. Daemon host: laptop (visible window) and possibly the VPS (headless tmux, no window). So headless mode is a first-class case,
   not only a fallback: `terminal.mode: auto` opens a window only when a display exists, else it only replies with the attach command.
2. Terminal: auto-detect, override with `terminal.command`.
3. `exit` on a session not started by `new`: refuse.
4. `newSession.enabled` is a separate opt-in (default off). CLI `pa remote new|exit` yes. No MCP tool, no HTTP control action.

Resolved after the answers:

5. `/cc new <name>` passes the name with `-n, --name <name>` (verified in `claude --help`, version 2.1.330: "Set a display name for
   this session (shown in the prompt box, /resume picker, and terminal title)"). The tmux session name stays `pa-cc-<n>`.
   The name is cleaned to `[A-Za-z0-9 _.-]`, max 80 chars, and passed as ONE argv element (no shell). Hook payloads have NO session name field
   (hooks reference: session_id, cwd, transcript_path, ... only), so: the bridge keeps its own label (from the poll `name`, derived from the cwd) and shows the chosen name
   from the spawner record. Docs: https://code.claude.com/docs/en/cli-reference
7. First-run dialog (docs, permission-modes): the bypass warning shows once and then sets `skipDangerousModePermissionPrompt: true` in
   the USER file `~/.claude/settings.json` (already set on the laptop). No pre-flight check in code (user decision): the user runs
   `claude --dangerously-skip-permissions` by hand once on each new host (VPS) and the docs say so. The register timeout notice
   covers a stuck dialog. Hooks of a never-trusted folder: docs only cover `-p`/parent-trusted cases, so the
   spike must check the interactive first launch in the workspace.
6. VPS: `new` uses that host's `security.workspace` as cwd (user confirmed).

## 10. Spike results and changes against the plan (2026-11-21, claude 2.1.330, tmux 3.6, GNOME Wayland)

Spike (real `claude --dangerously-skip-permissions -n x` in tmux on an own socket):

- Pane pid == `claude` pid (tmux runs the argv directly). The session registered in the bridge within 12 s. No dialog (key already
  set in `~/.claude/settings.json`, workspace already trusted). So the bridge needs NO `adoptSpawned` and no hook change: the
  controller matches `status` sessions by `pid == panePid`.
- `send-keys -l /exit` + `Enter` ended claude, the tmux session and the registration (SessionEnd) within 4 s.
- `gnome-terminal -- tmux -S <sock> attach -t <name>` opened a window attached to the session (display variables of the systemd
  user manager were present).
- The bridge shows the session as `workspace-<pid>` (name comes from the hook poll). `--name` only sets the terminal title and the
  `/resume` name. `status` does not show the label.

Changes against sections 4 and 5:

- No bridge change. `withSpawnControl` (spawn-control.ts) wraps the bridge: `new` and `exit` go to it, the rest to the bridge.
- `new`/`exit` ARE actions of `POST /remote/control` (the CLI needs a route). Guards: no MCP tool, the CLI refuses without a TTY,
  the opt-in. Anyone with the local `remote-token` could already attach and inject text into a bypass session, so the token is the
  trust boundary.
- A tmux server started inside a systemd service dies with `systemctl --user restart` (control-group kill). The server and the
  terminal window start in a transient scope (`systemd-run --user --scope`) when `INVOCATION_ID` is set.
- `exit` accepts a number, a name, the label or the tmux name.
