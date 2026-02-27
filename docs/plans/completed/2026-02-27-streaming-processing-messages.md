# Streaming Processing Messages for Telegram & Slack Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show intermediate agent outputs (tool calls + text) in a periodically-updated "processing message" in Telegram/Slack, then send the final response as a separate new message.

**Architecture:** The gateway queue switches from `runAgentTurn()` to `streamAgentTurn()` for adapters that implement optional `createProcessingMessage`/`updateProcessingMessage` methods. A `ProcessingMessageAccumulator` consumes `StreamEvent`s, buffers formatted content, and flushes to the adapter on a configurable timer.

**Tech Stack:** TypeScript, Grammy (Telegram), Bolt.js (Slack), Vitest

---

### Task 1: Add `processingUpdateIntervalMs` to Config

**Files:**
- Modify: `src/core/types.ts:42-44` (GatewayConfigSchema)
- Modify: `src/core/config.ts:38` (DEFAULTS.gateway)
- Modify: `src/core/config.test.ts` (add test for new default)
- Modify: `src/gateway/queue.test.ts:81` (makeConfig helper)

**Step 1: Write the failing test**

In `src/core/config.test.ts`, inside the `"returns full defaults when settings.json has empty object {}"` test (line 114), add an assertion after line 132:

```typescript
expect(config.gateway.processingUpdateIntervalMs).toBe(5000);
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/config.test.ts`
Expected: FAIL — `processingUpdateIntervalMs` does not exist on gateway config

**Step 3: Write minimal implementation**

In `src/core/types.ts`, update `GatewayConfigSchema`:

```typescript
export const GatewayConfigSchema = z.object({
  maxQueueSize: z.number().int().positive(),
  processingUpdateIntervalMs: z.number().int().positive().default(5000),
});
```

In `src/core/config.ts`, update `DEFAULTS.gateway`:

```typescript
gateway: { maxQueueSize: 20, processingUpdateIntervalMs: 5000 },
```

In `src/gateway/queue.test.ts`, update the `makeConfig` helper's gateway field:

```typescript
gateway: { maxQueueSize: 5, processingUpdateIntervalMs: 5000 },
```

Also update any other test files that construct a full Config object inline (e.g., `src/core/config.test.ts` line 34 — add `processingUpdateIntervalMs: 5000` to the gateway object in the first test).

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/config.test.ts src/gateway/queue.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/types.ts src/core/config.ts src/core/config.test.ts src/gateway/queue.test.ts
git commit -m "feat: add processingUpdateIntervalMs to gateway config"
```

---

### Task 2: Add optional processing message methods to Adapter interface

**Files:**
- Modify: `src/core/types.ts:107-116` (Adapter interface)

**Step 1: Update the Adapter interface**

In `src/core/types.ts`, add two optional methods to the `Adapter` interface:

```typescript
export interface Adapter {
  /** Human-readable adapter name (e.g. "telegram"). */
  name: string;
  /** Start listening for incoming messages. */
  start(): Promise<void>;
  /** Gracefully stop the adapter. */
  stop(): Promise<void>;
  /** Deliver a response back to the user via this adapter. */
  sendResponse(message: AdapterMessage): Promise<void>;

  /**
   * Create a processing message in the user's chat/thread.
   * Returns a platform-specific message ID for later updates.
   * Optional — only adapters that support streaming implement this.
   */
  createProcessingMessage?(
    sourceId: string,
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<string>;

  /**
   * Update an existing processing message with new content.
   * Optional — only adapters that support streaming implement this.
   */
  updateProcessingMessage?(
    sourceId: string,
    messageId: string,
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
}
```

**Step 2: Run existing tests to verify nothing breaks**

Run: `npx vitest run`
Expected: All PASS (new methods are optional, no existing code needs to change)

**Step 3: Commit**

```bash
git add src/core/types.ts
git commit -m "feat: add optional processing message methods to Adapter interface"
```

---

### Task 3: Add `getAdapter()` to Router

**Files:**
- Modify: `src/gateway/router.ts:14-21` (Router interface)
- Modify: `src/gateway/router.ts:32-58` (createRouter implementation)
- Test: `src/gateway/queue.test.ts` (Router tests section)

**Step 1: Write the failing test**

In `src/gateway/queue.test.ts`, add a new describe block inside the Router describe (after the `unregister` block, around line 804):

```typescript
describe("getAdapter", () => {
  it("returns registered adapter by name", () => {
    const router = createRouter();
    const adapter = makeAdapter("telegram");
    router.register(adapter);

    expect(router.getAdapter("telegram")).toBe(adapter);
  });

  it("returns undefined for unregistered adapter", () => {
    const router = createRouter();

    expect(router.getAdapter("nonexistent")).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/gateway/queue.test.ts`
Expected: FAIL — `getAdapter` does not exist on router

**Step 3: Write minimal implementation**

In `src/gateway/router.ts`, add to the interface:

```typescript
export interface Router {
  register(adapter: Adapter): void;
  unregister(name: string): void;
  route(response: AdapterMessage): Promise<void>;
  /** Look up a registered adapter by name. */
  getAdapter(name: string): Adapter | undefined;
}
```

In the `createRouter()` return object, add:

```typescript
getAdapter(name: string): Adapter | undefined {
  return adapters.get(name);
},
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/gateway/queue.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/gateway/router.ts src/gateway/queue.test.ts
git commit -m "feat: add getAdapter() to Router for adapter capability checks"
```

---

### Task 4: Implement Telegram `createProcessingMessage` and `updateProcessingMessage`

**Files:**
- Modify: `src/adapters/telegram.ts` (add new methods to returned adapter)
- Test: `src/adapters/telegram.test.ts` (add tests for new methods)

**Step 1: Write failing tests**

In `src/adapters/telegram.test.ts`, first add `editMessageText` to the mock setup. In the `mocks` hoisted block (around line 15), add:

```typescript
const botApiEditMessageText = vi.fn().mockResolvedValue(undefined);
```

And update the BotCtor to include it:

```typescript
this.api = { sendMessage: botApiSendMessage, editMessageText: botApiEditMessageText };
```

Update the `mocks` return to include `botApiEditMessageText`.

Then add a new describe block after the `start / stop` block:

```typescript
describe("createProcessingMessage", () => {
  it("sends a message and returns the message_id as string", async () => {
    const onMessage = vi.fn();
    mocks.botApiSendMessage.mockResolvedValueOnce({ message_id: 42 });
    const adapter = createTelegramAdapter(makeConfig(), onMessage);

    const messageId = await adapter.createProcessingMessage!("999", "Processing...");

    expect(mocks.botApiSendMessage).toHaveBeenCalledWith(999, "Processing...");
    expect(messageId).toBe("42");
  });

  it("logs error when chat ID is invalid", async () => {
    const onMessage = vi.fn();
    const adapter = createTelegramAdapter(makeConfig(), onMessage);

    await expect(
      adapter.createProcessingMessage!("not-a-number", "text"),
    ).rejects.toThrow();
  });
});

describe("updateProcessingMessage", () => {
  it("edits an existing message with new text", async () => {
    const onMessage = vi.fn();
    const adapter = createTelegramAdapter(makeConfig(), onMessage);

    await adapter.updateProcessingMessage!("999", "42", "Updated content");

    expect(mocks.botApiEditMessageText).toHaveBeenCalledWith(
      999,
      42,
      "Updated content",
    );
  });

  it("logs error when edit fails", async () => {
    const onMessage = vi.fn();
    const adapter = createTelegramAdapter(makeConfig(), onMessage);
    mocks.botApiEditMessageText.mockRejectedValueOnce(new Error("edit failed"));

    await expect(
      adapter.updateProcessingMessage!("999", "42", "text"),
    ).rejects.toThrow("edit failed");
    expect(mockLog.error).toHaveBeenCalled();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/adapters/telegram.test.ts`
Expected: FAIL — `createProcessingMessage` / `updateProcessingMessage` are undefined

**Step 3: Write minimal implementation**

In `src/adapters/telegram.ts`, add to the returned adapter object (after `sendResponse`):

```typescript
async createProcessingMessage(
  sourceId: string,
  text: string,
): Promise<string> {
  const chatId = Number(sourceId);
  if (Number.isNaN(chatId)) {
    const err = new Error(`invalid chat ID: ${sourceId}`);
    log.error({ sourceId }, "invalid chat ID for processing message");
    throw err;
  }
  const result = await bot.api.sendMessage(chatId, text);
  return String(result.message_id);
},

async updateProcessingMessage(
  sourceId: string,
  messageId: string,
  text: string,
): Promise<void> {
  const chatId = Number(sourceId);
  const msgId = Number(messageId);
  try {
    await bot.api.editMessageText(chatId, msgId, text);
  } catch (err) {
    log.error({ chatId, messageId, err }, "failed to edit processing message");
    throw err;
  }
},
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/adapters/telegram.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/adapters/telegram.ts src/adapters/telegram.test.ts
git commit -m "feat: implement createProcessingMessage/updateProcessingMessage for Telegram"
```

---

### Task 5: Implement Slack `createProcessingMessage` and `updateProcessingMessage`

**Files:**
- Modify: `src/adapters/slack.ts` (add new methods to returned adapter)
- Test: `src/adapters/slack.test.ts` (add tests for new methods)

**Step 1: Write failing tests**

In `src/adapters/slack.test.ts`, first add `chatUpdate` to the mock setup. In the `mocks` hoisted block, add:

```typescript
const chatUpdate = vi.fn().mockResolvedValue({ ok: true });
```

Update the `AppCtor` client mock:

```typescript
this.client = {
  chat: { postMessage: chatPostMessage, update: chatUpdate },
  auth: { test: authTest },
};
```

Update the `mocks` return to include `chatUpdate`.

Then add new describe blocks:

```typescript
describe("createProcessingMessage", () => {
  it("posts a message in the correct thread and returns ts", async () => {
    const onMessage = vi.fn();
    mocks.chatPostMessage.mockResolvedValueOnce({
      ok: true,
      ts: "1234567890.999999",
    });
    const adapter = createSlackAdapter(makeConfig(), onMessage);

    const messageId = await adapter.createProcessingMessage!(
      "C_CHANNEL_1--1234567890.000001",
      "Processing...",
    );

    expect(mocks.chatPostMessage).toHaveBeenCalledWith({
      channel: "C_CHANNEL_1",
      text: "Processing...",
      thread_ts: "1234567890.000001",
    });
    expect(messageId).toBe("1234567890.999999");
  });

  it("uses metadata for channel/thread when sourceId parsing fails", async () => {
    const onMessage = vi.fn();
    mocks.chatPostMessage.mockResolvedValueOnce({
      ok: true,
      ts: "1234567890.999999",
    });
    const adapter = createSlackAdapter(makeConfig(), onMessage);

    await adapter.createProcessingMessage!(
      "C_CHANNEL_1--1234567890.000001",
      "Processing...",
      { channelId: "C_META_CHANNEL", threadId: "1234567890.000002" },
    );

    expect(mocks.chatPostMessage).toHaveBeenCalledWith({
      channel: "C_META_CHANNEL",
      text: "Processing...",
      thread_ts: "1234567890.000002",
    });
  });
});

describe("updateProcessingMessage", () => {
  it("updates an existing message with new text in the correct channel", async () => {
    const onMessage = vi.fn();
    const adapter = createSlackAdapter(makeConfig(), onMessage);

    await adapter.updateProcessingMessage!(
      "C_CHANNEL_1--1234567890.000001",
      "1234567890.999999",
      "Updated content",
    );

    expect(mocks.chatUpdate).toHaveBeenCalledWith({
      channel: "C_CHANNEL_1",
      ts: "1234567890.999999",
      text: "Updated content",
    });
  });

  it("logs error when update fails", async () => {
    const onMessage = vi.fn();
    const adapter = createSlackAdapter(makeConfig(), onMessage);
    mocks.chatUpdate.mockRejectedValueOnce(new Error("update failed"));

    await expect(
      adapter.updateProcessingMessage!(
        "C_CHANNEL_1--1234567890.000001",
        "1234567890.999999",
        "text",
      ),
    ).rejects.toThrow("update failed");
    expect(mockLog.error).toHaveBeenCalled();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/adapters/slack.test.ts`
Expected: FAIL — `createProcessingMessage` / `updateProcessingMessage` are undefined

**Step 3: Write minimal implementation**

In `src/adapters/slack.ts`, add to the returned adapter object (after `sendResponse`):

```typescript
async createProcessingMessage(
  sourceId: string,
  text: string,
  metadata?: Record<string, unknown>,
): Promise<string> {
  const { channelId: parsedChannel, threadTs: parsedThread } = decodeSourceId(sourceId);
  const channelId = (metadata?.channelId as string) ?? parsedChannel;
  const threadTs = (metadata?.threadId as string) ?? parsedThread;

  try {
    const result = await app.client.chat.postMessage({
      channel: channelId,
      text,
      thread_ts: threadTs,
    });
    return result.ts as string;
  } catch (err) {
    log.error({ channelId, threadTs, err }, "failed to create processing message");
    throw err;
  }
},

async updateProcessingMessage(
  sourceId: string,
  messageId: string,
  text: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const { channelId: parsedChannel } = decodeSourceId(sourceId);
  const channelId = (metadata?.channelId as string) ?? parsedChannel;

  try {
    await app.client.chat.update({
      channel: channelId,
      ts: messageId,
      text,
    });
  } catch (err) {
    log.error({ channelId, messageId, err }, "failed to update processing message");
    throw err;
  }
},
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/adapters/slack.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/adapters/slack.ts src/adapters/slack.test.ts
git commit -m "feat: implement createProcessingMessage/updateProcessingMessage for Slack"
```

---

### Task 6: Create ProcessingMessageAccumulator

**Files:**
- Create: `src/gateway/processing-message.ts`
- Create: `src/gateway/processing-message.test.ts`

**Step 1: Write failing tests**

Create `src/gateway/processing-message.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createProcessingAccumulator,
  formatToolInput,
} from "./processing-message.js";
import type { StreamEvent } from "../core/agent-runner.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../core/logger.js", () => ({
  createLogger: () => mockLog,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter() {
  return {
    createProcessingMessage: vi.fn().mockResolvedValue("msg-1"),
    updateProcessingMessage: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("formatToolInput", () => {
  it("formats Bash tool with command", () => {
    expect(formatToolInput("Bash", { command: "ls -la" })).toBe(
      "Running: ls -la",
    );
  });

  it("formats Read tool with file path", () => {
    expect(formatToolInput("Read", { file_path: "/src/index.ts" })).toBe(
      "Reading /src/index.ts",
    );
  });

  it("formats Glob tool with pattern", () => {
    expect(formatToolInput("Glob", { pattern: "**/*.ts" })).toBe(
      "Searching: **/*.ts",
    );
  });

  it("truncates long Bash commands", () => {
    const longCmd = "a".repeat(100);
    const result = formatToolInput("Bash", { command: longCmd });
    expect(result.length).toBeLessThan(80);
    expect(result).toContain("...");
  });

  it("returns tool name for unknown tools", () => {
    expect(formatToolInput("CustomTool", { foo: "bar" })).toBe("CustomTool");
  });
});

describe("ProcessingMessageAccumulator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not flush when no events have been received", async () => {
    const adapter = makeAdapter();
    const acc = createProcessingAccumulator(adapter, "123", undefined, 5000);
    acc.start();

    await vi.advanceTimersByTimeAsync(5000);

    expect(adapter.createProcessingMessage).not.toHaveBeenCalled();

    await acc.stop();
  });

  it("creates processing message on first flush with buffered content", async () => {
    const adapter = makeAdapter();
    const acc = createProcessingAccumulator(adapter, "123", undefined, 5000);
    acc.start();

    acc.handleEvent({ type: "tool_start", toolName: "Glob" });
    acc.handleEvent({
      type: "tool_input",
      toolName: "Glob",
      input: { pattern: "**/*.ts" },
    });

    await vi.advanceTimersByTimeAsync(5000);

    expect(adapter.createProcessingMessage).toHaveBeenCalledTimes(1);
    expect(adapter.createProcessingMessage).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("Glob"),
      undefined,
    );
  });

  it("updates processing message on subsequent flushes", async () => {
    const adapter = makeAdapter();
    const acc = createProcessingAccumulator(adapter, "123", undefined, 5000);
    acc.start();

    acc.handleEvent({ type: "tool_start", toolName: "Glob" });
    await vi.advanceTimersByTimeAsync(5000);

    acc.handleEvent({ type: "tool_start", toolName: "Read" });
    await vi.advanceTimersByTimeAsync(5000);

    expect(adapter.createProcessingMessage).toHaveBeenCalledTimes(1);
    expect(adapter.updateProcessingMessage).toHaveBeenCalledTimes(1);
    expect(adapter.updateProcessingMessage).toHaveBeenCalledWith(
      "123",
      "msg-1",
      expect.stringContaining("Read"),
      undefined,
    );
  });

  it("accumulates text_delta events", async () => {
    const adapter = makeAdapter();
    const acc = createProcessingAccumulator(adapter, "123", undefined, 5000);
    acc.start();

    acc.handleEvent({ type: "text_delta", text: "Hello " });
    acc.handleEvent({ type: "text_delta", text: "world" });

    await vi.advanceTimersByTimeAsync(5000);

    expect(adapter.createProcessingMessage).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("Hello world"),
      undefined,
    );
  });

  it("interleaves tool calls and text", async () => {
    const adapter = makeAdapter();
    const acc = createProcessingAccumulator(adapter, "123", undefined, 5000);
    acc.start();

    acc.handleEvent({ type: "tool_start", toolName: "Glob" });
    acc.handleEvent({
      type: "tool_input",
      toolName: "Glob",
      input: { pattern: "**/*.ts" },
    });
    acc.handleEvent({ type: "text_delta", text: "Found files. " });
    acc.handleEvent({ type: "tool_start", toolName: "Read" });
    acc.handleEvent({
      type: "tool_input",
      toolName: "Read",
      input: { file_path: "/src/index.ts" },
    });

    await vi.advanceTimersByTimeAsync(5000);

    const content = adapter.createProcessingMessage.mock.calls[0][1] as string;
    const globIdx = content.indexOf("Glob");
    const textIdx = content.indexOf("Found files");
    const readIdx = content.indexOf("Read");
    expect(globIdx).toBeLessThan(textIdx);
    expect(textIdx).toBeLessThan(readIdx);
  });

  it("ignores result and error events", async () => {
    const adapter = makeAdapter();
    const acc = createProcessingAccumulator(adapter, "123", undefined, 5000);
    acc.start();

    acc.handleEvent({
      type: "result",
      response: "Final answer",
      messages: [],
      partial: false,
    });
    acc.handleEvent({ type: "error", error: "Something broke" });

    await vi.advanceTimersByTimeAsync(5000);

    expect(adapter.createProcessingMessage).not.toHaveBeenCalled();
  });

  it("does final flush on stop() if buffer has content", async () => {
    const adapter = makeAdapter();
    const acc = createProcessingAccumulator(adapter, "123", undefined, 5000);
    acc.start();

    acc.handleEvent({ type: "tool_start", toolName: "Bash" });

    // Don't advance timer — stop should flush
    await acc.stop();

    expect(adapter.createProcessingMessage).toHaveBeenCalledTimes(1);
  });

  it("passes metadata through to adapter", async () => {
    const metadata = { channelId: "C123", threadId: "T456" };
    const adapter = makeAdapter();
    const acc = createProcessingAccumulator(adapter, "123", metadata, 5000);
    acc.start();

    acc.handleEvent({ type: "tool_start", toolName: "Glob" });

    await vi.advanceTimersByTimeAsync(5000);

    expect(adapter.createProcessingMessage).toHaveBeenCalledWith(
      "123",
      expect.any(String),
      metadata,
    );
  });

  it("truncates content exceeding 4000 chars", async () => {
    const adapter = makeAdapter();
    const acc = createProcessingAccumulator(adapter, "123", undefined, 5000);
    acc.start();

    // Generate lots of content
    for (let i = 0; i < 100; i++) {
      acc.handleEvent({ type: "text_delta", text: "x".repeat(50) + "\n" });
    }

    await vi.advanceTimersByTimeAsync(5000);

    const content = adapter.createProcessingMessage.mock.calls[0][1] as string;
    expect(content.length).toBeLessThanOrEqual(4000);
    expect(content).toContain("...earlier output truncated...");
  });

  it("handles tool_progress by tracking elapsed time", async () => {
    const adapter = makeAdapter();
    const acc = createProcessingAccumulator(adapter, "123", undefined, 5000);
    acc.start();

    acc.handleEvent({ type: "tool_start", toolName: "Bash" });
    acc.handleEvent({
      type: "tool_progress",
      toolName: "Bash",
      elapsedSeconds: 8,
    });

    await vi.advanceTimersByTimeAsync(5000);

    const content = adapter.createProcessingMessage.mock.calls[0][1] as string;
    expect(content).toContain("8s");
  });

  it("handles adapter errors gracefully during flush", async () => {
    const adapter = makeAdapter();
    adapter.createProcessingMessage.mockRejectedValueOnce(
      new Error("API error"),
    );
    const acc = createProcessingAccumulator(adapter, "123", undefined, 5000);
    acc.start();

    acc.handleEvent({ type: "tool_start", toolName: "Glob" });

    await vi.advanceTimersByTimeAsync(5000);

    // Should not throw, just log the error
    expect(mockLog.error).toHaveBeenCalled();

    await acc.stop();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/gateway/processing-message.test.ts`
Expected: FAIL — module `./processing-message.js` does not exist

**Step 3: Write minimal implementation**

Create `src/gateway/processing-message.ts`:

```typescript
/**
 * Processing Message Accumulator
 * ==============================
 *
 * Consumes StreamEvent objects from streamAgentTurn() and periodically
 * flushes formatted intermediate output to an adapter's processing message.
 *
 * The accumulator creates a single message on first flush, then updates it
 * on subsequent flushes. Text deltas and tool calls are interleaved in the
 * output, matching the terminal streaming display style.
 */

import type { StreamEvent } from "../core/agent-runner.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("processing-message");

/** Max content length before truncation (conservative for both platforms). */
const MAX_CONTENT_LENGTH = 4000;

// ---------------------------------------------------------------------------
// Tool input formatting (mirrors terminal/stream-render.ts)
// ---------------------------------------------------------------------------

export function formatToolInput(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const MAX_CMD_LEN = 60;

  switch (toolName) {
    case "Bash": {
      const cmd = input.command as string | undefined;
      if (!cmd) return toolName;
      const truncated =
        cmd.length > MAX_CMD_LEN ? cmd.slice(0, MAX_CMD_LEN) + "..." : cmd;
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

// ---------------------------------------------------------------------------
// Accumulator types
// ---------------------------------------------------------------------------

interface AdapterProcessingMethods {
  createProcessingMessage(
    sourceId: string,
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<string>;
  updateProcessingMessage(
    sourceId: string,
    messageId: string,
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
}

export interface ProcessingMessageAccumulator {
  /** Feed a stream event into the accumulator. */
  handleEvent(event: StreamEvent): void;
  /** Start the periodic flush timer. */
  start(): void;
  /** Stop timer and do a final flush if needed. */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ProcessingMessageAccumulator that buffers StreamEvents and
 * periodically flushes them to an adapter's processing message.
 */
export function createProcessingAccumulator(
  adapter: AdapterProcessingMethods,
  sourceId: string,
  metadata: Record<string, unknown> | undefined,
  intervalMs: number,
): ProcessingMessageAccumulator {
  // Content that has been flushed already
  let flushedContent = "";
  // Lines buffered since last flush
  const buffer: string[] = [];
  // Platform message ID (set after first flush)
  let messageId: string | null = null;
  // Timer handle
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  // Latest elapsed seconds from tool_progress
  let lastElapsedSeconds = 0;
  // Whether we're currently inside a tool (for formatting)
  let currentToolName: string | null = null;
  // Track if a flush is in progress to avoid concurrent flushes
  let flushing = false;

  function truncateContent(content: string): string {
    if (content.length <= MAX_CONTENT_LENGTH) return content;
    // Drop from the top, keep the most recent content
    const truncated = content.slice(content.length - MAX_CONTENT_LENGTH + 40);
    const firstNewline = truncated.indexOf("\n");
    const cleanStart = firstNewline !== -1 ? truncated.slice(firstNewline + 1) : truncated;
    return `[...earlier output truncated...]\n${cleanStart}`;
  }

  async function flush(): Promise<void> {
    if (flushing) return;
    if (buffer.length === 0 && lastElapsedSeconds === 0) return;

    flushing = true;
    try {
      // Build the new content from buffer
      const newContent = buffer.join("");
      buffer.length = 0;

      // Append to flushed content
      flushedContent += newContent;

      // Add elapsed time indicator if tools are running
      let displayContent = flushedContent;
      if (lastElapsedSeconds > 0) {
        displayContent += `\n\n\u23f3 Processing... (${lastElapsedSeconds}s)`;
      }

      displayContent = truncateContent(displayContent);

      if (!messageId) {
        // First flush — create the processing message
        messageId = await adapter.createProcessingMessage(
          sourceId,
          displayContent,
          metadata,
        );
        log.debug({ messageId, sourceId }, "created processing message");
      } else {
        // Subsequent flushes — update existing message
        await adapter.updateProcessingMessage(
          sourceId,
          messageId,
          displayContent,
          metadata,
        );
        log.debug({ messageId, sourceId }, "updated processing message");
      }
    } catch (err) {
      log.error({ err, sourceId, messageId }, "failed to flush processing message");
    } finally {
      flushing = false;
    }
  }

  return {
    handleEvent(event: StreamEvent): void {
      switch (event.type) {
        case "tool_start":
          currentToolName = event.toolName;
          buffer.push(`\n\ud83d\udd27 ${event.toolName}`);
          break;
        case "tool_input":
          if (currentToolName === event.toolName) {
            // Replace the last tool line with formatted input
            const lastIdx = buffer.length - 1;
            if (lastIdx >= 0 && buffer[lastIdx].includes(event.toolName)) {
              buffer[lastIdx] = `\n\ud83d\udd27 ${formatToolInput(event.toolName, event.input)}`;
            }
          }
          break;
        case "text_delta":
          buffer.push(event.text);
          break;
        case "tool_progress":
          lastElapsedSeconds = event.elapsedSeconds;
          break;
        case "result":
        case "error":
          // Ignored — handled by the queue
          break;
      }
    },

    start(): void {
      intervalHandle = setInterval(() => {
        void flush();
      }, intervalMs);
    },

    async stop(): Promise<void> {
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
      // Final flush
      await flush();
    },
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/gateway/processing-message.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/gateway/processing-message.ts src/gateway/processing-message.test.ts
git commit -m "feat: create ProcessingMessageAccumulator for streaming to adapters"
```

---

### Task 7: Integrate Streaming into Gateway Queue

**Files:**
- Modify: `src/gateway/queue.ts` (switch to streamAgentTurn for capable adapters)
- Modify: `src/gateway/queue.test.ts` (add streaming integration tests)

**Step 1: Write failing tests**

In `src/gateway/queue.test.ts`, update mocks. First, add `streamAgentTurn` to the agent-runner mock:

```typescript
vi.mock("../core/agent-runner.js", () => ({
  runAgentTurn: vi.fn(),
  streamAgentTurn: vi.fn(),
  clearSdkSession: vi.fn(),
}));
```

Update the import:

```typescript
import { runAgentTurn, streamAgentTurn } from "../core/agent-runner.js";
import type { AgentOptions, AgentTurnResult, StreamEvent } from "../core/agent-runner.js";
```

Also mock the processing-message module:

```typescript
vi.mock("./processing-message.js", () => ({
  createProcessingAccumulator: vi.fn(),
}));
```

And import it:

```typescript
import { createProcessingAccumulator } from "./processing-message.js";
```

Add a helper to create an adapter with processing message support:

```typescript
function makeStreamingAdapter(name: string) {
  return {
    name,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendResponse: vi.fn().mockResolvedValue(undefined),
    createProcessingMessage: vi.fn().mockResolvedValue("proc-msg-1"),
    updateProcessingMessage: vi.fn().mockResolvedValue(undefined),
  };
}
```

Add a helper to create a mock async generator:

```typescript
async function* mockStreamGenerator(
  events: StreamEvent[],
): AsyncGenerator<StreamEvent> {
  for (const event of events) {
    yield event;
  }
}
```

Then add a new describe block inside the MessageQueue describe:

```typescript
describe("streaming with processing messages", () => {
  it("uses streamAgentTurn when adapter supports processing messages", async () => {
    const config = makeConfig();
    const agentOptions = makeAgentOptions();
    const router = createRouter();
    const adapter = makeStreamingAdapter("telegram");
    router.register(adapter);

    const mockAcc = {
      handleEvent: vi.fn(),
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createProcessingAccumulator).mockReturnValue(mockAcc);

    const events: StreamEvent[] = [
      { type: "tool_start", toolName: "Glob" },
      { type: "text_delta", text: "Found files" },
      {
        type: "result",
        response: "Here are the files",
        messages: [],
        partial: false,
      },
    ];
    vi.mocked(streamAgentTurn).mockReturnValue(mockStreamGenerator(events));

    const queue = createMessageQueue(config);
    queue.enqueue(makeMessage({ source: "telegram", sourceId: "123456" }));

    await queue.processNext(agentOptions, config, router);

    expect(streamAgentTurn).toHaveBeenCalled();
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(mockAcc.start).toHaveBeenCalled();
    expect(mockAcc.handleEvent).toHaveBeenCalledTimes(3);
    expect(mockAcc.stop).toHaveBeenCalled();
    // Final response sent as new message
    expect(adapter.sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Here are the files",
      }),
    );
  });

  it("falls back to runAgentTurn when adapter lacks processing methods", async () => {
    const config = makeConfig();
    const agentOptions = makeAgentOptions();
    const router = createRouter();
    const adapter = makeAdapter("telegram"); // No processing methods
    router.register(adapter);

    vi.mocked(runAgentTurn).mockResolvedValue({
      response: "reply",
      messages: [],
      partial: false,
    });

    const queue = createMessageQueue(config);
    queue.enqueue(makeMessage({ source: "telegram", sourceId: "123456" }));

    await queue.processNext(agentOptions, config, router);

    expect(runAgentTurn).toHaveBeenCalled();
    expect(streamAgentTurn).not.toHaveBeenCalled();
  });

  it("always uses runAgentTurn for heartbeat messages", async () => {
    const config = makeConfig({
      heartbeat: {
        enabled: true,
        intervalMinutes: 30,
        activeHours: "8-21",
        deliverTo: "last" as const,
      },
    });
    const agentOptions = makeAgentOptions();
    const router = createRouter();
    const adapter = makeStreamingAdapter("telegram");
    router.register(adapter);

    // Establish last adapter
    vi.mocked(streamAgentTurn).mockReturnValue(
      mockStreamGenerator([
        { type: "result", response: "ok", messages: [], partial: false },
      ]),
    );
    const mockAcc = {
      handleEvent: vi.fn(),
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createProcessingAccumulator).mockReturnValue(mockAcc);

    const queue = createMessageQueue(config);
    queue.enqueue(makeMessage({ source: "telegram", sourceId: "42", text: "hi" }));
    await queue.processNext(agentOptions, config, router);

    vi.clearAllMocks();
    vi.mocked(runAgentTurn).mockResolvedValue({
      response: "HEARTBEAT_OK",
      messages: [],
      partial: false,
    });

    queue.enqueue({
      source: "heartbeat",
      sourceId: "last",
      text: "heartbeat prompt",
    });
    await queue.processNext(agentOptions, config, router);

    expect(runAgentTurn).toHaveBeenCalled();
    expect(streamAgentTurn).not.toHaveBeenCalled();
  });

  it("sends error response when streamAgentTurn yields error event", async () => {
    const config = makeConfig();
    const agentOptions = makeAgentOptions();
    const router = createRouter();
    const adapter = makeStreamingAdapter("telegram");
    router.register(adapter);

    const mockAcc = {
      handleEvent: vi.fn(),
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createProcessingAccumulator).mockReturnValue(mockAcc);

    const events: StreamEvent[] = [
      { type: "error", error: "Something went wrong" },
    ];
    vi.mocked(streamAgentTurn).mockReturnValue(mockStreamGenerator(events));

    const queue = createMessageQueue(config);
    queue.enqueue(makeMessage({ source: "telegram", sourceId: "123456" }));

    await queue.processNext(agentOptions, config, router);

    expect(adapter.sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("something went wrong"),
      }),
    );
  });

  it("passes processingUpdateIntervalMs from config to accumulator", async () => {
    const config = makeConfig({
      gateway: { maxQueueSize: 5, processingUpdateIntervalMs: 3000 },
    });
    const agentOptions = makeAgentOptions();
    const router = createRouter();
    const adapter = makeStreamingAdapter("telegram");
    router.register(adapter);

    const mockAcc = {
      handleEvent: vi.fn(),
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createProcessingAccumulator).mockReturnValue(mockAcc);

    vi.mocked(streamAgentTurn).mockReturnValue(
      mockStreamGenerator([
        { type: "result", response: "ok", messages: [], partial: false },
      ]),
    );

    const queue = createMessageQueue(config);
    queue.enqueue(makeMessage({ source: "telegram", sourceId: "123456" }));

    await queue.processNext(agentOptions, config, router);

    expect(createProcessingAccumulator).toHaveBeenCalledWith(
      expect.any(Object),
      "123456",
      undefined,
      3000,
    );
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/gateway/queue.test.ts`
Expected: FAIL — queue still uses `runAgentTurn` for everything

**Step 3: Write minimal implementation**

In `src/gateway/queue.ts`, update imports:

```typescript
import { runAgentTurn, streamAgentTurn, clearSdkSession } from "../core/agent-runner.js";
import type { AgentOptions, AgentTurnResult, StreamEvent } from "../core/agent-runner.js";
import type { Router } from "./router.js";
import { createProcessingAccumulator } from "./processing-message.js";
```

Replace the try block inside `processNext()` (lines 149–201) with:

```typescript
try {
  const routeTarget = resolveRouteTarget(message, config);
  const targetAdapter = routeTarget ? router.getAdapter(routeTarget.source) : undefined;
  const supportsProcessing =
    message.source !== "heartbeat" &&
    targetAdapter?.createProcessingMessage != null &&
    targetAdapter?.updateProcessingMessage != null;

  let responseText: string;
  let partial = false;

  if (supportsProcessing && routeTarget) {
    // Streaming path with processing message
    const accumulator = createProcessingAccumulator(
      targetAdapter as Required<Pick<typeof targetAdapter, "createProcessingMessage" | "updateProcessingMessage">>,
      routeTarget.sourceId,
      message.metadata,
      config.gateway.processingUpdateIntervalMs,
    );
    accumulator.start();

    let resultEvent: { response: string; messages: unknown[]; partial: boolean } | undefined;

    for await (const event of streamAgentTurn(message.text, sessionKey, agentOptions, config)) {
      accumulator.handleEvent(event);
      if (event.type === "result") {
        resultEvent = event;
      }
    }

    await accumulator.stop();

    responseText = resultEvent?.response ?? "";
    partial = resultEvent?.partial ?? false;
  } else {
    // Non-streaming fallback
    const result: AgentTurnResult = await runAgentTurn(
      message.text,
      sessionKey,
      agentOptions,
      config,
    );
    responseText = result.response;
    partial = result.partial;
  }

  if (partial) {
    responseText += "\n\n[Note: This response may be incomplete due to an internal interruption.]";
  }

  // Route the response back to the source adapter
  if (responseText.trim()) {
    if (message.source === "heartbeat" && isHeartbeatOk(responseText)) {
      log.debug({ sessionKey }, "heartbeat OK, no notification needed");
    } else {
      const routeTarget2 = resolveRouteTarget(message, config);
      if (routeTarget2) {
        const response: AdapterMessage = {
          source: routeTarget2.source,
          sourceId: routeTarget2.sourceId,
          text: responseText,
          metadata: message.metadata,
        };
        await router.route(response);
      } else {
        log.warn(
          { deliverTo: config.heartbeat.deliverTo },
          "no adapter target for heartbeat, dropping response",
        );
      }
    }
  } else {
    log.warn({ source: message.source, sessionKey }, "agent returned empty response");
    const emptyTarget = resolveRouteTarget(message, config);
    if (emptyTarget) {
      try {
        await router.route({
          source: emptyTarget.source,
          sourceId: emptyTarget.sourceId,
          text: "I processed your message but had nothing to respond with. Could you try rephrasing?",
          metadata: message.metadata,
        });
      } catch (routeErr) {
        log.error({ err: routeErr }, "failed to send empty-response notice");
      }
    }
  }
} catch (err) {
  // ... existing error handling (unchanged) ...
}
```

Note: The `routeTarget` is resolved once at the top of the try block for the streaming check, and reused for the final response routing. Avoid calling `resolveRouteTarget` redundantly — you can hoist it above the `supportsProcessing` check and reuse it later.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/gateway/queue.test.ts`
Expected: PASS

**Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: All PASS

**Step 6: Commit**

```bash
git add src/gateway/queue.ts src/gateway/queue.test.ts
git commit -m "feat: integrate streaming processing messages into gateway queue"
```

---

### Task 8: Full Integration Verification

**Step 1: Run the complete test suite**

Run: `npx vitest run`
Expected: All PASS

**Step 2: Run test coverage**

Run: `npm run test:coverage`
Expected: Coverage meets the 70% threshold

**Step 3: Build the project**

Run: `npm run build`
Expected: Clean compilation with no TypeScript errors

**Step 4: Commit any final fixes needed**

If any tests or build issues arise, fix and commit.

---

### Task 9: Update Documentation

**Files:**
- Modify: `CLAUDE.md` — mention the streaming processing message feature in the Architecture/Message Flow section

**Step 1: Add a brief note to CLAUDE.md**

In the Message Flow section, update the diagram/description to mention that daemon mode now uses streaming for adapters with processing message support. Keep it concise — one or two sentences.

**Step 2: Move design doc to completed**

```bash
mv docs/plans/active/2026-02-27-streaming-processing-messages-design.md docs/plans/completed/
```

**Step 3: Commit**

```bash
git add CLAUDE.md docs/plans/
git commit -m "docs: document streaming processing messages feature"
```
