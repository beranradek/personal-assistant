# Slack remote interactive session communication - Specification

**Date:** 2026-11-11
**Status:** Plan (not implemented). Docs only. Nothing in `src/` is changed by this document.
**Related:** [Telegram remote session spec](../2026-11-08-remote-interactive-session-communication/spec.md),
[Telegram remote session plan](../2026-11-08-remote-interactive-session-communication/implementation-plan.md),
[Claude Code remote session guide](../../../settings/claude_code_remote_session.md),
[Slack setup guide](../../../settings/slack_configuration.md), [implementation plan](slack-implementation-plan.md)

## 1. Goal

The user runs a Claude Code companion session ("Claude Companion") on a laptop. Today the user talks to it from a phone
through Telegram. The user wants the same through Slack, in the PERSONAL Slack workspace first.

- A Slack DM to the app goes into the attached live session as a new user turn (same as Telegram text today).
- The PA daemon (not the model) sends the final answer back to the Slack DM.
- Control is done with ONE slash command: `/cc status`, `/cc attach [n|name]`, `/cc detach`, `/cc help`, `/cc pa <text>`.
- The bridge core stays channel independent. Telegram and Slack are two channels of the same bridge.
- At any moment ONE chat is attached per session, across ALL channels.

## 2. Owner decisions (fixed)

1. Target the PERSONAL Slack workspace first: a Slack app with its own bot token and app token in the PA config. Preferably the
   Slack app that already works with PA is extended (new scopes, `message.im`, `/cc`) and its tokens stay in `settings.json`; a new
   app from the manifest is the alternative. No company workspace approval is needed. The company workspace is a later option
   (see section 9).
2. Implementation needs NO Slack token, workspace or network access (decided 2026-11-11). Code and tests use mocks. Facts come
   from the official Slack docs (see the plan, "Verified in the official Slack docs"). The owner runs the live checklist after
   delivery.
3. One registered slash command (Socket Mode, ack within 3 s, no public URL). Plain DM text goes to the attached session.
4. One attached chat per session across all channels (Telegram and Slack).

## 3. Verified current state (checked in the code on 2026-11-11)

What the design input said, and what the code says. Items marked CORRECTION differ from the input.

| Topic | Code says | Source |
|---|---|---|
| Slack adapter | Exists. Bolt (`package.json` `^5.0.0`, installed 5.1.0), Socket Mode, push events, no polling, no public endpoint. Config `adapters.slack` has `enabled`, `botToken`, `appToken`, `allowedUserIds` (strings), `socketMode`. Default `enabled: false`. | `src/adapters/slack.ts`, `src/core/types.ts`, `src/core/config.ts` |
| Source id | `slack--{channel}--{threadTs}`. Every top-level message starts a NEW thread, the answer goes into that thread. | `src/adapters/slack.ts` |
| CORRECTION: allowlist | The check is `if (msg.user && !allowed.includes(msg.user))`. A message event WITHOUT `user` passes the check. Must be `!msg.user \|\| !allowed.includes(...)`. Fix first (task 4). | `src/adapters/slack.ts` |
| CORRECTION: DM-only | The adapter has NO `channel_type` check. It handles messages of any channel where the bot is. Remote mode must check `channel_type === "im"` itself. | `src/adapters/slack.ts` |
| Adapter surface | `createSlackAdapter` returns only the `Adapter` interface. It does not expose the Bolt `app` or `client`, and registers no slash command. Needs an extension. | `src/adapters/slack.ts` |
| Bridge core | Channel independent: queue per session, 55 s long poll, delivery confirmation by the frame id, echo stripping, `Stop` final answer, idle detach, tombstone, late confirm. | `src/remote/bridge.ts` |
| Telegram coupling in the bridge | `RemoteTelegramSender` (3 functions), `"Telegram error"` text, `retryAfterMs` reads `parameters.retry_after` (grammY), texts "no Telegram messages" and "your message", per-turn processing message through `createProcessingAccumulator`. | `src/remote/bridge.ts` |
| One chat per session | Already true in the bridge: `attach` returns "<name> is attached to another chat." when `attachedChatId` differs. The other chat is NOT replaced. A chat key is an opaque string, so the rule already works across channels once keys are unique. | `src/remote/bridge.ts` (`control`) |
| Chat key today | Raw Telegram chat id string (`"987654321"`). Used in `attachments`, `rateLog`, `attachedChatId`, `RemoteControlRequest.chatId`, `RemoteSessionInfo.attachedChatId`. | `src/remote/*` |
| Router | `createTelegramRouter` rejects `msg.source !== "telegram"` (passes it on to the normal queue). Commands `/attach /detach /status /pa /help /start`. | `src/remote/telegram-router.ts` |
| Daemon | Remote mode is OFF unless `adapters.telegram.enabled` (warning logged). `defaultChatId` is `String(telegram.allowedUserIds[0])`. The bridge is CREATED INSIDE the `if (telegram.enabled)` block (so it must be moved out). The Slack adapter is created without any router. | `src/daemon.ts` (lines about 241-262, 538-613) |
| MCP tools and CLI | `remote_session_*` tools and `pa remote ...` send NO chat id. The default is filled in TWO places: `daemon.ts` (`handleRemoteControl`, in-daemon HTTP MCP, about line 279) and `routes.ts` (`handleControl`, for `pa remote` and the stdio MCP server, via `holder.defaultChatId`). `remote_session_detach` ignores `target` and acts on the default chat only. | `src/tools/stdio-mcp-server.ts`, `src/cli.ts`, `src/remote/routes.ts`, `src/daemon.ts` |
| Hook protocol | `/remote/poll`, `/remote/hook`, token file, frame header: no channel notion. MUST NOT change. | `src/remote/protocol.ts`, `src/claude/remote-hook.ts` |
| Event loop stall | A 2026-08-14 incident: event loop stalls under RAM pressure showed as missed Slack socket-mode pongs in the daemon logs. | `src/backends/codex.ts` (about line 277) |
| Slack token redaction | CORRECTION: the daemon `redact` is `createRedactor(CONSERVATIVE_PATTERNS)` from `src/security/content-redaction.ts` (built in `src/memory/startup-services.ts`). It has NO `xoxb-`/`xapp-` pattern (the generic 40+ alphanumeric pattern does not match dashes, the `token=` pattern needs a key). Needs a new pattern + test (task 4). `script-content-scanner.ts` has `xox[baprs]-` but it is a scanner, not a redactor. Logger `REDACT_PATHS` covers `*.botToken` and `*.appToken` only one level deep. | `src/security/content-redaction.ts`, `src/core/logger.ts` |

Facts about libraries, read in `node_modules` (not measured at run time):

- `@slack/socket-mode` 3.1.1: `autoReconnectEnabled = true`, `clientPingTimeout = 5000` ms, `serverPingTimeout = 30000` ms.
  The envelope `retry_attempt` is passed on as `retry_num`.
- `@slack/web-api` 8.3.0: option `rejectRateLimitedCalls` (default false); with it a 429 throws `WebAPIRateLimitedError` with
  `retryAfter` (seconds). Default `retryConfig` = 10 retries over about 30 min. Default `timeout` = 0 (NO request timeout).
  A platform error has the Slack error name in `err.data.error`.
- Bolt 5.1.0: `AppOptions.clientOptions` (`WebClientOptions`) is used for `app.client`. `ignoreSelf` default true. Events API
  events are acked by Bolt RIGHT AWAY, BEFORE the listener runs (`App.js`, "Events API requests are acknowledged right away").
  So a slow listener never causes a redelivery by itself. `retryNum` is in the event context. For a slash command `ack` is passed
  to the listener (`AckFn<string | RespondArguments>`) and the listener must call it.

## 4. Requirements

### Functional

- F1. Only DM text from allowlisted users goes to the session. Channel, private channel, group DM and thread messages of
  other places NEVER go to the bridge.
- F2. A DM message while attached starts a turn in the session. Delivery rules F1-F3, F9 of the Telegram spec apply
  unchanged (queue, order, delivery timeout notice, late confirm).
- F3. The final answer goes to the Slack DM as new message(s) from the `Stop` hook. It is split into chunks that fit the
  Slack limits. Markdown is converted to Slack mrkdwn (small subset, see section 6.4).
- F4. Turn status uses reactions on the user's message (no "processing" message by default):
  `eyes` when the daemon accepted the message, `white_check_mark` when the turn ended, `x` when the turn failed.
  An optional edited progress message exists as a config flag (default off for Slack).
- F5. Slash command `/cc` with subcommands: `status`, `attach [n|name] [force]`, `detach`, `help`, `pa <text>`.
  `/cc` without arguments shows help. `/cc pa <text>` sends `<text>` to the normal PA agent queue.
- F6. Telegram behavior stays the same (commands, progress message, texts). Regression tests prove it.
- F7. MCP tools and CLI get an optional `channel` (`telegram` or `slack`). Without it they use the configured default channel.
- F8. A message is never forwarded twice (Slack retry or redelivery): dedupe by `channel:ts`.
- F9. Text only in phase 1. Files, images, voice, edits, deletes and thread semantics are ignored (see section 8).

### Non-functional

- N1. Off by default. Slack remote mode needs `claudeCode.remote.enabled: true` and `adapters.slack.enabled: true`.
- N2. Backward compatible: existing Telegram only configs, the token file and the hook protocol work without any change.
- N3. Tokens are secrets: only in the PA `settings.json` (config dir, not in a repository). Never in docs, logs or commits.
- N4. Slack text is untrusted input, same as Telegram text. Same frame, same sanitizer.
- N5. Audit log line for each forwarded message (existing). No secrets, no message text beyond the existing preview rules.
- N6. Hooks and daemon do not need a public URL. Socket Mode only.
- N7. Files: lines in md max about 140 chars, STE English.

## 5. Design

### 5.1 Architecture before and after

Before:

```
Telegram bot --long poll--> telegram adapter --> telegram-router --attached--> RemoteBridge(sender: RemoteTelegramSender)
Slack app ----WebSocket---> slack adapter -----> gateway queue (PA agent only, thread per message)
Claude session hooks <--> /remote/poll, /remote/hook, /remote/control <--> RemoteBridge
```

After:

```
Telegram bot --long poll--> telegram adapter --> telegram-router --+                       +--> TelegramChannel --> Telegram
Slack app ---WebSocket----> slack adapter ----> slack-router ------+--> RemoteBridge ------+--> SlackChannel -----> Slack
   (DM events + /cc command, DM-only,   dedupe)                         (chat keys:         (chunking, mrkdwn, reactions,
                                                                         telegram:<id>,       retry_after mapping)
                                                                         slack:<userId>)
Claude session hooks <--> /remote/poll, /remote/hook, /remote/control <--> RemoteBridge   (UNCHANGED protocol)
```

The bridge talks to a `RemoteChannelRegistry`. It picks the channel from the chat key prefix.

### 5.2 Channel abstraction

New types in `src/remote/protocol.ts` (or `src/remote/channel.ts`):

```ts
export type RemoteChannelId = "telegram" | "slack";
/** Namespaced chat key: `telegram:<chatId>` or `slack:<userId>`. */
export type RemoteChatKey = `${RemoteChannelId}:${string}`;

export interface RemoteChannel {
  readonly id: RemoteChannelId;
  /** Human label used in notices: "Telegram", "Slack". */
  readonly label: string;
  /** Command that detaches, for notices: Telegram `/detach`, Slack `/cc detach`. */
  readonly detachCommand: string;
  /**
   * Send plain text to the chat (the channel chunks and formats it). Rejects on failure. If some chunks were already sent,
   * it rejects with `RemotePartialSendError` and the bridge does NOT retry (no duplicate chunks).
   * ALL functions of the channel get the ID PART of the chat key (`987654321`, `U123`), never the namespaced key.
   */
  sendText(chat: string, text: string): Promise<void>;
  /** Adapter-like functions for the progress accumulator. Absent when the channel has no progress message. */
  progress?: {
    create(chat: string, text: string): Promise<string>;
    update(chat: string, messageId: string, text: string): Promise<void>;
  };
  /** Turn status on the user's message. `ref` comes from the router (Slack: `<dmChannel>:<ts>`). Optional. */
  setTurnStatus?(chat: string, ref: string, status: "accepted" | "done" | "failed" | "dropped"): Promise<void>;
  /** Milliseconds to wait before a retry when `err` is a rate limit error, else undefined. */
  retryAfterMs(err: unknown): number | undefined;
  /** Text for "answer could not be delivered". */
  readonly deliveryFailedText: string;
}

export interface RemoteChannelRegistry {
  get(id: RemoteChannelId): RemoteChannel | undefined;
}

export function makeChatKey(channel: RemoteChannelId, id: string): RemoteChatKey;
/** `telegram:123` -> parts (split at the FIRST colon). A bare integer string (`/^-?\d+$/`, Telegram ids can be negative)
 *  is a legacy Telegram chat id. Returns undefined when invalid. */
export function parseChatKey(key: string): { channel: RemoteChannelId; id: string } | undefined;
```

Bridge changes (details in the plan): `sender: RemoteTelegramSender` becomes `channels: RemoteChannelRegistry`; `notify`,
`sendFinal`, accumulator creation and `retryAfterMs` go through the channel of the chat key. `forward(chat, text, ref?)`
accepts an optional `ref` (message reference) that the bridge keeps with the queued message to set the turn status.
The hook protocol, frame text and delivery rules do not change.

Rules that keep Telegram identical and Slack safe:

- `setTurnStatus` is fire and forget: the bridge never awaits it and catches its rejection. `done` is called AFTER `sendFinal`
  was started, never before, so a slow reaction call cannot delay the answer. The Slack channel serializes the calls per `ref`
  (a promise chain), so a fast `done` cannot overtake the `accepted` add.
- Status calls are also made for every other way a message or a turn ends: stale turn cleared by a terminal prompt
  (`dropped`), `removeSession`, bridge `stop()`, queue dropped by `detachSession`/`force` (`dropped`).
- All Telegram texts stay byte for byte. Texts with a channel word use the label: idle notice
  `no ${label} messages for N min` ("no Telegram messages for 60 min" as today), final failure `deliveryFailedText`. The
  attach notice ends with the channel `detachCommand` ("/detach to stop." for Telegram, "/cc detach to stop." for Slack).
- The control reply `attachedChatId` stays a string but is now namespaced (see 5.3).

### 5.3 Chat keys, config and compatibility

- Chat key = `<channel>:<id>`. Telegram id = private chat id (equals user id). Slack id = Slack USER id (`U...`), not the DM
  channel id. Reason: it ties the key to the allowlist and to the config, and does not need a lookup to build the default
  key. The Slack channel resolves the DM channel with `conversations.open` (needs `im:write`) and caches it.
  VERIFIED ONLINE (docs.slack.dev, chat.postMessage): a user id as `channel` opens a DM. The plan still does not rely on it:
  reactions and `chat.update` need the real DM channel id anyway.
- Backward compatibility: `parseChatKey` treats a bare numeric string as `telegram:<id>`. Old callers of
  `/remote/control` with a bare `chatId` keep working. `RemoteSessionInfo.attachedChatId` now holds the namespaced key (a
  visible change of the control response only, not of the hook protocol). New field `attachedChannel`. The field is in
  `RemoteControlResponse.sessions[]` (`RemoteSessionInfo`), not at the top level. Only `pa remote status` prints it
  (`[attached: telegram:42]`) and tests compare it (see the test list in the plan).
- Config (all new keys optional, defaults keep today's behavior):

```json
{
  "adapters": { "slack": { "enabled": true, "botToken": "<xoxb token>", "appToken": "<xapp token>",
                           "allowedUserIds": ["<your Slack member id>"], "socketMode": true } },
  "claudeCode": { "remote": { "enabled": true, "defaultChannel": "slack",
                              "slack": { "progress": false, "reactions": true, "format": "mrkdwn" } } }
}
```

| Key | Default | Meaning |
|---|---|---|
| `claudeCode.remote.defaultChannel` | `telegram` when Telegram is enabled, else `slack` | Channel used by MCP tools and `pa remote` without `channel` |
| `claudeCode.remote.slack.progress` | `false` | Edited progress message in Slack (tool lines). Off: reactions only |
| `claudeCode.remote.slack.reactions` | `true` | Turn status reactions |
| `claudeCode.remote.slack.format` | `mrkdwn` | `mrkdwn` (small converter) or `plain` (escaped text only) |

`claudeCode.remote.progress` (existing) still controls Telegram. Slack uses `slack.progress`.
Migration: none for users. Old settings files stay valid. Daemon now allows remote mode when Telegram OR Slack is enabled.

### 5.4 One chat per session, across channels

The bridge already refuses an attach by a second chat ("attached to another chat"). With namespaced keys this holds across
channels. DECISION: keep REFUSE as the default, add an explicit `force` replace.

| Situation | Behavior |
|---|---|
| Slack chat attaches to a session attached to a Telegram chat | Refused. Reply names the owner and the way out: "Session 1 is attached to Telegram. Run `/detach` in Telegram, or `/cc attach 1 force` to take it over." (same-channel refusal keeps today's text "<name> is attached to another chat.") |
| Same, with `force` (`/cc attach 1 force`, Telegram `/attach 1 force`, MCP `force: true`) | Old chat is detached (queue and unconfirmed messages dropped, running turn finishes). Old chat gets a notice: "Detached from <session>: taken over by Slack." New chat is attached. |
| A chat attaches to a second session while attached to a first | Existing rule: first session is detached, the second is attached (one session per chat). |

Why refuse by default: it is today's tested behavior, it never drops queued messages of the other chat silently, and the
reply tells how to proceed. Why `force` exists: the owner may be away from the laptop and from the other channel (stale
attach from yesterday). The stale attach also ends by idle detach (default 60 min). Both chats belong to the same
allowlisted person, so a takeover does not widen the trust boundary.

### 5.5 Behavior per event and channel

"Chat" = the attached chat. Texts are examples. The channel only changes how the notice is sent (Slack: DM text).

| Event | Telegram | Slack |
|---|---|---|
| `attach` ok | Bridge posts "Attached to ... /detach to stop." in the chat | Same text in the DM. `/cc` ack is empty (no duplicate) |
| `attach` refused | Reply in chat (router) | Ephemeral ack of `/cc` (only the user sees it) |
| `status` | Reply in chat | Ephemeral ack of `/cc status`. Marks `[attached to this chat]`, `[attached to Telegram]`, `[attached to Slack]` |
| `detach` | Bridge posts notice, drops queue | Same in the DM. `/cc` ack empty |
| Text while attached | `bridge.forward` | `bridge.forward` (DM only) |
| Text while not attached | Normal PA queue | Normal PA queue (DM, as the adapter does today) |
| Turn started (delivery confirmed) | Progress message after first tool event | Reaction `eyes` was set at accept. Optional progress message |
| `Stop` | Progress trim + final answer message | `eyes` removed, `white_check_mark` added, final answer in DM (chunks) |
| `StopFailure` | "Turn failed" notice | `x` reaction + same notice |
| Terminal prompt during a remote turn | "Turn ended: a prompt was typed in the terminal." | Same notice, `eyes` removed |
| Not delivered (timeout) | Notice | Notice, `eyes` replaced by `x` |
| Idle detach | Notice "no Telegram messages for N min" | Notice "no Slack messages for N min". Queued messages dropped, `eyes` removed |
| Session end or pid gone | Notice "<session> ended. Detached." | Same |
| Daemon restart | Attach lost (memory only). User attaches again | Same. A DM text then goes to the PA agent. The user must check `/cc status` |
| `force` takeover | Old chat gets a notice | Old chat gets a notice |

The channel supplies the label and the detach command, so Telegram texts that tests check stay exactly as they are
(`bridge.test.ts` asserts `/no Telegram messages/` and `"Answer could not be delivered (Telegram error)."`).

## 6. Slack specifics

### 6.1 Slash command name

DECISION: `/cc`.

- It is short to type on a phone. It stands for "Claude Companion".
- VERIFIED ONLINE (docs.slack.dev, slash commands): commands are NOT namespaced. Several apps can register the same name and
  Slack invokes the one installed MOST RECENTLY. So a clash with another installed app silently hijacks `/cc`. The manifest
  allows a command name up to 32 characters including `/`. The docs do not say Slack rejects names; the built-in list is on a
  separate page. Slash commands "can be summoned from any conversation" except message threads (so `/cc` does not work in a
  thread: put it in the guide).
- It should not clash with a Slack built-in command. Built-ins known to the author (from memory of the Slack docs, NOT
  re-verified): `/status`, `/remind`, `/dm`, `/msg`, `/me`, `/shrug`, `/invite`, `/leave`, `/mute`, `/open`, `/search`,
  `/topic`, `/who`, `/apps`, `/call`, `/dnd`, `/feed`, `/join`, `/keys`, `/pref`, `/rename`, `/remove`, `/star`,
  `/archive`. So a direct `/status` or `/attach` is not possible: `/status` is the built-in user status command.
  That is the reason for ONE command with subcommands.
- Slack rejects a reserved name when the command is saved in the app (no official reserved list was found in the docs). The
  owner records the real result in manual check item 0 of the plan.
  Fallbacks if `/cc` is taken in the workspace by another app: `/cmp`, `/companion`.
- `/claude` is NOT used: other Claude apps for Slack may register it. Avoid a clash.

Subcommand `pa`: `/cc pa <text>` is the equivalent of Telegram `/pa <text>`. It makes sense because a DM while attached
goes to the session. The escape to the PA agent is needed in Slack too. Typing `/cc pa ...` in a DM is the natural place.

The command can be typed in ANY channel or DM, also where the app is not present. Rules: the handler checks
`command.user_id` against the allowlist; the answer is always EPHEMERAL (`ack` with `response_type: "ephemeral"`, also the
documented default);
the chat key is built from `user_id`, never from `channel_id`. A command typed in a public channel therefore never
leaks session names to other people, and never attaches a channel.

### 6.2 Inbound DM path

Adapter filter order for a `message` event (any failure: drop with debug log, never reply):

1. `bot_id` present or `subtype` present: drop (existing).
2. `user` missing or not in `allowedUserIds`: drop (FIX of the existing hole).
3. `channel_type !== "im"`: not a remote message. It goes on the old path (normal PA queue as today) but NEVER to the
   bridge. Metadata `channelType` is added to the `AdapterMessage` so the router can check it. A reply inside a DM thread
   (`thread_ts` set, `channel_type` im) is a normal DM message for the bridge (no thread semantics in phase 1).
4. Dedupe `channel:ts` in a bounded TTL set (for example 500 entries, 10 min). A duplicate is dropped with a debug log.
   The dedupe is applied in the adapter AFTER filters 1-3 and BEFORE the old path too (a replay must not enqueue twice).
5. Empty text: drop.

Inbound text decoding (slack-router, remote path only; the old PA path is unchanged): Slack sends `&amp; &lt; &gt;` escaped and
links as `<https://x|label>` or `<https://x>`. Before `bridge.forward` decode entities, turn links into `label (url)` or `url`,
keep `<@U1>` mentions as `@U1`. Reason: the model must read what the user typed, and `stripRemoteEcho` compares the echo line
with the forwarded text.

Bolt acks Events API events RIGHT AWAY, before the listener runs (verified in `node_modules`, see section 3). A slow listener
therefore does not cause a redelivery. The `channel:ts` dedupe is the safety net for replays after a reconnect and does not
depend on `retryNum`. The Slack docs document `retry_num` for HTTP only and say events can be lost while no connection is open, so
a replay after a reconnect is not expected, and the code does not rely on one. Manual check item 15 of the plan looks at it.

### 6.3 Slash command path

`app.command("/cc", handler)`. The handler must `ack` within 3 s. `bridge.control` is in memory, so the handler awaits it,
then calls `ack(text)` (ephemeral) for `status`, errors, and `help`, and `ack()` for a successful attach or detach (the
bridge posts the confirmation into the DM). The handler must NOT await a Slack API call before `ack` (the bridge `notify` is not
awaited). Any handler error still ends in an ephemeral `ack`. If anything could be slow, `ack()` first and use `respond` later.
`/cc pa <text>` has no message `ts` (a command is not a message): the router posts the PA answer as a top level DM message
(the adapter omits `thread_ts` when it is empty), see task 6.

### 6.4 Reply formatting

- Final answer = `last_assistant_message` (markdown from the model).
- `format: mrkdwn` (default): minimal converter, tested: `**bold**` to `*bold*`, `# heading` to a bold line,
  `[text](url)` to `<url|text>`, bullets `-` and `*` to `•`, code fences and inline code kept as they are, text inside code
  is NOT converted. Escape `&`, `<`, `>` outside code (stops `<!channel>` and `<@U..>` mention injection from model text).
  Tables stay as text (Slack has no table markup in mrkdwn).
- `format: plain`: only escape and send with `mrkdwn: false`.
- Length: VERIFIED ONLINE (chat.postMessage docs): keep `text` to about 4,000 chars (longer may be split by Slack); above
  40,000 it is truncated with a `message_truncated` warning. A block `section` text limit of 3,000 is from memory (not used).
  Plan: send with the plain `text` field only (no blocks), chunk size 3,500 chars, split on a newline or a space, never inside
  a code fence (close and reopen the fence at the cut). Cap: at most 20 chunks per answer (about 70,000 chars); the rest is
  replaced by "[...answer truncated]" so the send time stays bounded (20 chunks x 1 s pacing).
- Chunks are sent in order, one by one (awaited). Each chunk has its OWN retry inside `SlackChannel.sendText` (3 tries, delays
  as below). If a chunk still fails after chunks were sent, `sendText` rejects with `RemotePartialSendError`; the bridge then
  skips its whole-answer retry (it would re-send chunk 1..n again) and sends `deliveryFailedText`. If nothing was sent yet,
  the bridge retry loop works as today.

### 6.5 Rate limits and retries

- Slack `chat.postMessage`: about 1 message per second per channel, several hundred per minute per workspace, generous burst
  (special limits, VERIFIED ONLINE in the docs, not measured here). A `429` carries `Retry-After`.
- The default WebClient retries by itself for a long time (10 retries over about 30 min) and has NO request timeout (both
  verified in `node_modules`). That would block the final answer loop for minutes or forever. DECISION: create the Bolt app with
  `clientOptions: { rejectRateLimitedCalls: true, retryConfig: { retries: 2 }, timeout: 15000 }`. Option names and the
  `WebAPIRateLimitedError` (`retryAfter` seconds) are verified in `node_modules`; the run-time behavior is a manual check (item 17). The
  channel maps that error to `retryAfterMs(err)`, capped by the existing `MAX_RETRY_AFTER_MS` (30 s). These options also apply
  to the existing PA thread flow of the same adapter (it gets faster failure, no 30 min retry). That is intended and tested.
- The bridge `sendFinal` loop stays: 3 tries, delays 1 s and 3 s, or the channel `retryAfterMs`. Then
  `channel.deliveryFailedText` ("Answer could not be delivered (Slack error).").
- Chunk pacing: wait 1 s between chunks of one answer.
- Reactions: `reactions.add` is Tier 3 (50+ per minute, VERIFIED ONLINE; `remove` assumed the same). One add and one swap per
  message is far below that. Known errors (`already_reacted`, `no_reaction`, `message_not_found`, `too_many_reactions`,
  `thread_locked`) are ignored. Any other reaction error is logged at debug (error name only) and never blocks a turn.
  Reaction calls never run inside the final answer path (see 5.2 rules).

### 6.6 Socket Mode connection

- One persistent WebSocket, push events. No polling by the daemon. No public endpoint.
- Reconnect is automatic (`autoReconnectEnabled` default true). VERIFIED ONLINE (docs.slack.dev, Socket Mode): Slack sends a
  `disconnect` message with reason `warning` about 10 s before it closes, and `refresh_requested`; connections refresh every few
  hours; an app may hold up to 10 connections and events may go to ANY open connection (so two daemons with one app token
  split the events, risk R3 is real).
- Events sent while the socket is down: the Slack docs do not say if they are buffered or lost. NOT verified. Mitigation: the
  `eyes` reaction is a receipt. No `eyes` on a message means the daemon did not accept it. Say this in the guide.
- Event loop stall (see `src/backends/codex.ts` about line 277): under heavy RAM pressure the loop stalls, pongs are
  missed and the socket reconnects. Not a new risk (the adapter exists already), but remote mode makes it visible.
  Mitigation: guide note (do not run heavy builds while you chat with the session), log the reconnect events at info
  level, no extra code in phase 1.

### 6.7 Resources: Socket Mode idle cost vs Telegram long polling

Numbers come from code and docs. They are NOT measured.

| | Telegram | Slack Socket Mode |
|---|---|---|
| Idle network | A long poll `getUpdates` (grammY default timeout 30 s, from library docs, not checked in code here): about 2,880 HTTPS requests per day | One open WebSocket with ping and pong frames. Client ping timeout 5 s, server ping timeout 30 s (library code) |
| Idle CPU and memory | Small | Small. Bolt and the Slack SDK are already loaded when the Slack adapter is enabled |
| Extra cost of remote mode | None | None on top of the existing Slack adapter (no new connection) |

A new measurement is not needed for the decision. Task 9 may record `ps` memory before and after enabling Slack as a note.

## 7. Security

- Allowlist: events and commands are checked on `user` / `user_id` against `adapters.slack.allowedUserIds`. The existing
  hole (missing `user` passes) is fixed first.
- DM-only for the bridge: `channel_type === "im"`. The app may be invited into channels. Such messages never reach the
  bridge. The `/cc` command is allowed from anywhere but answers ephemerally and attaches the USER's DM, not the channel.
- App-level token (`xapp-`, scope `connections:write`) and bot token (`xoxb-`) are secrets. They live only in the PA
  `settings.json` in the config dir (not in a repository). Never commit them, never paste them in a chat, never put them in
  docs or logs. The logger already redacts `appToken`. Task 4 adds a test for `botToken` and checks `redact` for `xoxb-`
  and `xapp-` patterns (the daemon `redact` is in `src/security/content-redaction.ts` and has none today, see section 3; it is
  applied to final answers and progress text, so a token printed by the model is hidden). `settings.json` must be mode 0600
  (the guide says `chmod 600`; the daemon logs a warning at start when it is group or world readable). Rotate tokens if they
  leak (Slack app page, Reinstall / Regenerate).
- Prompt injection: Slack text is untrusted like Telegram text. It goes through the same sanitizer and frame. With
  `--dangerously-skip-permissions` a DM can make the session run commands. Only the allowlisted user can DM the bot. Keep the
  allowlist to one id. Model output sent back is escaped (`&`, `<`, `>`) so it cannot ping others.
- A second Slack user in a shared workspace cannot attach, forward or even see the session list (ephemeral replies only to
  the allowlisted user; others get nothing, only a warn log).
- The hook protocol and the localhost token stay as they are (127.0.0.1, bearer token, 0600 file).
- Audit: existing log line per forwarded message, chat key in the line (`slack:U...` is an id, not a secret).

## 8. Out of scope (phase 1)

- Voice, images, documents, file shares, message edits and deletes, message threads as separate chats, App Home tab,
  interactive buttons (the `/cc` command only), permission relay, Block Kit formatting.
- Company workspace. Persisting attach state across daemon restart. More than one allowlisted user per daemon with separate
  attachments (works by key, not tested as a goal).
- Telegram `setMessageReaction` status (Telegram keeps its progress message).

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Generalizing the bridge breaks Telegram | Regression first: keep all `bridge.test.ts` and `telegram-router.test.ts` cases green with a `TelegramChannel` fake. New cases only add |
| Existing Slack adapter hole (no `user` passes) | Fix and test in task 4 before any remote code uses the adapter |
| Slash command clash or rename | Manual check item 0 of the plan. Fallback names listed |
| WebClient retries block the final answer | `rejectRateLimitedCalls`, 2 retries, our own loop (manual check item 17) |
| Lost events during reconnect | `eyes` receipt, guide note |
| Event redelivery | `channel:ts` dedupe |
| mrkdwn converter bugs | Small subset, property style tests, `plain` fallback flag |
| Slack token in logs or in a forwarded answer | Logger redaction test, `redact` check, never log the Bolt client config |
| User thinks the chat is attached after a daemon restart | Guide note, `/cc status` is cheap. A later option: a DM notice at daemon start when remote mode is on |
| The bot is used in channels by the existing PA flow (thread per message) | Unchanged. Remote path is DM-only |
| Company workspace later needs admin approval | Out of scope. Same manifest, same code. Only tokens and the allowlist change |

## 10. Rollout and rollback

- Rollout: merge behind existing flags (`claudeCode.remote.enabled`, `adapters.slack.enabled`). Telegram only users see no
  change. Enable Slack in the personal workspace, run the E2E checklist, then use it.
- Rollback: set `adapters.slack.enabled: false` (or remove the `claudeCode.remote.slack` block). Remote mode with Telegram
  keeps working. Full code rollback = revert the merge (no data migration, no schema in a database, no token file change).
- Slack side: uninstall or delete the app in the Slack app settings. Regenerate or revoke the tokens.

## 11. Acceptance criteria

- A1. Attach from Slack (`/cc attach`), send a DM, the answer arrives in the DM exactly once, in order, chunked when long.
- A2. `eyes` appears on the DM when accepted, `white_check_mark` replaces it at turn end, `x` on failure.
- A3. Telegram behavior is unchanged (all old tests pass, new regression tests added).
- A4. A message from a non-allowlisted user, a message in a channel, and a message without `user` never reach the bridge.
- A5. A duplicate Slack event is forwarded once.
- A6. Attach from the second channel is refused with a clear message, `force` replaces and the old chat is told.
- A7. Idle detach, session end and `/cc detach` behave as the table in 5.5 says, for both channels.
- A8. The guide, manifest and README link exist. No real token appears anywhere in the repository (grep check in task 9).
- A9. Targeted unit and integration tests pass (all with mocks, no Slack token). The manual E2E checklist is run by the owner in
  the personal workspace after delivery; it is not an agent task.
