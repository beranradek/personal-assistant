# Streaming Processing Messages for Telegram & Slack Adapters

**Date:** 2026-02-27
**Status:** Active

## Overview

When the agent processes a request from Telegram or Slack, intermediate outputs (tool calls + text fragments) are buffered and periodically flushed to a **processing message** in the user's chat/thread. Once the agent completes, the final response is sent as a **separate new message**. The processing message is kept visible as history of what the agent did.

**Variant chosen:** Two messages (processing + final) — because message edits don't trigger push notifications on either platform, so the final response must be a new message to notify the user.

## Key Components

1. **`ProcessingMessageAccumulator`** — new module in `src/gateway/processing-message.ts` that consumes `StreamEvent`s, formats them, and flushes to adapters on a configurable timer
2. **Extended Adapter interface** — optional `createProcessingMessage()` and `updateProcessingMessage()` methods on `Adapter`
3. **Gateway queue change** — `processNext()` uses `streamAgentTurn()` for adapters that support processing messages
4. **Router addition** — `getAdapter(name)` method to check adapter capabilities
5. **Config addition** — `gateway.processingUpdateIntervalMs` (default: 5000)

## Processing Message Format

Interleaved tool calls and text, matching the terminal's streaming style:

```
🔧 Glob: **/*.ts

Found 42 files matching the pattern...

🔧 Read: src/index.ts

Let me check the implementation details...

⏳ Processing... (12s)
```

- `tool_start` + `tool_input` → `🔧 ToolName: <summary of input>`
- `text_delta` → appended as-is (text between tool calls)
- `tool_progress` → updates elapsed time indicator at the bottom
- Telegram: 4096 char limit — truncate from top if exceeded, keeping most recent content
- Slack: similar truncation strategy

## Extended Adapter Interface

```typescript
export interface Adapter {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendResponse(message: AdapterMessage): Promise<void>;

  // Optional methods for streaming processing messages
  createProcessingMessage?(
    sourceId: string,
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<string>; // returns platform message ID
  updateProcessingMessage?(
    sourceId: string,
    messageId: string,
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
}
```

### Telegram Implementation

- `createProcessingMessage`: calls `bot.api.sendMessage(chatId, text)`, returns `String(result.message_id)`
- `updateProcessingMessage`: calls `bot.api.editMessageText(chatId, messageId, text)`
- `chatId` extracted from `sourceId` (same as existing `sendResponse`)

### Slack Implementation

- `createProcessingMessage`: calls `chat.postMessage({ channel, text, thread_ts })`, returns `result.ts`
- `updateProcessingMessage`: calls `chat.update({ channel, ts: messageId, text })`
- `channelId` and `threadTs` decoded from `sourceId` (same as existing `sendResponse`)

## ProcessingMessageAccumulator

New file: `src/gateway/processing-message.ts`

```typescript
interface ProcessingMessageAccumulator {
  handleEvent(event: StreamEvent): void;
  start(): void;
  stop(): Promise<void>;
}
```

### Internal State

- `buffer: string[]` — formatted lines accumulated since last flush
- `flushedContent: string` — content already sent in the processing message
- `messageId: string | null` — platform message ID, created on first flush
- `intervalHandle` — the periodic flush timer
- `elapsedSeconds: number` — latest tool progress time

### Flush Logic (every `processingUpdateIntervalMs`)

1. If buffer is empty and no elapsed time change, skip
2. Append buffer contents to `flushedContent`, add elapsed time indicator
3. If no `messageId` yet → `adapter.createProcessingMessage()`, store returned ID
4. If `messageId` exists → `adapter.updateProcessingMessage()` with full `flushedContent`
5. Clear buffer

### Event Formatting

- `tool_start` → push `🔧 {toolName}` line
- `tool_input` → append input summary to last tool line (e.g., command, file path, search pattern)
- `text_delta` → push text content
- `tool_progress` → update `elapsedSeconds` (rendered at bottom on next flush)
- `result` / `error` → ignored (handled by queue directly)

### Truncation

If `flushedContent` exceeds platform limits (4096 for Telegram):
- Drop oldest lines from the top
- Prepend `[...earlier output truncated...]`
- Keep most recent content visible

## Gateway Queue Changes

In `processNext()`, the flow becomes:

```typescript
const routeTarget = resolveRouteTarget(message, config);
const adapter = routeTarget ? router.getAdapter(routeTarget.source) : undefined;

if (adapter?.createProcessingMessage && adapter?.updateProcessingMessage) {
  // Streaming path with processing message
  const accumulator = createProcessingAccumulator(
    adapter,
    routeTarget.sourceId,
    message.metadata,
    config.gateway.processingUpdateIntervalMs,
  );
  accumulator.start();

  let result: AgentTurnResult | undefined;
  for await (const event of streamAgentTurn(message.text, sessionKey, agentOptions, config)) {
    accumulator.handleEvent(event);
    if (event.type === "result") {
      result = { response: event.response, messages: event.messages, partial: event.partial };
    }
    if (event.type === "error") {
      result = { response: event.error, messages: [], partial: true };
    }
  }

  await accumulator.stop(); // final flush + cleanup

  // Send final response as a NEW message
  // ... existing routing logic with result.response ...
} else {
  // Fallback: non-streaming path (existing behavior)
  const result = await runAgentTurn(message.text, sessionKey, agentOptions, config);
  // ... existing routing logic ...
}
```

Heartbeat messages always use the non-streaming fallback path.

## Router Addition

```typescript
getAdapter(name: string): Adapter | undefined;
```

Simple lookup in the existing adapter registry.

## Config Change

```typescript
export const GatewayConfigSchema = z.object({
  maxQueueSize: z.number().int().positive(),
  processingUpdateIntervalMs: z.number().int().positive().default(5000),
});
```

Default config value: `5000` (5 seconds).

## Thread Scoping

All messages stay in the correct thread:
- **Telegram**: `sourceId` = chatId — processing message and final response go to same chat
- **Slack**: `sourceId` = `{channelId}--{threadTs}` — both messages use same `thread_ts`

The original message's `metadata` is passed through to the accumulator for full adapter context.

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/gateway/processing-message.ts` | **Create** — ProcessingMessageAccumulator |
| `src/gateway/processing-message.test.ts` | **Create** — Tests for accumulator |
| `src/core/types.ts` | **Modify** — Add optional methods to Adapter interface |
| `src/adapters/telegram.ts` | **Modify** — Implement createProcessingMessage/updateProcessingMessage |
| `src/adapters/telegram.test.ts` | **Modify** — Test new methods |
| `src/adapters/slack.ts` | **Modify** — Implement createProcessingMessage/updateProcessingMessage |
| `src/adapters/slack.test.ts` | **Modify** — Test new methods |
| `src/gateway/queue.ts` | **Modify** — Switch to streamAgentTurn for capable adapters |
| `src/gateway/queue.test.ts` | **Modify** — Test streaming path |
| `src/gateway/router.ts` | **Modify** — Add getAdapter() method |
| `src/core/config-defaults.ts` | **Modify** — Add processingUpdateIntervalMs default |
