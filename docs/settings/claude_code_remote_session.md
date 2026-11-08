# Claude Code remote session (Telegram)

## What it does

You run a Claude Code session on your laptop. You attach your phone to it through Telegram. A Telegram message goes
into the running session as a new user turn. The session keeps its own history. The PA daemon sends the progress and
the final answer back to Telegram.

```
Phone (Telegram) <-> new laptop bot <-> PA daemon (laptop) <-> hooks (pa-remote-hook) <-> Claude Code session
```

## Important facts

- Claude Code Channels are NOT used. An organization policy can block them (Team plan).
- The mechanism is an `asyncRewake` hook. The hook makes a long poll to the PA daemon. When a message arrives, the hook
  exits with code 2 and wakes the idle session.
- It works in any terminal. tmux is optional. tmux is useful because the session survives a closed terminal window.
- The mode is off by default (`claudeCode.remote.enabled: false`).
- Tested with Claude Code 2.1.319. The `asyncRewake` behavior can change in new versions.

## Prerequisites

- The `pa` CLI and the small hook command `pa-remote-hook` are installed and are on `PATH`. The hooks run
  `pa-remote-hook <mode>`. It is a separate bin. It starts in about 30 ms. The old form `pa claude-remote-hook <mode>`
  still works as a subcommand, but it starts slower.
- Build and link from this version. In the repository run `npm run build` and `npm link`. Run `npm link` again, so the
  NEW bin `pa-remote-hook` exists. Check: `command -v pa-remote-hook` prints a path. Check: `pa --help` lists `remote`.
- Claude Code (`claude`) is installed and logged in.
- A working PA configuration. See [claude_code_companion.md](claude_code_companion.md).
- A Telegram account on your phone.

## Step 1 - Create a NEW Telegram bot for the laptop

1. Open a chat with @BotFather. Send `/newbot`. Follow the steps. Copy the token.
2. Get your numeric Telegram user id. See [telegram_configuration.md](telegram_configuration.md).

Rules:

- The VPS keeps the old bot. The laptop uses the new bot.
- Never use one token in two daemons. Two pollers on one token give `409 Conflict`.

## Step 2 - Laptop settings.json

Edit `settings.json` in the laptop config directory (`PA_CONFIG`, default `~/.personal-assistant`):

```json
{
  "adapters": {
    "telegram": {
      "enabled": true,
      "botToken": "123456789:ABCdef-NEW-LAPTOP-TOKEN",
      "allowedUserIds": [987654321],
      "mode": "polling"
    }
  },
  "heartbeat": { "enabled": false },
  "claudeCode": {
    "remote": {
      "enabled": true
    }
  }
}
```

You do not need `mcp.httpServer.enabled`. The daemon starts the local HTTP server by itself when remote mode is on.

`heartbeat.enabled: false` stops only the heartbeat. These scheduled things stay on in the laptop daemon:

| What | Default | How to turn it off |
|------|---------|--------------------|
| Daily reflection (07:00) | on | `reflection.enabled: false` (this also stops the weekly one) |
| Weekly reflection (Monday 07:05) | on | `reflection.weeklyEnabled: false` |
| Memory index sync at start | on | No key. It only embeds changed files. |
| Memory index sync every 30 min | on | `memory.sync.intervalMinutes: 0` |
| Cron jobs (`cron-jobs.json` in the data dir) | the jobs you created | Remove the jobs with the cron tools |

Keep the bot token out of git. The config directory is not part of a project repository. Do not copy `settings.json`
into a repository.

All `claudeCode.remote` keys:

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `false` | Turns remote mode on. The daemon then writes the token file and enables the `/remote/*` routes. |
| `idleDetachMinutes` | `60` | Detach the session after this many minutes without Telegram messages. |
| `deliveryTimeoutMs` | `20000` | Time to wait for a poll and for a reaction of the session. See "Delivery" below. |
| `progress` | `true` | Show progress (tool calls and text) in one edited Telegram message. |
| `maxMessageChars` | `4000` | Longest Telegram message sent to the session. Longer text is cut. |
| `maxMessagesPerMinute` | `20` | Rate limit per chat. |
| `reasoning` | `false` | Reserved. It has no effect now. |

The daemon HTTP server uses the port `codex.httpMcpPort` (default `47392`). The hooks read the same key.

## Step 3 - Install the hooks

The remote hooks are opt-in. `pa init --claude-code` alone installs NO remote hooks.

1. Run `pa init --claude-code` (once). It creates `.mcp.json`. The `pa` MCP server there gives the session the tools
   `remote_session_status`, `remote_session_attach`, `remote_session_detach`. It is required for these MCP tools. It is
   optional for the rest (Telegram `/attach` and the `pa remote` CLI work without it).
2. Run:

```bash
pa init --claude-remote
```

What it does:

- It merges the hooks into the workspace file `.claude/settings.json` and into the launcher file
  `$PA_CONFIG/claude-code/settings.json`. The hooks come from `src/templates/claude-code/remote-settings.json`.
- Hook modes: `listen-start` (SessionStart), `listen-stop` (Stop), `listen-fail` (StopFailure), `listen-prompt`
  (UserPromptSubmit). These four wait for a Telegram message. The plain events are PreToolUse, MessageDisplay,
  Notification and SessionEnd.
- It adds the three allow entries `mcp__pa__remote_session_status`, `mcp__pa__remote_session_attach` and
  `mcp__pa__remote_session_detach` to `permissions.allow`.
- It creates a missing file from the base template first, then merges. It does not change other keys or other hooks.
- It reads and checks both files before it writes. If one file is not valid JSON, it stops and changes nothing.
- It is idempotent. You can run it again. It does not add a hook twice.
- It upgrades hooks and entries of old versions in place (for example the old `pa claude-remote-hook` form).

Claude Code loads hooks at session start. Restart running sessions after this step.

## Step 4 - Start the daemon and a session

1. Start the daemon on the laptop:

   ```bash
   pa daemon
   ```

2. In the assistant workspace, start a session. Use one of these:

   ```bash
   pa claude
   claude --dangerously-skip-permissions
   ```

   Example alias for the second command:

   ```bash
   alias cc='claude --dangerously-skip-permissions'
   ```

The session registers with the daemon when the SessionStart hook starts. Optional: run the session in tmux. If you
close the terminal window, the session stays alive.

Read "Tested / not tested" and "Security" below before you use `pa claude` for remote turns.

## Step 5 - Control from the phone

Telegram commands (only from users in `allowedUserIds`):

| Command | Result |
|---------|--------|
| `/help` (also `/start`) | Shows the command list and whether this chat is attached. Works only in remote mode. |
| `/status` | Lists the live sessions. Shows which one is attached. |
| `/attach` | Attaches to the only session. With several sessions it asks you to choose. |
| `/attach <n>` | Attaches to session number `n` from `/status` (a session name also works). |
| `/detach` | Detaches. Queued messages are dropped. |
| `/pa <text>` | Sends the text to the normal PA agent. Works while attached. |
| normal text | Goes to the attached session as a new user turn. Without attach it goes to the normal PA agent. |

Voice, photo, and document messages arrive in the session as plain text:

- Voice: the transcript text. This needs `adapters.telegram.audio` enabled (default) and `OPENAI_API_KEY` in the daemon
  environment.
- Photo or document: the text `Received image|document and saved it to documents/telegram-inbox/<file>`. The path is
  relative to the daemon workspace. So the session must run in the daemon workspace to find the file.
- Replies to Telegram are text only.

The session itself can use these PA MCP tools: `remote_session_status`, `remote_session_attach` (optional `target`),
`remote_session_detach`.

From a terminal on the laptop:

```bash
pa remote status
pa remote attach [target]
pa remote detach
```

These CLI commands use the first id in `allowedUserIds` as the chat.

What you see in Telegram:

- One progress message per turn. The daemon edits it. It shows tool calls and assistant text.
  Tool lines of subagents have the prefix "(subagent)".
- The final answer as a new message.
- Turns that you start in the terminal are not sent to Telegram.
- Session numbers in `/status` are stable. They do not shift when another session ends.

What you see in the terminal:

- Claude Code shows a Telegram message only as the line "Stop hook feedback". It hides the text. The hook cannot change this.
- To make the message visible, the frame asks the model to start its reply with one line
  `📱 Telegram: <the message, at most 100 characters>`. This is a normal assistant line in the terminal.
- The daemon removes such lines before it sends the progress message and the final answer to Telegram.
- The model follows this instruction on its own. If it does not, the terminal shows only "Stop hook feedback".
  Nothing else breaks.

Ignored on purpose:

- Headless `claude -p` runs.
- PA's own Agent SDK turns (the daemon sets `PA_REMOTE_HOOKS=off` for them).

Delivery:

- A message goes to the waiting listener at once. The order is kept. Claude Code decides when it processes the message.
  Tested only with a short turn.
- If you type a prompt in the terminal during a Telegram turn, the Telegram turn ends. You get "Turn ended: a prompt
  was typed in the terminal."
- `/clear` and `/resume` keep the attachment. The daemon ignores SessionEnd with these reasons.
- No poll after `deliveryTimeoutMs`: you get "The session is not listening right now (no poll). ..." The message stays
  queued. Send a prompt in the terminal to wake the listener.
- No reaction after `deliveryTimeoutMs`: you get "Not delivered to the session ...". The timer does not count while a
  turn runs. A late confirmation within 5 minutes still works.
- The final answer has 3 send tries. If all fail you get "Answer could not be delivered (Telegram error)."
- The daemon refuses a poll from a removed session for 60 s. So an old hook cannot bring a dead session back.

Auto detach:

- The session ends (SessionEnd hook).
- The session process is gone (the daemon checks every 30 s). In the tests the SessionEnd event did not always arrive
  before exit, so the auto detach after `/exit` can take up to 30 s.
- No Telegram message for `idleDetachMinutes`.

The daemon tells you in Telegram about each detach.

Limits:

- `maxMessageChars`: longer text is cut and gets a truncation marker.
- `maxMessagesPerMinute`: more messages are refused ("Not sent to the session: rate limit ...").
- `deliveryTimeoutMs`: see "Delivery" above.

## Security

- Only users in `adapters.telegram.allowedUserIds` can send messages. The adapter checks the sender before the router.
- The daemon routes listen on `127.0.0.1` only. The server checks the Host and Origin headers.
- Each route needs a bearer token. The daemon creates a random token at start in the file `<config dir>/remote-token`
  (mode `0600`). The daemon removes the file at stop.
- Telegram text is untrusted user input. The hook removes control, invisible and bidi characters anywhere in the text.
  It makes fake frame headers and system tags harmless. It wraps the text in a clear frame.
- With `--dangerously-skip-permissions` there are no approval prompts. A Telegram message can make the session run
  commands. Use a bot token that only you control. Keep `allowedUserIds` short.
- With `pa claude` (no skip-permissions) a tool that needs approval blocks the remote turn. The phone cannot approve.
  Add tool allow rules, or use skip-permissions knowingly.
- The hooks run in every session of the workspace. They exit at once when there is no token file (daemon not running or
  remote mode off). They never block or fail the session.
- Each forwarded message gets an audit log line (no secrets).

## Troubleshooting

| Problem | Cause and fix |
|---------|---------------|
| `/status` shows no sessions | Hooks are not installed. Run `pa init --claude-remote`. |
| `/status` shows no sessions | The session started before `init`. Restart it. |
| `/status` shows no sessions | The token file is missing: daemon not running, or `remote.enabled` is false. |
| `/status` shows no sessions | `pa-remote-hook` is not on `PATH` of the session. Run `command -v pa-remote-hook`. |
| `409 Conflict` in the daemon log | Another daemon uses the same bot token. Use a separate bot for the laptop. |
| "Not delivered to the session" | The session did not react in time. Check that the session runs and uses the hooks. Try again. |
| "The session is not listening right now" | No listener polls. Send a prompt in the terminal. The message stays queued. |
| Hooks do nothing | `claudeCode.remote.enabled` is false, or the daemon is not running. |
| Hooks do nothing, or `pa-remote-hook: command not found` | The new bin is missing. Run `npm run build` and `npm link`. |
| After a daemon restart nothing arrives | The attach state is in memory only. Send `/status`, then `/attach` again. |
| `pa remote ...` says the token file is missing | The daemon is not running, or remote mode is off. |
| No `remote-token` file, but `remote.enabled` is true | `adapters.telegram.enabled` is false. The daemon logs a warning. |
| `pa claude-remote-hook` is unknown | The global `pa` is old. Run `npm run build` and `npm link` in the repository. |
| Behavior changed after a Claude Code update | `asyncRewake` is a Claude Code feature that can change. Tested with 2.1.319. |

## Tested / not tested

Tested (Claude Code 2.1.319, tmux, real `claude`, real bridge and routes, FAKE Telegram sender):

- The session registers at start. `attach` works.
- A forwarded message wakes an idle session. One progress message and one final answer arrive.
- A terminal turn while attached sends nothing to Telegram. A second Telegram message works again.
- `/exit` detaches (up to 30 s).
- Unit tests and an integration test cover the daemon side.

NOT tested:

- A real Telegram bot.
- The restricted launcher `pa claude`.
- Plain `claude --dangerously-skip-permissions` (only plain `claude` with `--settings` was run).
- Voice and photo through real Telegram.
- Notification events.
- A message sent while a long turn runs (only a short turn).

Run the checklist below with your real bot before you rely on it.

## Manual verification checklist

1. `pa init --claude-remote` prints the hooks as created, added, or already present.
2. Start `pa daemon`. Check that the file `remote-token` exists in the config directory.
3. Start a session in the workspace. Send `/status` in Telegram. The session is listed.
4. Send `/attach`. The bot confirms.
5. Send a short text. The session starts a turn. One progress message appears and the final answer arrives as a new message.
6. Type a prompt in the terminal. Nothing goes to Telegram.
7. Send `/pa hello`. The normal PA agent answers.
8. Send `/detach`. The bot confirms. A new text goes to the normal PA agent.
9. Exit the session while attached. The bot tells you about the detach.
10. Stop the daemon. The token file is removed.
