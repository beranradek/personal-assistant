import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateSdkMcpServer = vi.fn((opts: { name: string; version?: string; tools?: unknown[] }) => ({
  type: "sdk" as const,
  name: opts.name,
  instance: {} as unknown,
  _tools: opts.tools,
}));

const mockTool = vi.fn(
  (name: string, description: string, inputSchema: unknown, handler: (...args: unknown[]) => Promise<unknown>, extras?: unknown) => ({
    name,
    description,
    inputSchema,
    handler,
    extras,
  }),
);

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  tool: mockTool,
}));

const { createTmuxAgentsServer } = await import("./tmux-agents-server.js");
const { TmuxAgentError } = await import("../tmux-agents/errors.js");

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>;

function handlerOf(name: string): Handler {
  const call = mockTool.mock.calls.find((c) => c[0] === name);
  if (!call) throw new Error(`Tool "${name}" not registered`);
  return call[3] as unknown as Handler;
}

describe("createTmuxAgentsServer", () => {
  const service = {
    list: vi.fn().mockResolvedValue({ sessions: [] }),
    status: vi.fn(),
  };

  beforeEach(() => {
    mockTool.mockClear();
    mockCreateSdkMcpServer.mockClear();
    service.status.mockReset();
    createTmuxAgentsServer(service as never);
  });

  it("registers one server named tmuxagents with nine tools", () => {
    expect(mockCreateSdkMcpServer).toHaveBeenCalledWith(expect.objectContaining({ name: "tmuxagents" }));
    expect(mockTool.mock.calls.map((c) => c[0])).toEqual([
      "agent_session_start", "agent_session_list", "agent_session_status", "agent_session_read", "agent_session_send",
      "agent_session_interrupt", "agent_session_stop", "agent_session_recover", "agent_session_attach",
    ]);
  });

  it("passes the right annotations", () => {
    const extras = (name: string) => mockTool.mock.calls.find((c) => c[0] === name)![4] as { annotations: Record<string, boolean> };
    expect(extras("agent_session_list").annotations.readOnlyHint).toBe(true);
    expect(extras("agent_session_stop").annotations.destructiveHint).toBe(true);
    expect(extras("agent_session_send").annotations.readOnlyHint).toBe(false);
  });

  it("a call returns JSON text", async () => {
    const result = await handlerOf("agent_session_list")({ includeStopped: false });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: true, sessions: [] });
    expect(service.list).toHaveBeenCalledWith({ includeStopped: false });
  });

  it("an error result sets isError", async () => {
    service.status.mockRejectedValue(new TmuxAgentError("NOT_FOUND", "Unknown session"));
    const result = await handlerOf("agent_session_status")({ session: "pa-x-1a2b" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});
