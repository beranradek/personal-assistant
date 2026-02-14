# How to set up Telegram to communicate with the assistant

## 1. Create a bot via BotFather

1. In Telegram open a chat with @BotFather
2. Send /newbot
3. Enter a name (e.g. "MyName Personal Assistant") and a username (must end with bot, e.g. myname_pa_bot)
4. BotFather will return a token in the format 123456789:ABCdef... — copy it

## 2. Find your Telegram User ID

Send a message to the special bot @userinfobot — it will reply with your numeric ID (e.g. 987654321).

## 3. Edit settings.json

In ~/.personal-assistant/settings.json add/edit the section:

```json
{
  "adapters": {
    "telegram": {
      "enabled": true,
      "botToken": "123456789:ABCdef-YOUR-TOKEN",
      "allowedUserIds": [987654321],
      "mode": "polling"
    }
  }
}
```
