Added `docs/settings/claude_code_remote_slack.md` (STE English): what it does, manifest, way A/B setup, reinstall note, placeholder
Request URL note, tokens/config with placeholders, `/cc` table, reactions and chunks, one chat per session and `force`, security,
troubleshooting, tested / not tested, and the manual E2E checklist copied from the plan. Added pointers in
`claude_code_remote_session.md` and `slack_configuration.md`, one README setup-guides line plus a companion sentence, and
`slack-router` / `channels/` in the CLAUDE.md layout. Spec/plan not marked "Implemented".

Checks: no line over 140 chars in the new guide; token regex finds only fake test strings; `git diff --check` clean. Docs only, no tests run.
Review: read the diff; claims checked against the router help text, chunk limit 3500 and redaction pattern in code.
