# Claude Code remote session (Slack)

## What it does

You run a Claude Code session on your laptop. You attach a Slack direct message (DM) to it. A DM text goes into the running
session as a new user turn. The PA daemon sends the answer back to the DM. It is the same bridge as for Telegram. See
[claude_code_remote_session.md](claude_code_remote_session.md) for the hook mechanism, the hook install and the Telegram flow.

```
Slack DM <-> Slack app (Socket Mode) <-> PA daemon (laptop) <-> hooks (pa-remote-hook) <-> Claude Code session
```

- Socket Mode: the daemon opens the connection. No public URL and no open port.
- Remote mode is off by default (`claudeCode.remote.enabled: false`).
- The hook protocol, the token file and the frame header are the same as for Telegram. They have no Slack part.
- Telegram behavior and texts do not change.

## Step 1 - Slack app

Two ways. Way A (recommended): extend the Slack app that PA already uses. Its tokens are already in `settings.json`.
Way B: create a new app from the manifest. Open https://api.slack.com/apps, choose Create New App, From an app manifest, choose
your workspace, paste the YAML.

Manifest:

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
|------|-----|
| `commands` | Registers `/cc` |
| `chat:write` | Post answers and notices |
| `im:history` | Receive `message.im` events |
| `im:write` | `conversations.open` to find the DM channel |
| `reactions:write` | `reactions.add` and `reactions.remove` for the turn status |
| event `message.im` | DM messages only. No `message.channels` and no `message.groups` |
| `messages_tab_enabled: true` | Lets you write to the app in a DM |

Notes:

- Way A: add only the missing items (the command, the scopes, the event, the Messages tab). Then reinstall the app to the
  workspace. Slack requires a reinstall for new scopes. After the reinstall compare the Bot User OAuth Token with
  `settings.json`. The Slack docs do not say if it changes. The App-Level Token stays.
- The old PA channel mode (a thread per message in a private channel) needs more scopes and events. See
  [slack_configuration.md](slack_configuration.md). Remote mode does not need them. In way A you keep them. The remote router
  ignores channel messages (DM only).
- The App-Level Token (`xapp-`, scope `connections:write`) is made by hand: Basic Information, App-Level Tokens. A manifest
  cannot make it.
- Request URL of `/cc`: with Socket Mode the command arrives over the socket and the URL is not called. If Slack asks for a
  URL, enter a placeholder, for example `https://example.com/slack/commands`. That Slack accepts it is NOT verified (see the
  checklist, item 0).

## Step 2 - Tokens and settings.json

1. Copy the Bot token (`xoxb-`) and the App-Level Token (`xapp-`). Tokens are SECRETS. Do not paste them into chat,
   screenshots, issues or git.
2. Get your Slack member id: profile, three dots, Copy member ID (`U` plus letters and digits).
3. Edit `settings.json` in the PA config directory (`PA_CONFIG`, default `~/.personal-assistant`). The file is outside any
   repository. Run `chmod 600` on it. The example has placeholders only:

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
  "claudeCode": {
    "remote": {
      "enabled": true,
      "defaultChannel": "slack",
      "slack": { "progress": false, "reactions": true, "format": "mrkdwn" }
    }
  }
}
```

| Key | Meaning |
|-----|---------|
| `defaultChannel` | Channel for `pa remote` and MCP tools when no chat is given (`telegram` or `slack`) |
| `slack.progress` | Progress message in the DM (default `false`) |
| `slack.reactions` | Status reactions on your DM (default `true`) |
| `slack.format` | `mrkdwn` (Markdown converted to Slack mrkdwn) or `plain` |

## Step 3 - Install hooks and start

1. Run `pa init --claude-code` and `pa init --claude-remote` (see the Telegram guide, step 3).
2. Start the daemon (`pa daemon`). The log shows "Slack adapter started" and "Remote session bridge ready".
3. Start `claude` (or `pa claude`) in the workspace.
4. Open the app in Slack (Apps, the app name, Messages tab). Send `/cc status`, then `/cc attach`.

## Control with /cc

| Command | Action |
|---------|--------|
| `/cc status` | Lists live sessions. Marks `[attached to this chat]`, `[attached to Telegram]`, `[attached to Slack]` |
| `/cc attach [n\|name] [force]` | Attaches this chat to a session |
| `/cc detach` | Detaches |
| `/cc pa <text>` | Sends the text to the PA agent (not to the session). The answer is a top level DM message |
| `/cc help` | Shows help |

Answers to `/cc` are ephemeral: only you see them. Exceptions: a successful `attach` and `detach` post their notice in the DM.
Plain DM text goes to the session when attached, and to the PA agent (in a thread, as before) when not attached.

## What you see

- `eyes` on your DM: the message is accepted.
- `white_check_mark` (and `eyes` removed): the turn is done. The final answer is a DM message.
- `x`: the turn failed, or the message was not delivered. A notice explains it.
- A long answer is split into chunks of at most 3,500 characters. The chunks arrive in order. A code fence is closed and
  reopened at a cut.
- A prompt typed in the terminal while attached is a terminal turn. Nothing goes to Slack.
- Idle detach (`idleDetachMinutes`, default 60) and session end send a notice. Queued messages are dropped.

## One chat per session

One chat is attached per session, across Telegram and Slack.

- Attach to a session that another channel holds: refused. The reply names the owner and the way out.
- `/cc attach 1 force` (Telegram: `/attach 1 force`, MCP: `force: true`) takes it over. The old chat gets the notice
  "Detached from <session>: taken over by Slack." Its queued messages are dropped. A running turn finishes.
- The operator can run `pa remote detach` on the laptop to detach a Slack chat too.

## Security

- Only ids in `adapters.slack.allowedUserIds` can use the bridge. Other users get no reply and a warn log line.
- DM only. A channel message never reaches the session. `/cc` in a channel gets an ephemeral answer.
- The daemon routes listen on `127.0.0.1` only and need the bearer token of the file `remote-token`. The Telegram guide
  describes it.
- Slack text is untrusted input. The hook removes control, invisible and bidi characters and wraps the text in a frame.
- With `--dangerously-skip-permissions` a DM can make the session run commands. Keep `allowedUserIds` short.
- Tokens are not logged. The redactor knows `xoxb-` and `xapp-` patterns. Never share a token. If a token leaks, regenerate it
  in the app settings or delete the app.
- Never run one app token in two daemons. Slack spreads events over the connections, so a second daemon gets part of your
  messages. Documented Slack Socket Mode behavior, not tested here.

## Troubleshooting

| Problem | Cause and fix |
|---------|---------------|
| No `/cc` command in Slack | The command is missing, or the app was not reinstalled. Add it, reinstall. Another app can own `/cc` |
| `/cc` shows an error | Slack refuses the command without a URL: use a placeholder URL. Check that Socket Mode is on |
| No `eyes` on a DM | Not received. Check `reactions:write`, `im:history`, `message.im`, `slack.reactions`, the log. Send again |
| Token errors in the log (`invalid_auth`, `not_authed`) | Wrong or revoked `botToken` or `appToken`. Copy them again after the reinstall |
| `missing_scope` | Add the scope in the app, reinstall, update the token |
| Half of the DMs are lost | A second daemon uses the same app token. Stop it |
| Nothing arrives after a network gap | Socket Mode reconnects. Events from the gap can be lost. No `eyes` means not received. Send again |
| Nothing arrives after a daemon restart | The attach is in memory. Send `/cc status`, then `/cc attach` |
| No `remote-token` file | The daemon is not running, or `claudeCode.remote.enabled` is false |
| Session not listed | Hooks problems: see the Telegram guide, Troubleshooting |

## Tested / not tested

Tested (automated tests, FAKE tokens such as `xoxb-test`, mocked `@slack/bolt` and a fake `SlackRemoteApi`):

- Chat keys, bridge, Slack router and channel, mrkdwn conversion and chunking, DM-only and allowlist checks.
- Daemon wiring, control routes, MCP tools and CLI with the channel and `force`.
- Token redaction. Telegram tests stay green and unchanged.

NOT tested (needs a real app, the owner does it):

- A real Slack workspace, real tokens and a real `claude` session with Slack.
- That Slack accepts `/cc` with a placeholder Request URL, and an empty `/cc` reply.
- A reaction in a DM, events lost during a reconnect gap, escaping of inbound text, a `/cc` name clash.
- Rate limit behavior with a real workspace.

## Manual checklist

Setup: the app (way A or B), tokens in `settings.json`, `pa init --claude-remote`, daemon running, `claude` in the workspace.

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
