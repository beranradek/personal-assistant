import * as http from "node:http";
import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createLazyIntegApiSupervisor, type LazyIntegApiSupervisor, type SupervisedChild } from "./lazy-supervisor.js";

/** A fake integ-api child: an HTTP server on the internal port, started after a small delay. */
function createFakeChildFactory(opts: { startDelayMs?: number; neverListens?: boolean } = {}) {
  const state = { started: 0, killed: 0, ports: [] as number[] };
  const startChild = (port: number): SupervisedChild => {
    state.started++;
    state.ports.push(port);
    let server: http.Server | null = null;
    let exitListener: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const begin = () => {
      server = http.createServer((_req, res) => {
        res.setHeader("Connection", "close");
        res.end(JSON.stringify({ status: "ok", port }));
      });
      server.listen(port, "127.0.0.1");
    };
    if (!opts.neverListens) timer = setTimeout(begin, opts.startDelayMs ?? 0);
    return {
      kill: () => {
        state.killed++;
        if (timer) clearTimeout(timer);
        const done = () => exitListener?.();
        if (server) server.close(done);
        else done();
        server?.closeAllConnections();
        return true;
      },
      once: (event, listener) => {
        if (event === "exit") exitListener = listener;
      },
    };
  };
  return { state, startChild };
}

function getJson(port: number): Promise<{ status: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, agent: false }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(JSON.parse(body)));
      })
      .on("error", reject);
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

describe("createLazyIntegApiSupervisor", () => {
  let supervisor: LazyIntegApiSupervisor | null = null;

  afterEach(async () => {
    await supervisor?.stop();
    supervisor = null;
  });

  it("does not start the child until the first connection", async () => {
    const { state, startChild } = createFakeChildFactory();
    const port = await freePort();
    supervisor = createLazyIntegApiSupervisor({ bind: "127.0.0.1", port, idleMs: 10_000, startChild });
    await supervisor.start();
    expect(state.started).toBe(0);
    expect(supervisor.isChildRunning()).toBe(false);
  });

  it("starts the child on the first request, forwards it and reuses the child", async () => {
    const { state, startChild } = createFakeChildFactory({ startDelayMs: 150 });
    const port = await freePort();
    supervisor = createLazyIntegApiSupervisor({ bind: "127.0.0.1", port, idleMs: 10_000, startChild });
    await supervisor.start();

    const first = await getJson(port);
    expect(first.status).toBe("ok");
    expect(state.started).toBe(1);
    expect(supervisor.isChildRunning()).toBe(true);

    await getJson(port);
    expect(state.started).toBe(1);
  });

  it("starts the child only once for concurrent first requests", async () => {
    const { state, startChild } = createFakeChildFactory({ startDelayMs: 100 });
    const port = await freePort();
    supervisor = createLazyIntegApiSupervisor({ bind: "127.0.0.1", port, idleMs: 10_000, startChild });
    await supervisor.start();

    const results = await Promise.all([getJson(port), getJson(port), getJson(port)]);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(state.started).toBe(1);
  });

  it("stops the child when idle and starts it again on the next request", async () => {
    const { state, startChild } = createFakeChildFactory();
    const port = await freePort();
    supervisor = createLazyIntegApiSupervisor({ bind: "127.0.0.1", port, idleMs: 150, startChild });
    await supervisor.start();

    await getJson(port);
    expect(supervisor.isChildRunning()).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(state.killed).toBe(1);
    expect(supervisor.isChildRunning()).toBe(false);

    const again = await getJson(port);
    expect(again.status).toBe("ok");
    expect(state.started).toBe(2);
  });

  it("drops the connection when the child never becomes ready", async () => {
    const { state, startChild } = createFakeChildFactory({ neverListens: true });
    const port = await freePort();
    supervisor = createLazyIntegApiSupervisor({
      bind: "127.0.0.1",
      port,
      idleMs: 10_000,
      startChild,
      readyTimeoutMs: 300,
      killTimeoutMs: 200,
    });
    await supervisor.start();

    await expect(getJson(port)).rejects.toThrow();
    expect(state.started).toBe(1);
    expect(state.killed).toBe(1);
    expect(supervisor.isChildRunning()).toBe(false);
  });

  it("still stops the child when the only client left while it was starting", async () => {
    const { state, startChild } = createFakeChildFactory({ startDelayMs: 300 });
    const port = await freePort();
    supervisor = createLazyIntegApiSupervisor({ bind: "127.0.0.1", port, idleMs: 100, startChild });
    await supervisor.start();

    const socket = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.destroy(); // leaves while the child is still starting

    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(state.started).toBe(1);
    expect(state.killed).toBe(1);
    expect(supervisor.isChildRunning()).toBe(false);
  });

  it("fails fast when the child cannot be started (error event, no exit event)", async () => {
    const listeners: Record<string, () => void> = {};
    const port = await freePort();
    supervisor = createLazyIntegApiSupervisor({
      bind: "127.0.0.1",
      port,
      idleMs: 10_000,
      readyTimeoutMs: 30_000,
      startChild: () => {
        setTimeout(() => listeners["error"]?.(), 50);
        return {
          kill: () => true,
          once: (event, listener) => {
            listeners[event] = listener;
          },
        };
      },
    });
    await supervisor.start();

    const startedAt = Date.now();
    await expect(getJson(port)).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(supervisor.isChildRunning()).toBe(false);
  });

  it("stop() closes the listener and stops the running child", async () => {
    const { state, startChild } = createFakeChildFactory();
    const port = await freePort();
    supervisor = createLazyIntegApiSupervisor({ bind: "127.0.0.1", port, idleMs: 10_000, startChild });
    await supervisor.start();
    await getJson(port);

    await supervisor.stop();
    expect(state.killed).toBe(1);
    await expect(getJson(port)).rejects.toThrow();
    supervisor = null;
  });
});
