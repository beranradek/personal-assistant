import { describe, it, expect, vi, beforeEach } from "vitest";

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

const { createIntegServer } = await import("./integ-server.js");

function findTool(name: string) {
  const call = mockTool.mock.calls.find((c) => c[0] === name);
  if (!call) throw new Error(`Tool "${name}" not registered`);
  return {
    handler: call[3] as (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>,
  };
}

describe("createIntegServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    })) as any);
  });

  it("registers integrations MCP server with tools", async () => {
    const server = createIntegServer({ port: 19100 });
    expect(server).toHaveProperty("name", "integrations");
    expect(mockCreateSdkMcpServer).toHaveBeenCalledOnce();
    expect(mockTool).toHaveBeenCalled();
  });

  it("integ_list calls the integ-api integrations endpoint", async () => {
    createIntegServer({ port: 19100, bind: "127.0.0.1" });
    const { handler } = findTool("integ_list");

    await handler({});

    const fetchMock = vi.mocked(fetch as any);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:19100/integ-api/integrations");
  });

  it("integ_gmail builds paths for list/read/labels/search and validates required args", async () => {
    createIntegServer({ port: 19100, bind: "127.0.0.1" });
    const { handler } = findTool("integ_gmail");

    await handler({ action: "list", query: "from:me", max: 5, labelIds: "INBOX" });
    await handler({ action: "labels" });

    const rMissingMessageId = await handler({ action: "read" });
    expect(rMissingMessageId.isError).toBe(true);

    await handler({ action: "read", messageId: "abc/def" });

    const rMissingQuery = await handler({ action: "search" });
    expect(rMissingQuery.isError).toBe(true);

    await handler({ action: "search", query: "subject:test", max: 10 });

    const urls = vi.mocked(fetch as any).mock.calls.map((c) => c[0]);
    expect(urls).toContain("http://127.0.0.1:19100/gmail/messages?query=from%3Ame&max=5&labelIds=INBOX");
    expect(urls).toContain("http://127.0.0.1:19100/gmail/labels");
    expect(urls).toContain("http://127.0.0.1:19100/gmail/messages/abc%2Fdef");
    expect(urls).toContain("http://127.0.0.1:19100/gmail/search?q=subject%3Atest&max=10");
  });

  it("integ_calendar builds paths for today/week/event/free_busy and validates required args", async () => {
    createIntegServer({ port: 19100, bind: "127.0.0.1" });
    const { handler } = findTool("integ_calendar");

    await handler({ action: "today" });
    await handler({ action: "week" });

    const rMissingEventId = await handler({ action: "event" });
    expect(rMissingEventId.isError).toBe(true);

    await handler({ action: "event", eventId: "evt/1" });

    const rMissingTimes = await handler({ action: "free_busy", timeMin: "2026-01-01T00:00:00Z" });
    expect(rMissingTimes.isError).toBe(true);

    await handler({ action: "free_busy", timeMin: "2026-01-01T00:00:00Z", timeMax: "2026-01-01T01:00:00Z" });

    const urls = vi.mocked(fetch as any).mock.calls.map((c) => c[0]);
    expect(urls).toContain("http://127.0.0.1:19100/calendar/today");
    expect(urls).toContain("http://127.0.0.1:19100/calendar/week");
    expect(urls).toContain("http://127.0.0.1:19100/calendar/event/evt%2F1");
    expect(urls).toContain("http://127.0.0.1:19100/calendar/free-busy?timeMin=2026-01-01T00%3A00%3A00Z&timeMax=2026-01-01T01%3A00%3A00Z");
  });
});

