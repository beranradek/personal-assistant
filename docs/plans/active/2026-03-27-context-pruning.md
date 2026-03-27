# Context Pruning & LLM-based Summarization

**Date:** 2026-03-27
**Status:** In progress

## Motivation

The Claude Agent SDK's `query()` function uses `resume: sdkSessionId` to continue sessions stored in `~/.claude/projects/`. Each session accumulates unlimited history — both text turns and tool-call/result blocks. Over time this:
- Consumes growing token budgets per request
- Degrades model focus with noise from old interactions
- Includes many tool-call details that are irrelevant to later turns

## Current State

| Feature | Config | Implemented |
|---------|--------|-------------|
| `maxHistoryMessages: 50` | ✅ | ❌ never enforced |
| `compactionEnabled: true` | ✅ | ❌ no compactor exists |
| Tool call filtering | — | ✅ already done — JSONL never saves tool_use/tool_result |

## Architecture Decision: Why Session Restart + Summary

The SDK internally manages conversation history for an active session. We **cannot** directly
remove or filter individual messages from a running SDK session — the session state lives in
the Claude Code subprocess (`~/.claude/projects/<hash>/`).

The only levers we have:
1. **`resume: sdkSessionId`** — resume a previous session (full history)
2. **`systemPrompt.append`** — inject additional context into the system prompt
3. **Start a new session** (omit `resume`) — fresh context, no prior history

Strategy: track turns per session. When turns exceed `maxHistoryMessages / 2`,
summarize the JSONL audit trail via a direct Anthropic API call (haiku model),
store the summary in the JSONL as a `compaction` entry, clear the SDK session ID
to force a new session, and inject the summary into `systemPrompt.append` for
all subsequent turns.

## Flow

```
Turn 1–N (N = maxHistoryMessages / 2 = 10):
  SDK session accumulates history normally (resume used)

Turn N+1 (compaction trigger):
  1. Read user/assistant messages from JSONL (tool calls excluded)
  2. POST to Anthropic Messages API (haiku) → compact summary ≤400 words
  3. Append { role: "compaction", content: summary, timestamp } to JSONL
  4. Clear sdkSessionId → next query() starts a fresh SDK session
  5. Cache summary in sessionSummaries map

Turn N+1 (actual turn, after compaction):
  systemPrompt.append gets "## Previous Conversation Summary\n\n{summary}\n\n{memory}"
  SDK starts fresh with only system-prompt context (no stale tool calls)

Turn N+2 … 2N:
  SDK session resumes normally with the new session ID

Turn 2N+1:
  Compaction runs again, new summary includes old summary + recent turns
```

## Tool Call Filtering

### JSONL audit trail (already done)
`agent-runner.ts` only saves `user` and `assistant` role messages to `saveInteraction()`.
Tool calls executed inside `query()` are resolved in the SDK subprocess and never written
to the JSONL. **No change needed.**

### Active SDK session (during `resume`)
Tool calls within a `query()` call are tracked by the SDK internally and are part of the
active session's history. We cannot remove them from a live session.

**After compaction:** the new SDK session starts from zero — only the textual summary is
in the system prompt. All prior tool-call history is discarded. This is the natural
pruning mechanism.

## New Config Fields

```json
"session": {
  "maxHistoryMessages": 20,
  "compactionEnabled": true,
  "summarizationEnabled": true,
  "summarizationModel": "claude-haiku-4-5-20251001"
}
```

- `summarizationEnabled`: whether to call the API for a summary (vs. just resetting session silently)
- `summarizationModel`: model used for summarization (should be cheap/fast)
- `maxHistoryMessages` default changed from 50 → 20

## Files Changed

| File | Change |
|------|--------|
| `src/core/types.ts` | Add `summarizationEnabled`, `summarizationModel` to `SessionConfigSchema` |
| `src/core/config.ts` | Change default `maxHistoryMessages` 50→20, add new defaults |
| `src/session/store.ts` | Add `loadMessages()` to read all messages from JSONL |
| `src/session/compactor.ts` | New: `loadConversationHistory()`, `summarizeConversation()`, `appendCompactionEntry()`, `loadLatestSummary()` |
| `src/core/agent-runner.ts` | Add `sessionTurnCounts`, `sessionSummaries` maps; compaction trigger; summary injection into `systemPrompt.append` |

## Non-goals

- No rewriting/truncation of old JSONL entries (they remain as full audit trail)
- No semantic relevance scoring (simple FIFO summarization)
- No sub-agent or hierarchical summarization
- No summary retrieval tools (out of scope)
