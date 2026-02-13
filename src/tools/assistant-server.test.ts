import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock the SDK ────────────────────────────────────────────────────
// The SDK bundles native dependencies, so we mock it at the module level
// and capture calls to verify behaviour.

const mockCreateSdkMcpServer = vi.fn(
  (opts: { name: string; version?: string; tools?: unknown[] }) => ({
    type: "sdk" as const,
    name: opts.name,
    instance: {} as unknown,
    _tools: opts.tools,
  }),
);

const mockTool = vi.fn(
  (
    name: string,
    description: string,
    inputSchema: unknown,
    handler: (...args: unknown[]) => Promise<unknown>,
  ) => ({
    name,
    description,
    inputSchema,
    handler,
  }),
);

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  tool: mockTool,
}));

// Import *after* mock registration so the mock takes effect.
const { createAssistantServer } = await import("./assistant-server.js");
import type { AssistantServerDeps } from "./assistant-server.js";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeDeps(overrides?: Partial<AssistantServerDeps>): AssistantServerDeps {
  return {
    handleCronAction: vi.fn(async () => ({ success: true, message: "ok" })),
    handleExec: vi.fn(async () => ({ success: true, sessionId: "s1", output: "hello", exitCode: 0 })),
    getProcessSession: vi.fn(() => ({
      pid: 42,
      command: "echo hi",
      output: "hi\n",
      exitCode: 0,
      startedAt: "2025-01-01T00:00:00Z",
      exitedAt: "2025-01-01T00:00:01Z",
    })),
    listProcessSessions: vi.fn(() => [
      {
        id: "s1",
        session: {
          pid: 42,
          command: "echo hi",
          exitCode: 0,
          startedAt: "2025-01-01T00:00:00Z",
          exitedAt: "2025-01-01T00:00:01Z",
        },
      },
    ]),
    ...overrides,
  };
}

/** Helper to find a tool by name from the mockTool calls. */
function findToolByName(name: string) {
  const call = mockTool.mock.calls.find((c) => c[0] === name);
  if (!call) throw new Error(`Tool "${name}" not found in mockTool calls`);
  return {
    name: call[0] as string,
    description: call[1] as string,
    inputSchema: call[2] as Record<string, unknown>,
    handler: call[3] as (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("createAssistantServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Shape tests ---

  it("returns an object with type 'sdk'", () => {
    const server = createAssistantServer(makeDeps());
    expect(server).toHaveProperty("type", "sdk");
  });

  it("returns an object with name 'assistant'", () => {
    const server = createAssistantServer(makeDeps());
    expect(server).toHaveProperty("name", "assistant");
  });

  it("returns an object with an instance property", () => {
    const server = createAssistantServer(makeDeps());
    expect(server).toHaveProperty("instance");
  });

  // --- Tool registration ---

  it("registers exactly 3 tools via the tool() helper", () => {
    createAssistantServer(makeDeps());
    expect(mockTool).toHaveBeenCalledTimes(3);
  });

  it("exposes a 'cron' tool", () => {
    createAssistantServer(makeDeps());
    const toolNames = mockTool.mock.calls.map((c) => c[0]);
    expect(toolNames).toContain("cron");
  });

  it("exposes an 'exec' tool", () => {
    createAssistantServer(makeDeps());
    const toolNames = mockTool.mock.calls.map((c) => c[0]);
    expect(toolNames).toContain("exec");
  });

  it("exposes a 'process' tool", () => {
    createAssistantServer(makeDeps());
    const toolNames = mockTool.mock.calls.map((c) => c[0]);
    expect(toolNames).toContain("process");
  });

  it("passes all 3 tools to createSdkMcpServer in the tools array", () => {
    createAssistantServer(makeDeps());
    const serverOpts = mockCreateSdkMcpServer.mock.calls[0][0];
    expect(serverOpts.tools).toHaveLength(3);
  });

  // --- Cron tool ---

  describe("cron tool", () => {
    it("has a description mentioning scheduled or reminders or jobs", () => {
      createAssistantServer(makeDeps());
      const cronTool = findToolByName("cron");
      expect(cronTool.description.toLowerCase()).toMatch(/schedul|reminder|job/);
    });

    it("has action and params in its input schema", () => {
      createAssistantServer(makeDeps());
      const cronTool = findToolByName("cron");
      expect(cronTool.inputSchema).toHaveProperty("action");
      expect(cronTool.inputSchema).toHaveProperty("params");
    });

    it("delegates to handleCronAction with correct arguments", async () => {
      const deps = makeDeps();
      createAssistantServer(deps);
      const cronTool = findToolByName("cron");

      await cronTool.handler({ action: "add", params: { label: "test" } }, {});

      expect(deps.handleCronAction).toHaveBeenCalledOnce();
      expect(deps.handleCronAction).toHaveBeenCalledWith("add", { label: "test" });
    });

    it("passes empty object when params is omitted", async () => {
      const deps = makeDeps();
      createAssistantServer(deps);
      const cronTool = findToolByName("cron");

      await cronTool.handler({ action: "list" }, {});

      expect(deps.handleCronAction).toHaveBeenCalledWith("list", {});
    });

    it("returns result as JSON in content array", async () => {
      const deps = makeDeps({
        handleCronAction: vi.fn(async () => ({ success: true, message: "Job added", data: { id: "j1" } })),
      });
      createAssistantServer(deps);
      const cronTool = findToolByName("cron");

      const result = await cronTool.handler({ action: "add", params: { label: "test" } }, {});

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({ success: true, message: "Job added", data: { id: "j1" } });
    });
  });

  // --- Exec tool ---

  describe("exec tool", () => {
    it("has command in its input schema", () => {
      createAssistantServer(makeDeps());
      const execTool = findToolByName("exec");
      expect(execTool.inputSchema).toHaveProperty("command");
    });

    it("delegates to handleExec with correct arguments", async () => {
      const deps = makeDeps();
      createAssistantServer(deps);
      const execTool = findToolByName("exec");

      await execTool.handler({ command: "ls -la", background: true, yieldMs: 500 }, {});

      expect(deps.handleExec).toHaveBeenCalledOnce();
      expect(deps.handleExec).toHaveBeenCalledWith({
        command: "ls -la",
        background: true,
        yieldMs: 500,
      });
    });

    it("returns result as JSON in content array", async () => {
      const deps = makeDeps({
        handleExec: vi.fn(async () => ({ success: true, sessionId: "s2", output: "done", exitCode: 0 })),
      });
      createAssistantServer(deps);
      const execTool = findToolByName("exec");

      const result = await execTool.handler({ command: "echo done" }, {});

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({ success: true, sessionId: "s2", output: "done", exitCode: 0 });
    });
  });

  // --- Process tool ---

  describe("process tool", () => {
    it("has action and sessionId in its input schema", () => {
      createAssistantServer(makeDeps());
      const processTool = findToolByName("process");
      expect(processTool.inputSchema).toHaveProperty("action");
      expect(processTool.inputSchema).toHaveProperty("sessionId");
    });

    it("list action delegates to listProcessSessions", async () => {
      const deps = makeDeps();
      createAssistantServer(deps);
      const processTool = findToolByName("process");

      const result = await processTool.handler({ action: "list" }, {});

      expect(deps.listProcessSessions).toHaveBeenCalledOnce();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe("s1");
    });

    it("status action delegates to getProcessSession", async () => {
      const deps = makeDeps();
      createAssistantServer(deps);
      const processTool = findToolByName("process");

      const result = await processTool.handler({ action: "status", sessionId: "s1" }, {});

      expect(deps.getProcessSession).toHaveBeenCalledOnce();
      expect(deps.getProcessSession).toHaveBeenCalledWith("s1");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.pid).toBe(42);
    });

    it("status action returns error when session not found", async () => {
      const deps = makeDeps({
        getProcessSession: vi.fn(() => undefined),
      });
      createAssistantServer(deps);
      const processTool = findToolByName("process");

      const result = await processTool.handler({ action: "status", sessionId: "missing" }, {});

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({ error: "Session not found" });
    });

    it("status action without sessionId returns error", async () => {
      const deps = makeDeps();
      createAssistantServer(deps);
      const processTool = findToolByName("process");

      const result = await processTool.handler({ action: "status" }, {});

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveProperty("error");
    });
  });
});
