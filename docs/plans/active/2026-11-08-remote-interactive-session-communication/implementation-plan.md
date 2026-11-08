# Remote interactive session communication - Implementation plan

**Date:** 2026-11-08 (revised after Gate G)
**Status:** Implemented 2026-11-08 (unit tests and fake-Telegram E2E done; real Telegram bot check by the user pending)
**Spec:** [spec.md](spec.md)

## Gate G result (done)

- Channels: blocked by org policy (Team plan, `channelsEnabled` not set). Not usable.
- `asyncRewake` hook (SessionStart and Stop, `async: true` + `asyncRewake: true`, exit 2, text on stderr) woke an idle
  Claude Code 2.1.319 session; Claude answered the text. Scratch files: the scratchpad `channel-exp/` directory
  (`rewake.sh`, `exp-settings.json`). Design uses this path.

## Verified current state

- Telegram adapter: `src/adapters/telegram.ts` (`createTelegramAdapter`, `sendResponse`, `createProcessingMessage`,
  `updateProcessingMessage`). Started in `src/daemon.ts` (about line 476). `onMessage` calls `queue.enqueue(msg)`.
  Allowlist is checked inside the adapter on `from.id`.
- Accumulator: `src/gateway/processing-message.ts` `createProcessingAccumulator(adapter, sourceId, metadata, intervalMs,
  redact)` consumes `StreamEvent` (`tool_start`, `tool_input`, `text_delta`), has `start()`, `stop()`,
  `trimSuffixFromProcessingMessage()`. It creates the Telegram message only after the first tool event.
- Localhost HTTP server: `src/tools/http-mcp-server.ts` (`startHttpMcpServer(deps, port)`, `isAllowedRequest`). It parses
  every request body as MCP JSON. Started in `createDaemonCoreFromConfig` (`src/daemon.ts` about line 229) when backend is
  codex or `mcp.httpServer.enabled`; BEFORE adapters are created.
- MCP tools: `src/tools/stdio-mcp-server.ts` (`StdioMcpServerDeps`). Companion launcher and `pa init`: `src/cli.ts`
  (`runInit`, `buildClaudeCompanionArgs`, `VALID_COMMANDS`). Templates: `src/templates/claude-code/settings.json`,
  installer `src/claude/templates.ts` (never overwrites existing files).
- No `claudeCode` section exists in `src/core/types.ts` yet.
- Config rules: Zod schemas in `src/core/types.ts`, tests co-located, factories with dependency injection.

## Protocol (fixed contract)

Base URL `http://127.0.0.1:<codex.httpMcpPort>`. All `/remote/*` requests need `Authorization: Bearer <token>`.
Token: 32 random bytes hex, written by the daemon to `<configDir>/remote-token` (mode 0600) at start when
`claudeCode.remote.enabled`, removed at stop. Bad token -> 401. Bad Host/Origin -> 403 (`isAllowedRequest`).
Bridge not ready (late binding) -> 503. Shared types: `src/remote/protocol.ts`.

| Route | Request | Response |
|---|---|---|
| `GET /remote/poll?pid=<n>&cwd=<s>&name=<s>` | long poll, waits up to 55 s | `200 { messages: [{ msgId, text }] }` when messages are queued for an attached session; `204` on timeout; `204` + header `X-Remote-Replaced: 1` when a newer poll for the same pid took over. The first poll registers the session. |
| `POST /remote/hook` | `{ event, pid, cwd?, payload }` (`payload` = raw hook JSON) | `204` at once |
| `POST /remote/control` | `{ action: "attach"\|"detach"\|"status", chatId?, target? }` | `200 { ok, message, sessions: [{ index, name, cwd, pid, attachedChatId? }] }` |

- Hook events: `UserPromptSubmit`, `PreToolUse`, `MessageDisplay`, `Stop`, `StopFailure`, `Notification`, `SessionEnd`.
  The bridge reads defensive fields: `tool_name`, `tool_input`, `last_assistant_message`, `notification_type`, `message`,
  `prompt`, `reason`, `agent_id`. Unknown shape -> ignore, never throw.
- Confirmation rule: only a `UserPromptSubmit` whose `prompt` contains the frame header `[Telegram message from the user,
  id N]` of a sent (or late, up to 5 min) message confirms delivery and sets the turn origin. Any other prompt is a
  terminal prompt: it ends a stale Telegram turn. Events with `agent_id` (subagents) never start or end a turn.
  `SessionEnd` with reason `clear` or `resume` is ignored.
- A poll from a removed pid is answered `204` + `X-Remote-Replaced` for 60 s (tombstone).
- `chatId` default for `control` = first id in `adapters.telegram.allowedUserIds` (private chat id = user id).
- `target` = session index from `status`, or name. Default: the only registered session, else error "choose one".
- `pid` = pid of the `claude` ancestor process (`src/claude/process-tree.ts`: walk `/proc/<pid>/stat`).
- Text printed by the hook (stderr, exit 2): frame from spec 5.3.

## Tasks

Do not run the full test suite or typecheck in parallel with other heavy work. Use targeted `npx vitest run <file>`.
Do not run `pnpm typecheck` without the user's approval; use targeted Vitest and `git diff --check`.

### 0. Spike (agent B, first)

Use tmux (allowed) and a scratch dir under the scratchpad/`tmp/` (not the repo). Settings file passed with `--settings`.
- Log stdin JSON of `UserPromptSubmit`, `PreToolUse`, `MessageDisplay`, `Stop`, `Notification`, `SessionEnd`.
- Record: `MessageDisplay` fields and granularity; whether `UserPromptSubmit` fires for a rewake turn and what `prompt` holds;
  whether `Stop` fires after the rewake turn (yes, seen); how an async hook behaves when the user types meanwhile.
- Write findings under "Delivery notes" at the end of this file.

### 1. Config (agent A)

New `claudeCode.remote` in `src/core/types.ts` (new section `claudeCode`, default object): `enabled` (false),
`idleDetachMinutes` (60), `deliveryTimeoutMs` (20000), `progress` (true), `maxMessageChars` (4000),
`maxMessagesPerMinute` (20), `reasoning` (false, reserved). Test in `src/core/config.test.ts`.

### 2. RemoteBridge (agent A)

`src/remote/protocol.ts` (types), `src/remote/bridge.ts` + test. Deps: send functions (final message, processing message
via the adapter), config, clock, logger, `isPidAlive`.
- State in memory: sessions by pid (name, cwd, last poll, waiter), attach per chatId, per-session message queue, pending
  delivery list, turn origin per pid, accumulator per turn.
- API: `poll(pid, cwd, name, signal)`, `handleHook(event, pid, payload)`, `forward(chatId, text)`, `attach`, `detach`,
  `status`, `stop`.
- Poll: replaces an older waiter of the same pid; returns queued messages at once; 55 s timeout -> 204.
- Delivery: after a message is returned by a poll, mark "sent". A `UserPromptSubmit` that contains the frame header confirms
  delivery and sets turn origin "telegram". Timeout (`deliveryTimeoutMs`, paused while a turn runs) -> "not delivered" notice;
  a late confirmation within 5 minutes still works. A queued message that no poll takes in `deliveryTimeoutMs` -> one
  "session is not listening (no poll)" notice, the message stays queued.
- Stable session ids (never reused, shown in status). Tombstone (60 s) for removed pids. `SessionEnd` clear/resume ignored.
- Final answer: up to 3 send tries (delays 1 s and 3 s, or the Telegram `retry_after`), then "Answer could not be delivered".
- Subagent events (`agent_id`): tool lines prefixed "(subagent)", no turn start or end.
- Hooks: `PreToolUse` -> synthetic `tool_start` + `tool_input` events into the accumulator; `MessageDisplay` ->
  `text_delta`; `Stop` -> if turn origin is telegram: `accumulator.stop()`, `trimSuffixFromProcessingMessage(final)`,
  send final answer as a new Telegram message, reset origin; `Notification` -> short notice; `SessionEnd` -> unregister and
  detach with notice. Terminal-origin turns are ignored.
- Limits: `maxMessageChars` (truncate with marker), `maxMessagesPerMinute` per chat. Strip control characters.
- Idle detach after `idleDetachMinutes` without Telegram traffic. Liveness check every 30 s (dead pid -> detach).
- Tests (fake clock, fake sender): attach/detach, forward while not attached (rejected), long-poll replace, queue order,
  delivery confirm and timeout, Stop sends once, terminal turn not sent, SessionEnd, idle detach, limits.

### 3. Routes (agent C)

`src/remote/routes.ts`: `handleRemoteRequest(req, res, holder)` for `/remote/poll|hook|control` with token check.
`holder.bridge` is set by `daemon.ts` after the adapter exists (503 before). Mount in `startHttpMcpServer` through an
optional parameter, dispatch BEFORE MCP body parsing. Token file create/remove in daemon start/stop
(`src/remote/token.ts` + test). Start the HTTP server also when `claudeCode.remote.enabled`.
Tests: extend `src/tools/http-mcp-server.test.ts`, new `src/remote/routes.test.ts` (401, 403, 503, long poll end to end
with a fake bridge, client abort cleanup).

### 4. Hook command `pa-remote-hook <mode>` (agent B)

`src/claude/remote-hook.ts`, `src/claude/remote-hook-cli.ts` (tiny bin `pa-remote-hook` in `package.json`),
`src/claude/process-tree.ts` + tests. `claude-remote-hook` stays a subcommand in `VALID_COMMANDS` in `src/cli.ts`
(both call `runRemoteHookEntry`).
Modes: `listen-start`, `listen-stop`, `listen-fail`, `listen-prompt` (long poll, asyncRewake) and the plain events.
Headless `claude -p` (no claude pid) and `PA_REMOTE_HOOKS=off` -> exit 0 at once.
- Read stdin JSON. Read the token file from the config dir (`PA_CONFIG`, else default dir, same as the CLI). No token ->
  exit 0. Find claude pid. Port from config or default.
- Plain events: POST `/remote/hook` (1 s timeout), exit 0.
- `listen-start` (SessionStart): loop `GET /remote/poll`: 200 -> print frame to stderr, exit 2; 204 -> loop; replaced -> exit 0;
  connection error -> backoff (1 s to 15 s), exit 0 when the claude pid is dead. Token lost or 401/403: retry 5 min.
  Connection errors: retry 30 min.
- `listen-stop` / `listen-fail` / `listen-prompt`: first POST the event (`Stop` / `StopFailure` / `UserPromptSubmit`), then
  the same loop. A new poll replaces the old one of the pid, so these re-arm a deaf session.
- Never print to stdout. Never throw. Handle SIGTERM.
- Tests with a fake HTTP server: exit codes, frame text, replace, token missing, dead parent, backoff.

### 5. Telegram routing (agent A)

`src/remote/telegram-router.ts` + test (pure function wrapping the adapter `onMessage`): `/attach [n]`, `/detach`, `/status`,
`/pa <text>` (normal queue), attached text -> `bridge.forward`, otherwise normal `queue.enqueue`. Wire in `src/daemon.ts`
(agent C does the wiring). Prove the router is not reached for a non-allowlisted sender (adapter test).

### 6. MCP tools and CLI (agent C)

`remote_session_attach|detach|status` in `src/tools/stdio-mcp-server.ts` (handlers call `/remote/control` through deps) and
the http server deps. `pa remote attach|detach|status` in `src/cli.ts`. The `mcp__pa__remote_session_*` allow entries are in
the opt-in `src/templates/claude-code/remote-settings.json` (see task 7). Tests in `stdio-mcp-server.test.ts`, `cli.test.ts`.

### 7. Hooks template and `pa init --claude-remote` (agent C)

- Opt-in split: the remote hooks and the three `mcp__pa__remote_session_*` allow entries live in
  `src/templates/claude-code/remote-settings.json` (command `pa-remote-hook <mode>`). The base `settings.json` has none, so
  `pa init --claude-code` installs no remote hooks. `SessionStart`, `Stop`, `StopFailure`, `UserPromptSubmit` use
  `"async": true, "asyncRewake": true` (modes `listen-start`, `listen-stop`, `listen-fail`, `listen-prompt`);
  `PreToolUse`, `MessageDisplay`, `Notification`, `SessionEnd` use `"async": true`.
- `installClaudeRemoteConfig` in `src/claude/templates.ts`, command `pa init --claude-remote`: additive idempotent JSON merge
  of the remote hooks into the workspace Claude settings file and the launcher settings under `<configDir>/claude-code/`.
  Never remove or edit other keys, never duplicate an existing remote hook entry (old forms are detected and upgraded in
  place), merge the allow entries, create a missing file from the base template first. Both files are parsed and checked
  before any write (atomic two-file install), atomic write, keep file mode.
- Tests in `src/claude/templates.test.ts` (fresh, existing file with other hooks, idempotent second run).

### 8. Docs (agent D, after A-C)

- New `docs/settings/claude_code_remote_session.md` (STE English, lines max 140 chars). Chapters: what it does; prerequisites
  (new Telegram bot from BotFather, laptop `settings.json` example with `adapters.telegram`, `heartbeat.enabled: false`,
  `claudeCode.remote.enabled: true`; `mcp.httpServer.enabled` is not needed, the daemon starts the HTTP server itself);
  setup (`pa init --claude-code`, then `pa init --claude-remote`; `npm run build` and `npm link` for the
  `pa-remote-hook` bin); start (`pa claude` or plain
  `claude --dangerously-skip-permissions`, alias example); control (Telegram commands, MCP tools, CLI); what you see
  (progress message, final answer); security (allowlist, token, localhost, no approvals with skip-permissions);
  troubleshooting (Channels blocked by org policy - not needed here, 409 Conflict means a second poller on the token,
  no sessions in `/status`, hooks not installed, daemon restart, `claude` version).
- `docs/settings/claude_code_companion.md`: short pointer. `README.md`: one line in "Setup guides" plus 2-3 sentences with
  a link in chapter "Claude Code companion mode". `CLAUDE.md`: add `remote/` to the source layout table.

### 9. Review and verification

- Two review agents (correctness/security, then completeness vs spec), fix findings.
- Targeted tests: `npx vitest run src/remote src/claude src/tools/http-mcp-server.test.ts src/cli.test.ts src/core/config.test.ts`.
- Real E2E with tmux and a FAKE Telegram sender (no real bot needed): start the bridge/routes in a test harness or the daemon
  with a stub adapter, start `claude` with the hooks, check: session registers, `attach`, a forwarded message wakes the idle
  session, final answer is captured from `Stop`, progress lines, detach on `/exit`.
- Real Telegram E2E needs the user's new bot token: the user runs it with the setup guide.

## Work split for subagents (disjoint files, agents do NOT commit)

- Agent A: tasks 1, 2, 5 (files `src/core/types.ts`, `src/core/config.test.ts`, `src/remote/{protocol,bridge,telegram-router}*`).
- Agent B: tasks 0, 4 (`src/claude/{remote-hook,process-tree}*`).
- Agent C: tasks 3, 6, 7 (`src/remote/{routes,token}*`, `src/tools/*`, `src/daemon.ts`, `src/cli.ts`, `src/claude/templates*`,
  `src/templates/claude-code/*`). Waits for A's `protocol.ts` and B's exported hook function only for imports.
- Agent D: task 8 after A-C.

## Delivery notes

- (filled in by the spike and the implementation)
- Spike (Claude Code 2.1.319, tmux, all hooks async, scratch dir in the scratchpad):
  - `MessageDisplay` payload: `session_id`, `transcript_path`, `cwd`, `prompt_id`, `hook_event_name`, `turn_id`, `message_id`,
    `index` (0), `final` (true), `delta` (text). Not token streaming: one event per assistant message block (a short
    answer gave one event with `final: true` and the full text in `delta`). No `tool_name`. The bridge must read `delta`.
  - `UserPromptSubmit` DOES fire for a rewake turn. `prompt` is NOT the message text: it is a wrapper
    `<task-notification><summary>Stop hook feedback</summary></task-notification><system-reminder>Stop hook blocking error
    from command "SessionStart:startup": <our stderr text></system-reminder>` (command name is "Stop" for the Stop hook).
    The model sees the stderr text inside this wrapper and answers it. Do not use this `prompt` as the turn text.
  - `Stop` payload: `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `effort`, `stop_hook_active`
    (true after a rewake turn), `last_assistant_message` (present, full final text), `background_tasks`, `session_crons`.
  - `PreToolUse` payload has `tool_name` ("Bash") and `tool_input` ({command, description}) plus `tool_use_id`, `prompt_id`.
  - `SessionEnd` fires on `/exit` (`reason: "prompt_input_exit"`). No pid in any payload (the hook finds the claude pid).
  - An async hook that ran 70 s (no timeout set) was NOT killed at 60 s: it ended normally. Long polls (55 s) are safe.
  - The Stop hook fires again after each rewake turn, so the listen loop continues by itself.
  - Not tested: `Notification` (did not occur), typing while an async hook runs.
  - Plan impact: nothing contradicts the plan, except the `prompt` wrapper above (UserPromptSubmit text is not the Telegram text).
- Review round (2026-11-08): two reviewers (correctness/security, completeness). Fixed: delivery confirmation only by a
  `UserPromptSubmit` that contains the frame header (terminal turns no longer leak), stale turn clearing, `StopFailure`,
  busy-aware delivery timeout, abort race, token lifecycle (token file written after the HTTP bind, never in probes),
  listen loop token/connection retry windows, `PA_REMOTE_HOOKS=off` for PA's own Agent SDK turns, no pid guessing,
  frame hardening, big payload stub, allow-entry merge in `pa init --claude-remote`.
- Real E2E (2026-11-08, Claude Code 2.1.319, tmux, real `claude`, real bridge and routes, FAKE Telegram sender, hooks made by
  the real `installClaudeRemoteConfig`, hook command = built `pa claude-remote-hook`):
  - Session registered itself at start (SessionStart listener). `attach` OK.
  - A forwarded message woke the idle session. One processing message with the tool line, one final answer. OK.
  - A terminal turn while attached: nothing sent to Telegram. OK. A second Telegram message woke the session again
    (the Stop hook re-armed the listener). OK. A Telegram message during a terminal turn was answered, the terminal answer
    did not leak. OK.
  - `/exit`: no hook process stayed. The `SessionEnd` event did not detach at once; the 30 s liveness check detached it
    with the notice "process is gone". So auto detach after exit takes up to 30 s.
  - Not tested: real Telegram bot, `pa claude` restricted launcher, plain `claude --dangerously-skip-permissions`
    (only the plain `claude` + `--settings` path), a terminal other than tmux, `Notification` events, voice/photo.
- Round 2 review (2026-11-08). Fixed:
  - Deaf-session re-arm: new listen modes `listen-fail` and `listen-prompt`; a new poll replaces the old one. A "not
    listening (no poll)" notice after `deliveryTimeoutMs`; the message stays queued.
  - Final answer retry (3 tries, then "Answer could not be delivered").
  - Ghost session tombstone (60 s) for removed pids. Stable session numbers in `/status`.
  - Subagent events (`agent_id`) never start or end a turn; tool lines get "(subagent)".
  - `SessionEnd` with reason `clear` or `resume` is ignored (attachment kept).
  - Hook cost: split to the tiny bin `pa-remote-hook` (about 30 ms). `pa claude-remote-hook` stays.
  - Opt-in template split: `remote-settings.json`; `pa init --claude-code` installs no remote hooks.
  - Duplicate hook detection and in-place upgrade of old entries; atomic two-file install (validate both, then write).
  - Headless `claude -p` runs are ignored. Sanitizer removes control, invisible and bidi characters anywhere in the text.
  - Integration test `src/remote/integration.test.ts`.
- Real E2E round 2 (2026-11-08, Claude Code 2.1.319, tmux, fake Telegram sender, built `pa-remote-hook` bin, hooks written by
  `installClaudeRemoteConfig` over an older settings file, so the in-place upgrade of old entries ran too, no duplicates):
  - Idle wake, progress message and one final answer: OK. After `/clear` in the session the attachment stayed and the next
    message was answered. After an Esc interrupt of a Telegram turn (no `Stop` event) the next message was delivered and
    answered (the `listen-prompt` hook re-arms the listener). No hook process stayed after the session ended.
  - Still not tested: real Telegram bot, `pa claude`, plain `claude --dangerously-skip-permissions`, voice and photo over the
    real adapter, `Notification` events, a terminal other than tmux, and a long daemon outage.
  - Docs: guide updated (bin and `npm link`, no `mcp.httpServer.enabled`, honest scheduled-work table, delivery notes,
    tested / not tested).
