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
  onsessioninitialized?: ((sessionId: string) => void | Promise<void>) | undefined;
  initialized?: boolean;
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
    onsessioninitialized?: ((sessionId: string) => void | Promise<void>) | undefined;
    initialized: boolean;

    constructor(options?: { sessionIdGenerator?: () => string; onsessioninitialized?: (sessionId: string) => void | Promise<void> }) {
      this.sessionId = "";
      this.onclose = undefined;
      this.onsessioninitialized = options?.onsessioninitialized;
      this.initialized = false;

      // Simulate a simple 200 response and expose the instance for assertions.
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;
      this.handleRequest = vi.fn().mockImplementation(function (
        _req: unknown,
        res: http.ServerResponse,
      ) {
        if (!self.initialized) {
          self.sessionId = options?.sessionIdGenerator?.() ?? `sid-${mockTransports.length + 1}`;
          self.initialized = true;
          void self.onsessioninitialized?.(self.sessionId);
        }
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

import { isAllowedRequest, startHttpMcpServer, type HttpMcpServerHandle } from "./http-mcp-server.js";

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

function httpRequest(
  port: number,
  options: {
    method?: string;
    sessionId?: string;
    body?: string;
    protocolVersion?: string;
    headers?: http.OutgoingHttpHeaders;
  } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "mcp-protocol-version": options.protocolVersion ?? "2025-03-26",
      ...options.headers,
    };
    if (options.sessionId) headers["mcp-session-id"] = options.sessionId;
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/", method: options.method ?? "POST", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end(options.body ?? "{}");
  });
}

function httpPost(
  port: number,
  sessionId?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return httpRequest(port, { method: "POST", sessionId, body: "{}" });
}

function httpRawRequest(
  port: number,
  options: {
    method?: string;
    sessionId?: string;
    body?: string;
  } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return httpRequest(port, options);
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
    expect(mockTransports[0].sessionId).toBeTruthy();
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
    expect(res.body).toContain("\"code\":-32001");
    expect(res.body).toContain("\"message\":\"Session not found\"");
    expect(mockTransports).toHaveLength(0);
    expect(mockServers).toHaveLength(0);
  });

  it("rejects unknown session before parsing malformed JSON body", async () => {
    handle = await startHttpMcpServer(makeDeps(), 0);

    const res = await httpRawRequest(handle.port, {
      method: "POST",
      sessionId: "unknown-session-id",
      body: "{not-json",
    });

    expect(res.status).toBe(404);
    expect(res.body).toContain("\"code\":-32001");
    expect(mockTransports).toHaveLength(0);
    expect(mockServers).toHaveLength(0);
  });

  it("rejects GET requests when the mcp-session-id header is unknown", async () => {
    handle = await startHttpMcpServer(makeDeps(), 0);

    const res = await httpRequest(handle.port, { method: "GET", sessionId: "unknown-session-id", body: "" });

    expect(res.status).toBe(404);
    expect(res.body).toContain("\"code\":-32001");
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
    expect(res.body).toContain("\"code\":-32001");
    expect(mockTransports).toHaveLength(1);
  });

  it("rejects DELETE requests for a stale session-id after transport onclose", async () => {
    handle = await startHttpMcpServer(makeDeps(), 0);

    await httpPost(handle.port);
    const sid = mockTransports[0].sessionId;

    mockTransports[0].onclose?.();
    await Promise.resolve();

    const res = await httpRequest(handle.port, { method: "DELETE", sessionId: sid, body: "" });
    expect(res.status).toBe(404);
    expect(res.body).toContain("\"code\":-32001");
    expect(mockTransports).toHaveLength(1);
    expect(mockServers).toHaveLength(1);
  });

  it("rejects stale session before parsing malformed JSON body", async () => {
    handle = await startHttpMcpServer(makeDeps(), 0);

    await httpPost(handle.port);
    const sid = mockTransports[0].sessionId;
    mockTransports[0].onclose?.();
    await Promise.resolve();

    const res = await httpRawRequest(handle.port, {
      method: "POST",
      sessionId: sid,
      body: "{not-json",
    });

    expect(res.status).toBe(404);
    expect(res.body).toContain("\"code\":-32001");
    expect(mockTransports).toHaveLength(1);
    expect(mockServers).toHaveLength(1);
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
    expect(res.body).toContain("\"code\":-32000");
    expect(res.body).toContain("\"message\":\"MCP server shutting down\"");
    expect(mockTransports).toHaveLength(1);
    expect(mockServers).toHaveLength(1);

    resolveServerClose?.();
    await shutdownPromise;
    handle = undefined;
  });

  it("rejects GET requests with JSON-RPC 503 envelope once shutdown starts", async () => {
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

    const res = await httpRequest(handle.port, { method: "GET", body: "" });
    expect(res.status).toBe(503);
    expect(res.body).toContain("\"code\":-32000");
    expect(res.body).toContain("\"message\":\"MCP server shutting down\"");
    expect(mockTransports).toHaveLength(1);
    expect(mockServers).toHaveLength(1);

    resolveServerClose?.();
    await shutdownPromise;
    handle = undefined;
  });

  it("rejects DELETE requests with JSON-RPC 503 envelope once shutdown starts", async () => {
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

    const res = await httpRequest(handle.port, { method: "DELETE", body: "" });
    expect(res.status).toBe(503);
    expect(res.body).toContain("\"code\":-32000");
    expect(res.body).toContain("\"message\":\"MCP server shutting down\"");
    expect(mockTransports).toHaveLength(1);
    expect(mockServers).toHaveLength(1);

    resolveServerClose?.();
    await shutdownPromise;
    handle = undefined;
  });

  describe("Host and Origin check", () => {
    it("rejects a foreign Host header with 403 and never creates a session", async () => {
      handle = await startHttpMcpServer(makeDeps(), 0);
      const res = await httpRequest(handle.port, { headers: { Host: "evil.example" } });
      expect(res.status).toBe(403);
      expect(res.body).toContain("Forbidden");
      expect(mockTransports).toHaveLength(0);
    });

    it("rejects a loopback Host with a different port (DNS rebinding with a guessed port)", async () => {
      handle = await startHttpMcpServer(makeDeps(), 0);
      const res = await httpRequest(handle.port, { headers: { Host: `127.0.0.1:${handle.port + 1}` } });
      expect(res.status).toBe(403);
    });

    it.each(["127.0.0.1", "localhost"])("accepts Host %s:<port>", async (name) => {
      handle = await startHttpMcpServer(makeDeps(), 0);
      const res = await httpRequest(handle.port, { headers: { Host: `${name}:${handle.port}` } });
      expect(res.status).toBe(200);
    });

    it("rejects an Origin that is not this server (foreign site, other local port, other host name)", async () => {
      handle = await startHttpMcpServer(makeDeps(), 0);
      const origins = [
        "https://evil.example", "http://127.0.0.1.evil.example", "null", "not a url",
        "http://localhost:3000", `http://127.0.0.1:${handle.port + 1}`, `http://localhost:${handle.port}`, "http://127.0.0.1",
      ];
      for (const origin of origins) {
        const res = await httpRequest(handle.port, { headers: { Host: `127.0.0.1:${handle.port}`, Origin: origin } });
        expect(res.status).toBe(403);
      }
    });

    it("accepts an Origin equal to the Host (same host and port) and no Origin at all", async () => {
      handle = await startHttpMcpServer(makeDeps(), 0);
      for (const name of ["127.0.0.1", "localhost"]) {
        const host = `${name}:${handle.port}`;
        const res = await httpRequest(handle.port, { headers: { Host: host, Origin: `http://${host}` } });
        expect(res.status).toBe(200);
      }
      const without = await httpRequest(handle.port);
      expect(without.status).toBe(200);
    });
  });
});

describe("isAllowedRequest", () => {
  it("accepts only loopback hosts with the given port", () => {
    expect(isAllowedRequest({ host: "127.0.0.1:9" }, 9)).toBe(true);
    expect(isAllowedRequest({ host: "localhost:9" }, 9)).toBe(true);
    expect(isAllowedRequest({ host: "localhost" }, 9)).toBe(false);
    expect(isAllowedRequest({}, 9)).toBe(false);
    expect(isAllowedRequest({ host: "evil.example:9" }, 9)).toBe(false);
  });

  it("allows an Origin only when it names exactly the Host", () => {
    expect(isAllowedRequest({ host: "localhost:9", origin: "http://localhost:9" }, 9)).toBe(true);
    expect(isAllowedRequest({ host: "localhost:9", origin: "http://localhost:3000" }, 9)).toBe(false);
    expect(isAllowedRequest({ host: "localhost:9", origin: "http://127.0.0.1:9" }, 9)).toBe(false);
  });
});
