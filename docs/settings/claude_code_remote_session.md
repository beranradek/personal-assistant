# Claude Code remote session (Telegram)

## What it does

You run a Claude Code session on your laptop. You attach your phone to it through Telegram. A Telegram message goes
into the running session as a new user turn. The session keeps its own history. The PA daemon sends the progress and
the final answer back to Telegram.

```
Phone (Telegram) <-> new laptop bot <-> PA daemon (laptop) <-> hooks (pa claude-remote-hook) <-> Claude Code session
```

## Important facts

- Claude Code Channels are NOT used. An organization policy can block them (Team plan).
- The mechanism is an `asyncRewake` hook. The hook makes a long poll to the PA daemon. When a message arrives, the hook
  exits with code 2 and wakes the idle session.
- It works in any terminal. tmux is optional. tmux is useful because the session survives a closed terminal window.
- The mode is off by default (`claudeCode.remote.enabled: false`).
- Tested with Claude Code 2.1.319. The `asyncRewake` behavior can change in new versions.

## Prerequisites

- The `pa` CLI is installed and is on `PATH` (the hooks run the command `pa claude-remote-hook`). It must be built from
  this version: run `npm run build` in the repository (and `npm link` once). Check: `pa --help` lists `remote`.
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
  "mcp": { "httpServer": { "enabled": true } },
  "claudeCode": {
    "remote": {
      "enabled": true
    }
  }
}
```

Set `heartbeat.enabled` to `false`. Then the laptop does not repeat the heartbeat work of the VPS.

Keep the bot token out of git. The config directory is not part of a project repository. Do not copy `settings.json`
into a repository.

All `claudeCode.remote` keys:

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `false` | Turns remote mode on. The daemon then writes the token file and enables the `/remote/*` routes. |
| `idleDetachMinutes` | `60` | Detach the session after this many minutes without Telegram messages. |
| `deliveryTimeoutMs` | `20000` | A forwarded message not taken by the session in this time gets a "not delivered" notice. |
| `progress` | `true` | Show progress (tool calls and text) in one edited Telegram message. |
| `maxMessageChars` | `4000` | Longest Telegram message sent to the session. Longer text is cut. |
| `maxMessagesPerMinute` | `20` | Rate limit per chat. |
| `reasoning` | `false` | Reserved. It has no effect now. |

The daemon HTTP server uses the port `codex.httpMcpPort` (default `47392`).

## Step 3 - Install the hooks

Run `pa init --claude-code` first, if you did not do it yet. Then run:

```bash
pa init --claude-remote
```

What it does:

- It merges the `pa claude-remote-hook` hooks into the workspace file `.claude/settings.json`.
- It merges the same hooks into the launcher file `$PA_CONFIG/claude-code/settings.json`.
- It creates a missing file from the template. It does not change other keys or other hooks.
- It is idempotent. You can run it again. It does not add a hook twice.
- It stops with an error when a settings file is not valid JSON. It does not change that file.

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

## Step 5 - Control from the phone

Telegram commands (only from users in `allowedUserIds`):

| Command | Result |
|---------|--------|
| `/status` | Lists the live sessions. Shows which one is attached. |
| `/attach` | Attaches to the only session. With several sessions it asks you to choose. |
| `/attach <n>` | Attaches to session number `n` from `/status` (a session name also works). |
| `/detach` | Detaches. Queued messages are dropped. |
| `/pa <text>` | Sends the text to the normal PA agent. Works while attached. |
| normal text | Goes to the attached session as a new user turn. Without attach it goes to the normal PA agent. |

Voice, photo, and document messages use the normal PA handling. The session gets the text or the saved path.

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
- The final answer as a new message.
- Turns that you start in the terminal are not sent to Telegram.
- While the session is busy, messages wait. The session gets them when the turn ends.

Auto detach:

- The session ends (SessionEnd hook).
- The session process is gone (the daemon checks every 30 s). In the tests the SessionEnd event did not always arrive
  before exit, so the detach after `/exit` can take up to 30 s.
- No Telegram message for `idleDetachMinutes`.

The daemon tells you in Telegram about each detach.

Limits:

- `maxMessageChars`: longer text is cut and gets a truncation marker.
- `maxMessagesPerMinute`: more messages are refused ("Not sent to the session: rate limit ...").
- `deliveryTimeoutMs`: after this time without a reaction, you get "Not delivered to the session ...". The message is dropped.

## Security

- Only users in `adapters.telegram.allowedUserIds` can send messages. The adapter checks the sender before the router.
- The daemon routes listen on `127.0.0.1` only. The server checks the Host and Origin headers.
- Each route needs a bearer token. The daemon creates a random token at start in the file `<config dir>/remote-token`
  (mode `0600`). The daemon removes the file at stop.
- Telegram text is untrusted user input. The hook removes control characters and wraps the text in a clear frame.
- With `--dangerously-skip-permissions` there are no approval prompts. A Telegram message can make the session run
  commands. Use a bot token that only you control. Keep `allowedUserIds` short.
- The hooks run in every session of the workspace. They exit at once when there is no token file (daemon not running or
  remote mode off). They never block or fail the session.
- Each forwarded message gets an audit log line (no secrets).

## Troubleshooting

| Problem | Cause and fix |
|---------|---------------|
| `/status` shows no sessions | Hooks are not installed. Run `pa init --claude-remote`. |
| `/status` shows no sessions | The session started before `init`. Restart it. |
| `/status` shows no sessions | The token file is missing: daemon not running, or `remote.enabled` is false. |
| `/status` shows no sessions | `pa` is not on `PATH` of the session. |
| `409 Conflict` in the daemon log | Another daemon uses the same bot token. Use a separate bot for the laptop. |
| "Not delivered to the session" | The session did not react in time. Check that the session runs and uses the hooks. Try again. |
| Hooks do nothing | `claudeCode.remote.enabled` is false, or the daemon is not running. |
| After a daemon restart nothing arrives | The attach state is in memory only. Send `/status`, then `/attach` again. |
| `pa remote ...` says the token file is missing | The daemon is not running, or remote mode is off. |
| No `remote-token` file although `remote.enabled` is true | The Telegram adapter is off (`adapters.telegram.enabled`). The daemon logs a warning. |
| `pa claude-remote-hook` is unknown | The global `pa` is old. Run `npm run build` in the repository (and `npm link` once). |
| Behavior changed after a Claude Code update | `asyncRewake` is a Claude Code feature that can change. Tested with 2.1.319. |

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
