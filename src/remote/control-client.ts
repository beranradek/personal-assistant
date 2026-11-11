/**
 * Remote control client
 * =====================
 *
 * Calls `POST /remote/control` of a running PA daemon with the token from `<configDir>/remote-token`.
 * Used by `pa remote ...` and by the stdio MCP server (`pa mcp-server` is a separate process from the daemon).
 * The HTTP MCP server inside the daemon does not use it: it calls the bridge directly (see daemon.ts).
 */

import type { RemoteControlRequest, RemoteControlResponse } from "./protocol.js";
import { readRemoteToken } from "./token.js";

export type RemoteControlFn = (request: RemoteControlRequest) => Promise<RemoteControlResponse>;

export interface RemoteControlClientOptions {
  configDir: string;
  /** Port of the daemon HTTP server (`codex.httpMcpPort`). */
  port: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createRemoteControlClient(options: RemoteControlClientOptions): RemoteControlFn {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (request) => {
    const token = await readRemoteToken(options.configDir);
    if (!token) {
      throw new Error("Remote mode is not running: token file is missing. Start the daemon with claudeCode.remote.enabled: true.");
    }
    let res: Response;
    try {
      res = await fetchImpl(`http://127.0.0.1:${options.port}/remote/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch {
      throw new Error(`PA daemon is not reachable on 127.0.0.1:${options.port}`);
    }
    if (res.status === 401) throw new Error("Remote token was rejected. The daemon was restarted? Try again.");
    if (res.status === 503) throw new Error("Remote bridge is not ready (no remote channel adapter started yet).");
    if (res.status === 400) {
      // The route answers 400 with a readable reason (for example a channel that is not enabled).
      const body = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
      if (typeof body?.error === "string") throw new Error(body.error);
    }
    if (!res.ok) throw new Error(`Remote control failed with HTTP ${res.status}`);
    return (await res.json()) as RemoteControlResponse;
  };
}
