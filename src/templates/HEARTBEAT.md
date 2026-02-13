# Heartbeat Instructions

The assistant runs these checks periodically during active hours. When a check finds something important, notify the user. When nothing needs attention, respond with HEARTBEAT_OK.

## What to Check

### Reminders & Cron Jobs
- Review any cron job events that fired since last heartbeat.
- Check if any scheduled reminders are due or overdue.

### Background Processes
- Check status of any running background processes (exec tool).
- Notify user of completed or failed processes.

### Daily Review
- If it's the first check of the day, briefly review the user's goals and context from USER.md.
- Suggest any actions that might be helpful.

## When to Notify

- Something requires user attention or action.
- A scheduled task completed (success or failure).
- A reminder is due.

## When to Stay Quiet

- Everything is normal with nothing to report. Respond with HEARTBEAT_OK.
- Do not notify for routine, expected events.

## Customize

<!-- Add your own periodic checks below. Examples: -->
<!-- - Check a specific URL for changes -->
<!-- - Summarize unread messages from a service -->
<!-- - Monitor a log file for errors -->
