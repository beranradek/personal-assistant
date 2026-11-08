# Remote interactive session communication - Specification

**Date:** 2026-11-08
**Status:** Proposed
**Related:** [Claude Code companion mode](../../../settings/claude_code_companion.md),
[implementation plan](implementation-plan.md)

## 1. Goal

The user runs a Claude Code companion session (`pa claude`) on a laptop. The user wants to talk to this live session
from a phone through the same Telegram bot that the PA daemon already uses.

- A Telegram message goes into the running session as a new user turn.
- The session handles it as a normal prompt. It keeps its own history.
- The PA daemon (not the model) sends progress and the final answer back to Telegram.
- The mode is on demand. It does not run all the time. The user attaches to a session when needed and detaches later.

## 2. Requirements

### Functional

- F1. Only the next Telegram message goes to the session. The session never receives the Telegram history.
- F2. Delivery is near live. Target: the turn starts less than 2 s after the message reaches the daemon (session idle).
- F3. When the session is busy, messages wait in order and arrive in the next turn.
- F4. Progress shows in ONE continuously updated Telegram "processing" message per turn, the same way as today's
  normal PA conversation over Telegram. It collects tool calls and intermediate assistant text. Reasoning is NOT sent
  by default (too much traffic); it is an optional best-effort flag (see 3.3). Reuse `createProcessingAccumulator` and `gateway.processingUpdateIntervalMs` (default 5 s) and the
  adapter `createProcessingMessage` / `updateProcessingMessage`. The final answer is a separate new message.
- F5. The final answer of the session is sent to Telegram when the turn stops. The source is a hook, not a model tool call.
- F6. Tool permission prompts can be approved or denied from Telegram (`yes <id>` / `no <id>`). The terminal dialog stays valid.
- F7. Attach and detach:
  - Telegram commands `/attach`, `/attach <n>`, `/detach`, `/status`.
  - A PA MCP tool `remote_session_attach` / `remote_session_detach` / `remote_session_status` callable by the session.
  - A CLI command `pa remote attach|detach|status`.
  - Auto detach: session exit, channel disconnect, configurable idle timeout.
- F8. While attached, `/pa <text>` still goes to the normal PA agent queue (existing gateway queue and agent runner).
- F9. Voice messages use the existing transcription. Photos and documents use the existing inbox save. The session gets
  the text or the saved path.
- F10. The daemon reports "not delivered" to Telegram when a message is not confirmed within a timeout.

### Non-functional

- N1. One Telegram poller per bot token. The PA daemon stays the only owner of the bot (Telegram returns 409 when two pollers run).
- N2. Localhost only. A random token protects the bridge endpoints. No secrets in generated files.
- N3. Only the existing Telegram allowlist can send. Check the sender id (`from.id`), not the chat id.
- N4. Hooks must be fast and must never block or fail the session. No daemon, or not attached: hook exits 0 at once.
- N5. No extra model cost when the mode is idle. No polling by the model.
- N6. Telegram text is untrusted user input. Same trust level as today's PA Telegram messages.
- N7. Each forwarded message gets an audit log line.
- N8. The mode is off by default (`claudeCode.remote.enabled: false`).

### Documentation

- D1. A new guide `docs/settings/claude_code_remote_session.md` describes setup, start, control, security, and
  troubleshooting of the remote session mode.
- D2. The README chapter "Claude Code companion mode" and the "Setup guides" list link to this guide briefly.
  `docs/settings/claude_code_companion.md` gets a short pointer.

## 3. Research summary

Sources: Claude Code docs (checked 2026-11-08, local Claude Code 2.1.319).

### 3.1 Claude Code Channels (research preview) - chosen for inbound

- A channel is an MCP stdio server that Claude Code starts. It declares `capabilities.experimental['claude/channel']`.
- It sends `notifications/claude/channel` with `content` and `meta` (keys: letters, digits, underscore). The event arrives
  as `<channel source="..." key="value">text</channel>`.
- An idle session starts a turn at once. Events that arrive during a turn queue and arrive together in the next turn.
- No acknowledgement exists. Events are dropped silently when the channel is not registered or policy blocks it.
- Optional `claude/channel/permission` capability: Claude Code sends `notifications/claude/channel/permission_request`
  (`request_id`, `tool_name`, `description`, `input_preview`). The server answers with
  `notifications/claude/channel/permission` (`request_id`, `behavior: allow|deny`). Only senders that are authenticated
  may be allowed to answer.
- A custom channel is not on the Anthropic allowlist. It needs `--dangerously-load-development-channels server:<name>`.
  This works only in interactive mode and shows a confirmation dialog at each start.
- Needs claude.ai or Console login. Team and Enterprise need `channelsEnabled`. Pro/Max users skip this check.
- The flags and protocol can change (research preview). Keep the channel code small and isolated.

### 3.2 The official Telegram channel plugin - rejected

It polls Telegram itself. The PA daemon already polls the same bot. Two pollers cause 409 Conflict. A second bot would
solve this, but the user wants one bot. The PA daemon forwards messages to a small PA channel server instead.

### 3.3 Hooks - chosen for outbound (progress and final answer)

- `Stop` input has `last_assistant_message`. This is the deterministic final answer of the turn.
- `PreToolUse`, `PostToolUse` have `tool_name`, `tool_input`, `tool_response`. They give progress.
- `Notification` has `notification_type` (`permission_prompt`, `idle_prompt`, ...).
- `UserPromptSubmit` fires also for turns that start from a channel event. It can confirm delivery.
- `"async": true` runs a command hook without blocking the session.
- `MessageDisplay` fires while assistant message text is displayed (display-only, 10 s default timeout). Use it for
  intermediate assistant text. Exact input fields and streaming granularity are NOT confirmed in the docs: verify in a spike
  (implementation plan task 0).
- Reasoning (thinking) has no documented hook. Sources, in order of preference:
  1. `MessageDisplay`, if it also carries thinking text (spike decides).
  2. Tail of `transcript_path` JSONL (thinking blocks, if written). The file is written asynchronously and may lag, so
     reasoning can arrive late or be summarized/redacted. Best effort only.
  3. If neither works: progress shows tool calls and intermediate text only. This is acceptable for acceptance A3.
- Hooks cannot create a new user message. `additionalContext` only adds a system reminder next to a prompt or tool result.
  `PreToolUse` runs only when the model calls a tool, so it cannot wake an idle session.
- `asyncRewake` can wake the model from a background hook. Keep it as plan B for inbound (see 3.4).

### 3.4 Options compared

| Option | Latency | Reliability | Verdict |
|---|---|---|---|
| Channel (inbound) + hooks (outbound) | < 1-2 s | High (official push path) | **Chosen** |
| `asyncRewake` hook with long poll | Low | Medium (hook lifetime, hack) | Plan B |
| tmux `send-keys` (existing `src/tmux-agents/`) | Low | Low (dialogs, screen state) | Fallback only |
| Session cron or `/loop` polling | Equal to interval | Medium | Rejected (cost, delay) |
| `PreToolUse` injection | Only when a tool runs | Low | Rejected (cannot wake idle session) |
| Remote Control (Claude mobile app) | Low | High | Rejected (not allowed for the user) |

## 3.5 Launch modes

The mode must work in both launches:

- `pa claude --remote` (restricted launcher, recommended).
- Plain `claude --dangerously-skip-permissions --dangerously-load-development-channels server:pa-remote`, started in the
  assistant workspace. `pa claude` is only a wrapper. The channel comes from the project MCP file (entry `pa-remote`),
  the hooks from the project Claude settings file (both created by `pa init --claude-code`). No launcher setting is needed.
- The dev-channel flag is required in both modes (custom channel, not on the allowlist). It is not implied by
  `--dangerously-skip-permissions`. The confirmation dialog shows at each start. A running session cannot get a channel
  later: it must be started with the flag.
- With `--dangerously-skip-permissions` no permission prompts exist, so permission relay is unused. The PA security hook
  (PreToolUse) still runs from the project settings, unless the user removed it. Risk: Telegram text becomes a prompt in
  a session without approvals. Only the allowlisted user can send (N3).
- Config lookup: the channel server and hook commands find the PA config dir from `PA_CONFIG`, else the default
  `~/.personal-assistant` (same rule as the `pa` CLI). A plain `claude` start needs no extra environment variable.
- Sessions without the channel (plain `claude`, no flag) still run the hooks. They exit 0 at once (no registered
  channel for this claude pid) and never send to Telegram.
- Suggested alias: `alias claude-remote='claude --dangerously-skip-permissions --dangerously-load-development-channels server:pa-remote'`.

## 4. Design

```
Telegram -> PA daemon (grammy, only poller)
              |-- not attached: normal gateway queue (unchanged)
              `-- attached: RemoteBridge
                    | localhost SSE (token)
                    v
           `pa claude-channel` (stdio MCP channel, child of claude)
                    | notifications/claude/channel
                    v
           live Claude session turn
Claude hooks (async) -> `pa claude-remote-hook <event>` -> POST localhost -> RemoteBridge
           -> Telegram processing message (edit) and final answer (new message)
```

### 4.1 Components

- **RemoteBridge** (in the daemon): registry of channel connections, attach state per Telegram chat, message delivery,
  delivery confirmation, permission relay, progress accumulator (reuses `createProcessingAccumulator`).
- **Bridge HTTP routes** on the existing localhost HTTP server (`src/tools/http-mcp-server.ts`, port `codex.httpMcpPort`,
  default 47392, with the `isAllowedRequest` Host/Origin guard): `/remote/register`, `/remote/events` (SSE), `/remote/hook`.
  The daemon creates a random token at start. Clients read it from a `0600` file in `$PA_CONFIG`.
- **`pa claude-channel`**: stdio MCP server. Registers with the daemon (claude pid, cwd, name), holds the SSE stream,
  reconnects with backoff, and converts each SSE message to `notifications/claude/channel`. It declares the permission
  capability. It has no reply tool: answers come from hooks.
- **`pa claude-remote-hook <event>`**: reads hook JSON from stdin, adds the claude pid, POSTs to the daemon, exits 0 fast.
- **Session identity**: the channel server and all hook commands are descendants of one `claude` process. The claude
  pid (found by walking `/proc/<pid>/stat`) is the key. Hooks also send `session_id`.
- **Telegram routing** in `daemon.ts`: a wrapper around the existing `onMessage` handler. It handles `/attach`, `/detach`,
  `/status`, `/pa`, the verdict regex, and forwards other text to the bridge when attached.

### 4.2 Activation flow

1. `pa claude --remote` starts Claude Code with the `pa-remote` MCP server and
   `--dangerously-load-development-channels server:pa-remote`. The channel registers and waits. Nothing goes to Telegram.
2. The user attaches: `/attach` from Telegram, or the session calls `remote_session_attach`, or `pa remote attach`.
3. The daemon sends "attached to <name>" to Telegram. Later messages go to the session.
4. The user detaches, the session ends, or the idle timeout fires. The daemon sends "detached" and the normal PA flow returns.

### 4.3 Turn flow

1. Telegram message -> daemon -> bridge assigns a message id -> SSE event to the channel server.
2. Channel server sends the channel notification with `meta { msg_id, chat }` and the text.
3. The `UserPromptSubmit` hook fires with the prompt. The bridge matches `msg_id` and marks the message delivered.
4. Async `PreToolUse` / `PostToolUse` / `MessageDisplay` hooks (and the best-effort transcript tail for reasoning) append
   lines to the accumulator of this turn. One Telegram message is created at the first line and edited at most every
   `processingUpdateIntervalMs`. Long content is trimmed to the Telegram limit (oldest lines dropped first).
5. The `Stop` hook sends `last_assistant_message`. The bridge sends it to Telegram as a new message and finishes the
   processing message.
6. Turns that were not started by Telegram (for example started in the terminal) are not sent to Telegram.

### 4.4 Channel instructions text (sent to the model)

Short: "Messages from the user arrive from Telegram as <channel source=pa-remote ...>. Treat them as normal user prompts. Answer
normally. Do not call a reply tool. The PA daemon delivers your final answer to Telegram. Keep answers short."

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Channels are a research preview, flags can change | Isolate in `src/claude/channel-server.ts`. Version check at start. Document plan B (asyncRewake) and tmux fallback. |
| Dev flag shows a confirmation dialog at each start | Accept at start of the laptop session (user is there). Document. |
| Message silently dropped | Delivery confirmation via `UserPromptSubmit`. Timeout -> "not delivered" notice. |
| Hook adds latency to every tool call | Async hooks, 1 s HTTP timeout, exit 0 when not attached. |
| Remote approval of dangerous tools | Permission relay only for the allowlisted Telegram user. Show `input_preview`. Keep the terminal dialog. |
| Two sessions attached | One attached session per chat. `/attach <n>` switches. |
| Daemon restarts | Channel reconnects. Attach state is in memory only: user must attach again (documented, status message shown). |
| Claude Code not logged in via claude.ai/Console | `pa claude --remote` checks and prints a clear error. |

## 6. Out of scope

- Slack or other adapters (design keeps the bridge adapter-neutral, but only Telegram is built).
- Remote control of sessions that were not started with `pa claude --remote`.
- Persisting attach state across daemon restart.
- Sending the full terminal screen to Telegram. Reasoning text is out of scope by default (it grows the traffic). Optional flag only, see F4 and 3.3.

## 7. Acceptance criteria

- A1. With the daemon and `pa claude --remote` running and attached, a Telegram message starts a turn in less than 2 s (idle).
- A2. The final answer of the turn arrives in Telegram exactly once.
- A3. Progress shows in one edited message. It never floods the chat.
- A4. A message sent during a running turn is handled in the next turn. Order is kept.
- A5. A permission prompt appears in Telegram. `yes <id>` lets the call continue. The terminal dialog closes.
- A6. When not attached, Telegram behaves as before. The PA agent answers.
- A7. Detach on session exit, on `/detach`, and on idle timeout works. No hook error appears in the session.
- A8. A user that is not in the allowlist cannot send to the session or approve a permission.
- A10. The new guide exists, every command in it was run in the E2E test, and the README links to it.
- A9. Tests pass for the bridge, channel server, hook command, and Telegram routing. E2E test passes on the laptop.
