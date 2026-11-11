Daemon remote mode now runs with Slack, Telegram or both on ONE shared bridge; MCP and CLI accept a channel.

- New `src/remote/default-chat.ts` (+test): one helper `resolveControlChat` and `buildDefaultChatIds`, used by both
  `routes.ts` `handleControl` and `daemon.ts` handleRemoteControl. Order: explicit chatId (bare numeric still works),
  `request.channel`, `claudeCode.remote.defaultChannel`, telegram, slack. Not enabled channel -> error text (HTTP 400 on routes;
  control-client now surfaces the 400 reason). `detach`/`status` without chatId/channel pass through.
- `bridge.control`: `detach` without chatId detaches whichever chat holds the target session; `status` works without chatId.
- Holder: `defaultChatId` replaced by `defaultChatIds` + `defaultChannel`. 503 text in control-client updated.
- `daemon.ts`: bridge creation moved out of the Telegram block; adapters created with late-bound onMessage/onCommand; registry
  from enabled adapters; Slack router (`onCommand` only in remote mode); `holder.bridge` set before any adapter starts;
  neither channel -> warning, no token file; queue-full notice helper deduplicated; warning on group/world readable
  `settings.json` when Slack enabled (mode check only). Shutdown order unchanged (bridge.stop before adapters).
- MCP tools: optional `channel` (all three), `force` (attach only). CLI: `pa remote attach [target] [--channel] [--force]`,
  status prints `[attached: telegram:42]`.

Tests: `npx vitest run src/daemon.test.ts src/remote src/tools/stdio-mcp-server.test.ts src/cli.test.ts src/adapters/slack.test.ts`
-> 16 files, 401 tests green; `git diff --check` clean; `tsc --noEmit` clean. No Slack network access used.

Review: self-reviewed; fixed a CLI parser bug (args[++i] inside find callback) found by tests.
