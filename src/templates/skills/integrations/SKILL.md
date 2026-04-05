---
name: "integrations"
description: "Data integrations for your lookups and summarization. Use whenever user wants info about his Google Calendar events (schedule) or GMail emails."
version: "2026-04-05"
---

# Integrations (integ-api)

Access Google Workspace services (Calendar, Gmail) via the `pa integapi` CLI.
Do not start integ-api HTTP server or configure it yourself — it's managed by the daemon/user.

## Commands

### Discovery & Health

```bash
# List available integrations and their status (only if required)
pa integapi list

# Check integ-api server health / uptime (only in case of issues)
pa integapi health
```

### Calendar

```bash
# Today's events (all calendars)
pa integapi calendar today

# Events for the next 7 days - hardcoded 7-day window starting from now.
pa integapi calendar week

# Events for an explicit time range (RFC3339).
# Prefer this when the user asks for "next week" (Mon–Sun) or any specific dates.
pa integapi calendar range --timeMin "2026-04-06T00:00:00+02:00" --timeMax "2026-04-13T00:00:00+02:00"

# Machine-friendly compact outputs (recommended for the assistant)
pa integapi calendar week --format compact-json
pa integapi calendar range --timeMin "..." --timeMax "..." --format compact-json

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

All commands return JSON to stdout. Prefer `--format compact-json` for easy parsing.
If you need ad-hoc parsing and `jq` is not available, use Python:

```bash
pa integapi calendar week > /tmp/cal.json
python3 - <<'PY'
import json
data=json.load(open("/tmp/cal.json","r",encoding="utf-8"))
for e in data.get("events",[]):
    print(e.get("summary"))
PY
```

## Default Assistant Style (Calendar)

- Default to a concise “agenda” view: **time + title + location/meet link**.
- Omit **attendees** and long **description** fields unless the user explicitly asks.
- Fetch full details only on demand via `pa integapi calendar event <eventId>`.

## Error Handling

- If the server is not running, commands will fail with a connection error.
  The daemon auto-restarts the server on crash — wait a few seconds and retry.
- Authentication errors (expired tokens) are handled automatically via token
  refresh. If refresh fails, tell the user authentication is needed (do not attempt authenticate yourself)

## When to Use

- **Heartbeat checks:** Use `pa integapi calendar today` to see upcoming events.
- **User asks about schedule:** Use calendar commands to answer.
- **User asks about email:** Use gmail commands to check inbox.
- **Proactive awareness:** During heartbeat, check calendar for context.
