import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { StdioMcpServerDeps } from "./stdio-mcp-server.js";

// ---------------------------------------------------------------------------
// Shared tracking state — populated by mock constructors during tests
// ---------------------------------------------------------------------------

const mockTransports: Array<{
  sessionId: string;
  handleRequest: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onclose: (() => void) | undefined;
}> = [];

const mockServers: Array<{
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}> = [];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../core/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class FakeMcpServer {
    connect = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    constructor() {
      mockServers.push(this as unknown as typeof mockServers[number]);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: class FakeTransport {
    sessionId: string;
    handleRequest: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    onclose: (() => void) | undefined;

    constructor() {
      this.sessionId = `sid-${mockTransports.length + 1}`;
      this.onclose = undefined;

      // Simulate a simple 200 response and expose the instance for assertions.
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;
      this.handleRequest = vi.fn().mockImplementation(function (
        _req: unknown,
        res: http.ServerResponse,
      ) {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "mcp-session-id": self.sessionId,
        });
        res.end("{}");
        return Promise.resolve();
      });
      this.close = vi.fn().mockResolvedValue(undefined);
      mockTransports.push(this as unknown as typeof mockTransports[number]);
    }
  },
}));

vi.mock("./stdio-mcp-server.js", () => ({
  createStdioMcpServer: vi.fn(() => {
    const server = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockServers.push(server);
    return server;
  }),
}));

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------

import { startHttpMcpServer, type HttpMcpServerHandle } from "./http-mcp-server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(): StdioMcpServerDeps {
  return {
    search: vi.fn().mockResolvedValue([]),
    handleCronAction: vi.fn().mockResolvedValue({ success: true }),
    handleExec: vi.fn().mockResolvedValue({ success: true }),
    getProcessSession: vi.fn().mockReturnValue(undefined),
    listProcessSessions: vi.fn().mockReturnValue([]),
  };
}

function httpPost(
  port: number,
  sessionId?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = { "Content-Type": "application/json" };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/", method: "POST", headers },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startHttpMcpServer", () => {
  let handle: HttpMcpServerHandle | undefined;

  beforeEach(() => {
    mockTransports.length = 0;
    mockServers.length = 0;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it("starts a server and resolves with a positive port and a close() function", async () => {
    handle = await startHttpMcpServer(makeDeps(), 0);
    expect(handle.port).toBeGreaterThan(0);
    expect(typeof handle.close).toBe("function");
  });

  it("creates a new MCP session for a request that has no mcp-session-id header", async () => {
    handle = await startHttpMcpServer(makeDeps(), 0);

    const res = await httpPost(handle.port);

    expect(res.status).toBe(200);
    expect(mockTransports).toHaveLength(1);
    expect(mockServers[0].connect).toHaveBeenCalledWith(mockTransports[0]);
  });

  it("routes a second request with the same session-id to the existing transport", async () => {
    handle = await startHttpMcpServer(makeDeps(), 0);

    const first = await httpPost(handle.port);
    const sid = first.headers["mcp-session-id"] as string;
    expect(sid).toBeTruthy();

    await httpPost(handle.port, sid);

    // Same transport was used twice; no new transport created
    expect(mockTransports).toHaveLength(1);
    expect(mockTransports[0].handleRequest).toHaveBeenCalledTimes(2);
  });

  it("rejects requests when the mcp-session-id header is unknown", async () => {
    handle = await startHttpMcpServer(makeDeps(), 0);

    const res = await httpPost(handle.port, "unknown-session-id");

    expect(res.status).toBe(404);
    expect(mockTransports).toHaveLength(0);
    expect(mockServers).toHaveLength(0);
  });

  it("two requests without session-id each get their own session", async () => {
    handle = await startHttpMcpServer(makeDeps(), 0);

    await httpPost(handle.port);
    await httpPost(handle.port);

    expect(mockTransports).toHaveLength(2);
    expect(mockTransports[0].handleRequest).toHaveBeenCalledOnce();
    expect(mockTransports[1].handleRequest).toHaveBeenCalledOnce();
  });

  it("close() calls close on every active session transport and MCP server", async () => {
    handle = await startHttpMcpServer(makeDeps(), 0);

    await httpPost(handle.port);
    await httpPost(handle.port);

    await handle.close();
    handle = undefined;

    for (const t of mockTransports) {
      expect(t.close).toHaveBeenCalledOnce();
    }
    for (const s of mockServers) {
      expect(s.close).toHaveBeenCalledOnce();
    }
  });

  it("removes a session from the map when its transport fires onclose", async () => {
    handle = await startHttpMcpServer(makeDeps(), 0);

    await httpPost(handle.port);
    const sid = mockTransports[0].sessionId;
    const firstServer = mockServers[0];

    // Simulate transport close event
    mockTransports[0].onclose?.();
    await Promise.resolve();

    expect(firstServer.close).toHaveBeenCalledOnce();
    expect(mockTransports[0].close).toHaveBeenCalledOnce();

    // A subsequent request with the stale sid is rejected instead of silently creating a new session
    const res = await httpPost(handle.port, sid);
    expect(res.status).toBe(404);
    expect(mockTransports).toHaveLength(1);
  });

  it("waits for session teardown already started via onclose before close() resolves", async () => {
    handle = await startHttpMcpServer(makeDeps(), 0);

    await httpPost(handle.port);

    let resolveServerClose: (() => void) | undefined;
    mockServers[0].close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveServerClose = resolve;
        }),
    );

    mockTransports[0].onclose?.();
    await Promise.resolve();

    let shutdownResolved = false;
    const shutdownPromise = handle.close().then(() => {
      shutdownResolved = true;
    });

    await Promise.resolve();
    expect(shutdownResolved).toBe(false);

    resolveServerClose?.();
    await shutdownPromise;
    handle = undefined;

    expect(shutdownResolved).toBe(true);
    expect(mockTransports[0].close).toHaveBeenCalledOnce();
    expect(mockServers[0].close).toHaveBeenCalledOnce();
  });

  it("rejects new requests once shutdown starts so no new session can race in", async () => {
    handle = await startHttpMcpServer(makeDeps(), 0);

    await httpPost(handle.port);

    let resolveServerClose: (() => void) | undefined;
    mockServers[0].close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveServerClose = resolve;
        }),
    );

    const shutdownPromise = handle.close();
    await Promise.resolve();

    const res = await httpPost(handle.port);
    expect(res.status).toBe(503);
    expect(mockTransports).toHaveLength(1);
    expect(mockServers).toHaveLength(1);

    resolveServerClose?.();
    await shutdownPromise;
    handle = undefined;
  });
});
