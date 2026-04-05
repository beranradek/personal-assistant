# How to set up Slack integration (unread messages feed)

The assistant can read your unread Slack messages across multiple workspaces through the `integ-api` sidecar service. This is a **read-only data integration** — distinct from the Slack adapter which handles bidirectional chat with the assistant.

Use cases:
- Quick overview of pending Slack activity across workspaces
- Aggregated unread counts with mention highlighting
- Reading unread DM texts and messages where you're mentioned
- Proactive heartbeat awareness of Slack activity

**Messages are never marked as read** by this integration.

## 0. Prerequisites

- A Slack workspace where you want to monitor unreads
- A Slack app with a user token (xoxp-...) — see step 2
- `pa` installed and a `~/.personal-assistant/settings.json` present (`pa init`)

## 1. Enable Slack in settings.json

Edit `~/.personal-assistant/settings.json`:

```json
{
  "integApi": {
    "enabled": true,
    "services": {
      "slack": { "enabled": true }
    }
  }
}
```

## 2. Create a Slack app and get a user token

1. Go to https://api.slack.com/apps and click **Create New App** → **From scratch**
2. Name it (e.g., "Personal Assistant Reader") and select your workspace
3. Go to **OAuth & Permissions** → **User Token Scopes** and add:
   - `channels:read` — list public channels
   - `channels:history` — read public channel messages
   - `groups:read` — list private channels
   - `groups:history` — read private channel messages
   - `im:read` — list direct messages
   - `im:history` — read DM messages
   - `mpim:read` — list group DMs
   - `mpim:history` — read group DM messages
   - `users:read` — resolve user display names
4. Click **Install to Workspace** and authorize
5. Copy the **User OAuth Token** (starts with `xoxp-`)

> **Note:** Use a **user token** (xoxp-), not a bot token (xoxb-). User tokens see your personal unread state. Bot tokens cannot see which messages you've read.

## 3. Register the workspace

```bash
pa integapi auth slack
```

This interactive command will ask for:
- **Workspace ID** — a short identifier you choose (e.g., `mycompany`, `client-acme`)
- **User token** — the xoxp-... token from step 2
- **Display name** — optional, defaults to the Slack team name

The token is validated via Slack's `auth.test` API and stored securely in `~/.personal-assistant/data/integ-api/credentials/`.

### Multiple workspaces

Run `pa integapi auth slack` once per workspace. Each gets its own workspace ID. The `unreads` command aggregates across all configured workspaces.

## 4. Start or restart the integ-api server

```bash
pa integapi serve
# or restart the daemon if it manages integ-api
```

## 5. Verify

```bash
# Check that Slack appears in integrations
pa integapi list

# Get unread summary
pa integapi slack unreads

# Read messages in a specific channel
pa integapi slack messages <channelId>
```

## CLI Reference

```bash
# Unread summary across all workspaces
pa integapi slack unreads

# Unreads for a specific workspace
pa integapi slack unreads --workspace mycompany

# Read unread messages in a channel (text only, no attachments)
pa integapi slack messages <channelId>

# With workspace filter and limit
pa integapi slack messages <channelId> --workspace mycompany --limit 30
```

## Response format

### Unreads summary

```json
{
  "workspaces": [
    {
      "workspaceId": "mycompany",
      "workspaceName": "My Company",
      "channels": [
        {
          "id": "D123",
          "name": "alice",
          "type": "im",
          "unreadCount": 3,
          "mentionCount": 3,
          "hasMention": true,
          "isDirect": true
        },
        {
          "id": "C456",
          "name": "engineering",
          "type": "channel",
          "unreadCount": 12,
          "mentionCount": 1,
          "hasMention": true,
          "isDirect": false
        }
      ],
      "totalUnread": 15,
      "totalMentions": 4
    }
  ],
  "summary": {
    "totalWorkspaces": 1,
    "totalUnreadChannels": 2,
    "totalUnread": 15,
    "totalMentions": 4
  }
}
```

### Channel messages

```json
{
  "workspace": "mycompany",
  "channel": { "id": "D123", "name": "alice", "type": "im" },
  "messages": [
    {
      "ts": "1712345678.123456",
      "userId": "U111",
      "userName": "alice",
      "text": "Hey, can you review the PR?",
      "replyCount": 0,
      "time": "2026-04-05T10:00:00.000Z"
    }
  ],
  "unreadCount": 1
}
```

## Troubleshooting

- **auth_failed errors**: Re-run `pa integapi auth slack` to update the token
- **Missing channels**: Ensure the Slack app has all required scopes and is installed to the workspace
- **No unreads showing**: The integration uses `unread_count_display` which respects your Slack notification preferences
- **Rate limits**: Slack allows ~50 requests/minute per workspace. Large workspaces with many channels may take a few seconds
