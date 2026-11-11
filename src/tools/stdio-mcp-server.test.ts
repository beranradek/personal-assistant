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
    lintMemory: vi.fn().mockResolvedValue({ filesScanned: 0, issues: [] }),
    handleCronAction: vi
      .fn()
      .mockResolvedValue({ success: true, message: "ok" }),
    handleExec: vi
      .fn()
      .mockResolvedValue({ success: true, output: "done" }),
    getProcessSession: vi.fn().mockReturnValue(undefined),
    listProcessSessions: vi.fn().mockReturnValue([]),
    handleHabitCheck: vi.fn().mockResolvedValue({ success: true, message: "Habit checked" }),
    handleHabitStatus: vi.fn().mockResolvedValue({ pillars: [] }),
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
    it("returns separate read and write cron tool definitions", async () => {
      const result = await getListHandler()({});
      const names = result.tools.map((t: { name: string }) => t.name);
      expect(names).toEqual([
        "memory_search",
        "memory_lint",
        "cron_list",
        "cron_create",
        "cron_update",
        "cron_remove",
        "exec",
        "process",
        "habit_check",
        "habit_status",
      ]);
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
  // habits
  // -----------------------------------------------------------------------
  describe("habit tools", () => {
    it("dispatches habit_check and habit_status to supplied handlers", async () => {
      await callTool("habit_check", { label: "Walk", done: true });
      await callTool("habit_status");

      expect(deps.handleHabitCheck).toHaveBeenCalledWith("Walk", true);
      expect(deps.handleHabitStatus).toHaveBeenCalledOnce();
    });

    it("returns the disabled-config response from habit handlers", async () => {
      deps = makeDeps({
        handleHabitStatus: vi.fn().mockResolvedValue({ error: "Habits tracking is disabled in config" }),
      });
      handlers.clear();
      createStdioMcpServer(deps);

      const result = await callTool("habit_status");

      expect(JSON.parse(result.content[0].text)).toEqual({ error: "Habits tracking is disabled in config" });
    });
  });

  describe("remote session tools", () => {
    const response = { ok: true, message: "done", sessions: [] };

    it("does not list the tools without a control handler", async () => {
      const { tools } = await getListHandler()({});
      expect(tools.map((t: { name: string }) => t.name).filter((n: string) => n.startsWith("remote_session"))).toEqual([]);
    });

    it("lists the tools and marks status read-only", async () => {
      deps = makeDeps({ handleRemoteControl: vi.fn().mockResolvedValue(response) });
      handlers.clear();
      createStdioMcpServer(deps);
      const { tools } = await getListHandler()({});
      const byName = new Map(tools.map((t: { name: string }) => [t.name, t]));
      expect([...byName.keys()]).toEqual(expect.arrayContaining(["remote_session_attach", "remote_session_detach", "remote_session_status"]));
      const props = (byName.get("remote_session_attach") as { inputSchema: { properties: Record<string, unknown> } }).inputSchema.properties;
      expect(Object.keys(props)).toEqual(["target", "channel", "force"]);
      expect(Object.keys((byName.get("remote_session_detach") as { inputSchema: { properties: object } }).inputSchema.properties)).toEqual(["channel"]);
      expect((byName.get("remote_session_status") as { annotations: { readOnlyHint: boolean } }).annotations.readOnlyHint).toBe(true);
      expect((byName.get("remote_session_attach") as { annotations: { readOnlyHint: boolean } }).annotations.readOnlyHint).toBe(false);
    });

    it("maps tools to control actions and passes the attach target", async () => {
      const control = vi.fn().mockResolvedValue(response);
      deps = makeDeps({ handleRemoteControl: control });
      handlers.clear();
      createStdioMcpServer(deps);

      await callTool("remote_session_attach", { target: "2" });
      await callTool("remote_session_attach");
      await callTool("remote_session_detach", { target: "ignored" });
      await callTool("remote_session_attach", { target: "1", channel: "slack", force: true });
      await callTool("remote_session_attach", { force: "yes" });
      await callTool("remote_session_status", { channel: "slack", force: true });
      const result = await callTool("remote_session_status");

      expect(control.mock.calls.map((c) => c[0])).toEqual([
        { action: "attach", target: "2" },
        { action: "attach" },
        { action: "detach" },
        { action: "attach", target: "1", channel: "slack", force: true },
        { action: "attach" },
        { action: "status", channel: "slack" },
        { action: "status" },
      ]);
      expect(JSON.parse(result.content[0].text)).toEqual(response);
    });

    it("rejects an unknown channel with a tool error and never calls the control", async () => {
      const control = vi.fn().mockResolvedValue(response);
      deps = makeDeps({ handleRemoteControl: control });
      handlers.clear();
      createStdioMcpServer(deps);
      for (const name of ["remote_session_attach", "remote_session_detach", "remote_session_status"]) {
        const result = await callTool(name, { channel: "slak" });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text).error).toMatch(/Unknown channel/);
      }
      expect(control).not.toHaveBeenCalled();
    });

    it("turns a control failure into an MCP error", async () => {
      deps = makeDeps({ handleRemoteControl: vi.fn().mockRejectedValue(new Error("daemon down")) });
      handlers.clear();
      createStdioMcpServer(deps);
      const result = await callTool("remote_session_status");
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({ error: "daemon down" });
    });
  });

  describe("integration tools", () => {
    it("exposes PA credential proxies when all integration handlers are available", async () => {
      deps = makeDeps({
        handleIntegList: vi.fn().mockResolvedValue({ integrations: [] }),
        handleIntegGmail: vi.fn().mockResolvedValue({ messages: [] }),
        handleIntegCalendar: vi.fn().mockResolvedValue({ events: [] }),
        handleIntegSlack: vi.fn().mockResolvedValue({ channels: [] }),
      });
      handlers.clear();
      createStdioMcpServer(deps);

      const result = await getListHandler()({});
      expect(result.tools.map((tool: { name: string }) => tool.name)).toContain("integ_slack");

      await callTool("integ_gmail", { action: "unreads", max: 10 });
      await callTool("integ_calendar_rsvp", { eventId: "evt", responseStatus: "accepted" });
      await callTool("integ_slack", { action: "messages", channelId: "chan", limit: 10 });

      expect(deps.handleIntegGmail).toHaveBeenCalledWith({ action: "unreads", max: 10 });
      expect(deps.handleIntegCalendar).toHaveBeenCalledWith({ action: "rsvp", eventId: "evt", responseStatus: "accepted" });
      expect(deps.handleIntegSlack).toHaveBeenCalledWith({ action: "messages", channelId: "chan", limit: 10 });
    });

    it("does not route a crafted calendar RSVP through the auto-approved read tool", async () => {
      deps = makeDeps({
        handleIntegList: vi.fn(), handleIntegGmail: vi.fn(), handleIntegCalendar: vi.fn(), handleIntegSlack: vi.fn(),
      });
      handlers.clear();
      createStdioMcpServer(deps);

      const result = await callTool("integ_calendar", { action: "rsvp", eventId: "evt", responseStatus: "accepted" });
      expect(result.isError).toBe(true);
      expect(deps.handleIntegCalendar).not.toHaveBeenCalled();
    });

    it("converts integration proxy validation errors into an MCP error", async () => {
      deps = makeDeps({
        handleIntegList: vi.fn(),
        handleIntegGmail: vi.fn().mockRejectedValue(new Error("messageId is required")),
        handleIntegCalendar: vi.fn(),
        handleIntegSlack: vi.fn(),
      });
      handlers.clear();
      createStdioMcpServer(deps);

      const result = await callTool("integ_gmail", { action: "read" });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({ error: "messageId is required" });
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

      expect(deps.search).toHaveBeenCalledWith("hello", 3, {});
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual(fakeResults);
    });

    it("passes undefined maxResults when not provided", async () => {
      await callTool("memory_search", { query: "test" });
      expect(deps.search).toHaveBeenCalledWith("test", undefined, {});
    });

    it("passes type and tag filters to search", async () => {
      await callTool("memory_search", { query: "jan", type: "Person", tags: ["work"] });

      expect(deps.search).toHaveBeenCalledWith("jan", undefined, {
        type: "Person",
        tags: ["work"],
      });
    });

    it("rejects an excessive maxResults without calling search", async () => {
      const result = await callTool("memory_search", { query: "jan", maxResults: 101 });

      expect(deps.search).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
    });

    it("dispatches memory_lint when provided", async () => {
      deps = makeDeps({ lintMemory: vi.fn().mockResolvedValue({ filesScanned: 2, issues: [] }) });
      handlers.clear();
      createStdioMcpServer(deps);

      const result = await callTool("memory_lint");
      expect(deps.lintMemory).toHaveBeenCalledOnce();
      expect(JSON.parse(result.content[0].text)).toEqual({ filesScanned: 2, issues: [] });
    });
  });

  // -----------------------------------------------------------------------
  // cron tools
  // -----------------------------------------------------------------------
  describe("cron tools", () => {
    it("declares cron_list as an idempotent read-only operation", async () => {
      const result = await getListHandler()({}) as {
        tools: Array<{ name: string; annotations?: Record<string, boolean> }>;
      };
      const cronListTool = result.tools.find((tool) => tool.name === "cron_list");

      expect(cronListTool?.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    });

    it("declares mutations separately from reads", async () => {
      const result = await getListHandler()({}) as {
        tools: Array<{ name: string; annotations?: Record<string, boolean> }>;
      };
      const createTool = result.tools.find((tool) => tool.name === "cron_create");
      const updateTool = result.tools.find((tool) => tool.name === "cron_update");
      const removeTool = result.tools.find((tool) => tool.name === "cron_remove");

      expect(createTool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(updateTool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(removeTool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      });
    });

    it("documents the optional IANA timezone for cron schedules", async () => {
      const result = await getListHandler()({}) as { tools: Array<{ name: string; description: string }> };
      const cronTool = result.tools.find((tool) => tool.name === "cron_create");

      expect(cronTool?.description).toContain('"timezone": "<IANA timezone, optional>"');
    });

    it("dispatches cron_create to the add action", async () => {
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

      const result = await callTool("cron_create", {
        label: "Standup",
        schedule: { type: "cron", expression: "0 9 * * *" },
        payload: { text: "standup" },
      });

      expect(deps.handleCronAction).toHaveBeenCalledWith("add", {
        label: "Standup",
        schedule: { type: "cron", expression: "0 9 * * *" },
        payload: { text: "standup" },
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual(cronResult);
    });

    it("dispatches cron_list without mutation parameters", async () => {
      await callTool("cron_list");
      expect(deps.handleCronAction).toHaveBeenCalledWith("list", {});
    });

    it("dispatches cron_update and cron_remove to their matching actions", async () => {
      await callTool("cron_update", { id: "job-1", enabled: false });
      await callTool("cron_remove", { id: "job-1" });

      expect(deps.handleCronAction).toHaveBeenNthCalledWith(1, "update", {
        id: "job-1",
        enabled: false,
      });
      expect(deps.handleCronAction).toHaveBeenNthCalledWith(2, "remove", {
        id: "job-1",
      });
    });

    it("does not expose the legacy mixed cron tool", async () => {
      const result = await callTool("cron", { action: "list" });

      expect(result.isError).toBe(true);
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

  // -----------------------------------------------------------------------
  // Episodic tools (via episodeDeps)
  // -----------------------------------------------------------------------
  describe("episodic tools", () => {
    const fakeEpisode = {
      id: "ep-1",
      startedAt: "2026-06-27T10:00:00.000Z",
      endedAt: "2026-06-27T10:05:00.000Z",
      source: "terminal" as const,
      sessionKey: "terminal--default",
      sessionId: null,
      initiator: "user" as const,
      action: "test action",
      normalizedAction: "test action",
      summary: "test summary",
      why: null,
      projectName: null,
      jobName: null,
      issueId: null,
      pullRequestId: null,
      detailedMemoryFile: null,
      category: null,
      location: null,
      skillsUsed: [],
      toolsUsed: [],
      tags: [],
      outcome: "success" as const,
      successScore: 1,
      blockers: [],
      errors: [],
      openQuestions: [],
      relatedEpisodeIds: [],
      model: null,
      inputTokens: null,
      outputTokens: null,
      trajectory: [],
      semanticEmbeddingText: "test action test summary",
    };

    function makeEpisodeDeps() {
      return {
        listEpisodes: vi.fn().mockReturnValue([fakeEpisode]),
        insertEpisode: vi.fn().mockResolvedValue(undefined),
        searchEpisodesVector: undefined,
        redact: undefined,
      };
    }

    it("includes episode tools in the tool list when episodeDeps is provided", async () => {
      const episodeDeps = makeEpisodeDeps();
      handlers.clear();
      createStdioMcpServer(makeDeps({ episodeDeps }));

      const result = await getListHandler()({});
      const names = result.tools.map((t: { name: string }) => t.name);
      expect(names).toContain("episode_recent");
      expect(names).toContain("episode_search");
      expect(names).toContain("episode_stats");
      expect(names).toContain("episode_write");
    });

    it("omits episode tools from the tool list when episodeDeps is absent", async () => {
      const result = await getListHandler()({});
      const names = result.tools.map((t: { name: string }) => t.name);
      expect(names).not.toContain("episode_recent");
      expect(names).not.toContain("episode_write");
    });

    it("episode_recent delegates to listEpisodes and returns sanitized records", async () => {
      const episodeDeps = makeEpisodeDeps();
      handlers.clear();
      createStdioMcpServer(makeDeps({ episodeDeps }));

      const result = await callTool("episode_recent", { source: "terminal" });

      expect(episodeDeps.listEpisodes).toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].id).toBe("ep-1");
    });

    it("episode_write delegates to insertEpisode and returns inserted id", async () => {
      const episodeDeps = makeEpisodeDeps();
      handlers.clear();
      createStdioMcpServer(makeDeps({ episodeDeps }));

      const result = await callTool("episode_write", {
        action: "deployed fix",
        summary: "deployed the schema migration fix",
        outcome: "success",
      });

      expect(episodeDeps.insertEpisode).toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe("inserted");
      expect(typeof parsed.id).toBe("string");
    });

    it("episode_stats returns aggregated counts", async () => {
      const episodeDeps = makeEpisodeDeps();
      handlers.clear();
      createStdioMcpServer(makeDeps({ episodeDeps }));

      const result = await callTool("episode_stats", {});

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.totalEpisodes).toBe(1);
      expect(parsed.byOutcome).toEqual({ success: 1 });
    });
  });

  describe("tmux agent tools", () => {
    const TMUX_NAMES = [
      "agent_session_start", "agent_session_list", "agent_session_status", "agent_session_read", "agent_session_send",
      "agent_session_interrupt", "agent_session_stop", "agent_session_recover", "agent_session_attach",
    ];

    function makeTmuxService() {
      const fn = () => vi.fn().mockResolvedValue({ session: "pa-x-1a2b" });
      return {
        start: fn(), list: fn(), status: fn(), read: fn(), send: fn(), interrupt: fn(), stop: fn(), recover: fn(), attach: fn(),
      };
    }

    it("are absent without deps.tmuxAgents (disabled means absent)", async () => {
      const result = await getListHandler()({});
      expect(result.tools.some((t: { name: string }) => t.name.startsWith("agent_session_"))).toBe(false);
      const call = await callTool("agent_session_list", {});
      expect(call.isError).toBe(true);
      expect(JSON.parse(call.content[0].text).error).toMatch(/Unknown tool/);
    });

    it("are listed with valid input schemas when deps.tmuxAgents is set", async () => {
      handlers.clear();
      createStdioMcpServer(makeDeps({ tmuxAgents: makeTmuxService() as never }));
      const result = await getListHandler()({});
      const tmuxTools = result.tools.filter((t: { name: string }) => t.name.startsWith("agent_session_"));
      expect(tmuxTools.map((t: { name: string }) => t.name)).toEqual(TMUX_NAMES);
      for (const tool of tmuxTools) {
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.annotations).toBeDefined();
      }
    });

    it("each tool call reaches the service", async () => {
      const service = makeTmuxService();
      handlers.clear();
      createStdioMcpServer(makeDeps({ tmuxAgents: service as never }));
      const args: Record<string, Record<string, unknown>> = {
        start: { project: "p", directory: "/x" },
        list: {},
        status: { session: "pa-x-1a2b" },
        read: { session: "pa-x-1a2b" },
        send: { session: "pa-x-1a2b", text: "hi" },
        interrupt: { session: "pa-x-1a2b" },
        stop: { session: "pa-x-1a2b" },
        recover: { session: "pa-x-1a2b", userConfirmed: true },
        attach: { session: "pa-x-1a2b" },
      };
      for (const [name, input] of Object.entries(args)) {
        const result = await callTool(`agent_session_${name}`, input);
        expect(result.isError).toBeUndefined();
        expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: true });
        expect(service[name as keyof typeof service]).toHaveBeenCalledTimes(1);
      }
    });

    it("invalid arguments give isError and do not reach the service", async () => {
      const service = makeTmuxService();
      handlers.clear();
      createStdioMcpServer(makeDeps({ tmuxAgents: service as never }));
      const result = await callTool("agent_session_status", { session: "pa-x" });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
      expect(service.status).not.toHaveBeenCalled();
    });
  });
});
