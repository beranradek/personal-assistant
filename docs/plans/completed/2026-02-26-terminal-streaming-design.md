# Terminal Streaming Output — Design

## Problem

The terminal REPL currently waits for the entire agent response to complete before displaying anything. With a spinner showing during the wait, the experience feels disconnected — especially for longer responses where the agent thinks, calls tools, and generates multi-paragraph answers.

The Claude Agent SDK already streams events (`SDKPartialAssistantMessage` with `type: 'stream_event'`), but the current `runAgentTurn()` accumulates all text into a single string and returns it at the end.

## Solution

Stream agent output to the terminal in real time using an async generator pattern. Show tool activity as it happens. Re-render with markdown formatting on completion.

## Architecture

### Stream Event Type

```typescript
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; toolName: string; input?: Record<string, unknown> }
  | { type: 'tool_progress'; toolName: string; elapsedSeconds: number }
  | { type: 'result'; response: string; messages: SessionMessage[]; partial: boolean }
  | { type: 'error'; error: string };
```

### New Function: `streamAgentTurn()`

An `AsyncGenerator<StreamEvent>` in `agent-runner.ts` that maps SDK messages to stream events. Handles:
- Session ID capture and resumption (same as `runAgentTurn`)
- Text deltas from `SDKPartialAssistantMessage` (`stream_event` with `content_block_delta`)
- Tool use detection from `content_block_start` events
- Tool progress from `SDKToolProgressMessage`
- Final result assembly, audit logging, and error handling

The existing `runAgentTurn()` stays unchanged — daemon mode is not affected.

### Terminal Rendering Flow

1. **Spinner** starts on user Enter (unchanged)
2. **First `text_delta`** — stop spinner, print `\nAssistant:\n`, enter streaming mode
3. **`text_delta`** — `process.stdout.write(text)` (raw text, no markdown)
4. **`tool_start`** — if mid-text, print newline. Show dimmed tool summary:
   - `Bash` → `Running: <command>` (truncated to ~60 chars)
   - `Read` → `Reading <file_path>`
   - `Write` / `Edit` → `Writing <file_path>` / `Editing <file_path>`
   - `Glob` → `Searching: <pattern>`
   - `Grep` → `Grepping: <pattern>`
   - `WebFetch` → `Fetching: <url>`
   - `WebSearch` → `Searching: <query>`
   - Other → tool name only
5. **`tool_progress`** — update tool line with elapsed time
6. **`result`** — smart re-render:
   - Check full response text for markdown elements (code blocks, headers, bold, lists)
   - If markdown found: calculate terminal rows consumed by raw output (accounting for line wrapping at `stdout.columns`), move cursor up with `\x1b[<n>A`, clear with `\x1b[J`, print `renderMarkdown(response)`
   - If plain text only: leave raw output as-is (no visual flash)
7. **`error`** — print in red

### Tool Input Summary Extraction

Tool use appears in the SDK stream as `content_block_start` events with `content_block.type === 'tool_use'`. The tool name is immediately available. Input JSON arrives incrementally via `input_json_delta` events. The generator buffers JSON fragments and extracts the relevant summary field when the content block completes (`content_block_stop`).

For immediate display, show just the tool name on `content_block_start`. Update with the summary once input is available.

### Smart Re-render

The `hasMarkdownElements()` function checks the **full response text** (not individual chunks) for:
- Fenced code blocks (triple backtick)
- Headers (`#`)
- Bold/italic (`**`, `__`, `*`, `_`)
- Lists (`- `, `* `, `1. `)
- Links (`[text](url)`)

If any element is found, the entire streamed output is cleared and re-rendered with markdown. This handles the case where a plain text segment is part of a larger response that contains markdown elsewhere.

## File Changes

| File | Change |
|------|--------|
| `src/core/agent-runner.ts` | Add `StreamEvent` type, `streamAgentTurn()` async generator |
| `src/terminal/handler.ts` | Add `handleLineStreaming()` returning `AsyncGenerator<StreamEvent>` |
| `src/terminal/repl.ts` | Consume stream events: stop spinner on first delta, write text, show tools, smart re-render |
| `src/terminal/markdown.ts` | Add `hasMarkdownElements(text)` helper |
| `src/core/agent-runner.test.ts` | Tests for `streamAgentTurn()` |
| `src/terminal.test.ts` | Update to test streaming flow |

## Scope

Terminal mode only. Daemon mode (`gateway/queue.ts`, adapters) continues using `runAgentTurn()` unchanged. The streaming interface can be adopted by adapters later if needed.

## SDK Types Used

- `SDKPartialAssistantMessage` — `type: 'stream_event'`, contains `BetaRawMessageStreamEvent`
- `SDKToolProgressMessage` — `type: 'tool_progress'`, contains tool name and elapsed time
- `SDKAssistantMessage` — `type: 'assistant'`, complete message (used for final text collection)
- `SDKResultSuccess` / `SDKResultError` — `type: 'result'`, turn completion
