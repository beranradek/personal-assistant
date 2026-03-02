import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted so the mock factory can reference these
const { makeMockThread, mockStartThread, mockResumeThread } = vi.hoisted(() => {
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

  const mockStartThread = vi.fn();
  const mockResumeThread = vi.fn();

  return { makeMockThread, mockStartThread, mockResumeThread };
});

vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    constructor() {}
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
  return { ...DEFAULTS, ...overrides } as Config;
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

  it("has runTurn, runTurnSync, clearSession methods", async () => {
    const backend = await createCodexBackend(makeConfig());
    expect(typeof backend.runTurn).toBe("function");
    expect(typeof backend.runTurnSync).toBe("function");
    expect(typeof backend.clearSession).toBe("function");
  });

  it("runTurn yields stream events and a final result", async () => {
    const backend = await createCodexBackend(makeConfig());
    const events = [];
    for await (const event of backend.runTurn("hello", "test--session")) {
      events.push(event);
    }
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
    for await (const _ of backend.runTurn("hello", "test--session")) {
      // consume
    }
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
    const events = [];
    for await (const event of backend.runTurn("list files", "test--cmd")) {
      events.push(event);
    }
    const toolStarts = events.filter((e) => e.type === "tool_start");
    expect(toolStarts.length).toBeGreaterThan(0);
    expect(toolStarts[0].type === "tool_start" && toolStarts[0].toolName).toBe("command_execution");
  });
});
