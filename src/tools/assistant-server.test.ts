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
    handleHabitCheck: vi.fn(async () => ({ success: true, message: "ok" })),
    handleHabitStatus: vi.fn(async () => ({ pillars: [] })),
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
    annotations: (call[4] as { annotations?: Record<string, unknown> } | undefined)?.annotations,
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

  it("registers exactly 8 tools via the tool() helper", () => {
    createAssistantServer(makeDeps());
    expect(mockTool).toHaveBeenCalledTimes(8);
  });

  it("exposes distinct cron read and mutation tools", () => {
    createAssistantServer(makeDeps());
    const toolNames = mockTool.mock.calls.map((c) => c[0]);
    expect(toolNames).toEqual(expect.arrayContaining(["cron_list", "cron_create", "cron_update", "cron_remove"]));
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

  it("passes all 8 tools to createSdkMcpServer in the tools array", () => {
    createAssistantServer(makeDeps());
    const serverOpts = mockCreateSdkMcpServer.mock.calls[0][0];
    expect(serverOpts.tools).toHaveLength(8);
  });

  it("exposes a 'habit_check' tool", () => {
    createAssistantServer(makeDeps());
    const toolNames = mockTool.mock.calls.map((c) => c[0]);
    expect(toolNames).toContain("habit_check");
  });

  it("exposes a 'habit_status' tool", () => {
    createAssistantServer(makeDeps());
    const toolNames = mockTool.mock.calls.map((c) => c[0]);
    expect(toolNames).toContain("habit_status");
  });

  // --- Cron tools ---

  describe("cron tools", () => {
    it("marks cron_list as a read-only idempotent operation", () => {
      createAssistantServer(makeDeps());
      const cronList = findToolByName("cron_list");

      expect(cronList.description.toLowerCase()).toMatch(/schedul|reminder|job/);
      expect(cronList.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    });

    it("marks cron mutations with accurate annotations", () => {
      createAssistantServer(makeDeps());
      const expectedMutationAnnotations = {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      };

      expect(findToolByName("cron_create").annotations).toEqual(expectedMutationAnnotations);
      expect(findToolByName("cron_update").annotations).toEqual(expectedMutationAnnotations);
      expect(findToolByName("cron_remove").annotations).toEqual({
        ...expectedMutationAnnotations,
        destructiveHint: true,
      });
    });

    it("provides individual schemas for cron mutations", () => {
      createAssistantServer(makeDeps());

      expect(findToolByName("cron_create").inputSchema).toEqual(expect.objectContaining({
        label: expect.anything(),
        schedule: expect.anything(),
        payload: expect.anything(),
      }));
      expect(findToolByName("cron_update").inputSchema).toHaveProperty("id");
      expect(findToolByName("cron_remove").inputSchema).toHaveProperty("id");
    });

    it("delegates each cron tool to the matching cron action", async () => {
      const deps = makeDeps();
      createAssistantServer(deps);

      await findToolByName("cron_list").handler({}, {});
      await findToolByName("cron_create").handler({ label: "test", schedule: { type: "cron", expression: "0 10 * * 3" }, payload: { type: "systemEvent", text: "research" } }, {});
      await findToolByName("cron_update").handler({ id: "j1", enabled: false }, {});
      await findToolByName("cron_remove").handler({ id: "j1" }, {});

      expect(deps.handleCronAction).toHaveBeenNthCalledWith(1, "list", {});
      expect(deps.handleCronAction).toHaveBeenNthCalledWith(2, "add", {
        label: "test",
        schedule: { type: "cron", expression: "0 10 * * 3" },
        payload: { type: "systemEvent", text: "research" },
      });
      expect(deps.handleCronAction).toHaveBeenNthCalledWith(3, "update", { id: "j1", enabled: false });
      expect(deps.handleCronAction).toHaveBeenNthCalledWith(4, "remove", { id: "j1" });
    });

    it("returns result as JSON in content array", async () => {
      const deps = makeDeps({
        handleCronAction: vi.fn(async () => ({ success: true, message: "Job added", data: { id: "j1" } })),
      });
      createAssistantServer(deps);
      const cronTool = findToolByName("cron_create");

      const result = await cronTool.handler({ label: "test", schedule: { type: "cron", expression: "0 10 * * 3" }, payload: { type: "systemEvent", text: "research" } }, {});

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
