# How to set up Google integrations (Gmail + Calendar)

The assistant can access Gmail and Google Calendar through the `integ-api` sidecar service, exposed via the `pa integapi ...` CLI.

## 0. Prerequisites

- A Google account
- A Google Cloud project with OAuth consent screen configured
- `pa` installed and a `~/.personal-assistant/settings.json` present (`pa init`)

## 1. Enable integ-api in settings.json

Edit `~/.personal-assistant/settings.json`:

```json
{
  "integApi": {
    "enabled": true,
    "services": {
      "gmail": {
        "enabled": true,
        "userEmails": ["your@gmail.com", "your@company.cz"]
      },
      "calendar": { "enabled": true }
    }
  }
}
```

The `userEmails` array lists all your email addresses across Gmail accounts. This enables
the `gmail unreads` command to correctly detect whether you are in TO vs CC for email
categorization. The account's own email is always auto-detected; `userEmails` is needed
when you have additional aliases or multiple accounts whose unreads you want aggregated.

Optional: override scopes per service:

```json
{
  "integApi": {
    "services": {
      "gmail": { "enabled": true, "scopes": ["https://www.googleapis.com/auth/gmail.readonly"] },
      "calendar": { "enabled": true, "scopes": ["https://www.googleapis.com/auth/calendar.readonly"] }
    }
  }
}
```

## 2. Create OAuth2 credentials in Google Cloud Console

1. Create / select a Google Cloud project, fill in Google OAuth consent screen details, and publish it.
2. Enable APIs:
   - Gmail API
   - Google Calendar API
3. Configure OAuth consent screen
   - If the app is in “Testing”, add your Google account as a test user
4. Create an OAuth client:
   - Type: Desktop application or Web application
   - Authorized redirect URI: `http://localhost:19101/oauth/callback`
5. Copy the **Client ID** and **Client secret**

## 3. Provide credentials to the assistant (env vars)

Set these environment variables for the `pa` process:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

If you run the daemon via systemd user service, put them into `~/.personal-assistant/.env`:

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

Then:

```bash
chmod 600 ~/.personal-assistant/.env
```

## 4. Run the OAuth setup flow

First, if you are running headless server (VPS like Hetzner) with no local browser UI, 
log in to server including set up of SSH tunnel from your laptop:

```bash
ssh -i ~/.ssh/<your-private-ssh-key> -L 19101:localhost:19101 <user>@<server>
```

This way the final redirect to `http://localhost:19101/oauth/callback` will be forwarded to the 
server’s local callback listener and OAuth flow can be completed on the server 
fully even without a browser there.

Run:

```bash
export GOOGLE_CLIENT_ID=...
export GOOGLE_CLIENT_SECRET=...
pa integapi auth google
```

Follow the printed URL, grant access, and complete the redirect. Credentials are stored under:

`~/.personal-assistant/data/integ-api/credentials/google-personal.json`

Restart pa daemon.

## 5. Verify

```bash
pa daemon
pa integapi health
pa integapi calendar today
pa integapi gmail unreads
pa integapi gmail list --query "is:unread" --max 5 --labels INBOX
```

## Troubleshooting

- `Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET ...` → env vars not set for the running process.
- `No integration services enabled ...` → enable at least Gmail or Calendar under `integApi.services.*`.
- `redirect_uri_mismatch` → ensure the OAuth client has `http://localhost:19101/oauth/callback` as an authorized redirect URI.
- Token refresh fails → re-run `pa integapi auth google`.

## Headless server (no local browser)

If `pa integapi auth google` runs on a server, create an SSH tunnel and open the printed URL on your laptop:

```bash
ssh -L 19101:localhost:19101 <user>@<server>
```

The browser redirect to `http://localhost:19101/oauth/callback` will be forwarded to the server’s local callback listener.
