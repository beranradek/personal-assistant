/**
 * Spawn control: the `new` and `exit` actions of the remote control request.
 *
 * `new`: start a session (spawner) -> show it in a terminal window (opener) -> wait until it registers in the bridge (the first
 * hook poll; the pane pid is the registered pid) -> attach the asking chat. `exit`: end a session that `new` started.
 * `withSpawnControl` wraps a bridge: `new` and `exit` go here, everything else to the bridge. Nothing here is an MCP tool:
 * only the chat routers and `pa remote new|exit` send these actions.
 */
import type { ClaudeCodeRemoteNewSessionConfig } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import { safeErr } from "../core/log-error.js";
import { parseChatKey } from "./chat-key.js";
import type { RemoteBridge, RemoteControlRequest, RemoteControlResponse, RemoteSessionInfo } from "./protocol.js";
import { cleanLabel, type SessionSpawner } from "./spawner.js";
import type { TerminalOpener } from "./terminal-opener.js";

const defaultLog = createLogger("remote-spawn-control");
const POLL_MS = 500;

export interface SpawnControlDeps {
  config: ClaudeCodeRemoteNewSessionConfig;
  bridge: RemoteBridge;
  spawner: SessionSpawner;
  terminal: TerminalOpener;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<typeof defaultLog, "info" | "warn" | "error">;
}

export function withSpawnControl(deps: SpawnControlDeps): RemoteBridge {
  const { config, bridge, spawner, terminal } = deps;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.logger ?? defaultLog;
  let lastStart = -Infinity;
  let starting = 0;

  const status = async (chatId?: string): Promise<RemoteSessionInfo[]> =>
    (await bridge.control({ action: "status", ...(chatId ? { chatId } : {}) })).sessions;
  const reply = async (ok: boolean, message: string): Promise<RemoteControlResponse> => ({ ok, message, sessions: await status() });

  async function newSession(request: RemoteControlRequest): Promise<RemoteControlResponse> {
    if (!config.enabled) return reply(false, "Starting sessions is disabled (claudeCode.remote.newSession.enabled).");
    const chatId = request.chatId;
    if (!chatId || !parseChatKey(chatId)) return reply(false, "A chat is required to start a session.");
    const t = now();
    if (t - lastStart < config.minStartIntervalMs) return reply(false, "Too fast. Wait a few seconds and try again.");
    // Reserve the slot BEFORE the first await: two concurrent requests must not both pass the gates.
    const previousStart = lastStart;
    lastStart = t;
    starting++;
    let tmuxName: string | undefined;
    try {
      const live = await spawner.list();
      if (live.length + starting - 1 >= config.maxSessions) {
        lastStart = previousStart;
        return reply(false, `Limit reached: ${live.length} started session(s) (max ${config.maxSessions}). End one with exit.`);
      }
      const label = cleanLabel(request.label);
      const started = await spawner.start({ ...(label ? { label } : {}) });
      tmuxName = started.tmuxName;
      log.info({ chatId, tmuxName: started.tmuxName, pid: started.panePid }, "remote spawn: session started");
      const title = label ? `${label} (${started.tmuxName})` : started.tmuxName;
      const win = await terminal.open({ attachArgv: spawner.attachArgv(started.tmuxName), title });
      const attachHint = `tmux -S ${spawner.socketPath} attach -t ${started.tmuxName}`;
      const windowText = win.opened ? `Window: ${win.detail}.` : `No window (${win.detail}). Attach: ${attachHint}`;

      const deadline = now() + config.registerTimeoutMs;
      let info: RemoteSessionInfo | undefined;
      while (now() < deadline) {
        info = (await status()).find((s) => s.pid === started.panePid);
        if (info) break;
        if (!(await spawner.list()).some((s) => s.tmuxName === started.tmuxName)) {
          return reply(false, `The session ${started.tmuxName} ended at once. Run the command by hand to see why: ${config.command.join(" ")}`);
        }
        await sleep(POLL_MS);
      }
      if (!info) {
        return reply(
          false,
          `Started ${started.tmuxName}, but it did not register in ${Math.round(config.registerTimeoutMs / 1000)} s ` +
            `(a dialog may wait for input). ${windowText} End it with: exit ${started.tmuxName}. ` +
            `(A wrapper script as command does not register: the program itself must be claude.)`,
        );
      }
      const attached = await bridge.control({ action: "attach", chatId, target: String(info.index) });
      if (!attached.ok) return reply(false, `Started ${started.tmuxName} (session ${info.index}) but attach failed: ${attached.message}`);
      return reply(true, `Started ${started.tmuxName}${label ? ` "${label}"` : ""} as session ${info.index} and attached. ${windowText}`);
    } catch (err) {
      log.error({ err: safeErr(err), chatId }, "remote spawn: new failed");
      const left = tmuxName ? ` The session ${tmuxName} may still run: exit ${tmuxName}.` : "";
      return reply(false, `Could not start the session: ${err instanceof Error ? err.message : "unknown error"}${left}`);
    } finally {
      starting--;
    }
  }

  async function exitSession(request: RemoteControlRequest): Promise<RemoteControlResponse> {
    const owned = await spawner.list();
    if (owned.length === 0) return reply(false, "No session was started by new. Exit other sessions in their own terminal.");
    const sessions = await status();
    const target = request.target?.trim();
    let pick: { session: RemoteSessionInfo | undefined; spawned: (typeof owned)[number] } | undefined;
    const byPid = (pid: number) => owned.find((o) => o.panePid === pid);
    if (target) {
      // `pa-cc-N` is a tmux name. A plain number is the session number of status. Names and labels follow.
      const byTmuxName = /^pa-cc-\d+$/.test(target) ? owned.find((o) => o.tmuxName === target) : undefined;
      const wanted = byTmuxName
        ? sessions.find((s) => s.pid === byTmuxName.panePid)
        : (sessions.find((s) => String(s.index) === target) ?? sessions.find((s) => s.name === target));
      const spawned = byTmuxName ?? (wanted ? byPid(wanted.pid) : owned.find((o) => o.label === target));
      if (!spawned) {
        return reply(false, wanted ? `Session ${wanted.index} was not started by new. Exit it in its own terminal.` : `No started session "${target}".`);
      }
      pick = { session: wanted ?? sessions.find((s) => s.pid === spawned.panePid), spawned };
    } else {
      const mine = request.chatId ? sessions.find((s) => s.attachedChatId === request.chatId && byPid(s.pid)) : undefined;
      if (mine) pick = { session: mine, spawned: byPid(mine.pid)! };
      else if (owned.length === 1) pick = { session: sessions.find((s) => s.pid === owned[0]!.panePid), spawned: owned[0]! };
      else return reply(false, `Several started sessions: ${owned.map((o) => o.tmuxName).join(", ")}. Say which one (number or name).`);
    }
    try {
      const gone = await spawner.stop(pick.spawned.tmuxName);
      log.info({ chatId: request.chatId, tmuxName: pick.spawned.tmuxName, gone }, "remote spawn: session stopped");
      return reply(gone, gone ? `Ended ${pick.spawned.tmuxName}.` : `Could not end ${pick.spawned.tmuxName}.`);
    } catch (err) {
      log.error({ err: safeErr(err) }, "remote spawn: exit failed");
      return reply(false, `Could not end the session: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  return {
    ...bridge,
    control: (request) => {
      if (request.action === "new") return newSession(request);
      if (request.action === "exit") return exitSession(request);
      return bridge.control(request);
    },
  };
}
