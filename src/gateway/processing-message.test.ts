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
      expect.stringContaining("Searching: **/*.ts"),
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

  it("accumulates text_delta events (flushed after tool_start)", async () => {
    const adapter = makeAdapter();
    const acc = createProcessingAccumulator(adapter, "123", undefined, 5000);
    acc.start();

    acc.handleEvent({ type: "text_delta", text: "Hello " });
    acc.handleEvent({ type: "text_delta", text: "world" });
    acc.handleEvent({ type: "tool_start", toolName: "Glob" });

    await vi.advanceTimersByTimeAsync(5000);

    expect(adapter.createProcessingMessage).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("Hello world"),
      undefined,
    );
  });

  it("does not flush when only text_delta events (no tools)", async () => {
    const adapter = makeAdapter();
    const acc = createProcessingAccumulator(adapter, "123", undefined, 5000);
    acc.start();

    acc.handleEvent({ type: "text_delta", text: "Hello " });
    acc.handleEvent({ type: "text_delta", text: "world" });

    await vi.advanceTimersByTimeAsync(5000);

    expect(adapter.createProcessingMessage).not.toHaveBeenCalled();

    await acc.stop();
    // Even stop() should not flush without tools
    expect(adapter.createProcessingMessage).not.toHaveBeenCalled();
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

    acc.handleEvent({ type: "tool_start", toolName: "Bash" });
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
