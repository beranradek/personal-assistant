/**
 * Remote HTTP routes
 * ==================
 *
 * `GET /remote/poll`, `POST /remote/hook`, `POST /remote/control` on the localhost HTTP server.
 * All routes need `Authorization: Bearer <token>` (constant-time compare). The caller (`startHttpMcpServer`) has already
 * checked Host and Origin (403). The bridge is bound late: until `holder.bridge` is set, routes answer 503.
 */

import type http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { createLogger } from "../core/logger.js";
import { safeErr } from "../core/log-error.js";
import { resolveControlChat, type RemoteDefaultChats } from "./default-chat.js";
import {
  REMOTE_CHANNEL_IDS,
  REMOTE_MAX_CWD_CHARS,
  REMOTE_MAX_NAME_CHARS,
  type RemoteBridge,
  type RemoteChannelId,
  type RemoteControlAction,
  type RemoteControlRequest,
} from "./protocol.js";

const log = createLogger("remote-routes");

/** Max size of a JSON request body. */
export const REMOTE_MAX_BODY_BYTES = 256 * 1024;

/**
 * Shared state between the daemon and the routes. The daemon sets `bridge` after the adapters exist.
 * `defaultChatIds` / `defaultChannel` give the chat `control` uses when the request has none (see `default-chat.ts`).
 */
export interface RemoteRouteHolder extends RemoteDefaultChats {
  bridge?: RemoteBridge;
  token: string;
}

export function isRemotePath(url: string | undefined): boolean {
  return (url ?? "").split("?")[0]!.startsWith("/remote/");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/** Compare via SHA-256 digests: constant time, and the length of the secret does not leak. */
export function tokenMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? "");
  if (!match) return false;
  const given = createHash("sha256").update(match[1]!).digest();
  const expected = createHash("sha256").update(token).digest();
  return timingSafeEqual(given, expected);
}

class BodyTooLargeError extends Error {}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > REMOTE_MAX_BODY_BYTES) throw new BodyTooLargeError("Body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as unknown) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePid(value: unknown): number | undefined {
  const pid = typeof value === "string" && value !== "" ? Number(value) : value;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

async function handlePoll(req: http.IncomingMessage, res: http.ServerResponse, url: URL, bridge: RemoteBridge): Promise<void> {
  const pid = parsePid(url.searchParams.get("pid"));
  if (pid === undefined) {
    sendError(res, 400, "Invalid pid");
    return;
  }
  const cwd = (url.searchParams.get("cwd") ?? "").slice(0, REMOTE_MAX_CWD_CHARS);
  const name = (url.searchParams.get("name") ?? "").slice(0, REMOTE_MAX_NAME_CHARS);

  // The response closes before it ends only when the client went away (for example the hook process was killed).
  // `req` 'close' is not used: it also fires when the request body ends.
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on("close", onClose);
  // The client may be gone already (the 'close' event came before this listener). Then the bridge must see an aborted
  // signal at once and keep the messages queued.
  if (res.destroyed || res.closed) controller.abort();
  try {
    const result = await bridge.poll({ pid, cwd, name, signal: controller.signal });
    if (controller.signal.aborted || res.destroyed) return;
    if (result.kind === "messages") {
      sendJson(res, 200, { messages: result.messages });
    } else if (result.kind === "replaced") {
      res.writeHead(204, { "X-Remote-Replaced": "1" });
      res.end();
    } else {
      res.writeHead(204);
      res.end();
    }
  } finally {
    res.off("close", onClose);
  }
}

async function handleHook(req: http.IncomingMessage, res: http.ServerResponse, bridge: RemoteBridge): Promise<void> {
  const body = await readJsonBody(req);
  const pid = isRecord(body) ? parsePid(body["pid"]) : undefined;
  if (!isRecord(body) || typeof body["event"] !== "string" || pid === undefined) {
    sendError(res, 400, "Invalid hook request");
    return;
  }
  const event = body["event"];
  const cwd = typeof body["cwd"] === "string" ? body["cwd"].slice(0, REMOTE_MAX_CWD_CHARS) : undefined;
  // Answer at once: the hook must never wait for the bridge.
  res.writeHead(204);
  res.end();
  bridge.handleHook(event, pid, body["payload"], cwd).catch((err) => {
    log.warn({ err: safeErr(err), event, pid }, "remote hook handler failed");
  });
}

const CONTROL_ACTIONS: readonly string[] = ["attach", "detach", "status"] satisfies RemoteControlAction[];

async function handleControl(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  holder: RemoteRouteHolder,
  bridge: RemoteBridge,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!isRecord(body) || typeof body["action"] !== "string" || !CONTROL_ACTIONS.includes(body["action"])) {
    sendError(res, 400, "Invalid control request");
    return;
  }
  const rawTarget = body["target"];
  const target = typeof rawTarget === "string" || typeof rawTarget === "number" ? String(rawTarget) : undefined;
  const chatId = typeof body["chatId"] === "string" && body["chatId"] !== "" ? body["chatId"] : undefined;
  const rawChannel = body["channel"];
  const channel = REMOTE_CHANNEL_IDS.find((id) => id === rawChannel) as RemoteChannelId | undefined;
  if (!channel && rawChannel !== undefined && rawChannel !== null && rawChannel !== "") {
    sendError(res, 400, `Unknown channel. Use one of: ${REMOTE_CHANNEL_IDS.join(", ")}.`);
    return;
  }
  const resolved = resolveControlChat(
    {
      action: body["action"] as RemoteControlAction,
      ...(chatId ? { chatId } : {}),
      ...(channel ? { channel } : {}),
      ...(body["force"] === true ? { force: true } : {}),
      ...(target ? { target } : {}),
    },
    holder,
  );
  if ("error" in resolved) {
    sendError(res, 400, resolved.error);
    return;
  }
  const request: RemoteControlRequest = resolved.request;
  sendJson(res, 200, await bridge.control(request));
}

/**
 * Handle one `/remote/*` request. Always answers (never leaves the response open, except the long poll).
 * The caller has checked Host and Origin already.
 */
export async function handleRemoteRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  holder: RemoteRouteHolder,
): Promise<void> {
  try {
    if (!tokenMatches(req.headers.authorization, holder.token)) {
      sendError(res, 401, "Unauthorized");
      return;
    }
    const bridge = holder.bridge;
    if (!bridge) {
      sendError(res, 503, "Remote bridge is not ready");
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    if (url.pathname === "/remote/poll") {
      if (method !== "GET") return sendError(res, 405, "Method not allowed");
      await handlePoll(req, res, url, bridge);
    } else if (url.pathname === "/remote/hook") {
      if (method !== "POST") return sendError(res, 405, "Method not allowed");
      await handleHook(req, res, bridge);
    } else if (url.pathname === "/remote/control") {
      if (method !== "POST") return sendError(res, 405, "Method not allowed");
      await handleControl(req, res, holder, bridge);
    } else {
      sendError(res, 404, "Not found");
    }
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof BodyTooLargeError) {
      sendError(res, 413, "Body too large");
    } else if (err instanceof SyntaxError) {
      sendError(res, 400, "Invalid JSON");
    } else {
      log.error({ err: safeErr(err) }, "remote route failed");
      sendError(res, 500, "Internal server error");
    }
  }
}
