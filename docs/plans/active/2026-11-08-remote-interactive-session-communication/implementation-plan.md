# Remote interactive session communication - Implementation plan

**Date:** 2026-11-08 (revised after Gate G)
**Status:** In progress
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

- Hook events: `UserPromptSubmit`, `PreToolUse`, `MessageDisplay`, `Stop`, `Notification`, `SessionEnd`.
  The bridge reads defensive fields: `tool_name`, `tool_input`, `last_assistant_message`, `notification_type`, `message`,
  `prompt`. Unknown shape -> ignore, never throw.
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
- Delivery: after a message is returned by a poll, mark "sent". Any hook event from that pid confirms delivery and sets
  turn origin "telegram". Timeout (`deliveryTimeoutMs`) -> "not delivered" notice to Telegram, message dropped.
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

### 4. Hook command `pa claude-remote-hook <event>` (agent B)

`src/claude/remote-hook.ts`, `src/claude/process-tree.ts` + tests. Add `claude-remote-hook` to `VALID_COMMANDS` in
`src/cli.ts` (agent C owns cli.ts edits: B gives the exported function `runClaudeRemoteHook(event, deps)`).
- Read stdin JSON. Read the token file from the config dir (`PA_CONFIG`, else default dir, same as the CLI). No token ->
  exit 0. Find claude pid. Port from config or default.
- Plain events: POST `/remote/hook` (1 s timeout), exit 0.
- `listen` for `SessionStart`: loop `GET /remote/poll`: 200 -> print frame to stderr, exit 2; 204 -> loop; replaced -> exit 0;
  connection error -> backoff (1 s to 15 s), exit 0 when the token file is gone or the claude pid is dead.
- `listen` for `Stop`: first POST the Stop payload (`event: "Stop"`), then the same loop.
- Never print to stdout. Never throw. Handle SIGTERM.
- Tests with a fake HTTP server: exit codes, frame text, replace, token missing, dead parent, backoff.

### 5. Telegram routing (agent A)

`src/remote/telegram-router.ts` + test (pure function wrapping the adapter `onMessage`): `/attach [n]`, `/detach`, `/status`,
`/pa <text>` (normal queue), attached text -> `bridge.forward`, otherwise normal `queue.enqueue`. Wire in `src/daemon.ts`
(agent C does the wiring). Prove the router is not reached for a non-allowlisted sender (adapter test).

### 6. MCP tools and CLI (agent C)

`remote_session_attach|detach|status` in `src/tools/stdio-mcp-server.ts` (handlers call `/remote/control` through deps) and
the http server deps. `pa remote attach|detach|status` in `src/cli.ts`. Add `mcp__pa__remote_session_*` to the allow list in
`src/templates/claude-code/settings.json`. Tests in `stdio-mcp-server.test.ts`, `cli.test.ts`.

### 7. Hooks template and `pa init --claude-remote` (agent C)

- Add hooks to `src/templates/claude-code/settings.json` (async, command `pa claude-remote-hook <event>`):
  `SessionStart` and `Stop` with `"async": true, "asyncRewake": true` (argument `listen-start` / `listen-stop`);
  `UserPromptSubmit`, `PreToolUse`, `MessageDisplay`, `Notification`, `SessionEnd` with `"async": true`.
  Keep the existing security `PreToolUse` hook first and unchanged. Keep the existing SessionStart context hook.
- `installClaudeRemoteConfig` in `src/claude/templates.ts`, command `pa init --claude-remote`: additive idempotent JSON merge
  of the remote hooks into the workspace Claude settings file and the launcher settings under `<configDir>/claude-code/`.
  Never remove or edit other keys, never duplicate an existing remote hook entry, atomic write, keep file mode.
- Tests in `src/claude/templates.test.ts` (fresh, existing file with other hooks, idempotent second run).

### 8. Docs (agent D, after A-C)

- New `docs/settings/claude_code_remote_session.md` (STE English, lines max 140 chars). Chapters: what it does; prerequisites
  (new Telegram bot from BotFather, laptop `settings.json` example with `adapters.telegram`, `heartbeat.enabled: false`,
  `claudeCode.remote.enabled: true`, `mcp.httpServer.enabled`); setup (`pa init --claude-remote`); start (`pa claude` or plain
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
