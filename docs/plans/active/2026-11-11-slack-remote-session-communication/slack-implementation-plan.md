# Slack remote interactive session communication - Implementation plan

**Date:** 2026-11-11
**Status:** Plan (not implemented)
**Spec:** [spec.md](spec.md)

**No token needed to implement (decided 2026-11-11).** Implementation, tests and review use NO Slack token, NO Slack workspace and NO
network call to Slack. Tests use fake strings (`xoxb-test`, `xapp-test`) and a mocked `@slack/bolt`. The live checks that need a real
app are the manual checklist at the end of this file. The owner runs it AFTER the code is delivered. Agents never run it. Facts that
were open before are taken from the official Slack docs (section "Verified in the official Slack docs") and the code. The Slack
integration that exists already (`src/adapters/slack.ts`, `docs/settings/slack_configuration.md`, Socket Mode, `connections:write`
app token) is reused: the plan extends it and does not replace it.

## Verified current state

Short list. Full table with sources: spec section 3.

- Bridge is channel independent but typed for Telegram: `RemoteTelegramSender`, "Telegram error" text, grammY `retry_after`.
  `src/remote/bridge.ts` already refuses an attach by a second chat (`"<name> is attached to another chat."`).
- `src/remote/telegram-router.ts` handles only `source === "telegram"`. `src/daemon.ts` disables remote mode without
  Telegram and builds `defaultChatId` from `adapters.telegram.allowedUserIds[0]`.
- `src/adapters/slack.ts`: Bolt Socket Mode, no `channel_type` check, no slash command, allowlist hole (`msg.user &&`),
  no dedupe, no access to `app.client` from outside, thread per top-level message.
- `src/adapters/slack.test.ts` mocks `@slack/bolt` (`App` with `message`, `event`, `start`, `stop`, `client.chat`, `client.auth`).
  New code needs `command`, `client.reactions`, `client.conversations` in the mock.
- MCP tools `remote_session_*` (`src/tools/stdio-mcp-server.ts`) and `pa remote` (`src/cli.ts`) send no chat id.
- Hook protocol, token file, frame header: no channel notion, MUST stay as they are.
- Corrections after review (2026-11-11): the bridge is created inside the Telegram block of `daemon.ts` (move it out); the daemon
  `redact` (`src/security/content-redaction.ts`) has no Slack token pattern; the default chat id is filled in two places
  (`daemon.ts` `handleRemoteControl` and `routes.ts` `handleControl`); WebClient has no request timeout by default; Bolt acks
  events before the listener runs.
- Existing tests that WILL need changes: `src/remote/bridge.test.ts` (sender -> channels setup, `attachedChatId` assertions at
  lines 101, 130-149, 1102 become `telegram:111`), `src/remote/integration.test.ts` (bridge setup), `src/remote/telegram-router.test.ts`
  (keys, `send`), `src/remote/routes.test.ts` (`defaultChatId` holder, lines 77, 252), `src/daemon.test.ts` (line 796 expects
  `defaultChatId: "4242"`), `src/cli.test.ts` (line 560-575 `[attached: 42]`), `src/tools/stdio-mcp-server.test.ts` (tool schema
  gets `channel`, `force`), `src/core/config.test.ts` (line 331 `toEqual` of the remote defaults gets the `slack` block),
  `src/adapters/slack.test.ts` (mock needs `command`, `client.reactions`, `client.conversations`; `makeConfig` stays).
- Slack behavior at run time is NOT checked by the implementation. The official docs answer most open points (next section). The
  rest is a manual check by the owner after delivery (E2E checklist), and the design tolerates both outcomes.

## Verified in the official Slack docs (2026-11-11, docs.slack.dev, no private data sent)

| Topic | Result | Design consequence |
|---|---|---|
| App-level token scope | `connections:write` (scope reference). Created in the app UI only (Basic Information), not by manifest | Already in the existing app and config. Nothing new |
| Slash command ack | Within 3000 ms. Default `response_type` is `ephemeral`. Payload: `command`, `text`, `response_url`, `trigger_id`, `user_id`, `channel_id` (no `thread_ts` listed) | `/cc` answers are ephemeral. A command has no `ts` (top level DM answer for `/cc pa`) |
| Slash command in a thread | NOT possible ("cannot be invoked in message threads") | Documented in the guide: use DM text in a thread |
| Slash command names | NOT namespaced, the most recently installed app wins. Max 32 chars with the `/` | Guide warning, fallback names `/cmp`, `/companion`. No official reserved list found |
| Manifest `url` of a slash command | Docs call it "the full https URL" and do not say it is optional. UNCLEAR for Socket Mode | Guide: if Slack asks for a Request URL, enter any https placeholder (Socket Mode delivers over the socket). Manual check |
| `message.im` | `channel_type` is `"im"`. Needs `im:history` and the `message.im` event. Subtypes exist (`message_changed`, `message_deleted`, `bot_message`). Rules for a missing `user` are not documented | Drop events with a `subtype`, a `bot_id` or no `user` (already in task 4) |
| Inbound text escaping | NOT documented for events. Outgoing rules are (`&amp;` `&lt;` `&gt;`, `<url\|label>`, `<@U..>`) | Keep the defensive decoder (task 6), tests use these shapes. Manual check |
| Socket Mode delivery | Each event must be acked with its `envelope_id`. Up to 10 connections, a payload goes to ANY of them. Events can be lost while no connection is open. `retry_num` is documented for HTTP only | Dedupe stays (cheap). One daemon per app token. Gap tolerance in the guide |
| Web API limits | `chat.postMessage` about 1 message per second per channel. `reactions.add` Tier 3, `reactions.remove` Tier 2 (20+/min), `conversations.open` Tier 3. 429 with `Retry-After` seconds. WebClient `retryConfig` default is 10 retries in about 30 minutes | `rejectRateLimitedCalls`, 2 retries, 1 s pacing, status reactions best effort (task 4, 5) |
| Text limits | 4,000 chars recommended, truncated above 40,000. `mrkdwn` defaults to true. Unescaped third party text can notify the whole workspace | Chunk 3,500, escape `& < >` (this makes `<!channel>` inert), no `link_names` |
| DM target | The method page says a user id opens a DM, the messaging guide says the message lands in the DM with `USLACK`. Pages disagree | ALWAYS `conversations.open` and post to the `D...` id (already the design) |
| Reactions | Bot token with `reactions:write`. Errors: `already_reacted`, `no_reaction` (also when the reaction is not ours), `message_not_found`, `too_many_reactions`, `thread_locked`. Works in DMs: not stated | Ignore those errors (task 5). Manual check in DM |
| Scopes | `commands`, `chat:write`, `im:history`, `im:write`, `reactions:write`. `im:read`, `channels:history` NOT needed for this feature. Messages tab must be on so a user can write to the app | Manifest below. Existing app keeps its channel scopes |
| Changing an installed app | New scopes need a reinstall. Docs do not say if the token strings change | Guide: reinstall, then compare the Bot token on the page with `settings.json` |

Sources: docs.slack.dev reference pages for the app manifest, `using-socket-mode`, `implementing-slash-commands`, `message.im`,
`chat.postMessage`, `reactions.add`, `reactions.remove`, `conversations.open`, rate limits, `node-slack-sdk` web-api, scope references.

## Slack app manifest (ready to paste)

Two ways, the owner chooses (see "Slack app setup steps"): A) extend the Slack app that already works with PA (recommended: its
tokens are already in `settings.json`), B) a new app: https://api.slack.com/apps -> Create New App -> From an app manifest ->
choose the PERSONAL workspace -> paste YAML. The scope names are the minimal set for this feature and match the official scope
references (see "Verified in the official Slack docs"). For way A, copy only the missing items (command, scopes, event, messages tab).

```yaml
display_information:
  name: Claude Companion
  description: Talk to a live local Claude Code session
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Claude Companion
    always_online: false
  slash_commands:
    - command: /cc
      description: Control the remote Claude Code session
      usage_hint: "status | attach [n|name] [force] | detach | pa <text> | help"
      should_escape: false
oauth_config:
  scopes:
    bot:
      - commands
      - chat:write
      - im:history
      - im:write
      - reactions:write
settings:
  event_subscriptions:
    bot_events:
      - message.im
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

| Item | Why |
|---|---|
| `commands` | Registers `/cc` |
| `chat:write` | Post answers and notices (existing adapter needs it too) |
| `im:history` | Receive `message.im` events |
| `im:write` | `conversations.open` to resolve the DM channel of the user |
| `reactions:write` | `reactions.add` and `reactions.remove` for turn status |
| event `message.im` | DM messages only. NO `message.channels` and NO `message.groups` for this app |
| `messages_tab_enabled: true` | Lets the user write to the app in a DM |
| No `im:read` | Not needed: `channel_type` is in the event, the DM id comes from `conversations.open` |

The existing PA channel mode (thread per message in a private channel) uses more scopes (`channels:history`, `groups:history`,
events `message.channels` and `message.groups`, see `docs/settings/slack_configuration.md`). Remote mode does not need them. When
the existing app is extended (way A) it keeps them, and the Slack router ignores channel messages for the bridge (DM only). Add
them to a NEW app (way B) only if you want channel mode there too.

The app-level token is created by hand in the app UI (Basic Information -> App-Level Tokens -> scope `connections:write`, confirmed
by the official scope reference). A manifest cannot create it (the docs show no such field). The existing app already has one.
The slash command `url` is an open point: the manifest reference calls it "the full https URL" and does not say it is optional.
If Slack refuses the manifest or the command form without a Request URL, enter any https placeholder (for example
`https://example.com/slack/commands`). With Socket Mode on, the command payload arrives over the socket and the URL is not called.
That this is accepted is NOT verified in the docs: manual check item 0 of the checklist.

## Slack app setup steps for the user (guide content, task 8)

1. Way A (recommended, the PA Slack app exists): open the app on https://api.slack.com/apps. Add the bot scopes `commands`,
   `im:write`, `reactions:write` (and `im:history`, `chat:write` if missing). Event Subscriptions -> add `message.im`. App Home ->
   turn the Messages tab on and allow messages. Slash Commands -> Create New Command `/cc` (usage hint as in the manifest).
   Reinstall the app to the workspace (Slack requires it for new scopes). Way B: create a new app from the manifest above and
   install it.
2. Way A: open OAuth & Permissions and compare the Bot User OAuth Token (`xoxb-`) with `settings.json` (the docs do not say if it
   changes on reinstall); the App-Level Token (`xapp-`) stays. Way B: copy the Bot token and generate the App-Level Token with
   `connections:write`. Tokens are SECRETS. Do not paste them into chat, screenshots, issues or git.
3. Find your Slack member id: profile -> three dots -> Copy member ID (looks like `U` plus letters and digits).
4. Edit `settings.json` in the PA config dir (`PA_CONFIG`, default `~/.personal-assistant`). This file is outside any repository.
   Run `chmod 600` on it. Put the values there. The example uses placeholders only:

```json
{
  "adapters": {
    "slack": {
      "enabled": true,
      "botToken": "<paste the xoxb token here>",
      "appToken": "<paste the xapp token here>",
      "allowedUserIds": ["<your member id>"],
      "socketMode": true
    }
  },
  "claudeCode": { "remote": { "enabled": true, "defaultChannel": "slack" } }
}
```

5. Run the hook install as in the Telegram guide (`pa init --claude-code`, `pa init --claude-remote`). Start the daemon.
6. Open the app in Slack (Apps -> Claude Companion -> Messages tab). Send `/cc status`, then `/cc attach`.
7. Never run one Slack app token in two daemons at the same time (Slack spreads events over several connections, so a second
   daemon would receive part of your messages). NOT verified in this repo; documented Slack behavior for Socket Mode.

## Behavior reference

Use spec sections 5.4 (one chat per session) and 5.5 (behavior table). The tasks below implement exactly those tables.

## Tasks

Rules for all agents: TDD (write the failing test first, then the code). Do not run the full test suite, a full build or
`pnpm typecheck` (4 GB RAM). Use targeted `npx vitest run <files>`, `npx tsc --noEmit -p` only on request, and
`git diff --check`. Agents do NOT commit. Lines in md and ts max about 140 chars. No real token anywhere (tests use
`xoxb-test`, `xapp-test` style fake strings). NO Slack token, workspace or network access is needed or allowed: every Slack call
in code and tests goes through a mock or a fake `SlackRemoteApi`. If a task needs a Slack fact that is missing here, take it from
the official docs (docs.slack.dev, search the exact page) and write the URL in the code comment or in "Delivery notes". Do not guess.

### 0. (no work) Slack facts

Done at planning time: see "Verified in the official Slack docs". The live spike was removed. Items that only a real app can answer
(empty `url` accepted, empty `ack()` silent, reaction in a DM, events lost during a gap, inbound text escaping, `/cc` clash) are in the
manual checklist, items 0, 2, 4, 15, 16a, 16d. The code must work with either outcome:
- an empty `ack()` that is NOT silent is harmless (no text is passed on success, the bridge posts its own notice in the DM);
- a gap that loses events is tolerated (the user sees no `eyes` and sends again);
- inbound text that is NOT escaped passes through unchanged (plain text without entities or link markup stays as it is, test it).
- Acceptance: nothing to do. Agents read the section and start at task 1 and task 4.

### 1. Chat keys, channel types, config (agent A)

Files: `src/remote/protocol.ts` (types from spec 5.2), `src/remote/chat-key.ts` + `chat-key.test.ts`, `src/core/types.ts`,
`src/core/config.ts`, `src/core/config.test.ts`.
- Tests first: `makeChatKey`, `parseChatKey` (valid, bare integer incl. negative = telegram, empty, unknown channel, colon inside
  id splits at the first colon), config defaults (`defaultChannel` undefined, `slack.progress` false, `reactions` true, `format`
  mrkdwn), invalid `format` rejected, update the `toEqual` default test in `config.test.ts` (line 331).
- Add `RemotePartialSendError` (class) and `RemoteChannel.detachCommand` to the types.
- `RemoteControlRequest`: add `channel?: RemoteChannelId` and `force?: boolean`. `RemoteSessionInfo`: add `attachedChannel?`.
  `RemoteBridge.forward(chat, text, ref?)`, `isAttached(chat)`.
- Acceptance: old settings files parse unchanged. `npx vitest run src/remote/chat-key.test.ts src/core/config.test.ts` green.

### 2. Generalize the bridge (agent A, after 1)

Files: `src/remote/bridge.ts`, `src/remote/bridge.test.ts`.
- Tests first (red): a fake `RemoteChannelRegistry` with two fake channels. Cases: notice goes to the channel of the chat key;
  `retryAfterMs` of the channel is used in `sendFinal`; `deliveryFailedText` of the channel; progress accumulator only when the
  channel has `progress` and its flag is on; Slack-like channel without `progress` still sends the final answer;
  `setTurnStatus` calls: `accepted` at `forward`, `done` at `Stop`, `failed` at `StopFailure` and not-delivered,
  `dropped` for queued messages on detach, idle detach and session end, for the stale turn cleared by a terminal prompt, and at
  bridge `stop()`; `setTurnStatus` is never awaited and `done` is called after `sendFinal` started; a failing or hanging
  `setTurnStatus` never breaks or delays a turn (fake channel that never resolves, the final answer still arrives);
  `RemotePartialSendError` from `sendText` means NO whole-answer retry, only `deliveryFailedText`; idle notice uses
  `no ${label} messages` and the attach notice uses `detachCommand`; channel functions get the id part, not the key;
  attach by the same chat twice stays "Already attached";
  bare numeric chat id is normalized to `telegram:<id>`; attach by chat B when A holds it (other channel) is refused with the
  message that names the channel and the two ways out; same with `force`: A is detached, A is notified, B attached.
- Code: replace `sender` by `channels`; `notify(chat, text)` resolves the channel; keep `Turn.chatId` as the key; keep refs
  in `QueuedForward`, `PendingDelivery`, `LateEntry` and `Turn` (`refs: string[]`). Make texts channel neutral
  (channel `label` and `detachCommand`; Telegram strings unchanged byte for byte). `checkRate` and `rateLog` keep using the key.
  The hook protocol code is not touched. `force` also works for two chats of the SAME channel.
- Regression: ALL existing cases of `bridge.test.ts` stay green with a `TelegramChannel` test double (adapt only the setup).
  Text assertions for Telegram stay identical.
- Acceptance: `npx vitest run src/remote/bridge.test.ts src/remote/integration.test.ts` green.

### 3. Telegram channel and router keys (agent A, after 2)

Files: `src/remote/channels/telegram-channel.ts` + test, `src/remote/telegram-router.ts` + test.
- `createTelegramChannel(telegramAdapter)`: `sendText` (existing `sendResponse` with `responseKind: "system"`), `progress`
  (existing processing functions), `retryAfterMs` (moved from the bridge, reads `parameters.retry_after`), label "Telegram",
  `deliveryFailedText` "Answer could not be delivered (Telegram error).". No `setTurnStatus`.
- Router: chat key `telegram:<chatId>` for `bridge.control`, `bridge.forward` and `bridge.isAttached`, while `send(chatId, ...)`
  (replies, `helpText`) keeps the RAW chat id (the Telegram adapter needs it); `/attach 1 force`; `helpText` text unchanged
  except that the `/attach` line may add ` [force]`. Prefer the minimal option: keep that line as is and document `force` only
  in the refusal message.
- Tests first: router test cases updated to keys; `force` parsing; unknown source still passes through.
- Acceptance: `npx vitest run src/remote/telegram-router.test.ts src/remote/channels` green.

### 4. Slack adapter hardening and surface (agent B, parallel to 1-3)

Files: `src/adapters/slack.ts`, `src/adapters/slack.test.ts`, `src/security/content-redaction.ts` + `content-redaction.test.ts`.
- Tests first: (a) message without `user` is dropped, (b) not allowlisted user dropped, (c) `channel_type` is passed in
  metadata (`channelType`), (d) duplicate `channel:ts` dropped, bounded set (entry expires, size cap), (e) `app.command("/cc")`
  registered; handler rejects a non-allowlisted `user_id` with an empty `ack()` (no content), calls `onCommand({userId, text,
  channelId})`, `ack`
  is called once and within the handler, ephemeral text passed through, empty `ack()` when handler returns nothing, handler
  error -> ack with a short ephemeral error, (f) `botToken` and `appToken` never appear in any log call (spy on logger),
  (g) Bolt `App` is created with `clientOptions.rejectRateLimitedCalls: true`, `retryConfig.retries: 2` and `timeout: 15000`,
  (h) `sendResponse` with an empty thread id omits `thread_ts`, (i) `redact` (CONSERVATIVE_PATTERNS) hides fake `xoxb-...` and
  `xapp-...` strings (add one source pattern `xox[baprs]-[A-Za-z0-9-]{10,}` and `xapp-[A-Za-z0-9-]{10,}`; existing redaction
  tests stay green).
- Code: `createSlackAdapter(config, onMessage, options?: { onCommand?: SlackCommandHandler })` returns
  `Adapter & { remote: SlackRemoteApi }`.
  `SlackRemoteApi`: `openDm(userId): Promise<string>` (cached `conversations.open`),
  `postMessage(channel, text, opts?: {mrkdwn?: boolean})`,
  `updateMessage(channel, ts, text)`, `addReaction(channel, ts, name)`, `removeReaction(channel, ts, name)`. Existing thread
  behavior for the normal PA flow stays as it is. Fix the allowlist hole.
- Acceptance: old `slack.test.ts` cases green plus new ones. `npx vitest run src/adapters/slack.test.ts`.

### 5. Slack channel and formatter (agent B, after 4 and the types of 1)

Files: `src/remote/channels/slack-channel.ts` + test, `src/remote/channels/slack-format.ts` + test.
- Formatter tests first: bold, heading, link, bullets, code fence and inline code untouched, `&<>` escaped outside code,
  `<!channel>` and `<@U1>` in model text become inert, empty text, unbalanced fence, very long single line.
  Chunker tests: limit 3,500, split on newline then space, hard cut when no break, fence closed and reopened at the cut,
  all chunks joined equal the input (modulo the fence repair), no empty chunk.
- Channel tests (fake `SlackRemoteApi`): `sendText` resolves the DM with `openDm(userId)` once (cache; a failed `openDm` is not
  cached), posts chunks in order with 1 s pacing (fake timers), each chunk retried alone (3 tries, `retryAfterMs`), a chunk that
  fails for good after others were sent -> `RemotePartialSendError`, more than 20 chunks -> truncated with a marker,
  `format: plain` sets `mrkdwn: false`; `setTurnStatus` calls of one `ref` are serialized (a slow `accepted` add finishes before
  the `done` remove starts); a status call that hangs never blocks `sendText`; `retryAfterMs` maps the rate limit error
  (`retryAfter` seconds -> ms, capped, unknown error -> undefined); `setTurnStatus`: `accepted` -> add `eyes`,
  `done` -> remove `eyes` + add `white_check_mark`, `failed` -> remove `eyes` + add `x`, `dropped` -> remove `eyes`;
  `already_reacted`, `no_reaction`, `message_not_found`, `too_many_reactions`, `thread_locked` ignored (error name is in
  `err.data.error`), any other error logged without the token and swallowed; `reactions: false` -> no calls; `progress` present only when
  `slack.progress` is true; label "Slack"; `deliveryFailedText` "Answer could not be delivered (Slack error).".
- Acceptance: `npx vitest run src/remote/channels`.

### 6. Slack router (agent B, after 1 and 4)

Files: `src/remote/slack-router.ts` + test.
- `createSlackRouter({ bridge, enqueue, send? })` returns `{ onMessage(msg), onCommand({ userId, text }) }`.
- Tests first: DM text, not attached -> `enqueue`; attached -> `bridge.forward("slack:<userId>", text, "<channel>:<ts>")`;
  non-DM (`channelType !== "im"`) never calls the bridge (goes to `enqueue` as before); non-slack source passes through;
  `/cc` parsing: empty and `help` -> help text, `status`, `attach`, `attach 2`, `attach name`, `attach 2 force`, `detach`,
  `pa text` -> `enqueue({text})` with source id `<dmChannel>--` (empty thread: no `ts` exists for a command, so the answer is a
  top level DM message; E2E item 8 is corrected accordingly), `pa` without text -> usage, unknown subcommand -> help;
  inbound decode before `bridge.forward` (`&amp;` `&lt;` `&gt;`, `<https://x|label>`, `<https://x>`, `<@U1>`), a thread reply in
  a DM is forwarded like a normal DM message;
  results: status and failures returned as ephemeral text, success -> empty (no duplicate with the bridge notice);
  rejected forward -> ephemeral-like DM notice "Not sent to the session: <reason>" through the channel.
- Help text lists the subcommands and the current state (attached or not), STE English.
- Acceptance: `npx vitest run src/remote/slack-router.test.ts`.

### 7. Daemon wiring, control defaults, MCP and CLI channel param (agent C, after 2, 3, 5, 6)

Files: `src/daemon.ts`, `src/daemon.test.ts`, `src/remote/routes.ts` + test, `src/remote/control-client.ts`,
`src/tools/stdio-mcp-server.ts` + test, `src/cli.ts` + `src/cli.test.ts`.
- Tests first: remote mode starts with Slack only (no Telegram); with Telegram only (unchanged); with both; neither -> warning
  and no token file. Default chat per channel: `holder.defaultChatIds` (`telegram:<first id>`, `slack:<first id>`); control
  request without `chatId` uses `request.channel`, else `claudeCode.remote.defaultChannel`, else telegram when enabled,
  else slack. A bare numeric `chatId` still works. MCP tools accept optional `channel` and `force` (attach only).
  `pa remote attach [target] [--channel slack] [--force]`. Error text when the requested channel is not enabled.
  `detach` and `status` without `chatId`/`channel`: detach whatever chat holds the target session (REQUIRED, was Q8): with one
  chat per session across channels, a default-channel detach would otherwise say "Not attached" for a Slack chat. `pa remote
  status` prints `[attached: telegram:42]`.
- The default chat id has TWO code paths and both change: `daemon.ts` `handleRemoteControl` (in-daemon MCP) and `routes.ts`
  `handleControl` (`holder.defaultChatIds`, used by `pa remote` and the stdio MCP server). Both share one helper and one test.
  Update the 503 text in `control-client.ts` ("Telegram adapter not started"). Daemon start logs a warning when `settings.json`
  is group or world readable and Slack is enabled (mode check only, no content read).
- Code: the bridge is created inside `if (telegram.enabled)` today. Move creation out, before both adapters. The registry resolves
  channels lazily (`get` reads the adapters once built); adapter `onMessage` callbacks use late bound variables as the Telegram
  block does now (`onTelegramMessage`), so no event arrives before the router is set. Build `RemoteChannelRegistry` from the
  enabled adapters; create the Slack adapter with `onCommand` from the Slack router
  (replaces the current direct enqueue only for DMs; non-DM messages keep the old enqueue path); both adapters share ONE bridge;
  `remote.holder.bridge` set after both are built. Slack adapter must start after the bridge is set (no message earlier).
  Stop path: `bridge.stop()` before adapters stop (existing order).
- Acceptance: `npx vitest run src/daemon.test.ts src/remote src/tools/stdio-mcp-server.test.ts src/cli.test.ts` green.

### 8. Docs (agent D, after 7)

- New `docs/settings/claude_code_remote_slack.md` (STE English, lines max 140): what it does, important facts, app setup with the
  two ways (A: extend the existing PA Slack app, B: new app from the manifest; copy the steps and the manifest from this plan, say
  that a reinstall is needed after new scopes and that the slash command may need a placeholder Request URL), tokens and config
  (placeholders only), start and control (`/cc ...` table),
  what you see (reactions, answer chunks), one chat per session and `force`, security, troubleshooting (no `/cc` command
  in Slack, `eyes` missing, token errors, second daemon on one app token, reconnect), tested / not tested, manual checklist.
- `docs/settings/claude_code_remote_session.md`: short pointer at the top and in "Security"; Telegram-only wording stays.
- `docs/settings/slack_configuration.md`: note that DMs and `/cc` are in the new guide; scopes there are for channel mode.
- `README.md`: one line in "Setup guides", 1-2 sentences in the companion chapter. `CLAUDE.md`: `remote/channels/` in the layout.
- Update the status line of the spec and plan to "Implemented <date>" after the E2E.
- Acceptance: `lines > 140 chars` check on the new md files; no `xox`/`xapp` string with real-looking tail
  (`rg "xox[baprs]-[A-Za-z0-9]{8,}|xapp-[A-Za-z0-9]{8,}" docs src` returns nothing outside fake test strings).

### 9. Review and verification (agents E and F, after 8)

- Agent E (correctness and security review): bridge diff, Slack adapter diff, router. Focus: DM-only, allowlist, ephemeral
  answers, dedupe, token leak, regression of Telegram.
- Agent F (completeness vs spec): every F and A item of the spec has a test or a checklist line.
- Targeted tests: `npx vitest run src/remote src/adapters/slack.test.ts src/daemon.test.ts src/tools/stdio-mcp-server.test.ts
  src/cli.test.ts src/core/config.test.ts src/security/content-redaction.test.ts` (one line when typed).
- The real E2E is NOT an agent task. The owner runs the checklist below in the personal workspace after delivery, with the real
  `claude` in tmux as for Telegram. The agents only make sure the guide (task 8) contains the checklist and the "not tested" list.

## E2E manual test checklist (OWNER, after delivery, personal workspace, real Slack app, real `claude`)

Not part of any agent task. Agents never run it and never ask for tokens.
Setup: the Slack app (way A or B of the setup steps), tokens in the laptop `settings.json`, `pa init --claude-remote`, daemon running,
`claude` session in the workspace.

0. App check (replaces the removed spike): Slack accepts the `/cc` command (with a placeholder Request URL if it asks for one);
   an empty `/cc` reply does not show an error; Socket Mode stays on; another app owning `/cc` is not installed. If `/cc` is refused
   or clashes, set the fallback name in the app and in the adapter config (`/cmp` or `/companion`).
1. Daemon log shows "Slack adapter started" and "Remote session bridge ready". Token file `remote-token` exists.
2. In Slack DM with the app: `/cc status` lists the session (ephemeral, only you see it). `/cc help` shows help.
3. `/cc attach`: the DM gets "Attached to ...". No duplicate ephemeral text.
4. Send a short DM text: `eyes` appears, the session starts a turn (terminal shows it), the answer arrives in the DM once,
   `eyes` becomes `white_check_mark`.
5. Send a long request (answer above 3,500 chars): chunks arrive in order, a code fence is not broken.
6. Send two DMs quickly: handled in order, both get a check mark.
7. Type a prompt in the terminal while attached: nothing goes to Slack (terminal turn).
8. `/cc pa what time is it`: the PA agent answers as a top level DM message (no thread, a command has no `ts`), the session gets
   nothing. A plain DM sent while NOT attached is answered in a thread as before.
9. Second channel: attach from Telegram while Slack holds the session: refused with the channel name and the way out.
   `/attach 1 force` in Telegram: Slack DM gets the "taken over" notice, Telegram works, Slack DM text now goes to the PA agent.
   Repeat the other way round (Telegram attached, `/cc attach 1`, refused, `/cc attach 1 force`).
10. `/cc detach`: notice in the DM, a later DM text goes to the PA agent.
11. Idle detach: set `idleDetachMinutes: 1`, attach, wait: notice arrives, queued messages dropped (no `eyes` left).
12. Session end: `/exit` in the terminal: "ended. Detached." (up to 30 s). Start a new session: `/cc status` lists it with a new number.
13. Daemon restart: `/cc status` after restart shows no attachment. A DM goes to the PA agent. `/cc attach` works again.
14. Security: send a DM from a second Slack user in the workspace (if available): no reply, only a warn log. Invite the app to a
    channel (optional): a channel message never reaches the session. `/cc status` in a public channel: ephemeral answer, nobody
    else sees it.
15. Reconnect: disconnect the laptop network for 30 s, reconnect. Log shows the socket reconnect. A DM sent after works. Note whether a
    DM sent during the gap shows up or not (no `eyes` means not received).
16. Duplicate: with a slow listener (debug build or breakpoint), verify one forward per Slack message. After a reconnect (item 15),
    verify that a replayed message (if Slack replays) is forwarded once.
16a. Inbound text: send `a & b <c> https://example.com` and a message with a mention: the terminal shows decoded text, the echo
    line is stripped from the answer.
16b. Partial failure: block `slack.com` after the first chunk of a long answer (firewall rule or network off): no duplicate
    chunks after the network is back, one "could not be delivered" notice.
16c. Telegram and Slack both enabled: same-channel second chat refused with the old text; `pa remote detach` on the laptop
    detaches a Slack chat; `pa remote status` shows `[attached: slack:U...]`.
16d. Another app owns `/cc` (if you have one installed): the manual result (item 0) decides the final command name.
17. Rate limit: a very long answer in many chunks while another chat is busy: no hang, a final notice if sending fails.
18. Telegram regression: run the old Telegram checklist (attach, progress message, final answer, detach).
19. Token hygiene: `rg` for token patterns in the repo and in `docs/`: no matches. `git status` shows no config file.

## Work split for subagents (disjoint files, agents do NOT commit)

| Agent | Tasks | Files (disjoint) |
|---|---|---|
| A | 1, 2, 3 | `src/remote/{protocol,chat-key,bridge,telegram-router}*`, `src/remote/channels/telegram-channel*`, `src/core/{types,config}*` |
| B | 4, 5, 6 | `src/adapters/slack*`, `src/security/content-redaction*`, `src/remote/channels/slack-*`, `src/remote/slack-router*` |
| C | 7 | `src/daemon*`, `src/remote/{routes,control-client}*`, `src/tools/stdio-mcp-server*`, `src/cli*` |
| D | 8 | `docs/**`, `README.md`, `CLAUDE.md` |
| E, F | 9 | read only, then fixes through A-C |

Order: A (1) and B (4) in parallel. Then A (2, 3) and B (5, 6) in parallel (B needs only the types from 1).
Then C (7). Then D (8). Then E and F (9). One subagent run = one task.

## Risks and open questions

| # | Question or risk | Plan |
|---|---|---|
| Q1 | Does Slack allow `/cc` and a command without request URL in Socket Mode? | Docs are unclear for the empty `url` (manual item 0). Fallback names `/cmp`, `/companion` |
| Q2 | Reconnect gap: lost events? | Docs: events can be lost while no connection is open. `eyes` receipt, guide note, manual item 15 |
| Q3 | Should a DM notice be sent at daemon start ("remote mode ready, attach again")? | Not in phase 1. Decide after E2E |
| Q4 | Company workspace later: admin approval, token policy, a bot in many channels | Out of scope. Same code, new app, review the allowlist and the logging policy first |
| Q5 | Progress message in Slack (`slack.progress`) is a flag, default off. Is a status reaction enough? | Decide after E2E (check 4 and 5) |
| Q6 | Markdown tables and nested lists in mrkdwn | Stay as text. Revisit if the output is unreadable |
| Q7 | `redact` knows Slack token patterns? | Checked: NO. Task 4 adds the patterns and a test (`xoxb-`, `xapp-`) |
| Q8 | `pa remote detach` from the laptop for a chat on another channel | Decided: required in task 7 (operator action, localhost + token) |
| Q9 | `/cc attach` typed outside the DM gives no visible reply there (the notice is in the DM) | Open, recommend: ephemeral "Attached. See your DM with the app." when `channel_id` is not the DM. Decide at task 6 |
| R1 | Generalizing the bridge regresses Telegram | Tasks 2 and 3 keep all old tests, texts and flows green first |
| R2 | Slack WebClient retry behavior blocks answers | `rejectRateLimitedCalls`, 2 retries, `timeout: 15000` (docs: 10 retries in 30 min by default). Manual item 17 |
| R3 | Two daemons with one app token split events | Guide warning |

## Rollout and rollback

- Rollout: tasks merge as one change set or as small PRs in task order (each task keeps `main` green). Features are behind the
  existing flags. Enable Slack only on the laptop daemon, personal workspace.
- Rollback: `adapters.slack.enabled: false` stops Slack. Revert the PRs for code rollback. No data migration, no token file change.
  Delete the Slack app or regenerate its tokens to cut access.

## Delivery notes

- (filled in by the implementation agents; Slack facts come from the official docs, see "Verified in the official Slack docs")

## Review 2026-11-11

Adversarial review against the code and the installed packages. Online checks used docs.slack.dev only (no private data sent).

Found and fixed (in spec and plan):

| # | Sev | Finding | Fix |
|---|---|---|---|
| 1 | major | Final answer retry would re-send ALL chunks after a late chunk failure (duplicates) | Per-chunk retry in the Slack channel, `RemotePartialSendError`, no whole-answer retry (tasks 2, 5) |
| 2 | major | WebClient default `timeout` is 0 (no limit): a hung call blocks the final answer | `timeout: 15000` added to `clientOptions` (task 4) |
| 3 | major | `redact` has no `xoxb-`/`xapp-` pattern and lives in `src/security/content-redaction.ts`, not in the adapter | Pattern + test added to task 4, file added to agent B |
| 4 | major | `/cc pa` has no message `ts`, so "answer in a thread" is impossible | Top level DM answer, adapter omits empty `thread_ts` (task 6, E2E 8) |
| 5 | major | Inbound Slack text is entity escaped and has link markup; echo stripping would not match | Inbound decoder in the Slack router (task 6, spec 6.2) |
| 6 | major | `pa remote detach` and MCP detach act on the default chat only: cannot detach a Slack chat from the laptop | Required in task 7 (was open "if cheap" item Q8) |
| 7 | major | Bridge is created inside the Telegram block of `daemon.ts`; default chat id has two code paths (`daemon.ts`, `routes.ts`) | Task 7 states the move, lazy registry, shared helper |
| 8 | major | Plan claim "Bolt acks after the listener" is wrong: Bolt acks events first | Spec 6.2 corrected. The docs do not say it: manual check |
| 9 | minor | Idle and attach notice texts would change for Telegram ("no messages", "/detach") | Channel `label` and `detachCommand`; Telegram text byte for byte |
| 10 | minor | `setTurnStatus` races (add vs remove), missing calls for stale turn, `removeSession`, `stop()`; must not delay the answer | Serialization per ref, never awaited, extra cases in task 2 |
| 11 | minor | Channel functions: key or id part? Negative Telegram ids as bare ids | Id part only; `parseChatKey` accepts `-?\d+`, splits at first colon |
| 12 | minor | Telegram router uses the raw id for `send`; a key there would break replies | Task 3: raw id for `send`, key for the bridge |
| 13 | minor | Existing tests to change were not listed | Listed in "Verified current state" |
| 14 | minor | Bolt version `^5.1.0` (package.json says `^5.0.0`); `attachedChatId` lives in `sessions[]` | Fixed |
| 15 | minor | Slash commands are not namespaced: another app with `/cc` silently wins | Spec 6.1, E2E 0 and 16d |
| 16 | minor | Reaction error list incomplete; answer length unbounded; no `settings.json` mode check | More error names; 20 chunk cap; 0600 warning in task 7 |
| 17 | minor | Four prose lines over 140 chars | Wrapped |

Verified offline (`node_modules`): web-api options, `WebAPIRateLimitedError.retryAfter`, defaults (10 retries, timeout 0); Bolt
`clientOptions`, `ignoreSelf`, event ack before listener, command `ack`; socket-mode ping defaults and `retry_num`.
Verified online: slash command 3 s ack, ephemeral default, no namespacing, optional manifest `url`, `command` max 32 chars;
`chat.postMessage` with a user id opens a DM, 4,000 / 40,000 text limits, rate hints; `reactions.add` Tier 3 and error names;
Socket Mode disconnect warning, refresh, 10 connections, events to any connection; manifest field names.
Update after the owner decision "no token for implementation" (2026-11-11): the spike (task 0) is removed. The official docs now
confirm the scope names (`connections:write`, `commands`, `im:history`, `im:write`, `reactions:write`) and the rate limits. Still
open in the docs and left to the manual checklist: slash command without a Request URL in Socket Mode, `/cc` acceptance and a
built-in command list (none found), replay or loss of events after a reconnect (docs: events can be lost), inbound text escaping,
reactions in a DM, 429 behavior at run time. The code tolerates every outcome (task 0).

Confirmed correct in the plan: a second chat is refused today (`bridge.ts` `control`, "is attached to another chat."), the allowlist
hole (`msg.user &&`), no `channel_type` check, no exposed Bolt `app` or client, daemon remote gating on Telegram, token file and hook
protocol untouched, no real tokens in the files.

Open for the owner (recommendation):
- Q9 ephemeral hint after `/cc attach` typed outside the DM: recommend YES (one line, no duplicate in the DM).
- Chunk cap 20 and chunk size 3,500: recommend keep, tune after E2E 5.
- `settings.json` mode warning in task 7: recommend keep (small), else drop.
