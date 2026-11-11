import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import type {
  RemoteBridge,
  RemoteControlRequest,
  RemoteControlResponse,
  RemotePollResult,
} from "./protocol.js";

vi.mock("../core/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import { handleRemoteRequest, isRemotePath, REMOTE_MAX_BODY_BYTES, tokenMatches, type RemoteRouteHolder } from "./routes.js";

const TOKEN = "t0ken";
const AUTH = { Authorization: `Bearer ${TOKEN}` };

interface FakeBridge extends RemoteBridge {
  pollArgs: Array<{ pid: number; cwd: string; name: string; signal: AbortSignal }>;
  resolvePoll: (result: RemotePollResult) => void;
}

function makeBridge(): FakeBridge {
  let resolver: (result: RemotePollResult) => void = () => undefined;
  const bridge: FakeBridge = {
    pollArgs: [],
    resolvePoll: (result) => resolver(result),
    poll: vi.fn((args) => {
      bridge.pollArgs.push(args);
      return new Promise<RemotePollResult>((resolve) => {
        resolver = resolve;
        if (args.signal.aborted) resolve({ kind: "timeout" });
        args.signal.addEventListener("abort", () => resolve({ kind: "timeout" }));
      });
    }),
    handleHook: vi.fn().mockResolvedValue(undefined),
    forward: vi.fn(),
    control: vi.fn(async (request: RemoteControlRequest): Promise<RemoteControlResponse> => ({
      ok: true,
      message: `did ${request.action}`,
      sessions: [],
    })),
    isAttached: vi.fn(),
    stop: vi.fn(),
  };
  return bridge;
}

function request(
  port: number,
  method: string,
  path: string,
  options: { headers?: http.OutgoingHttpHeaders; body?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

describe("remote routes", () => {
  let server: http.Server;
  let port: number;
  let holder: RemoteRouteHolder;
  let bridge: FakeBridge;

  beforeEach(async () => {
    bridge = makeBridge();
    holder = { token: TOKEN, bridge, defaultChatIds: { telegram: "telegram:42", slack: "slack:U1" } };
    server = http.createServer((req, res) => {
      void handleRemoteRequest(req, res, holder);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("tokenMatches checks the Bearer scheme and the value", () => {
    expect(tokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(tokenMatches(`Bearer x${TOKEN}`, TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN, TOKEN)).toBe(false);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
    expect(isRemotePath("/remote/poll?pid=1")).toBe(true);
    expect(isRemotePath("/")).toBe(false);
  });

  it("answers 401 without or with a wrong token (before the 503 check)", async () => {
    holder.bridge = undefined;
    expect((await request(port, "GET", "/remote/poll?pid=1")).status).toBe(401);
    expect((await request(port, "GET", "/remote/poll?pid=1", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
    expect((await request(port, "POST", "/remote/hook", { headers: { Authorization: "Basic abc" } })).status).toBe(401);
  });

  it("answers 503 with a valid token while the bridge is not bound", async () => {
    holder.bridge = undefined;
    for (const [method, path] of [["GET", "/remote/poll?pid=1"], ["POST", "/remote/hook"], ["POST", "/remote/control"]]) {
      expect((await request(port, method!, path!, { headers: AUTH, ...(method === "POST" ? { body: "{}" } : {}) })).status).toBe(503);
    }
  });

  it("answers 404 for an unknown path and 405 for a wrong method", async () => {
    expect((await request(port, "GET", "/remote/other", { headers: AUTH })).status).toBe(404);
    expect((await request(port, "POST", "/remote/poll?pid=1", { headers: AUTH })).status).toBe(405);
    expect((await request(port, "GET", "/remote/hook", { headers: AUTH })).status).toBe(405);
  });

  describe("poll", () => {
    it("returns 200 with messages once the bridge resolves (long poll end to end)", async () => {
      const pending = request(port, "GET", "/remote/poll?pid=77&cwd=%2Fwork&name=dev", { headers: AUTH });
      await vi.waitFor(() => expect(bridge.pollArgs).toHaveLength(1));
      expect(bridge.pollArgs[0]).toMatchObject({ pid: 77, cwd: "/work", name: "dev" });
      bridge.resolvePoll({ kind: "messages", messages: [{ msgId: 1, text: "hi" }] });
      const res = await pending;
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ messages: [{ msgId: 1, text: "hi" }] });
    });

    it("caps cwd at 300 and name at 80 characters", async () => {
      const long = `/poll?pid=5&cwd=${"c".repeat(500)}&name=${"n".repeat(200)}`;
      const pending = request(port, "GET", `/remote${long}`, { headers: AUTH });
      await vi.waitFor(() => expect(bridge.pollArgs).toHaveLength(1));
      expect(bridge.pollArgs[0]!.cwd).toHaveLength(300);
      expect(bridge.pollArgs[0]!.name).toHaveLength(80);
      // Finish the long poll so the client promise does not reject when the server closes.
      bridge.resolvePoll({ kind: "timeout" });
      await pending;
    });

    it("returns 204 on timeout and 204 with X-Remote-Replaced when replaced", async () => {
      let pending = request(port, "GET", "/remote/poll?pid=1", { headers: AUTH });
      await vi.waitFor(() => expect(bridge.pollArgs).toHaveLength(1));
      bridge.resolvePoll({ kind: "timeout" });
      let res = await pending;
      expect(res.status).toBe(204);
      expect(res.headers["x-remote-replaced"]).toBeUndefined();

      pending = request(port, "GET", "/remote/poll?pid=1", { headers: AUTH });
      await vi.waitFor(() => expect(bridge.pollArgs).toHaveLength(2));
      bridge.resolvePoll({ kind: "replaced" });
      res = await pending;
      expect(res.status).toBe(204);
      expect(res.headers["x-remote-replaced"]).toBe("1");
    });

    it("rejects an invalid pid with 400", async () => {
      for (const query of ["", "?pid=abc", "?pid=0", "?pid=-3", "?pid=1.5"]) {
        expect((await request(port, "GET", `/remote/poll${query}`, { headers: AUTH })).status).toBe(400);
      }
      expect(bridge.poll).not.toHaveBeenCalled();
    });

    it("aborts the bridge poll when the client goes away", async () => {
      const req = http.get({ hostname: "127.0.0.1", port, path: "/remote/poll?pid=5", headers: AUTH });
      req.on("error", () => undefined);
      await vi.waitFor(() => expect(bridge.pollArgs).toHaveLength(1));
      expect(bridge.pollArgs[0]!.signal.aborted).toBe(false);
      req.destroy();
      await vi.waitFor(() => expect(bridge.pollArgs[0]!.signal.aborted).toBe(true));
    });

    it("passes an already aborted signal when the response is closed before the poll starts", async () => {
      const res = Object.assign(new EventEmitter(), {
        destroyed: true,
        closed: true,
        writableEnded: false,
        headersSent: false,
        writeHead: vi.fn(),
        end: vi.fn(),
      });
      const req = Object.assign(new EventEmitter(), {
        headers: { authorization: `Bearer ${TOKEN}` },
        url: "/remote/poll?pid=9",
        method: "GET",
      });
      await handleRemoteRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, holder);
      expect(bridge.pollArgs).toHaveLength(1);
      expect(bridge.pollArgs[0]!.signal.aborted).toBe(true);
      expect(res.writeHead).not.toHaveBeenCalled();
    });

    it("does not abort when the answer was sent normally", async () => {
      const pending = request(port, "GET", "/remote/poll?pid=5", { headers: AUTH });
      await vi.waitFor(() => expect(bridge.pollArgs).toHaveLength(1));
      bridge.resolvePoll({ kind: "timeout" });
      await pending;
      expect(bridge.pollArgs[0]!.signal.aborted).toBe(false);
    });
  });

  describe("hook", () => {
    it("answers 204 and passes event, pid, payload and cwd to the bridge", async () => {
      const body = JSON.stringify({ event: "Stop", pid: 9, cwd: "/w", payload: { last_assistant_message: "done" } });
      const res = await request(port, "POST", "/remote/hook", { headers: AUTH, body });
      expect(res.status).toBe(204);
      await vi.waitFor(() => expect(bridge.handleHook).toHaveBeenCalledWith("Stop", 9, { last_assistant_message: "done" }, "/w"));
    });

    it("caps the hook cwd at 300 characters", async () => {
      const body = JSON.stringify({ event: "Stop", pid: 9, cwd: "d".repeat(500), payload: {} });
      await request(port, "POST", "/remote/hook", { headers: AUTH, body });
      await vi.waitFor(() => expect(bridge.handleHook).toHaveBeenCalledWith("Stop", 9, {}, "d".repeat(300)));
    });

    it("answers 204 even when the bridge handler rejects", async () => {
      vi.mocked(bridge.handleHook).mockRejectedValueOnce(new Error("boom"));
      const res = await request(port, "POST", "/remote/hook", { headers: AUTH, body: JSON.stringify({ event: "Stop", pid: 9 }) });
      expect(res.status).toBe(204);
    });

    it("rejects invalid JSON and invalid shapes with 400", async () => {
      expect((await request(port, "POST", "/remote/hook", { headers: AUTH, body: "{nope" })).status).toBe(400);
      expect((await request(port, "POST", "/remote/hook", { headers: AUTH, body: JSON.stringify({ event: "Stop" }) })).status).toBe(400);
      expect((await request(port, "POST", "/remote/hook", { headers: AUTH, body: JSON.stringify({ pid: 3 }) })).status).toBe(400);
      expect(bridge.handleHook).not.toHaveBeenCalled();
    });

    it("rejects a body over the size limit with 413", async () => {
      const body = JSON.stringify({ event: "Stop", pid: 1, payload: "x".repeat(REMOTE_MAX_BODY_BYTES) });
      const res = await request(port, "POST", "/remote/hook", { headers: AUTH, body }).catch(() => ({ status: 413 }));
      expect(res.status).toBe(413);
      expect(bridge.handleHook).not.toHaveBeenCalled();
    });
  });

  describe("control", () => {
    it("uses the default chat id when the request has none", async () => {
      const res = await request(port, "POST", "/remote/control", { headers: AUTH, body: JSON.stringify({ action: "status" }) });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, message: "did status", sessions: [] });
      expect(bridge.control).toHaveBeenCalledWith({ action: "status" });
    });

    it("attach without chatId uses channel, then defaultChannel, then telegram", async () => {
      const post = (body: object) => request(port, "POST", "/remote/control", { headers: AUTH, body: JSON.stringify(body) });
      await post({ action: "attach", channel: "slack", force: true });
      expect(bridge.control).toHaveBeenLastCalledWith({ action: "attach", channel: "slack", force: true, chatId: "slack:U1" });
      holder.defaultChannel = "slack";
      await post({ action: "attach" });
      expect(bridge.control).toHaveBeenLastCalledWith({ action: "attach", chatId: "slack:U1" });
      holder.defaultChannel = undefined;
      await post({ action: "attach" });
      expect(bridge.control).toHaveBeenLastCalledWith({ action: "attach", chatId: "telegram:42" });
    });

    it("answers 400 with a text when the requested channel is not enabled", async () => {
      holder.defaultChatIds = { telegram: "telegram:42" };
      const res = await request(port, "POST", "/remote/control", { headers: AUTH, body: JSON.stringify({ action: "attach", channel: "slack" }) });
      expect(res.status).toBe(400);
      expect(res.body).toContain("slack is not enabled");
    });

    it("passes an explicit chat id and target (number becomes string)", async () => {
      await request(port, "POST", "/remote/control", { headers: AUTH, body: JSON.stringify({ action: "attach", chatId: "7", target: 2 }) });
      expect(bridge.control).toHaveBeenCalledWith({ action: "attach", chatId: "7", target: "2" });
    });

    it("answers 400 for an unknown action or when no chat id can be found", async () => {
      expect((await request(port, "POST", "/remote/control", { headers: AUTH, body: JSON.stringify({ action: "kill" }) })).status).toBe(400);
      holder.defaultChatIds = undefined;
      expect((await request(port, "POST", "/remote/control", { headers: AUTH, body: JSON.stringify({ action: "attach" }) })).status).toBe(400);
      expect(bridge.control).not.toHaveBeenCalled();
    });

    it("answers 500 when the bridge throws", async () => {
      vi.mocked(bridge.control).mockRejectedValueOnce(new Error("boom"));
      const res = await request(port, "POST", "/remote/control", { headers: AUTH, body: JSON.stringify({ action: "status" }) });
      expect(res.status).toBe(500);
      expect(res.body).not.toContain("boom");
    });
  });
});
