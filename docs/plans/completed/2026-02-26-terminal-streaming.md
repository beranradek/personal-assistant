# Terminal Streaming Output Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stream agent output to the terminal in real time — text deltas appear as they arrive, tool activity is shown as dimmed status lines, and the final response is re-rendered with markdown formatting.

**Architecture:** New `streamAgentTurn()` async generator in `agent-runner.ts` yields typed `StreamEvent` objects. The terminal handler exposes `handleLineStreaming()` which wraps this. The REPL consumes events: stops the spinner on first text, writes raw text deltas via `stdout.write()`, shows tool summaries, and does a smart re-render on completion. Existing `runAgentTurn()` stays unchanged for daemon mode.

**Tech Stack:** Claude Agent SDK `query()` async generator, `SDKPartialAssistantMessage` (`stream_event`), `SDKToolProgressMessage`, Node.js ANSI escape codes for cursor control.

---

### Task 1: Add `StreamEvent` type and `streamAgentTurn()` to agent-runner

**Files:**
- Modify: `src/core/agent-runner.ts:15-21` (imports), append after line 78 (types), append after line 293 (new function)
- Test: `src/core/agent-runner.test.ts`

**Step 1: Write failing tests for `streamAgentTurn()`**

Add to `src/core/agent-runner.test.ts` at the end of the file, inside the `describe("agent-runner")` block. Also update the import on line 34 to include `streamAgentTurn`.

```typescript
// In the imports section (line 32-36), add streamAgentTurn:
import {
  buildAgentOptions,
  runAgentTurn,
  streamAgentTurn,
  clearSdkSessionIds,
} from "./agent-runner.js";

// Add new describe block after the runAgentTurn describe block:

describe("streamAgentTurn", () => {
  it("yields text_delta events from stream_event messages", async () => {
    const config = makeConfig();
    const sessionKey = "terminal--default";

    vi.mocked(query).mockReturnValue(
      mockQueryGenerator([
        {
          type: "stream_event",
          session_id: "sdk-session-abc",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hello " },
          },
        },
        {
          type: "stream_event",
          session_id: "sdk-session-abc",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "world" },
          },
        },
        {
          type: "assistant",
          session_id: "sdk-session-abc",
          message: {
            content: [{ type: "text", text: "Hello world" }],
          },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "sdk-session-abc",
          result: "Hello world",
        },
      ]) as any,
    );
    vi.mocked(saveInteraction).mockResolvedValue(undefined);
    vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

    const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
    const events = [];
    for await (const event of streamAgentTurn("Hi", sessionKey, agentOptions, config)) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: "text_delta", text: "Hello " });
    expect(events[1]).toEqual({ type: "text_delta", text: "world" });
    // Last event should be result
    const resultEvent = events[events.length - 1];
    expect(resultEvent.type).toBe("result");
    expect((resultEvent as any).response).toBe("Hello world");
  });

  it("yields tool_start events from content_block_start with tool_use", async () => {
    const config = makeConfig();
    const sessionKey = "terminal--default";

    vi.mocked(query).mockReturnValue(
      mockQueryGenerator([
        {
          type: "stream_event",
          session_id: "sdk-session-abc",
          event: {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "tu_1", name: "Bash", input: {} },
          },
        },
        {
          type: "assistant",
          session_id: "sdk-session-abc",
          message: {
            content: [{ type: "text", text: "Done" }],
          },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "sdk-session-abc",
          result: "Done",
        },
      ]) as any,
    );
    vi.mocked(saveInteraction).mockResolvedValue(undefined);
    vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

    const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
    const events = [];
    for await (const event of streamAgentTurn("Run ls", sessionKey, agentOptions, config)) {
      events.push(event);
    }

    const toolEvent = events.find((e) => e.type === "tool_start");
    expect(toolEvent).toBeDefined();
    expect((toolEvent as any).toolName).toBe("Bash");
  });

  it("yields tool_progress events from SDK tool_progress messages", async () => {
    const config = makeConfig();
    const sessionKey = "terminal--default";

    vi.mocked(query).mockReturnValue(
      mockQueryGenerator([
        {
          type: "tool_progress",
          tool_use_id: "tu_1",
          tool_name: "Bash",
          parent_tool_use_id: null,
          elapsed_time_seconds: 5,
          session_id: "sdk-session-abc",
        },
        {
          type: "assistant",
          session_id: "sdk-session-abc",
          message: {
            content: [{ type: "text", text: "Done" }],
          },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "sdk-session-abc",
          result: "Done",
        },
      ]) as any,
    );
    vi.mocked(saveInteraction).mockResolvedValue(undefined);
    vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

    const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
    const events = [];
    for await (const event of streamAgentTurn("Do thing", sessionKey, agentOptions, config)) {
      events.push(event);
    }

    const progressEvent = events.find((e) => e.type === "tool_progress");
    expect(progressEvent).toEqual({
      type: "tool_progress",
      toolName: "Bash",
      elapsedSeconds: 5,
    });
  });

  it("captures session ID for future resumption", async () => {
    const config = makeConfig();
    const sessionKey = "terminal--stream";

    vi.mocked(query).mockReturnValue(
      mockQueryGenerator([
        {
          type: "stream_event",
          session_id: "sdk-session-stream",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hi" },
          },
        },
        {
          type: "assistant",
          session_id: "sdk-session-stream",
          message: { content: [{ type: "text", text: "Hi" }] },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "sdk-session-stream",
          result: "Hi",
        },
      ]) as any,
    );
    vi.mocked(saveInteraction).mockResolvedValue(undefined);
    vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

    const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
    // Consume all events
    for await (const _event of streamAgentTurn("Hi", sessionKey, agentOptions, config)) {
      // drain
    }

    // Second call should use resume
    vi.mocked(query).mockReturnValue(
      mockQueryGenerator([
        {
          type: "assistant",
          session_id: "sdk-session-stream",
          message: { content: [{ type: "text", text: "Again" }] },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "sdk-session-stream",
          result: "Again",
        },
      ]) as any,
    );

    for await (const _event of streamAgentTurn("Again", sessionKey, agentOptions, config)) {
      // drain
    }

    const secondCallArgs = vi.mocked(query).mock.calls[1][0];
    expect(secondCallArgs.options).toHaveProperty("resume", "sdk-session-stream");
  });

  it("saves audit entry after stream completes", async () => {
    const config = makeConfig();
    const sessionKey = "terminal--default";

    vi.mocked(query).mockReturnValue(
      mockQueryGenerator([
        {
          type: "assistant",
          session_id: "sdk-session-abc",
          message: { content: [{ type: "text", text: "Audited" }] },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "sdk-session-abc",
          result: "Audited",
        },
      ]) as any,
    );
    vi.mocked(saveInteraction).mockResolvedValue(undefined);
    vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

    const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
    for await (const _event of streamAgentTurn("Audit", sessionKey, agentOptions, config)) {
      // drain
    }

    expect(saveInteraction).toHaveBeenCalled();
    expect(appendAuditEntry).toHaveBeenCalledWith(
      config.security.workspace,
      expect.objectContaining({
        type: "interaction",
        userMessage: "Audit",
        assistantResponse: "Audited",
      }),
    );
  });

  it("yields error event and still saves audit on transport error with partial response", async () => {
    const config = makeConfig();
    const sessionKey = "terminal--default";

    async function* transportErrorGenerator() {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "Partial" }] },
      };
      throw new Error("ProcessTransport is not ready for writing");
    }

    vi.mocked(query).mockReturnValue(transportErrorGenerator() as any);
    vi.mocked(saveInteraction).mockResolvedValue(undefined);
    vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

    const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
    const events = [];
    for await (const event of streamAgentTurn("Hi", sessionKey, agentOptions, config)) {
      events.push(event);
    }

    const resultEvent = events.find((e) => e.type === "result");
    expect(resultEvent).toBeDefined();
    expect((resultEvent as any).partial).toBe(true);
    expect((resultEvent as any).response).toBe("Partial");
  });

  it("yields error event on non-transport error with no response", async () => {
    const config = makeConfig();
    const sessionKey = "terminal--default";

    async function* errorGenerator() {
      throw new Error("Connection refused");
    }

    vi.mocked(query).mockReturnValue(errorGenerator() as any);

    const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
    const events = [];
    for await (const event of streamAgentTurn("Hi", sessionKey, agentOptions, config)) {
      events.push(event);
    }

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent as any).error).toContain("Connection refused");
  });

  it("buffers tool input JSON and yields tool_input event on content_block_stop", async () => {
    const config = makeConfig();
    const sessionKey = "terminal--default";

    vi.mocked(query).mockReturnValue(
      mockQueryGenerator([
        {
          type: "stream_event",
          session_id: "sdk-session-abc",
          event: {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "tu_1", name: "Read", input: {} },
          },
        },
        {
          type: "stream_event",
          session_id: "sdk-session-abc",
          event: {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"file_path":"/src/foo.ts"}' },
          },
        },
        {
          type: "stream_event",
          session_id: "sdk-session-abc",
          event: { type: "content_block_stop", index: 1 },
        },
        {
          type: "assistant",
          session_id: "sdk-session-abc",
          message: { content: [{ type: "text", text: "Read it" }] },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "sdk-session-abc",
          result: "Read it",
        },
      ]) as any,
    );
    vi.mocked(saveInteraction).mockResolvedValue(undefined);
    vi.mocked(appendAuditEntry).mockResolvedValue(undefined);

    const agentOptions = buildAgentOptions(config, "/tmp/workspace", "", {});
    const events = [];
    for await (const event of streamAgentTurn("Read file", sessionKey, agentOptions, config)) {
      events.push(event);
    }

    const toolInputEvent = events.find((e) => e.type === "tool_input");
    expect(toolInputEvent).toBeDefined();
    expect((toolInputEvent as any).toolName).toBe("Read");
    expect((toolInputEvent as any).input).toEqual({ file_path: "/src/foo.ts" });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/agent-runner.test.ts`
Expected: FAIL — `streamAgentTurn` is not exported

**Step 3: Add `StreamEvent` type and `streamAgentTurn()` implementation**

Add to `src/core/agent-runner.ts`. First, update the imports (line 15-21) to include `SDKPartialAssistantMessage`:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  HookCallbackMatcher,
  SDKMessage,
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
```

Add the `StreamEvent` type after `AgentTurnResult` (after line 78):

```typescript
// ---------------------------------------------------------------------------
// Stream events (for terminal streaming)
// ---------------------------------------------------------------------------

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; toolName: string }
  | { type: "tool_input"; toolName: string; input: Record<string, unknown> }
  | { type: "tool_progress"; toolName: string; elapsedSeconds: number }
  | { type: "result"; response: string; messages: SessionMessage[]; partial: boolean }
  | { type: "error"; error: string };
```

Add the `streamAgentTurn()` function after the existing `runAgentTurn()` function (after line 293):

```typescript
// ---------------------------------------------------------------------------
// streamAgentTurn
// ---------------------------------------------------------------------------

/**
 * Stream an agent turn, yielding events as they arrive from the SDK.
 *
 * Same lifecycle as `runAgentTurn()` (session resume, audit, error handling)
 * but yields `StreamEvent` objects instead of accumulating text.
 *
 * Used by terminal mode for real-time output. Daemon mode uses `runAgentTurn()`.
 */
export async function* streamAgentTurn(
  message: string,
  sessionKey: string,
  agentOptions: AgentOptions,
  config: Config,
): AsyncGenerator<StreamEvent> {
  const userMsg: SessionMessage = {
    role: "user",
    content: message,
    timestamp: new Date().toISOString(),
  };

  const sdkSessionId = sdkSessionIds.get(sessionKey);

  const result = query({
    prompt: message,
    options: {
      ...agentOptions,
      ...(sdkSessionId ? { resume: sdkSessionId } : {}),
    } as unknown as Options,
  });

  let responseText = "";
  let partial = false;
  const turnMessages: SessionMessage[] = [userMsg];

  // Track active tool_use content blocks for input buffering
  const activeTools = new Map<number, { name: string; jsonFragments: string[] }>();

  try {
    for await (const msg of result) {
      // Capture SDK session ID
      if (
        !sdkSessionIds.has(sessionKey) &&
        "session_id" in msg &&
        msg.session_id
      ) {
        sdkSessionIds.set(sessionKey, msg.session_id as string);
      }

      // Stream events — text deltas and tool use
      if (msg.type === "stream_event") {
        const streamMsg = msg as SDKPartialAssistantMessage;
        const event = streamMsg.event as any;

        if (event.type === "content_block_delta") {
          if (event.delta?.type === "text_delta" && event.delta.text) {
            yield { type: "text_delta", text: event.delta.text };
          } else if (event.delta?.type === "input_json_delta" && event.delta.partial_json) {
            const tool = activeTools.get(event.index);
            if (tool) {
              tool.jsonFragments.push(event.delta.partial_json);
            }
          }
        } else if (event.type === "content_block_start") {
          if (event.content_block?.type === "tool_use") {
            const toolName = event.content_block.name;
            activeTools.set(event.index, { name: toolName, jsonFragments: [] });
            yield { type: "tool_start", toolName };
          }
        } else if (event.type === "content_block_stop") {
          const tool = activeTools.get(event.index);
          if (tool && tool.jsonFragments.length > 0) {
            try {
              const input = JSON.parse(tool.jsonFragments.join(""));
              yield { type: "tool_input", toolName: tool.name, input };
            } catch {
              // Malformed JSON — skip tool_input event
            }
          }
          activeTools.delete(event.index);
        }
      }

      // Tool progress from SDK
      if (msg.type === "tool_progress") {
        const progressMsg = msg as any;
        yield {
          type: "tool_progress",
          toolName: progressMsg.tool_name,
          elapsedSeconds: progressMsg.elapsed_time_seconds,
        };
      }

      // Collect complete assistant message text (for final response + audit)
      if (
        msg.type === "assistant" &&
        (msg as SDKAssistantMessage).message?.content
      ) {
        const assistantMsg = msg as SDKAssistantMessage;
        for (const block of assistantMsg.message.content) {
          if (typeof block === "string") {
            responseText += block;
          } else if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            (block as { type: string }).type === "text" &&
            "text" in block
          ) {
            responseText += (block as { type: "text"; text: string }).text;
          }
        }
      }
    }
  } catch (err) {
    const isTransportError =
      err instanceof Error &&
      err.message.includes("ProcessTransport is not ready");
    if (isTransportError && responseText) {
      partial = true;
    } else {
      // Enhance process exit errors
      if (err instanceof Error) {
        const exitMatch = err.message.match(
          /Claude Code process exited with code (\d+)/,
        );
        if (exitMatch) {
          const code = exitMatch[1];
          const hint =
            code === "1"
              ? "This usually means an authentication error or a crash in the Claude Code subprocess. " +
                "Check that your ANTHROPIC_API_KEY is set and valid, or run `claude` directly to diagnose."
              : `Exit code ${code} from the Claude Code subprocess. Run \`claude\` directly to diagnose.`;
          yield { type: "error", error: `${err.message}\n${hint}` };
        } else {
          yield { type: "error", error: err.message };
        }
      } else {
        yield { type: "error", error: String(err) };
      }

      // Still do audit for partial responses
      if (responseText) {
        partial = true;
      } else {
        // Close transport and return early
        if (typeof (result as any).close === "function") {
          try { (result as any).close(); } catch { /* ignore */ }
        }
        return;
      }
    }
  } finally {
    if (typeof (result as any).close === "function") {
      try { (result as any).close(); } catch { /* ignore */ }
    }
  }

  // Add assistant response to turn messages
  turnMessages.push({
    role: "assistant",
    content: responseText,
    timestamp: new Date().toISOString(),
  });

  // Save to session transcript
  await saveInteraction(sessionKey, turnMessages, config);

  // Append audit entry
  await appendAuditEntry(config.security.workspace, {
    timestamp: new Date().toISOString(),
    source: sessionKey.split("--")[0],
    sessionKey,
    type: "interaction",
    userMessage: message,
    assistantResponse: responseText,
  });

  // Final result event
  yield { type: "result", response: responseText, messages: turnMessages, partial };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/agent-runner.test.ts`
Expected: ALL PASS

**Step 5: Run full test suite to verify no regressions**

Run: `npx vitest run`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/core/agent-runner.ts src/core/agent-runner.test.ts
git commit -m "feat: add streamAgentTurn() async generator for terminal streaming"
```

---

### Task 2: Add `hasMarkdownElements()` to markdown.ts

**Files:**
- Modify: `src/terminal/markdown.ts` (append new function)
- Test: `src/terminal/markdown.test.ts` (add new describe block)

**Step 1: Write failing tests**

Add to `src/terminal/markdown.test.ts` — import `hasMarkdownElements` and add tests:

```typescript
// Add to imports:
import { renderMarkdown, hasMarkdownElements } from "./markdown.js";

// Add new describe block:
describe("hasMarkdownElements", () => {
  it("returns false for plain text", () => {
    expect(hasMarkdownElements("Hello world")).toBe(false);
  });

  it("returns true for fenced code blocks", () => {
    expect(hasMarkdownElements("Here:\n```\ncode\n```")).toBe(true);
  });

  it("returns true for headers", () => {
    expect(hasMarkdownElements("# Title\nContent")).toBe(true);
  });

  it("returns true for bold text", () => {
    expect(hasMarkdownElements("This is **bold**")).toBe(true);
  });

  it("returns true for italic text with underscores", () => {
    expect(hasMarkdownElements("This is _italic_")).toBe(true);
  });

  it("returns true for unordered lists", () => {
    expect(hasMarkdownElements("Items:\n- first\n- second")).toBe(true);
  });

  it("returns true for ordered lists", () => {
    expect(hasMarkdownElements("Steps:\n1. first\n2. second")).toBe(true);
  });

  it("returns true for links", () => {
    expect(hasMarkdownElements("See [here](https://example.com)")).toBe(true);
  });

  it("returns false for text with hyphens in words", () => {
    expect(hasMarkdownElements("This is a well-known fact")).toBe(false);
  });

  it("returns false for text with underscores in identifiers", () => {
    expect(hasMarkdownElements("use my_variable_name here")).toBe(false);
  });

  it("returns true for inline code", () => {
    expect(hasMarkdownElements("Use `npm install` to install")).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/terminal/markdown.test.ts`
Expected: FAIL — `hasMarkdownElements` is not exported

**Step 3: Implement `hasMarkdownElements()`**

Append to `src/terminal/markdown.ts`:

```typescript
/**
 * Check whether text contains markdown elements that would benefit from
 * rendered formatting. Used for smart re-render: only clear and re-render
 * streamed text if the full response actually contains markdown.
 */
export function hasMarkdownElements(text: string): boolean {
  // Fenced code blocks
  if (/```/.test(text)) return true;
  // Inline code
  if (/`.+`/.test(text)) return true;
  // Headers (# at start of line)
  if (/^#{1,6}\s/m.test(text)) return true;
  // Bold (**text** or __text__)
  if (/\*\*.+\*\*/.test(text)) return true;
  if (/__\S.*\S__/.test(text)) return true;
  // Italic (*text* but not * in list) — single * surrounded by non-space
  if (/(?<!\*)\*(?!\s)[^*]+(?<!\s)\*(?!\*)/.test(text)) return true;
  // Italic _text_ — but not snake_case (require space or start-of-string before _)
  if (/(?:^|[\s(])_(?!\s)\S.*?\S_(?:[\s,.)!?]|$)/m.test(text)) return true;
  // Unordered list (- or * at start of line followed by space)
  if (/^[-*]\s/m.test(text)) return true;
  // Ordered list (number. at start of line)
  if (/^\d+\.\s/m.test(text)) return true;
  // Links [text](url)
  if (/\[.+\]\(.+\)/.test(text)) return true;

  return false;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/terminal/markdown.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/terminal/markdown.ts src/terminal/markdown.test.ts
git commit -m "feat: add hasMarkdownElements() for smart streaming re-render"
```

---

### Task 3: Add `handleLineStreaming()` to terminal handler

**Files:**
- Modify: `src/terminal/handler.ts`
- Test: `src/terminal.test.ts`

**Step 1: Write failing tests**

In `src/terminal.test.ts`, update the mock for `agent-runner.js` (line 59-63) to include `streamAgentTurn`, import it, and add tests. Also import the `StreamEvent` type.

Update the mock:
```typescript
vi.mock("./core/agent-runner.js", () => ({
  buildAgentOptions: vi.fn(),
  runAgentTurn: vi.fn(),
  streamAgentTurn: vi.fn(),
  clearSdkSession: vi.fn(),
}));
```

Update imports:
```typescript
import { buildAgentOptions, runAgentTurn, streamAgentTurn } from "./core/agent-runner.js";
import type { AgentOptions, AgentTurnResult, StreamEvent } from "./core/agent-runner.js";
```

Update the import from terminal.js to include `handleLineStreaming`:
```typescript
import { handleLine, handleLineStreaming, TERMINAL_SESSION_KEY, createTerminalSession } from "./terminal.js";
```

Add new test describe block:

```typescript
describe("handleLineStreaming", () => {
  it("yields stream events from streamAgentTurn", async () => {
    const config = makeConfig();
    const agentOpts = makeAgentOptions();

    async function* mockStream(): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", text: "Hello" };
      yield { type: "result", response: "Hello", messages: [], partial: false };
    }
    vi.mocked(streamAgentTurn).mockReturnValue(mockStream());

    const events = [];
    for await (const event of handleLineStreaming("Hi", TERMINAL_SESSION_KEY, agentOpts, config)) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "text_delta", text: "Hello" });
    expect(streamAgentTurn).toHaveBeenCalledWith("Hi", "terminal--default", agentOpts, config);
  });

  it("returns null-like empty generator for empty input", async () => {
    const config = makeConfig();
    const agentOpts = makeAgentOptions();

    const events = [];
    for await (const event of handleLineStreaming("", TERMINAL_SESSION_KEY, agentOpts, config)) {
      events.push(event);
    }

    expect(events).toHaveLength(0);
    expect(streamAgentTurn).not.toHaveBeenCalled();
  });

  it("returns null-like empty generator for whitespace-only input", async () => {
    const config = makeConfig();
    const agentOpts = makeAgentOptions();

    const events = [];
    for await (const event of handleLineStreaming("   ", TERMINAL_SESSION_KEY, agentOpts, config)) {
      events.push(event);
    }

    expect(events).toHaveLength(0);
  });

  it("handles /clear command by yielding a result event", async () => {
    const config = makeConfig();
    const agentOpts = makeAgentOptions();

    const events = [];
    for await (const event of handleLineStreaming("/clear", TERMINAL_SESSION_KEY, agentOpts, config)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "result",
      response: "Conversation cleared. Starting fresh.",
      messages: [],
      partial: false,
    });
  });

  it("trims input before sending to streamAgentTurn", async () => {
    const config = makeConfig();
    const agentOpts = makeAgentOptions();

    async function* mockStream(): AsyncGenerator<StreamEvent> {
      yield { type: "result", response: "ok", messages: [], partial: false };
    }
    vi.mocked(streamAgentTurn).mockReturnValue(mockStream());

    const events = [];
    for await (const event of handleLineStreaming("  hello  ", TERMINAL_SESSION_KEY, agentOpts, config)) {
      events.push(event);
    }

    expect(streamAgentTurn).toHaveBeenCalledWith("hello", "terminal--default", agentOpts, config);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/terminal.test.ts`
Expected: FAIL — `handleLineStreaming` is not exported

**Step 3: Implement `handleLineStreaming()`**

In `src/terminal/handler.ts`, add the import for `streamAgentTurn` and `StreamEvent`, then add the function. The file should become:

```typescript
import { runAgentTurn, clearSdkSession, streamAgentTurn } from "../core/agent-runner.js";
import type { AgentOptions, StreamEvent } from "../core/agent-runner.js";
import type { Config } from "../core/types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("terminal");

export interface HandleLineResult {
  response: string | null;
  error: string | null;
}

/**
 * Handle a single line of user input.
 *
 * Returns `null` when the input is empty/whitespace (caller should re-prompt).
 * Returns `{ response, error }` otherwise:
 *   - On success: `{ response: "...", error: null }`
 *   - On failure: `{ response: null, error: "..." }`
 */
export async function handleLine(
  input: string,
  sessionKey: string,
  agentOptions: AgentOptions,
  config: Config,
): Promise<HandleLineResult | null> {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  // Handle /clear command — reset conversation history
  if (trimmed === "/clear") {
    clearSdkSession(sessionKey);
    return { response: "Conversation cleared. Starting fresh.", error: null };
  }

  try {
    const result = await runAgentTurn(trimmed, sessionKey, agentOptions, config);
    return { response: result.response, error: null };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const isProcessExit =
      err instanceof Error &&
      /Claude Code process exited with code/.test(err.message);
    if (isProcessExit) {
      log.error("Agent turn failed: %s", errorMessage);
    } else {
      log.error({ err }, "Agent turn failed");
    }
    return { response: null, error: errorMessage };
  }
}

/**
 * Streaming variant of handleLine. Yields StreamEvent objects as they arrive.
 *
 * Yields nothing (empty generator) for empty/whitespace input.
 * For /clear, yields a single result event.
 * Otherwise, delegates to streamAgentTurn and yields all events.
 */
export async function* handleLineStreaming(
  input: string,
  sessionKey: string,
  agentOptions: AgentOptions,
  config: Config,
): AsyncGenerator<StreamEvent> {
  const trimmed = input.trim();
  if (!trimmed) {
    return;
  }

  if (trimmed === "/clear") {
    clearSdkSession(sessionKey);
    yield {
      type: "result",
      response: "Conversation cleared. Starting fresh.",
      messages: [],
      partial: false,
    };
    return;
  }

  yield* streamAgentTurn(trimmed, sessionKey, agentOptions, config);
}
```

Also update `src/terminal.ts` (the barrel/entry point) to re-export `handleLineStreaming`. Check what `src/terminal.ts` currently exports and add:

```typescript
export { handleLineStreaming } from "./terminal/handler.js";
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/terminal.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/terminal/handler.ts src/terminal.test.ts src/terminal.ts
git commit -m "feat: add handleLineStreaming() for terminal streaming mode"
```

---

### Task 4: Add `formatToolSummary()` helper and `countTerminalRows()`

**Files:**
- Create: `src/terminal/stream-render.ts`
- Create: `src/terminal/stream-render.test.ts`

**Step 1: Write failing tests**

Create `src/terminal/stream-render.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { formatToolSummary, countTerminalRows } from "./stream-render.js";

describe("formatToolSummary", () => {
  it("formats Bash tool with command", () => {
    expect(formatToolSummary("Bash", { command: "npm test" })).toBe("Running: npm test");
  });

  it("truncates long bash commands", () => {
    const longCmd = "a".repeat(100);
    const result = formatToolSummary("Bash", { command: longCmd });
    expect(result.length).toBeLessThanOrEqual(72); // "Running: " (9) + 60 + "..." (3)
    expect(result).toMatch(/\.\.\.$/);
  });

  it("formats Read tool with file path", () => {
    expect(formatToolSummary("Read", { file_path: "/src/foo.ts" })).toBe("Reading /src/foo.ts");
  });

  it("formats Write tool with file path", () => {
    expect(formatToolSummary("Write", { file_path: "/src/bar.ts" })).toBe("Writing /src/bar.ts");
  });

  it("formats Edit tool with file path", () => {
    expect(formatToolSummary("Edit", { file_path: "/src/baz.ts" })).toBe("Editing /src/baz.ts");
  });

  it("formats Glob tool with pattern", () => {
    expect(formatToolSummary("Glob", { pattern: "**/*.ts" })).toBe("Searching: **/*.ts");
  });

  it("formats Grep tool with pattern", () => {
    expect(formatToolSummary("Grep", { pattern: "handleLine" })).toBe("Grepping: handleLine");
  });

  it("formats WebFetch tool with URL", () => {
    expect(formatToolSummary("WebFetch", { url: "https://example.com" })).toBe("Fetching: https://example.com");
  });

  it("formats WebSearch tool with query", () => {
    expect(formatToolSummary("WebSearch", { query: "node.js streaming" })).toBe("Searching web: node.js streaming");
  });

  it("falls back to tool name for unknown tools", () => {
    expect(formatToolSummary("CustomTool", {})).toBe("CustomTool");
  });

  it("falls back to tool name when expected field is missing", () => {
    expect(formatToolSummary("Bash", {})).toBe("Bash");
  });
});

describe("countTerminalRows", () => {
  it("counts single line", () => {
    expect(countTerminalRows("hello", 80)).toBe(1);
  });

  it("counts wrapped lines", () => {
    // 100 chars at 80 columns = 2 rows
    expect(countTerminalRows("a".repeat(100), 80)).toBe(2);
  });

  it("counts multiple lines with wrapping", () => {
    // Line 1: 40 chars (1 row), Line 2: 100 chars (2 rows) = 3 rows
    expect(countTerminalRows("a".repeat(40) + "\n" + "b".repeat(100), 80)).toBe(3);
  });

  it("handles exact column-width lines", () => {
    expect(countTerminalRows("a".repeat(80), 80)).toBe(1);
  });

  it("counts empty lines as 1 row each", () => {
    expect(countTerminalRows("a\n\nb", 80)).toBe(3);
  });

  it("handles trailing newline", () => {
    expect(countTerminalRows("hello\n", 80)).toBe(2);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/terminal/stream-render.test.ts`
Expected: FAIL — module not found

**Step 3: Implement**

Create `src/terminal/stream-render.ts`:

```typescript
/**
 * Format a tool summary for terminal display during streaming.
 */
export function formatToolSummary(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const MAX_CMD_LEN = 60;

  switch (toolName) {
    case "Bash": {
      const cmd = input.command as string | undefined;
      if (!cmd) return toolName;
      const truncated = cmd.length > MAX_CMD_LEN ? cmd.slice(0, MAX_CMD_LEN) + "..." : cmd;
      return `Running: ${truncated}`;
    }
    case "Read": {
      const fp = input.file_path as string | undefined;
      return fp ? `Reading ${fp}` : toolName;
    }
    case "Write": {
      const fp = input.file_path as string | undefined;
      return fp ? `Writing ${fp}` : toolName;
    }
    case "Edit": {
      const fp = input.file_path as string | undefined;
      return fp ? `Editing ${fp}` : toolName;
    }
    case "Glob": {
      const pat = input.pattern as string | undefined;
      return pat ? `Searching: ${pat}` : toolName;
    }
    case "Grep": {
      const pat = input.pattern as string | undefined;
      return pat ? `Grepping: ${pat}` : toolName;
    }
    case "WebFetch": {
      const url = input.url as string | undefined;
      return url ? `Fetching: ${url}` : toolName;
    }
    case "WebSearch": {
      const q = input.query as string | undefined;
      return q ? `Searching web: ${q}` : toolName;
    }
    default:
      return toolName;
  }
}

/**
 * Count the number of terminal rows that a string occupies, accounting for
 * line wrapping at the given column width.
 */
export function countTerminalRows(text: string, columns: number): number {
  const lines = text.split("\n");
  let rows = 0;
  for (const line of lines) {
    if (line.length === 0) {
      rows += 1;
    } else {
      rows += Math.ceil(line.length / columns);
    }
  }
  return rows;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/terminal/stream-render.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/terminal/stream-render.ts src/terminal/stream-render.test.ts
git commit -m "feat: add formatToolSummary() and countTerminalRows() for streaming display"
```

---

### Task 5: Rewrite REPL to consume streaming events

**Files:**
- Modify: `src/terminal/repl.ts` (major rewrite of the `rl.on("line")` handler)

**Step 1: Rewrite `repl.ts` to use streaming**

Replace the contents of `src/terminal/repl.ts` with:

```typescript
import * as readline from "node:readline";
import {
  createPasteTracker,
  enableBracketedPaste,
  disableBracketedPaste,
} from "./paste.js";
import { createSpinner } from "./spinner.js";
import { renderMarkdown, hasMarkdownElements } from "./markdown.js";
import { colors } from "./colors.js";
import { handleLineStreaming } from "./handler.js";
import { formatToolSummary, countTerminalRows } from "./stream-render.js";
import type { TerminalSession } from "./session.js";
import type { StreamEvent } from "../core/agent-runner.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("terminal");

/**
 * Run the interactive terminal REPL loop with:
 * - Bracketed paste support (multiline paste submitted as single message)
 * - Streaming output with tool activity display
 * - Smart markdown re-render on completion
 * - Colored prompt and output
 * - Spinner while waiting for first response
 */
export function runTerminalRepl(session: TerminalSession): void {
  const { config, agentOptions, sessionKey } = session;
  const spinner = createSpinner();
  const isTTY = process.stdin.isTTY ?? false;

  const paste = createPasteTracker();
  let processing = false;
  let cleaned = false;

  if (isTTY) {
    enableBracketedPaste();
  }

  process.stdin.setEncoding("utf-8");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: colors.prompt("You> "),
  });

  // Listen for paste-start / paste-end keypress events emitted by readline
  if (isTTY) {
    process.stdin.on("keypress", (_ch: string, key: { name?: string }) => {
      paste.handleKeypress(key?.name);
    });
  }

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    spinner.stop();
    if (isTTY) {
      disableBracketedPaste();
    }
    await session.cleanup();
  };

  // Safety net: always restore terminal on process exit
  process.on("exit", () => {
    if (isTTY) {
      disableBracketedPaste();
    }
  });

  rl.prompt();

  rl.on("line", async (input) => {
    if (processing) return;

    const userInput = paste.handleLine(input);
    if (userInput === null) return;

    // Show a preview for multiline pastes
    if (userInput.includes("\n")) {
      const lineCount = userInput.split("\n").length;
      console.log(colors.dim(`(pasted ${lineCount} lines)`));
    }

    processing = true;
    spinner.start();

    let headerPrinted = false;
    let streamedText = "";
    let inTextBlock = false;
    // Track the last tool_start so we can update it with input details
    let pendingToolName: string | null = null;

    for await (const event of handleLineStreaming(userInput, sessionKey, agentOptions, config)) {
      switch (event.type) {
        case "text_delta": {
          if (!headerPrinted) {
            spinner.stop();
            console.log();
            console.log(colors.label("Assistant:"));
            headerPrinted = true;
          }
          inTextBlock = true;
          process.stdout.write(event.text);
          streamedText += event.text;
          break;
        }

        case "tool_start": {
          if (!headerPrinted) {
            spinner.stop();
            console.log();
            console.log(colors.label("Assistant:"));
            headerPrinted = true;
          }
          if (inTextBlock) {
            process.stdout.write("\n");
            inTextBlock = false;
          }
          pendingToolName = event.toolName;
          // Show tool name immediately; will be updated when input arrives
          console.log(colors.dim(`  ${event.toolName}...`));
          break;
        }

        case "tool_input": {
          // Update the tool line with detailed summary
          if (pendingToolName === event.toolName) {
            const summary = formatToolSummary(event.toolName, event.input);
            // Move cursor up one line, clear it, rewrite
            process.stdout.write("\x1b[1A\x1b[2K");
            console.log(colors.dim(`  ${summary}`));
          }
          pendingToolName = null;
          break;
        }

        case "tool_progress": {
          // Show elapsed time — overwrite current tool line
          const secs = Math.round(event.elapsedSeconds);
          if (secs > 2) {
            process.stdout.write("\x1b[1A\x1b[2K");
            console.log(colors.dim(`  ${event.toolName}... (${secs}s)`));
          }
          break;
        }

        case "result": {
          spinner.stop();
          pendingToolName = null;

          if (!headerPrinted) {
            // No streaming events arrived — display result directly
            if (event.response) {
              console.log();
              console.log(colors.label("Assistant:"));
              console.log(renderMarkdown(event.response));
              console.log();
            }
          } else if (streamedText && hasMarkdownElements(event.response)) {
            // Smart re-render: clear raw text and tool lines, replace with markdown
            const columns = process.stdout.columns || 80;
            // Count rows for: "Assistant:" header (1) + streamed content + tool lines
            // We re-render everything after the "Assistant:" label
            const rawOutput = streamedText;
            const rows = countTerminalRows(rawOutput, columns);
            // Move up and clear
            if (rows > 0) {
              process.stdout.write(`\x1b[${rows}A\x1b[J`);
            }
            console.log(renderMarkdown(event.response));
            console.log();
          } else {
            // Plain text — just finalize
            if (inTextBlock) {
              process.stdout.write("\n");
            }
            console.log();
          }
          break;
        }

        case "error": {
          spinner.stop();
          if (inTextBlock) {
            process.stdout.write("\n");
          }
          console.error(colors.error(`Error: ${event.error}`));
          break;
        }
      }
    }

    spinner.stop();
    processing = false;
    rl.prompt();
  });

  rl.on("close", async () => {
    log.info("Terminal session ended");
    await cleanup();
    process.exit(0);
  });
}
```

**Step 2: Verify build succeeds**

Run: `npm run build`
Expected: SUCCESS

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add src/terminal/repl.ts
git commit -m "feat: rewrite terminal REPL to stream agent output with tool activity display"
```

---

### Task 6: Update `terminal.ts` barrel exports

**Files:**
- Modify: `src/terminal.ts` — check current exports, ensure `handleLineStreaming` is re-exported

**Step 1: Read `src/terminal.ts` and check if `handleLineStreaming` needs re-exporting**

The `terminal.test.ts` imports `handleLineStreaming` from `./terminal.js`. Check what `src/terminal.ts` re-exports from `./terminal/handler.js`. If `handleLine` is re-exported, add `handleLineStreaming` next to it.

If not already present, add:

```typescript
export { handleLineStreaming } from "./terminal/handler.js";
```

**Step 2: Run tests**

Run: `npx vitest run src/terminal.test.ts`
Expected: ALL PASS

**Step 3: Run full suite**

Run: `npx vitest run`
Expected: ALL PASS

**Step 4: Build**

Run: `npm run build`
Expected: SUCCESS

**Step 5: Commit**

```bash
git add src/terminal.ts
git commit -m "feat: re-export handleLineStreaming from terminal barrel"
```

---

### Task 7: Manual verification

**Step 1: Build and link**

```bash
npm run build && npm link
```

**Step 2: Test streaming in terminal mode**

```bash
pa terminal
```

Test scenarios:
- Simple question → text streams character by character, then re-renders with markdown if applicable
- Question that triggers tool use → tool names appear as dimmed lines, then text streams
- Paste a URL → no `^[[200~` visible (paste fix still works)
- Paste multiline → "(pasted N lines)" message shown
- Ctrl+C → exits cleanly
- Arrow keys, backspace → still work

**Step 3: Verify non-TTY still works**

```bash
echo "Hello" | pa terminal
```

Expected: still processes input (no crash on missing TTY)
