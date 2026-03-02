import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createStdioMcpServer,
  type StdioMcpServerDeps,
} from "./stdio-mcp-server.js";

// ---------------------------------------------------------------------------
// Capture handlers registered via server.setRequestHandler
// ---------------------------------------------------------------------------
const handlers = new Map<string, Function>();

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class FakeServer {
    constructor() {}
    setRequestHandler(schema: { method?: string }, handler: Function) {
      handlers.set(schema.method ?? "unknown", handler);
    }
  },
}));

// We also need to mock the types module to provide the schema objects
// with their `method` property so the handlers map gets correct keys.
vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
  ListToolsRequestSchema: { method: "tools/list" },
  CallToolRequestSchema: { method: "tools/call" },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeDeps(
  overrides: Partial<StdioMcpServerDeps> = {},
): StdioMcpServerDeps {
  return {
    search: vi.fn().mockResolvedValue([]),
    handleCronAction: vi
      .fn()
      .mockResolvedValue({ success: true, message: "ok" }),
    handleExec: vi
      .fn()
      .mockResolvedValue({ success: true, output: "done" }),
    getProcessSession: vi.fn().mockReturnValue(undefined),
    listProcessSessions: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

function getListHandler() {
  const handler = handlers.get("tools/list");
  if (!handler) throw new Error("ListToolsRequestSchema handler not registered");
  return handler;
}

function getCallHandler() {
  const handler = handlers.get("tools/call");
  if (!handler) throw new Error("CallToolRequestSchema handler not registered");
  return handler;
}

function callTool(name: string, args: Record<string, unknown> = {}) {
  return getCallHandler()({ params: { name, arguments: args } });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("createStdioMcpServer", () => {
  let deps: StdioMcpServerDeps;

  beforeEach(() => {
    handlers.clear();
    deps = makeDeps();
    createStdioMcpServer(deps);
  });

  it("creates a server and registers both handlers", () => {
    expect(handlers.has("tools/list")).toBe(true);
    expect(handlers.has("tools/call")).toBe(true);
  });

  // -----------------------------------------------------------------------
  // ListTools
  // -----------------------------------------------------------------------
  describe("ListTools handler", () => {
    it("returns all four tool definitions", async () => {
      const result = await getListHandler()({});
      const names = result.tools.map((t: { name: string }) => t.name);
      expect(names).toEqual(["memory_search", "cron", "exec", "process"]);
    });

    it("each tool definition has a name, description, and inputSchema", async () => {
      const result = await getListHandler()({});
      for (const tool of result.tools) {
        expect(tool).toHaveProperty("name");
        expect(tool).toHaveProperty("description");
        expect(tool).toHaveProperty("inputSchema");
        expect(tool.inputSchema.type).toBe("object");
      }
    });
  });

  // -----------------------------------------------------------------------
  // memory_search
  // -----------------------------------------------------------------------
  describe("memory_search tool", () => {
    it("dispatches to deps.search with query and maxResults", async () => {
      const fakeResults = [
        {
          path: "notes.md",
          snippet: "hello world",
          startLine: 1,
          endLine: 2,
          score: 0.95,
        },
      ];
      deps = makeDeps({
        search: vi.fn().mockResolvedValue(fakeResults),
      });
      handlers.clear();
      createStdioMcpServer(deps);

      const result = await callTool("memory_search", {
        query: "hello",
        maxResults: 3,
      });

      expect(deps.search).toHaveBeenCalledWith("hello", 3);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual(fakeResults);
    });

    it("passes undefined maxResults when not provided", async () => {
      await callTool("memory_search", { query: "test" });
      expect(deps.search).toHaveBeenCalledWith("test", undefined);
    });
  });

  // -----------------------------------------------------------------------
  // cron
  // -----------------------------------------------------------------------
  describe("cron tool", () => {
    it("dispatches to deps.handleCronAction with action and params", async () => {
      const cronResult = {
        success: true,
        message: "Job added",
        data: { id: "abc" },
      };
      deps = makeDeps({
        handleCronAction: vi.fn().mockResolvedValue(cronResult),
      });
      handlers.clear();
      createStdioMcpServer(deps);

      const result = await callTool("cron", {
        action: "add",
        params: { schedule: "0 9 * * *", message: "standup" },
      });

      expect(deps.handleCronAction).toHaveBeenCalledWith("add", {
        schedule: "0 9 * * *",
        message: "standup",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual(cronResult);
    });

    it("defaults params to empty object when not provided", async () => {
      await callTool("cron", { action: "list" });
      expect(deps.handleCronAction).toHaveBeenCalledWith("list", {});
    });
  });

  // -----------------------------------------------------------------------
  // exec
  // -----------------------------------------------------------------------
  describe("exec tool", () => {
    it("dispatches to deps.handleExec with all options", async () => {
      const execResult = {
        success: true,
        sessionId: "s1",
        output: "running",
      };
      deps = makeDeps({
        handleExec: vi.fn().mockResolvedValue(execResult),
      });
      handlers.clear();
      createStdioMcpServer(deps);

      const result = await callTool("exec", {
        command: "ls -la",
        background: true,
        yieldMs: 500,
      });

      expect(deps.handleExec).toHaveBeenCalledWith({
        command: "ls -la",
        background: true,
        yieldMs: 500,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual(execResult);
    });

    it("passes undefined for optional fields when not provided", async () => {
      await callTool("exec", { command: "echo hi" });
      expect(deps.handleExec).toHaveBeenCalledWith({
        command: "echo hi",
        background: undefined,
        yieldMs: undefined,
      });
    });
  });

  // -----------------------------------------------------------------------
  // process
  // -----------------------------------------------------------------------
  describe("process tool", () => {
    it("dispatches process/list to deps.listProcessSessions", async () => {
      const sessions = [
        {
          id: "s1",
          session: {
            pid: 123,
            command: "sleep 10",
            exitCode: null,
            startedAt: "2026-01-01T00:00:00Z",
            exitedAt: null,
          },
        },
      ];
      deps = makeDeps({
        listProcessSessions: vi.fn().mockReturnValue(sessions),
      });
      handlers.clear();
      createStdioMcpServer(deps);

      const result = await callTool("process", { action: "list" });

      expect(deps.listProcessSessions).toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual(sessions);
    });

    it("dispatches process/status to deps.getProcessSession when sessionId is provided", async () => {
      const session = {
        pid: 42,
        command: "make build",
        output: "compiling...",
        exitCode: null,
        startedAt: "2026-01-01T00:00:00Z",
        exitedAt: null,
      };
      deps = makeDeps({
        getProcessSession: vi.fn().mockReturnValue(session),
      });
      handlers.clear();
      createStdioMcpServer(deps);

      const result = await callTool("process", {
        action: "status",
        sessionId: "abc-123",
      });

      expect(deps.getProcessSession).toHaveBeenCalledWith("abc-123");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual(session);
    });

    it("returns 'Not found' when getProcessSession returns undefined", async () => {
      deps = makeDeps({
        getProcessSession: vi.fn().mockReturnValue(undefined),
      });
      handlers.clear();
      createStdioMcpServer(deps);

      const result = await callTool("process", {
        action: "status",
        sessionId: "nonexistent",
      });

      expect(deps.getProcessSession).toHaveBeenCalledWith("nonexistent");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({ error: "Not found" });
    });

    it("returns 'Missing sessionId' when process/status is called without sessionId", async () => {
      const result = await callTool("process", { action: "status" });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({ error: "Missing sessionId" });
    });
  });

  // -----------------------------------------------------------------------
  // Unknown tool
  // -----------------------------------------------------------------------
  describe("unknown tool", () => {
    it("returns an error with isError: true for unrecognized tool names", async () => {
      const result = await callTool("nonexistent_tool", {});

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({ error: "Unknown tool: nonexistent_tool" });
    });
  });
});
