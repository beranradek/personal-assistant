import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Use vi.hoisted so the mock factory can reference these
const { makeMockThread, makeMockThreadWithEvents, mockStartThread, mockResumeThread, capturedCodexOptions } = vi.hoisted(() => {
  /** Captured options passed to the Codex constructor (last call wins). */
  const capturedCodexOptions: { value: Record<string, unknown> | undefined } = { value: undefined };
  /**
   * Creates a mock thread that yields a simple agent_message on both
   * runStreamed (async generator) and run (sync).
   */
  function makeMockThread(id: string, text: string) {
    return {
      id,
      runStreamed: vi.fn().mockResolvedValue({
        events: (async function* () {
          yield { type: "thread.started", thread_id: id };
          yield {
            type: "item.completed",
            item: { type: "agent_message", text },
          };
          yield { type: "turn.completed", usage: null };
        })(),
      }),
      run: vi.fn().mockResolvedValue({
        items: [{ type: "agent_message", text }],
        finalResponse: text,
        usage: null,
      }),
    };
  }

  /**
   * Creates a mock thread that yields a custom sequence of ThreadEvents
   * during runStreamed. The run() path returns a simple finalResponse.
   */
  function makeMockThreadWithEvents(
    id: string,
    events: Array<Record<string, unknown>>,
    finalResponse = "",
  ) {
    return {
      id,
      runStreamed: vi.fn().mockResolvedValue({
        events: (async function* () {
          for (const event of events) {
            yield event;
          }
        })(),
      }),
      run: vi.fn().mockResolvedValue({
        items: [{ type: "agent_message", text: finalResponse }],
        finalResponse,
        usage: null,
      }),
    };
  }

  const mockStartThread = vi.fn();
  const mockResumeThread = vi.fn();

  return { makeMockThread, makeMockThreadWithEvents, mockStartThread, mockResumeThread, capturedCodexOptions };
});

vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    constructor(opts?: Record<string, unknown>) {
      capturedCodexOptions.value = opts;
    }
    startThread = mockStartThread;
    resumeThread = mockResumeThread;
  },
}));

// Mock session/audit dependencies
vi.mock("../session/manager.js", () => ({
  saveInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../memory/daily-log.js", () => ({
  appendAuditEntry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../memory/files.js", () => ({
  readMemoryFiles: vi.fn().mockResolvedValue("Memory content here"),
}));

import { createCodexBackend } from "./codex.js";
import { DEFAULTS } from "../core/config.js";
import type { Config } from "../core/types.js";

function makeConfig(overrides?: Partial<Config>): Config {
  const { security: securityOverrides, ...restOverrides } = overrides ?? {};
  return {
    ...DEFAULTS,
    security: {
      ...DEFAULTS.security,
      workspace: "/tmp/workspace",
      dataDir: "/tmp/data",
      ...(securityOverrides ?? {}),
    },
    ...restOverrides,
  } as Config;
}

/** Helper to consume all events from a streaming turn. */
async function collectEvents(gen: AsyncGenerator<unknown>) {
  const events: Array<Record<string, unknown>> = [];
  for await (const event of gen) {
    events.push(event as Record<string, unknown>);
  }
  return events;
}

describe("createCodexBackend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartThread.mockReturnValue(makeMockThread("thread-123", "Hello from Codex"));
    mockResumeThread.mockReturnValue(makeMockThread("thread-123", "Resumed response"));
  });

  it("returns a backend with name 'codex'", async () => {
    const backend = await createCodexBackend(makeConfig());
    expect(backend.name).toBe("codex");
  });

  it("enables multi_agent feature flag by default", async () => {
    await createCodexBackend(makeConfig());
    const config = capturedCodexOptions.value?.config as Record<string, unknown>;
    expect((config.features as Record<string, unknown>).multi_agent).toBe(true);
  });

  it("preserves user feature flag overrides over multi_agent default", async () => {
    const cfg = makeConfig({
      codex: {
        ...DEFAULTS.codex,
        configOverrides: { features: { multi_agent: false, custom_flag: true } },
      },
    } as Partial<Config>);
    await createCodexBackend(cfg);
    const config = capturedCodexOptions.value?.config as Record<string, unknown>;
    const features = config.features as Record<string, unknown>;
    expect(features.multi_agent).toBe(false);
    expect(features.custom_flag).toBe(true);
  });

  it("injects config.mcpServers into Codex mcp_servers", async () => {
    const cfg = makeConfig({
      mcpServers: {
        "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
      },
    } as Partial<Config>);

    await createCodexBackend(cfg);

    const config = capturedCodexOptions.value?.config as Record<string, unknown>;
    const mcpServers = config.mcp_servers as Record<string, unknown>;

    expect(mcpServers).toHaveProperty("personal-assistant");
    expect(mcpServers).toHaveProperty("chrome-devtools");
  });


  it("has runTurn, runTurnSync, clearSession methods", async () => {
    const backend = await createCodexBackend(makeConfig());
    expect(typeof backend.runTurn).toBe("function");
    expect(typeof backend.runTurnSync).toBe("function");
    expect(typeof backend.clearSession).toBe("function");
  });

  it("runTurn yields stream events and a final result", async () => {
    const backend = await createCodexBackend(makeConfig());
    const events = await collectEvents(backend.runTurn("hello", "test--session"));
    const textEvents = events.filter((e) => e.type === "text_delta");
    const resultEvents = events.filter((e) => e.type === "result");
    expect(textEvents.length).toBeGreaterThan(0);
    expect(resultEvents.length).toBe(1);
    expect(resultEvents[0].type === "result" && resultEvents[0].response).toBe("Hello from Codex");
  });

  it("runTurnSync returns response text", async () => {
    const backend = await createCodexBackend(makeConfig());
    const result = await backend.runTurnSync("hello", "test--session");
    expect(result.response).toBe("Hello from Codex");
    expect(result.partial).toBe(false);
  });

  it("clearSession removes thread mapping", async () => {
    const backend = await createCodexBackend(makeConfig());
    await collectEvents(backend.runTurn("hello", "test--session"));
    backend.clearSession("test--session");
  });

  it("maps command_execution items to tool events", async () => {
    mockStartThread.mockReturnValue({
      id: "thread-cmd",
      runStreamed: vi.fn().mockResolvedValue({
        events: (async function* () {
          yield { type: "thread.started", thread_id: "thread-cmd" };
          yield {
            type: "item.started",
            item: { type: "command_execution", command: "ls -la" },
          };
          yield {
            type: "item.completed",
            item: {
              type: "command_execution",
              command: "ls -la",
              exit_code: 0,
              aggregated_output: "file1\nfile2",
            },
          };
          yield {
            type: "item.completed",
            item: { type: "agent_message", text: "Done" },
          };
          yield { type: "turn.completed", usage: null };
        })(),
      }),
    });

    const backend = await createCodexBackend(makeConfig());
    const events = await collectEvents(backend.runTurn("list files", "test--cmd"));
    const toolStarts = events.filter((e) => e.type === "tool_start");
    expect(toolStarts.length).toBeGreaterThan(0);
    expect(toolStarts[0].type === "tool_start" && toolStarts[0].toolName).toBe("command_execution");
  });

  // -----------------------------------------------------------------------
  // S2: Thread resume path
  // -----------------------------------------------------------------------

  describe("thread resume (S2)", () => {
    it("uses startThread on first turn, resumeThread on second, startThread again after clearSession", async () => {
      const backend = await createCodexBackend(makeConfig());
      const sessionKey = "test--resume";

      // Turn 1: should call startThread (no existing thread)
      await collectEvents(backend.runTurn("first message", sessionKey));
      expect(mockStartThread).toHaveBeenCalledTimes(1);
      expect(mockResumeThread).not.toHaveBeenCalled();

      // Reset to provide fresh async generators
      mockStartThread.mockReturnValue(makeMockThread("thread-123", "Fresh start"));
      mockResumeThread.mockReturnValue(makeMockThread("thread-123", "Resumed again"));

      // Turn 2: should call resumeThread (thread-123 exists)
      await collectEvents(backend.runTurn("second message", sessionKey));
      expect(mockResumeThread).toHaveBeenCalledTimes(1);
      // startThread should NOT have been called again
      expect(mockStartThread).toHaveBeenCalledTimes(1);

      // Clear session
      backend.clearSession(sessionKey);

      // Reset mocks for turn 3
      mockStartThread.mockReturnValue(makeMockThread("thread-456", "New thread"));
      vi.clearAllMocks();

      // Turn 3: should call startThread again (session was cleared)
      await collectEvents(backend.runTurn("third message", sessionKey));
      expect(mockStartThread).toHaveBeenCalledTimes(1);
      expect(mockResumeThread).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Thread resume failure recovery
  // -----------------------------------------------------------------------

  describe("thread resume failure recovery", () => {
    it("falls back to startThread when resumeThread throws", async () => {
      const backend = await createCodexBackend(makeConfig());
      const sessionKey = "test--resume-fail";

      // Turn 1: establish a thread
      await collectEvents(backend.runTurn("establish thread", sessionKey));
      expect(mockStartThread).toHaveBeenCalledTimes(1);

      // Set up resumeThread to throw on next call
      mockResumeThread.mockImplementation(() => {
        throw new Error("Resume failed: thread expired");
      });
      mockStartThread.mockReturnValue(makeMockThread("thread-fallback", "Fallback response"));

      // Turn 2: resumeThread throws, should fall back to startThread
      const events = await collectEvents(backend.runTurn("after failure", sessionKey));
      expect(mockResumeThread).toHaveBeenCalledTimes(1);
      // startThread should have been called again as fallback (1 from turn 1 + 1 from fallback)
      expect(mockStartThread).toHaveBeenCalledTimes(2);

      // Verify the turn still succeeded with a result event
      const resultEvent = events.find((e) => e.type === "result");
      expect(resultEvent).toBeDefined();
      expect(resultEvent?.response).toBe("Fallback response");
    });
  });

  // -----------------------------------------------------------------------
  // C1: MCP tool call event mapping
  // -----------------------------------------------------------------------

  describe("MCP tool call event mapping (C1)", () => {
    it("maps mcp_tool_call with server/tool to mcp:<server>/<tool> toolName", async () => {
      mockStartThread.mockReturnValue(
        makeMockThreadWithEvents("thread-mcp", [
          { type: "thread.started", thread_id: "thread-mcp" },
          {
            type: "item.started",
            item: {
              id: "mcp-1",
              type: "mcp_tool_call",
              server: "personal-assistant",
              tool: "memory_search",
              arguments: { query: "test" },
              status: "in_progress",
            },
          },
          {
            type: "item.completed",
            item: {
              id: "mcp-1",
              type: "mcp_tool_call",
              server: "personal-assistant",
              tool: "memory_search",
              arguments: { query: "test" },
              status: "completed",
              result: { structured_content: "some results" },
            },
          },
          {
            type: "item.completed",
            item: { type: "agent_message", text: "Found results" },
          },
          { type: "turn.completed", usage: null },
        ], "Found results"),
      );

      const backend = await createCodexBackend(makeConfig());
      const events = await collectEvents(backend.runTurn("search memory", "test--mcp"));

      const toolStarts = events.filter((e) => e.type === "tool_start");
      expect(toolStarts).toHaveLength(1);
      expect(toolStarts[0].toolName).toBe("mcp:personal-assistant/memory_search");

      const toolInputs = events.filter((e) => e.type === "tool_input");
      const mcpInput = toolInputs.find((e) => e.toolName === "mcp:personal-assistant/memory_search");
      expect(mcpInput).toBeDefined();
      expect((mcpInput?.input as Record<string, unknown>)?.arguments).toEqual({ query: "test" });
    });
  });

  // -----------------------------------------------------------------------
  // I1: Error event handling
  // -----------------------------------------------------------------------

  describe("error event handling (I1)", () => {
    it("yields error event from turn.failed with error.message", async () => {
      mockStartThread.mockReturnValue(
        makeMockThreadWithEvents("thread-fail", [
          { type: "thread.started", thread_id: "thread-fail" },
          {
            type: "turn.failed",
            error: { message: "Something went wrong" },
          },
        ]),
      );

      const backend = await createCodexBackend(makeConfig());
      const events = await collectEvents(backend.runTurn("fail me", "test--fail"));

      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].error).toBe("Something went wrong");
    });

    it("yields 'Turn failed' when turn.failed has no error message", async () => {
      mockStartThread.mockReturnValue(
        makeMockThreadWithEvents("thread-fail2", [
          { type: "thread.started", thread_id: "thread-fail2" },
          {
            type: "turn.failed",
            error: undefined,
          },
        ]),
      );

      const backend = await createCodexBackend(makeConfig());
      const events = await collectEvents(backend.runTurn("fail again", "test--fail2"));

      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].error).toBe("Turn failed");
    });

    it("yields error event from thread error event", async () => {
      mockStartThread.mockReturnValue(
        makeMockThreadWithEvents("thread-err", [
          { type: "thread.started", thread_id: "thread-err" },
          {
            type: "error",
            message: "Connection lost",
          },
        ]),
      );

      const backend = await createCodexBackend(makeConfig());
      const events = await collectEvents(backend.runTurn("error me", "test--err"));

      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].error).toBe("Connection lost");
    });
  });

  // -----------------------------------------------------------------------
  // file_change event mapping
  // -----------------------------------------------------------------------

  describe("file_change event mapping", () => {
    it("maps file_change item to tool_start and tool_input with formatted changes", async () => {
      mockStartThread.mockReturnValue(
        makeMockThreadWithEvents("thread-fc", [
          { type: "thread.started", thread_id: "thread-fc" },
          {
            type: "item.started",
            item: {
              id: "fc-1",
              type: "file_change",
              changes: [{ path: "foo.ts", kind: "update" }],
              status: "in_progress",
            },
          },
          {
            type: "item.completed",
            item: {
              id: "fc-1",
              type: "file_change",
              changes: [{ path: "foo.ts", kind: "update" }],
              status: "completed",
            },
          },
          {
            type: "item.completed",
            item: { type: "agent_message", text: "Updated file" },
          },
          { type: "turn.completed", usage: null },
        ], "Updated file"),
      );

      const backend = await createCodexBackend(makeConfig());
      const events = await collectEvents(backend.runTurn("update file", "test--fc"));

      const toolStarts = events.filter((e) => e.type === "tool_start");
      expect(toolStarts).toHaveLength(1);
      expect(toolStarts[0].toolName).toBe("file_change");

      const toolInputs = events.filter((e) => e.type === "tool_input" && e.toolName === "file_change");
      expect(toolInputs).toHaveLength(1);
      expect((toolInputs[0].input as Record<string, unknown>).changes).toBe("update foo.ts");
    });

    it("formats multiple file changes with comma separation", async () => {
      mockStartThread.mockReturnValue(
        makeMockThreadWithEvents("thread-fc2", [
          { type: "thread.started", thread_id: "thread-fc2" },
          {
            type: "item.completed",
            item: {
              id: "fc-2",
              type: "file_change",
              changes: [
                { path: "a.ts", kind: "create" },
                { path: "b.ts", kind: "delete" },
              ],
              status: "completed",
            },
          },
          { type: "turn.completed", usage: null },
        ]),
      );

      const backend = await createCodexBackend(makeConfig());
      const events = await collectEvents(backend.runTurn("multi change", "test--fc2"));

      const toolInputs = events.filter((e) => e.type === "tool_input" && e.toolName === "file_change");
      expect(toolInputs).toHaveLength(1);
      expect((toolInputs[0].input as Record<string, unknown>).changes).toBe("create a.ts, delete b.ts");
    });
  });

  // -----------------------------------------------------------------------
  // S4: reasoning and todo_list event mapping
  // -----------------------------------------------------------------------

  describe("reasoning and todo_list event mapping (S4)", () => {
    it("maps reasoning items to text_delta events", async () => {
      mockStartThread.mockReturnValue(
        makeMockThreadWithEvents("thread-reason", [
          { type: "thread.started", thread_id: "thread-reason" },
          {
            type: "item.started",
            item: { id: "r-1", type: "reasoning", text: "" },
          },
          {
            type: "item.completed",
            item: { id: "r-1", type: "reasoning", text: "Let me think about this..." },
          },
          {
            type: "item.completed",
            item: { type: "agent_message", text: "The answer is 42" },
          },
          { type: "turn.completed", usage: null },
        ], "The answer is 42"),
      );

      const backend = await createCodexBackend(makeConfig());
      const events = await collectEvents(backend.runTurn("think", "test--reason"));

      // item.started for reasoning should yield tool_start
      const toolStarts = events.filter((e) => e.type === "tool_start" && e.toolName === "reasoning");
      expect(toolStarts).toHaveLength(1);

      // item.completed for reasoning should yield text_delta with reasoning text
      const textDeltas = events.filter((e) => e.type === "text_delta");
      const reasoningDelta = textDeltas.find((e) => e.text === "Let me think about this...\n\n");
      expect(reasoningDelta).toBeDefined();
    });

    it("maps todo_list items to tool_start and tool_input events", async () => {
      mockStartThread.mockReturnValue(
        makeMockThreadWithEvents("thread-todo", [
          { type: "thread.started", thread_id: "thread-todo" },
          {
            type: "item.started",
            item: {
              id: "tl-1",
              type: "todo_list",
              items: [],
            },
          },
          {
            type: "item.completed",
            item: {
              id: "tl-1",
              type: "todo_list",
              items: [
                { text: "Fix bug", completed: true },
                { text: "Write tests", completed: false },
              ],
            },
          },
          { type: "turn.completed", usage: null },
        ]),
      );

      const backend = await createCodexBackend(makeConfig());
      const events = await collectEvents(backend.runTurn("plan", "test--todo"));

      const toolStarts = events.filter((e) => e.type === "tool_start" && e.toolName === "todo_list");
      expect(toolStarts).toHaveLength(1);

      const toolInputs = events.filter((e) => e.type === "tool_input" && e.toolName === "todo_list");
      expect(toolInputs).toHaveLength(1);
      const input = toolInputs[0].input as Record<string, unknown>;
      expect(input.items).toBe("[x] Fix bug\n[ ] Write tests");
    });
  });

  // -----------------------------------------------------------------------
  // runTurnSync with thread resume (S2)
  // -----------------------------------------------------------------------

  describe("runTurnSync with thread resume", () => {
    it("uses startThread on first sync turn and resumeThread on second", async () => {
      const backend = await createCodexBackend(makeConfig());
      const sessionKey = "test--sync-resume";

      // Turn 1: should call startThread
      const result1 = await backend.runTurnSync("first sync", sessionKey);
      expect(result1.response).toBe("Hello from Codex");
      expect(mockStartThread).toHaveBeenCalledTimes(1);
      expect(mockResumeThread).not.toHaveBeenCalled();

      // Reset to provide fresh run() mocks
      mockStartThread.mockReturnValue(makeMockThread("thread-123", "Fresh sync"));
      mockResumeThread.mockReturnValue(makeMockThread("thread-123", "Resumed sync"));

      // Turn 2: should call resumeThread
      const result2 = await backend.runTurnSync("second sync", sessionKey);
      expect(result2.response).toBe("Resumed sync");
      expect(mockResumeThread).toHaveBeenCalledTimes(1);
      expect(mockStartThread).toHaveBeenCalledTimes(1); // still only from turn 1
    });

    it("falls back to startThread in sync mode when resumeThread throws", async () => {
      const backend = await createCodexBackend(makeConfig());
      const sessionKey = "test--sync-fallback";

      // Establish a thread
      await backend.runTurnSync("establish", sessionKey);

      // Make resume fail
      mockResumeThread.mockImplementation(() => {
        throw new Error("Resume not available");
      });
      mockStartThread.mockReturnValue(makeMockThread("thread-new", "Fallback sync"));

      // Should fall back to startThread
      const result = await backend.runTurnSync("after fail", sessionKey);
      expect(result.response).toBe("Fallback sync");
      expect(mockResumeThread).toHaveBeenCalledTimes(1);
      // 1 from establish + 1 from fallback
      expect(mockStartThread).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // C2: tool_progress events during streaming
  // -----------------------------------------------------------------------

  describe("tool_progress events (C2)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("emits tool_progress events for long-running tool calls", async () => {
      // Create a thread where item.started is followed by a delay before item.completed.
      // We use a promise-based approach to control timing within the async generator.
      let resolveItemCompleted!: () => void;
      const itemCompletedPromise = new Promise<void>((resolve) => {
        resolveItemCompleted = resolve;
      });

      const mockThread = {
        id: "thread-progress",
        runStreamed: vi.fn().mockResolvedValue({
          events: (async function* () {
            yield { type: "thread.started", thread_id: "thread-progress" };
            yield {
              type: "item.started",
              item: { type: "command_execution", command: "long-task" },
            };
            // Wait for the test to advance timers before yielding completion
            await itemCompletedPromise;
            yield {
              type: "item.completed",
              item: {
                type: "command_execution",
                command: "long-task",
                exit_code: 0,
                aggregated_output: "done",
              },
            };
            yield {
              type: "item.completed",
              item: { type: "agent_message", text: "Task complete" },
            };
            yield { type: "turn.completed", usage: null };
          })(),
        }),
      };
      mockStartThread.mockReturnValue(mockThread);

      const backend = await createCodexBackend(makeConfig());
      const events: Array<Record<string, unknown>> = [];

      // Start consuming the generator but do so incrementally
      const gen = backend.runTurn("long task", "test--progress");

      // Consume events until the generator is paused waiting for itemCompletedPromise
      // We use a micro-task approach: read events that are immediately available
      const readAvailable = async () => {
        // Each next() call will resolve as events are yielded
        // The generator will pause at `await itemCompletedPromise`
        const result = await gen.next(); // thread.started -> no yield to us (switch default)
        // After thread.started, the next event is item.started which yields tool_start
        if (!result.done) events.push(result.value as Record<string, unknown>);
      };

      // Read the tool_start event
      await readAvailable();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("tool_start");

      // Now advance timers to trigger progress events
      // The startProgressTimer uses 1000ms intervals
      vi.advanceTimersByTime(2500);

      // Resolve the blocker so the generator can continue
      resolveItemCompleted();

      // Now consume remaining events
      for await (const event of gen) {
        events.push(event as Record<string, unknown>);
      }

      // Check that tool_progress events were emitted
      const progressEvents = events.filter((e) => e.type === "tool_progress");
      expect(progressEvents.length).toBeGreaterThanOrEqual(1);
      expect(progressEvents[0].toolName).toBe("command_execution");
      expect(typeof progressEvents[0].elapsedSeconds).toBe("number");

      // Verify the turn still completed with a result
      const resultEvent = events.find((e) => e.type === "result");
      expect(resultEvent).toBeDefined();
    });
  });
});
