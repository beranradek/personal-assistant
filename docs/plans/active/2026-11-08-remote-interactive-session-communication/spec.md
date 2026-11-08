# Remote interactive session communication - Specification

**Date:** 2026-11-08 (revised after the feasibility experiment, same day)
**Status:** Implemented 2026-11-08 (real Telegram check pending)
**Related:** [Claude Code companion mode](../../../settings/claude_code_companion.md),
[implementation plan](implementation-plan.md)

## 1. Goal

The user runs a Claude Code companion session (`pa claude`, or plain `claude --dangerously-skip-permissions`) on a laptop.
The user wants to talk to this live session from a phone through Telegram.

- A Telegram message goes into the running session as a new user turn.
- The session handles it as a normal prompt. It keeps its own history.
- The PA daemon (not the model) sends progress and the final answer back to Telegram.
- The mode is on demand. The user attaches to a session when needed and detaches later.
- The laptop uses its OWN new Telegram bot. The old bot stays on the VPS assistant.

## 2. Feasibility experiment result (2026-11-08)

| Question | Result |
|---|---|
| Account | claude.ai login, subscription `team`, org "Etnetera Core" |
| Claude Code Channels (`--dangerously-load-development-channels`) | **Blocked by org policy**: "Have an administrator set channelsEnabled: true in managed settings". Messages would be dropped. Channels are NOT usable. |
| `asyncRewake` hook wakes an IDLE session | **Works.** A `SessionStart` hook (async + asyncRewake) slept 12 s, then wrote text to stderr and exited 2. Claude started a turn alone and answered the text. The same worked from a `Stop` hook. Tested on Claude Code 2.1.319 in tmux. |

So the inbound path is an `asyncRewake` hook with a long poll to the PA daemon. No MCP channel, no dev flag, no dialog.

## 3. Requirements

### Functional

- F1. Only the next Telegram message(s) go to the session. The session never receives the Telegram history.
- F2. Near live delivery. Target: a turn starts less than 3 s after the message reaches the daemon (session idle).
- F3. A message is handed to the waiting listener at once. Claude Code decides when it processes the message (tested only
  with a short turn). Order is kept. If no poll takes the message in `deliveryTimeoutMs`, the user gets a "not listening"
  notice and the message stays queued. `deliveryTimeoutMs` does not count while a turn runs.
- F4. Progress shows in ONE continuously updated Telegram "processing" message per turn, like the normal PA conversation
  over Telegram. It has tool calls and intermediate assistant text. Reasoning is NOT sent by default (too much traffic).
  Reuse `createProcessingAccumulator` and `gateway.processingUpdateIntervalMs` (default 5 s).
- F5. The final answer of the turn is sent to Telegram as a new message, from the `Stop` hook (`last_assistant_message`),
  not by the model. If the text is the tail of the processing message, remove it there
  (`trimSuffixFromProcessingMessage`).
- F6. Attach and detach:
  - Telegram commands `/attach`, `/attach <n>`, `/detach`, `/status`.
  - PA MCP tools `remote_session_attach`, `remote_session_detach`, `remote_session_status` (callable by the session).
  - CLI `pa remote attach|detach|status`.
  - Auto detach: session end, process gone, idle timeout (config).
- F7. While attached, `/pa <text>` goes to the normal PA agent queue.
- F8. Voice, photo, and document messages use the existing handling. The session gets the text or the saved path.
- F9. The daemon sends a "not delivered" notice when a forwarded message is not taken by the session within a timeout.
- F10. Works in both launches: `pa claude` and plain `claude --dangerously-skip-permissions` in the assistant workspace.
  No special flag is needed. The hooks come from the workspace Claude settings (`pa init --claude-remote`).

### Non-functional

- N1. One Telegram poller per bot token (two pollers cause 409 Conflict). The laptop PA daemon uses a NEW bot token in the
  laptop `settings.json`. The VPS keeps the old bot. The laptop daemon runs with `heartbeat.enabled: false` so it does
  not duplicate VPS heartbeat work. This key stops only the heartbeat. Daily and weekly reflection, memory sync and cron
  jobs stay on (keys: `reflection.enabled`, `reflection.weeklyEnabled`, `memory.sync.intervalMinutes: 0`). The daemon
  starts the local HTTP server by itself when remote mode is on (`mcp.httpServer.enabled` is not needed).
- N2. Localhost only (`127.0.0.1`, `isAllowedRequest` guard). Random bearer token in a `0600` file. No secrets in
  generated files.
- N3. Only users in `adapters.telegram.allowedUserIds` can send (checked on `from.id` by the adapter).
- N4. Hooks never block the session and never fail it. Daemon down or no token: hook exits 0 at once.
- N5. No model cost and no polling by the model while idle. The long poll is a cheap background process.
- N6. Telegram text is untrusted user input (same trust as today's PA Telegram messages). It is wrapped in a clear frame.
- N7. Each forwarded message gets an audit log line (no secrets).
- N8. Off by default (`claudeCode.remote.enabled: false`).
- N9. Max message length and a per-chat rate limit in the bridge.

### Documentation

- D1. New guide `docs/settings/claude_code_remote_session.md`: bot creation, setup, start, control, security, troubleshooting.
- D2. README chapter "Claude Code companion mode" and the "Setup guides" list link to it briefly.
  `docs/settings/claude_code_companion.md` gets a short pointer.

## 4. Research summary

Sources: Claude Code docs (code.claude.com/docs: channels, channels-reference, hooks), checked 2026-11-08.

- **Channels** (research preview): an MCP server pushes events into a running session. Rejected: blocked by the org policy
  (Gate G). Team and Enterprise orgs need `channelsEnabled` from an Owner.
- **Hooks**: `Stop` has `last_assistant_message`; `PreToolUse` has `tool_name`, `tool_input`; `MessageDisplay` fires while
  assistant text is displayed; `Notification` has `notification_type`; `SessionStart`/`SessionEnd` bracket the session.
  `"async": true` runs a command hook in the background; `"asyncRewake": true` wakes Claude when the hook exits with
  code 2 (stderr, or stdout if stderr is empty, becomes a system reminder). Async hooks have no enforced timeout.
  Hooks cannot create a user message by themselves, but asyncRewake does start a turn (verified).
- **Alternatives**:

| Option | Latency | Reliability | Verdict |
|---|---|---|---|
| asyncRewake long-poll hook | < 3 s | High (verified idle wake) | **Chosen** |
| Channels | < 1 s | High | Blocked by org policy |
| tmux `send-keys` (`src/tmux-agents/`) | Low | Low (dialogs) | Fallback only |
| Session cron / `/loop` polling | Interval | Medium | Rejected (cost) |
| `PreToolUse` injection | Only when a tool runs | Low | Rejected |
| Remote Control (Claude app) | Low | High | Rejected (not allowed for the user) |

- Unverified (to check in the spike, plan task 0): exact payload of `MessageDisplay`; whether `UserPromptSubmit` fires for a
  rewake turn; how long an async hook can live (hours). The design does not depend on them (defensive fallbacks).

## 5. Design

```
Telegram (new laptop bot) -> PA daemon (laptop, only poller)
   |-- not attached: normal gateway queue (unchanged)
   `-- attached: RemoteBridge --queue--> long poll answer
Claude session (hooks, command `pa-remote-hook <mode>`):
   SessionStart / Stop / StopFailure / UserPromptSubmit (async + asyncRewake, modes listen-start / listen-stop /
   listen-fail / listen-prompt): [post the event] then GET /remote/poll (long poll, loops)
        message arrives -> hook prints framed text to stderr, exit 2 -> Claude starts a turn
   PreToolUse / MessageDisplay / Notification / SessionEnd (async): POST /remote/hook
RemoteBridge -> Telegram: one edited processing message + final answer (Stop.last_assistant_message)
```

### 5.1 Components

- **RemoteBridge** (daemon, `src/remote/bridge.ts`): session registry keyed by claude pid, attach state per Telegram chat,
  per-session message queue, long-poll waiters, delivery tracking, turn-origin tracking, progress accumulator, idle timer,
  pid liveness check (every 30 s).
- **HTTP routes** on the existing localhost HTTP server (`src/tools/http-mcp-server.ts`, port `codex.httpMcpPort`,
  default 47392): `/remote/poll`, `/remote/hook`, `/remote/control`. Dispatched before MCP body parsing. The server starts
  before the Telegram adapter, so routes bind the bridge late (holder). Wire format: see the plan, section Protocol.
- **`pa-remote-hook <mode>`** (tiny bin `src/claude/remote-hook-cli.ts`, about 30 ms; logic in `src/claude/remote-hook.ts`;
  `pa claude-remote-hook <mode>` still works): reads hook JSON from stdin, finds the claude pid (walk `/proc/<pid>/stat`,
  `src/claude/process-tree.ts`), reads the token file from the config dir, talks to the daemon. Listen modes
  (`listen-start` SessionStart, `listen-stop` Stop, `listen-fail` StopFailure, `listen-prompt` UserPromptSubmit) run the
  long-poll loop. Exits 0 quietly on any error, when no token file exists, for headless `claude -p`, and with
  `PA_REMOTE_HOOKS=off`. Re-arm: the bridge keeps one poller per pid, so a new poll from any listen mode replaces the old
  one. This re-arms a deaf session after an interrupt (Esc gives no Stop hook).
- **Opt-in template split**: `pa init --claude-code` installs the base template (no remote hooks) and `.mcp.json`.
  `pa init --claude-remote` merges `src/templates/claude-code/remote-settings.json` (hooks + the three
  `mcp__pa__remote_session_*` allow entries) into both settings files. Both files are validated before any write.
- **Extra safeguards**: stable session numbers, ghost-session tombstone (60 s), final answer retry (3 tries), late
  confirmation (5 min), subagent events never start or end a turn (tool lines get "(subagent)"), `/clear` and `/resume`
  keep the attachment, duplicate hook detection and in-place upgrade in the installer.
- **Telegram routing** (`src/remote/telegram-router.ts`, wired in `src/daemon.ts`): `/attach`, `/detach`, `/status`, `/pa`,
  forwarding when attached, unchanged otherwise.
- **MCP tools and CLI**: `remote_session_*` in `src/tools/stdio-mcp-server.ts`, `pa remote ...`, `pa init --claude-remote`
  (additive idempotent merge of the hooks into workspace and launcher Claude settings).

### 5.2 Flows

Attach: `pa claude` or `claude` starts -> SessionStart hook starts the listener -> session registers by its first poll ->
`/status` in Telegram lists it -> `/attach` -> daemon confirms in Telegram.

Turn: Telegram message -> daemon queue -> the poll returns `{messages}` -> hook prints
`[Telegram message from the user, id <N>]` + text plus a short instruction to stderr and exits 2 -> Claude starts a turn ->
only a `UserPromptSubmit` whose prompt contains the frame header confirms delivery and marks the turn "Telegram origin" ->
`PreToolUse` and `MessageDisplay` feed the processing message -> `Stop` sends the final answer to Telegram and the
Stop hook starts the next poll (the loop continues). A turn that starts without a pending forward is a terminal turn:
nothing is sent to Telegram.

One poller per pid: a new poll replaces the older one (the older returns "replaced" and its hook exits 0).
Detach: `/detach`, SessionEnd, dead pid, or idle timeout. The daemon tells Telegram.

### 5.3 Text frame sent to the model

`[Telegram message from the user, id N]` newline text newline `(Treat as a normal user prompt. Your final answer is sent to
Telegram by the PA daemon. Do not call tools only to reply. Keep it short.)` The text is limited in length and control
characters are removed.

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| asyncRewake behavior may change in a Claude Code update | Isolated in `remote-hook.ts`. Spike and E2E tests. Fallback: tmux `send-keys` input behind the same bridge. |
| Long-lived hook processes (one per session) | One per pid, parent-alive check, exits when the session ends. Memory is small. |
| Gap between poll end and next Stop hook | Messages stay queued in the bridge and are delivered at the next poll. |
| Message not taken | Delivery confirm by hook events from the pid. Timeout -> "not delivered" notice. |
| Hook cost per tool call (node spawn) | Async hooks, tiny entry point, exit at once without token file. Only `PreToolUse` (no `PostToolUse`). |
| Prompt injection via Telegram | Allowlist, frame text, same trust as the PA Telegram. No approvals exist with `--dangerously-skip-permissions`: use it knowingly. |
| Laptop daemon duplicates VPS scheduled work | `heartbeat.enabled: false` (heartbeat only), `reflection.enabled: false`, `memory.sync.intervalMinutes: 0`. Separate bot token. |
| Telegram flood | Max length, rate limit. |
| Two sessions attached | One attached session per chat. `/attach <n>` switches. |
| Daemon restart | Pollers retry with backoff. Attach state is in memory: attach again (the daemon says so). |

## 7. Out of scope

- Channels (blocked). Permission relay to Telegram (follow-up: `PermissionRequest` hook can allow/deny when attached).
- Reasoning text in progress (optional flag `claudeCode.remote.reasoning`, default off, not built in v1).
- Slack and other adapters. Persisting attach state across daemon restart. Sessions without the hooks.

## 8. Acceptance criteria

- A1. Daemon and a session with the hooks run and are attached: a Telegram message starts a turn in less than 3 s (idle).
- A2. The final answer arrives in Telegram exactly once. Progress shows in one edited message.
- A3. A message sent during a running turn is handled after it, in order.
- A4. Not attached: Telegram behaves as before (PA agent answers). Terminal turns are never sent to Telegram.
- A5. Detach works on `/detach`, session exit, and idle timeout. No hook error shows in the session.
- A6. A user outside the allowlist cannot send anything to the session.
- A7. Works with `pa claude` and with plain `claude --dangerously-skip-permissions`.
- A8. The new guide exists and the README links to it. Run in the E2E (fake Telegram, real `claude` in tmux): register,
  attach, wake, progress, final answer, terminal turn, `/exit` detach. NOT run: real Telegram bot, `pa claude`, plain
  `claude --dangerously-skip-permissions`, voice and photo through real Telegram, Notification events. The guide lists this.
- A9. Unit and integration tests pass for the bridge, routes, hook command, router, init merge. Real-Claude E2E passes
  (at least the idle wake and the final answer path, with a fake Telegram).
