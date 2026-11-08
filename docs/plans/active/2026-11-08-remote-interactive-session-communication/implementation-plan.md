# Remote interactive session communication - Implementation plan

**Date:** 2026-11-08
**Status:** Proposed
**Spec:** [spec.md](spec.md)

## Verified current state

- Telegram adapter: `src/adapters/telegram.ts` (`createTelegramAdapter`, `sendResponse`, processing message create/update).
  It is started in `src/daemon.ts` (about line 476). `onMessage` calls `queue.enqueue(msg)`.
- Gateway queue: `src/gateway/queue.ts` (FIFO, serial). Accumulator: `src/gateway/processing-message.ts`
  (`createProcessingAccumulator`). Interval: `gateway.processingUpdateIntervalMs` in `src/core/types.ts`.
- Localhost HTTP server: `src/tools/http-mcp-server.ts` (`startHttpMcpServer`, `isAllowedRequest`). It starts when
  `mcp.httpServer.enabled` is true (`src/daemon.ts` about line 229).
- MCP tools: `src/tools/stdio-mcp-server.ts` (tool definitions plus `StdioMcpServerDeps`).
- Companion launcher: `src/cli.ts` (`buildClaudeCompanionArgs`, `runClaudeCompanion`, `VALID_COMMANDS`).
- Claude templates: `src/templates/claude-code/` (`settings.json`, `.mcp.json`), installer `src/claude/templates.ts`.
- tmux input helpers (fallback only): `src/tmux-agents/`.

## Tasks

Do tasks in order. Each task ends with its tests green (`npx vitest run <file>`). Do not run the full suite or typecheck
in parallel (server has 4 GB RAM).

### 0. Spike: what the hooks really send (before task 2)

- Add a temporary hook in a scratch Claude Code project that writes stdin JSON of `MessageDisplay`, `PreToolUse`,
  `PostToolUse`, `Stop` to `tmp/`. Run a short session with tool calls and extended thinking.
- Record: `MessageDisplay` field names and granularity (chunk or full block), whether thinking text appears, whether
  `transcript_path` contains thinking blocks and how late they appear.
- Write the result into the Delivery notes of this plan. It decides the reasoning source (spec 3.3) before task 2.

### 1. Config

- Add `claudeCode.remote` to the Zod schema in `src/core/types.ts`:
  `enabled` (default false), `idleDetachMinutes` (default 60), `deliveryTimeoutMs` (default 15000),
  `progress` (default true), `permissionRelay` (default true).
- Remote mode needs the HTTP server: start it when `claudeCode.remote.enabled` (same place as `mcp.httpServer.enabled`).
- Test: `src/core/config.test.ts` - defaults and validation.

### 2. RemoteBridge

- New `src/remote/bridge.ts` with `createRemoteBridge(deps)`; deps: Telegram send functions, config, logger, clock.
- State (memory only): channel connections (id, claude pid, cwd, name, SSE writer), attach per chat id,
  pending messages (msg id, text, sent time, delivered flag), pending permission requests (request id -> connection).
- API: `registerChannel`, `unregisterChannel`, `attach(chatId, target)`, `detach(chatId)`, `status()`,
  `forward(chatId, text, attachments)`, `handleHook(event, payload)`, `handleVerdict(chatId, text)`.
- `handleHook`:
  - `UserPromptSubmit`: match `msg_id` text in the prompt, mark delivered.
  - `PreToolUse` / `PostToolUse`: add a short line (tool name plus trimmed target) to the accumulator.
  - `MessageDisplay` (and reasoning from the spike result): add the text to the SAME accumulator. One processing message
    per turn, edited continuously, like the normal PA Telegram flow (`createProcessingAccumulator`,
    `createProcessingMessage` / `updateProcessingMessage`). Make the transcript tail (`src/remote/transcript-tail.ts`,
    reads new JSONL lines from `transcript_path`, extracts thinking blocks, tolerates lag) optional behind
    `claudeCode.remote.reasoning` (default true, best effort).
  - `Stop`: send `last_assistant_message` as a new message. Finish the processing message. Only for turns that started from Telegram.
  - `Notification`: `permission_prompt` and `idle_prompt` -> short notice.
- Delivery timeout -> "not delivered" notice. Idle timer -> detach.
- Redact long tool input (limit length, no file content).
- Test: `src/remote/bridge.test.ts` with fake clock and fake Telegram. Cases: attach/detach, forward when detached (rejected),
  order, delivery confirm and timeout, Stop sends once, non-Telegram turn is not sent, idle detach, one attach per chat.

### 3. Bridge HTTP routes

- Extend `src/tools/http-mcp-server.ts` (or a sibling module `src/remote/routes.ts` that it mounts):
  - `POST /remote/register` -> channel registers, returns connection id.
  - `GET /remote/events?id=` -> SSE stream (heartbeat comment every 15 s).
  - `POST /remote/hook` -> hook payload.
  - `POST /remote/control` -> attach/detach/status for the CLI and the MCP tools.
- Keep `isAllowedRequest`. Add bearer token check. Token: random, created at daemon start, written to
  `$PA_CONFIG/remote-token` with mode `0600`, removed at shutdown.
- Test: extend `src/tools/http-mcp-server.test.ts` - no token -> 401, bad Host -> 403, SSE delivers, close cleans up.

### 4. Channel server `pa claude-channel`

- New `src/claude/channel-server.ts`. Use `@modelcontextprotocol/sdk` `Server` and `StdioServerTransport`.
- Capabilities: `experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }` (permission only when config allows).
- Set `instructions` from spec 4.4.
- Start: find claude pid, read token, POST `/remote/register`, open SSE, reconnect with exponential backoff (max 10 s).
- For each SSE message: `mcp.notification({ method: 'notifications/claude/channel', params: { content, meta: { msg_id, chat } } })`.
- Handle `notifications/claude/channel/permission_request` -> POST to bridge. Receive verdict via SSE ->
  `notifications/claude/channel/permission`.
- Never write to stdout except MCP frames. Log to stderr.
- Add `claude-channel` to `VALID_COMMANDS` in `src/cli.ts`.
- Check the SDK version against the Claude Code MCP client (docs mention protocol revision 2026-07-28 handling). Pin if needed.
- Test: `src/claude/channel-server.test.ts` with an in-memory transport and a fake bridge.

### 5. Hook command `pa claude-remote-hook <event>`

- New `src/claude/remote-hook.ts`. Read stdin JSON, add claude pid (ancestor lookup helper shared with task 4,
  new `src/claude/process-tree.ts` reading `/proc/<pid>/stat`), POST to `/remote/hook` with 1 s timeout.
- On any error or missing token or not attached: print nothing, exit 0.
- Test: `src/claude/remote-hook.test.ts` and `src/claude/process-tree.test.ts` (fake `/proc` reader).

### 6. Telegram routing

- In `src/daemon.ts`, wrap the Telegram `onMessage`. Put the logic in `src/remote/telegram-router.ts` (pure, testable):
  - `/attach`, `/attach <n>`, `/detach`, `/status` -> bridge.
  - `/pa <text>` -> normal queue with `<text>`.
  - Verdict regex `^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$` (case-insensitive) -> `bridge.handleVerdict`.
  - Attached and other text -> `bridge.forward`. Not attached -> unchanged `queue.enqueue`.
- Sender check stays in the Telegram adapter (allowlist on `from.id`). Add a test that proves the router is never reached for
  a non-allowlisted sender.
- Attachments: reuse the saved path text the adapter already builds.
- Test: `src/remote/telegram-router.test.ts`, extend `src/adapters/telegram.test.ts` if the adapter changes.

### 7. MCP tools

- Add `remote_session_attach`, `remote_session_detach`, `remote_session_status` to `src/tools/stdio-mcp-server.ts`.
  Handlers call `POST /remote/control` (via deps, same pattern as `handleExec`).
- Add `mcp__pa__remote_session_*` to the allow list in `src/templates/claude-code/settings.json`.
  Attach has an external effect (Telegram notice): keep it explicit - the tool is called only when the user asks.
- Test: `src/tools/stdio-mcp-server.test.ts` - tool list, disabled config message.

### 8. Templates and launcher

- `src/templates/claude-code/settings.json`: add async command hooks
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `MessageDisplay`, `Stop`, `Notification` -> `pa claude-remote-hook <event>` (`"async": true`).
  Keep the existing security hook as the first `PreToolUse` entry and unchanged.
- `.mcp.json` template: add server `pa-remote` -> `pa claude-channel`. Existing user files are never overwritten
  (current installer rule in `src/claude/templates.ts`); document the manual merge.
- `buildClaudeCompanionArgs` in `src/cli.ts`: option `--remote` adds
  `--dangerously-load-development-channels server:pa-remote`. Before start, check that the daemon answers and that
  `claudeCode.remote.enabled` is true. Print a clear error otherwise.
- Add `pa remote attach|detach|status` to `src/cli.ts` (calls `/remote/control`).
- Test: extend `src/cli.test.ts` (args, error cases), `src/claude/templates.test.ts` (new hooks present, security hook first).

### 9. Docs

- `docs/settings/claude_code_companion.md`: new section "Remote mode (Telegram)": setup, `pa claude --remote`, commands,
  dev-flag dialog, limits, security notes, troubleshooting (no events -> check `/mcp`, login type, channel flag).
- `README.md` and `CLAUDE.md` source layout table: add `remote/`.
- Move this plan to `docs/plans/completed/` when done.

### 10. Verification

Unit tests per task. Then end-to-end on the laptop (real Telegram, real Claude Code, from the phone):

1. `pa daemon` running with `claudeCode.remote.enabled: true`. `pa claude --remote`. Accept the dev-channel dialog.
2. In Telegram: `/status` shows the session. `/attach`. Expect "attached".
3. Send "what is in the current directory?". Expect: turn starts in less than 2 s (measure with timestamps in the audit
   log), one processing message edited, one final answer.
4. Send two messages quickly during a long turn. Expect: next turn handles both, order kept.
5. Trigger a tool that needs approval. Expect the prompt in Telegram. Reply `yes <id>`. Terminal dialog closes.
6. Send a message from a second Telegram account. Expect: dropped, no effect on the session.
7. `/detach`, then a normal message. Expect the PA agent answers (as before).
8. Attach again, quit `claude`. Expect auto detach notice.
9. Restart the daemon while the session runs. Expect the channel reconnects and `/status` shows it. Attach again.
10. Check there are no hook errors in the session and no orphan `pa claude-channel` process after exit.

Also run (one at a time): `npx vitest run src/remote src/claude src/tools/http-mcp-server.test.ts src/cli.test.ts`.
Do not run `pnpm typecheck` on this server without the user's approval (known memory rule). Use targeted Vitest and
`git diff --check`.

### Plan B and fallback

- If channels change or fail: replace only the channel transport (task 4) with an `asyncRewake` long-poll hook. The bridge,
  routing, and outbound hooks stay.
- If no push path works: tmux `send-keys` through `src/tmux-agents/` as input path. Accept lower reliability.

## Open questions (decide during implementation, default shown)

- Reasoning in the single progress message: yes, best effort (decided by the user 2026-11-08). Source depends on the spike.
- Idle detach time? Default: 60 min.
- Allow `/attach` to start a new session when none is registered? Default: no (the user starts `pa claude --remote`).
