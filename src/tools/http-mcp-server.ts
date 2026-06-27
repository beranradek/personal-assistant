/**
 * HTTP MCP Server
 * ===============
 *
 * Runs the PA MCP server over Streamable HTTP so that all Codex CLI instances
 * (main agent + every subagent) share a single persistent server process.
 * This eliminates orphaned `pa mcp-server` stdio processes that accumulate
 * because the Codex CLI re-parents its MCP child instead of killing it.
 *
 * Each connecting client gets its own Server+Transport pair (stateful sessions).
 * The underlying tool implementations (search, cron, exec) are shared.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { StdioMcpServerDeps } from "./stdio-mcp-server.js";
import { createStdioMcpServer } from "./stdio-mcp-server.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("http-mcp-server");

export interface HttpMcpServerHandle {
  port: number;
  close(): Promise<void>;
}

export async function startHttpMcpServer(
  deps: StdioMcpServerDeps,
  port: number,
): Promise<HttpMcpServerHandle> {
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();
  const closingSessions = new Map<string, Promise<void>>();
  let shuttingDown = false;

  function closeSession(sessionId: string): Promise<void> {
    const inFlight = closingSessions.get(sessionId);
    if (inFlight) return inFlight;

    const session = sessions.get(sessionId);
    if (!session) return Promise.resolve();

    sessions.delete(sessionId);
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    closingSessions.set(sessionId, closePromise);

    void (async () => {
      try {
        session.transport.onclose = undefined;
        await session.transport.close();
        await session.server.close();
      } catch {
        // ignore per-session close errors during shutdown
      } finally {
        closingSessions.delete(sessionId);
        log.debug({ sid: sessionId }, "MCP session closed");
        resolveClose();
      }
    })();

    return closePromise;
  }

  const httpServer = http.createServer(async (req, res) => {
    try {
      if (shuttingDown) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "MCP server shutting down" }));
        return;
      }

      // Buffer the full request body before handing off to the transport.
      // This is required because `StreamableHTTPServerTransport.handleRequest`
      // uses @hono/node-server to convert the Node.js request to a Web Request,
      // and the stream would be exhausted by then.
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const bodyStr = Buffer.concat(chunks).toString("utf8");
      const parsedBody: unknown = bodyStr ? (JSON.parse(bodyStr) as unknown) : undefined;

      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && sessions.has(sessionId)) {
        const { transport } = sessions.get(sessionId)!;
        await transport.handleRequest(req, res, parsedBody);
      } else {
        // New client — allocate a fresh transport + server pair.
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        const server = createStdioMcpServer(deps);
        await server.connect(transport);

        const sid = transport.sessionId;
        if (sid) {
          sessions.set(sid, { transport, server });
          transport.onclose = () => {
            void closeSession(sid);
          };
          log.debug({ sid, total: sessions.size }, "MCP session opened");
        }

        await transport.handleRequest(req, res, parsedBody);
      }
    } catch (err) {
      log.error({ err }, "Error handling MCP HTTP request");
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const assignedPort = (httpServer.address() as { port: number }).port;
  log.info({ port: assignedPort }, "HTTP MCP server listening");

  return {
    port: assignedPort,
    async close() {
      shuttingDown = true;
      await Promise.allSettled([
        ...[...sessions.keys()].map((sessionId) => closeSession(sessionId)),
        ...closingSessions.values(),
      ]);
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      log.info("HTTP MCP server closed");
    },
  };
}
