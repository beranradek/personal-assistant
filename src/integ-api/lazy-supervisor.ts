import * as net from "node:net";
import { createLogger } from "../core/logger.js";

const log = createLogger("integ-api:lazy");

/** The part of a child process the supervisor needs (a `ChildProcess` satisfies it). */
export interface SupervisedChild {
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit" | "error", listener: () => void): unknown;
}

export interface LazyIntegApiOptions {
  /** Public address the daemon listens on (what clients connect to). */
  bind: string;
  port: number;
  /** Stop the child after this long without open connections. */
  idleMs: number;
  /** Start the integ-api server process listening on `internalPort` (loopback). */
  startChild: (internalPort: number) => SupervisedChild;
  /** Longest wait for a freshly started child to accept connections. Default: 20 s. */
  readyTimeoutMs?: number;
  /** Time a stopping child gets before SIGKILL. Default: 5 s. */
  killTimeoutMs?: number;
}

export interface LazyIntegApiSupervisor {
  /** Start listening on the public port. The child is NOT started yet. */
  start(): Promise<void>;
  /** Stop listening, drop open connections and stop the child. */
  stop(): Promise<void>;
  isChildRunning(): boolean;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Socket-activation style supervisor for the integ-api server. The daemon owns the public port and
 * forwards each TCP connection to a child process that is started on the first connection and
 * stopped when it has been idle. Clients (MCP proxy, `pa integapi ...`) see the same address.
 */
export function createLazyIntegApiSupervisor(options: LazyIntegApiOptions): LazyIntegApiSupervisor {
  const readyTimeoutMs = options.readyTimeoutMs ?? 20_000;
  const killTimeoutMs = options.killTimeoutMs ?? 5_000;

  let child: SupervisedChild | null = null;
  let childPort = 0;
  let childReady = false;
  let starting: Promise<number> | null = null;
  let stopping: Promise<void> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const clients = new Set<net.Socket>();
  let server: net.Server | null = null;

  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const stopChild = (): Promise<void> => {
    if (stopping) return stopping;
    const current = child;
    if (!current) return Promise.resolve();
    stopping = new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        if (child === current) {
          child = null;
          childReady = false;
        }
        stopping = null;
        resolve();
      };
      const killTimer = setTimeout(() => {
        current.kill("SIGKILL");
        finish();
      }, killTimeoutMs);
      killTimer.unref();
      current.once("exit", finish);
      current.kill("SIGTERM");
    });
    return stopping;
  };

  const scheduleIdleStop = () => {
    clearIdle();
    if (stopped || clients.size > 0 || !child) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (clients.size === 0) {
        log.info("integ-api idle, stopping child");
        stopChild().catch(() => undefined);
      }
    }, options.idleMs);
    idleTimer.unref();
  };

  const ensureChild = async (): Promise<number> => {
    if (stopping) await stopping;
    if (child && childReady) return childPort;
    if (starting) return starting;
    starting = (async () => {
      const port = await findFreePort();
      let exited = false;
      const spawned = options.startChild(port);
      child = spawned;
      childPort = port;
      childReady = false;
      // A child that fails to start emits "error" and never "exit"; treat both as gone.
      const markGone = () => {
        exited = true;
        if (child === spawned) {
          child = null;
          childReady = false;
        }
      };
      spawned.once("exit", markGone);
      spawned.once("error", markGone);
      log.info({ internalPort: port }, "integ-api child starting on first request");
      const deadline = Date.now() + readyTimeoutMs;
      while (!(await canConnect(port))) {
        if (exited) throw new Error("integ-api child exited before it was ready");
        if (Date.now() > deadline) {
          await stopChild();
          throw new Error("integ-api child did not become ready in time");
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      childReady = true;
      return port;
    })().finally(() => {
      starting = null;
    });
    return starting;
  };

  const handleClient = (client: net.Socket) => {
    clients.add(client);
    clearIdle();
    let upstream: net.Socket | null = null;
    client.once("close", () => {
      clients.delete(client);
      upstream?.destroy();
      scheduleIdleStop();
    });
    client.on("error", () => client.destroy());

    ensureChild()
      .then((port) => {
        if (client.destroyed) {
          // The client left while the child was starting: make sure the idle timer is armed.
          scheduleIdleStop();
          return;
        }
        const up = net.connect(port, "127.0.0.1");
        upstream = up;
        up.on("error", () => client.destroy());
        up.once("close", () => client.destroy());
        client.pipe(up);
        up.pipe(client);
        client.resume();
      })
      .catch((err) => {
        log.error({ err }, "integ-api child unavailable, dropping connection");
        client.destroy();
        scheduleIdleStop();
      });
  };

  return {
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server = net.createServer({ pauseOnConnect: true }, handleClient);
        server.once("error", reject);
        server.listen(options.port, options.bind, () => {
          server?.removeListener("error", reject);
          log.info({ bind: options.bind, port: options.port }, "integ-api lazy listener started");
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      stopped = true;
      clearIdle();
      const listening = server;
      server = null;
      // close() only completes after all connections end, so drop them before awaiting it.
      const closed = listening ? new Promise<void>((resolve) => listening.close(() => resolve())) : Promise.resolve();
      for (const client of clients) client.destroy();
      await closed;
      if (starting) await starting.catch(() => undefined);
      await stopChild();
    },

    isChildRunning: () => child !== null && childReady,
  };
}
