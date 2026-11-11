# Threat model (Slack remote channel slice)

Scope: `src/remote/channels/slack-*.ts`, `src/remote/slack-router.ts`, Slack adapter (`src/adapters/slack.ts`).

## Assets
- Remote Claude Code sessions (input channel via the bridge, `slack:<userId>` chat key).
- Slack bot/app tokens (`xoxb-`, `xapp-`), never logged (redaction, `errorName`).
- Workspace users (mention/notification abuse).

## Trust boundaries and entry points
- Slack events and `/cc` slash command -> adapter (sender allowlist) -> router.
- Model/session answer text -> Slack channel (outbound formatting).

## Abuse cases and mitigations
- Channel message reaching a session: only `channelType === "im"` reaches the bridge; others use the old queue.
- `/cc pa` answer leaking to a channel: refused unless channelId starts with `D`.
- Mass mention (`<!channel>`) from model text: `& < >` escaped outside code; Slack does not render mentions in code.
- Inbound Slack markup injected into the session: decoded to plain text before `bridge.forward`.
- Token leak in logs: reaction errors log Slack error name or redacted message only.
- Flooding / rate limits: 3,500 char chunks, 20 chunk cap, 1 s pacing, bounded retry (max wait 30 s).

## Residual
- Allowlist enforcement lives in the adapter; the router trusts `userId` metadata.
