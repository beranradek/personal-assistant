Added `slack-format.ts` (mrkdwn converter, chunker 3,500, inbound decoder), `slack-channel.ts` (RemoteChannel over `SlackRemoteApi`:
DM cache, paced chunk send, per-chunk retry, partial-send error, 20-chunk cap, reaction statuses serialized per ref, redacted logging),
and `slack-router.ts` (`onMessage` DM-only bridge path, `/cc` parsing via `onCommand`). All with unit tests using fakes.
Also added `messageTs` to the Slack adapter message metadata (one line) so the router can build the `<channel>:<ts>` ref for thread replies.

Decisions: `/cc pa` is refused outside a DM (channelId must start with `D`) so answers never go to a channel. Inline code is left raw
per the issue text. `onCommand` takes an optional `channelId`. Router `send` is optional (notices logged when absent).
Tests run: `npx vitest run src/remote/channels src/remote/slack-router.test.ts src/adapters/slack.test.ts` - 103 passed; `git diff --check` clean.
Skipped: no other packages. Daemon wiring is task 7.

Review: self-reviewed; chunk budget reserves room for a fence close so every chunk stays <= limit.
