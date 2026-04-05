---
name: "integrations"
description: "Data integrations for your lookups and summarization. Use whenever user wants info about his Google Calendar events (schedule) or GMail emails."
---

# Integrations (integ-api)

Access Google Workspace services (Calendar, Gmail) via the `pa integapi` CLI.
The integ-api HTTP server runs as a child process of the daemon — do **not**
start or stop it yourself.

## Prerequisites

- `integApi.enabled` must be `true` in settings.json
- Google OAuth credentials must be configured (`pa integapi auth google`)
- The daemon must be running (`pa daemon`)

## Commands

### Discovery & Health

```bash
# List available integrations and their status
pa integapi list

# Check server health / uptime
pa integapi health
```

### Calendar

```bash
# Today's events (all calendars)
pa integapi calendar today

# Events for the next 7 days
pa integapi calendar week

# Full details of a single event
pa integapi calendar event <eventId>
```

### Gmail

```bash
# List recent messages (default: 10)
pa integapi gmail list

# List with filters
pa integapi gmail list --query "is:unread" --max 20 --labels INBOX

# Read a specific message
pa integapi gmail read <messageId>

# List all labels
pa integapi gmail labels
```

## Output

All commands return JSON to stdout. Parse with `jq` if needed:

```bash
pa integapi calendar today | jq '.[0].summary'
```

## Error Handling

- If the server is not running, commands will fail with a connection error.
  The daemon auto-restarts the server on crash — wait a few seconds and retry.
- Authentication errors (expired tokens) are handled automatically via token
  refresh. If refresh fails, re-run `pa integapi auth google`.

## Commands You Should NOT Run

- `pa integapi serve` — managed by the daemon automatically. Never start it yourself.
- `pa integapi auth google` — interactive OAuth flow that requires a browser. Tell the user to run it themselves if authentication is needed.

## When to Use

- **Heartbeat checks:** Use `pa integapi calendar today` to see upcoming events.
- **User asks about schedule:** Use calendar commands to answer.
- **User asks about email:** Use gmail commands to check inbox.
- **Proactive awareness:** During heartbeat, check calendar for context.

