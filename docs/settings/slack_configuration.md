# How to set up Slack to communicate with the assistant

## 1. Create a Slack App (free)

1. Go to https://api.slack.com/apps and sign in to your workspace
2. Click Create New App → From scratch
3. Name the app (e.g. "Personal Assistant") and select your workspace

## 2. Enable Socket Mode

Socket Mode means the bot connects via WebSocket — you don't need a public server or webhook URL.

1. In the left menu: Socket Mode → enable Enable Socket Mode
2. Create an App-Level Token with scope connections:write — name it e.g. "socket"
3. Copy the token xapp-... — you'll need it for the config

## 3. Set up bot permissions

1. In the left menu: OAuth & Permissions
2. In the Bot Token Scopes section add at minimum:
   - chat:write — sending messages
   - channels:history — reading messages in public channels
   - groups:history — reading messages in private channels
   - im:history — reading DMs (optional)
3. At the top click Install to Workspace and confirm
4. Copy the Bot User OAuth Token (xoxb-...)

## 4. Enable Events

1. In the left menu: Event Subscriptions → enable Enable Events
2. In Subscribe to bot events add:
   - message.channels (public channels)
   - message.groups (private channels)
   - message.im (DMs, optional)
3. Save changes

## 5. Find your Slack User ID

1. In Slack click on your profile (avatar top right → Profile)
2. Click ⋮ (three dots) → Copy member ID
3. You'll get something like U0ABC1DEF2

## 6. Invite the bot to a private channel

1. Open the private channel in Slack
2. Type /invite @Personal Assistant (or whatever you named the bot)

## 7. Edit settings.json

pa init   # if you don't have settings.json yet

Then edit ~/.personal-assistant/settings.json:

```json
{
  "adapters": {
    "slack": {
      "enabled": true,
      "botToken": "xoxb-YOUR-BOT-TOKEN",
      "appToken": "xapp-YOUR-APP-TOKEN",
      "allowedUserIds": ["U0ABC1DEF2"],
      "socketMode": true
    }
  }
}
```

## 8. Start the daemon

`pa daemon`

In the log you'll see Slack adapter started. 
From now on, just write in the private channel and the bot will reply in a thread.
