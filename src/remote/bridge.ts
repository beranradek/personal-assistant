/**
 * RemoteBridge
 * ============
 *
 * Daemon side of the remote interactive session feature. It connects one chat to one live Claude Code session. The bridge is
 * channel independent: chats are namespaced keys (`telegram:<id>`, see chat-key.ts) and each channel (Telegram, Slack) is a
 * `RemoteChannel` from the injected registry:
 * - Chat text -> per-session queue -> long poll answer (the asyncRewake hook starts a turn in the session).
 * - Hook events from the session -> optional "processing" message per turn + the final answer from `Stop`.
 * - Turn status (`setTurnStatus`, Slack reactions) is fire and forget: it never delays or breaks a turn.
 *
 * All state is in memory. Everything is injected (config, channels, timers, clock, pid check) so tests use fake time.
 * See docs/plans/active/2026-11-08-remote-interactive-session-communication/spec.md and
 * docs/plans/active/2026-11-11-slack-remote-session-communication/spec.md (sections 5.4 and 5.5).
 */

import * as path from "node:path";
import { createLogger } from "../core/logger.js";
import type { ClaudeCodeRemoteConfig } from "../core/types.js";
import type { StreamEvent } from "../backends/interface.js";
import { makeChatKey, parseChatKey } from "./chat-key.js";
import { createProcessingAccumulator, type ProcessingMessageAccumulator } from "../gateway/processing-message.js";
import {
  REMOTE_FRAME_HEADER_PREFIX,
  REMOTE_HOOK_EVENTS,
  REMOTE_MAX_CWD_CHARS,
  REMOTE_MAX_NAME_CHARS,
  REMOTE_POLL_TIMEOUT_MS,
  type ForwardResult,
  type RemoteBridge,
  type RemoteChannel,
  type RemoteChannelRegistry,
  type RemoteControlRequest,
  type RemoteControlResponse,
  RemotePartialSendError,
  type RemotePollResult,
  type RemoteQueuedMessage,
  type RemoteSessionInfo,
  type RemoteTurnStatus,
  stripRemoteEcho,
} from "./protocol.js";

const defaultLog = createLogger("remote-bridge");

/** Interval of the pid liveness check. */
export const REMOTE_LIVENESS_INTERVAL_MS = 30_000;
/** Window of the per-chat rate limit. */
const RATE_WINDOW_MS = 60_000;
const TRUNCATION_MARKER = "\n[...message truncated]";
const MAX_NOTICE_CHARS = 300;
const KNOWN_EVENTS: ReadonlySet<string> = new Set(REMOTE_HOOK_EVENTS);
/** Delays (ms) before the 2nd and 3rd try to send the final answer. */
const FINAL_SEND_RETRY_DELAYS_MS = [1000, 3000];
/** How long (ms) a removed session pid is refused (a late poll must not bring a ghost session back). */
const TOMBSTONE_MS = 60_000;
/** How long (ms) a timed-out message can still be confirmed late by its UserPromptSubmit. */
const LATE_CONFIRM_MS = 5 * 60_000;
/** Control characters except tab and newline. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** Timer functions. Default: the global ones (so vitest fake timers work). */
export interface RemoteBridgeTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface RemoteBridgeLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
}

export interface RemoteBridgeDeps {
  config: {
    remote: ClaudeCodeRemoteConfig;
    /** `gateway.processingUpdateIntervalMs`. */
    processingUpdateIntervalMs: number;
  };
  /** Channels the bridge can talk to (Telegram, Slack). A chat whose channel is missing gets no notices. */
  channels: RemoteChannelRegistry;
  isPidAlive: (pid: number) => boolean;
  now?: () => number;
  timers?: RemoteBridgeTimers;
  logger?: RemoteBridgeLogger;
  redact?: (text: string) => string;
}

interface PendingDelivery {
  msg: RemoteQueuedMessage;
  chatId: string;
  /** Channel refs of the chat messages (turn status targets). */
  refs: string[];
  /** Undefined while the delivery timer is paused (session busy). */
  timer: unknown;
}

interface LateEntry {
  msg: RemoteQueuedMessage;
  chatId: string;
  refs: string[];
  expiresAt: number;
}

interface QueuedForward {
  msg: RemoteQueuedMessage;
  chatId: string;
  refs: string[];
}

interface Waiter {
  resolve: (result: RemotePollResult) => void;
  timer: unknown;
  signal: AbortSignal;
  cleanup: () => void;
}

interface Turn {
  /** Chat key. */
  chatId: string;
  /** Channel refs of the chat messages that started this turn. */
  refs: string[];
  /** Texts of the chat messages that started this turn (used to hide the echo line). */
  echoes: string[];
  /** True while the final answer is being sent (a second Stop must not send it again). */
  finishing?: boolean;
  accumulator?: ProcessingMessageAccumulator;
  /** Text fed so far (used to separate message blocks). */
  lastText?: string;
}

interface Session {
  /** Stable number shown in status (never reused). */
  id: number;
  pid: number;
  name: string;
  cwd: string;
  /** Chat key of the attached chat. */
  attachedChatId?: string;
  queue: QueuedForward[];
  sent: Map<number, PendingDelivery>;
  /** Recently timed-out messages. A matching UserPromptSubmit can still confirm them. */
  late: Map<number, LateEntry>;
  /** True from UserPromptSubmit until Stop, StopFailure or SessionEnd. */
  busy: boolean;
  waiter?: Waiter;
  /** Set while a chat-origin turn runs. Terminal turns have no turn object. */
  turn?: Turn;
  idleTimer?: unknown;
  /** Runs while queued messages wait for a poll. */
  queueTimer?: unknown;
  /** True after the "not listening" notice for the current queued batch. */
  queueWarned?: boolean;
}

function cleanText(text: string): string {
  return text.replace(CONTROL_CHARS, "");
}

function preview(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

export function createRemoteBridge(deps: RemoteBridgeDeps): RemoteBridge {
  const { config, channels, isPidAlive } = deps;
  const remote = config.remote;
  const log = deps.logger ?? defaultLog;
  const now = deps.now ?? (() => Date.now());
  const timers: RemoteBridgeTimers = deps.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };

  const sessions = new Map<number, Session>();
  /** Chat key -> pid of the attached session (one per chat). */
  const attachments = new Map<string, number>();
  /** pid -> expiry time (ms) of removed sessions. */
  const tombstones = new Map<number, number>();
  const rateLog = new Map<string, number[]>();
  let nextMsgId = 1;
  let nextSessionId = 1;
  let stopped = false;

  // ---- helpers ----------------------------------------------------------

  /** Chat key (or a bare Telegram id) -> key. Invalid keys stay unchanged and match nothing. */
  function normalizeChat(chat: string): string {
    const parsed = parseChatKey(chat);
    return parsed ? makeChatKey(parsed.channel, parsed.id) : chat;
  }

  /** Channel of a chat key plus the id part the channel functions need. */
  function channelOf(chatKey: string): { channel: RemoteChannel; id: string } | undefined {
    const parsed = parseChatKey(chatKey);
    const channel = parsed ? channels.get(parsed.channel) : undefined;
    return parsed && channel ? { channel, id: parsed.id } : undefined;
  }

  /** Call `fn` without awaiting it. Sync throws and rejections are logged, never propagated to the caller. */
  function fireAndForget(fn: () => Promise<void> | void, onError: (err: unknown) => void): void {
    try {
      Promise.resolve(fn()).catch(onError);
    } catch (err) {
      onError(err);
    }
  }

  function notify(chatKey: string, text: string): void {
    const target = channelOf(chatKey);
    if (!target) {
      log.error({ chatId: chatKey }, "remote bridge: no channel for chat");
      return;
    }
    fireAndForget(
      () => target.channel.sendText(target.id, text),
      (err) => log.error({ err, chatId: chatKey }, "remote bridge: channel send failed"),
    );
  }

  /** A failing or hanging `setTurnStatus` never delays or breaks a turn (never awaited). */
  function setStatus(chatKey: string, refs: readonly string[], status: RemoteTurnStatus): void {
    const target = channelOf(chatKey);
    const set = target?.channel.setTurnStatus;
    if (!target || !set) return;
    for (const ref of refs) {
      fireAndForget(
        () => set.call(target.channel, target.id, ref, status),
        (err) => log.warn({ err, chatId: chatKey, status }, "remote bridge: turn status failed"),
      );
    }
  }

  function sessionLabel(s: Session): string {
    return `${s.name} (${s.cwd}, pid ${s.pid})`;
  }

  function listSessions(): RemoteSessionInfo[] {
    return [...sessions.values()].map((s) => ({
      index: s.id,
      name: s.name,
      cwd: s.cwd,
      pid: s.pid,
      ...(s.attachedChatId !== undefined ? { attachedChatId: s.attachedChatId } : {}),
      ...(s.attachedChatId !== undefined && parseChatKey(s.attachedChatId)
        ? { attachedChannel: parseChatKey(s.attachedChatId)!.channel }
        : {}),
    }));
  }

  function clearIdleTimer(s: Session): void {
    if (s.idleTimer !== undefined) {
      timers.clearTimeout(s.idleTimer);
      s.idleTimer = undefined;
    }
  }

  function armIdleTimer(s: Session): void {
    clearIdleTimer(s);
    if (s.attachedChatId === undefined) return;
    s.idleTimer = timers.setTimeout(() => {
      s.idleTimer = undefined;
      const chatId = s.attachedChatId;
      if (chatId === undefined) return;
      log.info({ pid: s.pid, chatId }, "remote bridge: idle detach");
      detachSession(s);
      const label = channelOf(chatId)?.channel.label ?? "chat";
      notify(chatId, `Detached from ${sessionLabel(s)}: no ${label} messages for ${remote.idleDetachMinutes} min.`);
    }, remote.idleDetachMinutes * 60_000);
  }

  function clearQueueTimer(s: Session): void {
    if (s.queueTimer !== undefined) {
      timers.clearTimeout(s.queueTimer);
      s.queueTimer = undefined;
    }
  }

  /** Warn once per queued batch when no poll takes the messages in time (the listener may be gone). */
  function armQueueTimer(s: Session): void {
    if (s.queueTimer !== undefined || s.queueWarned || s.queue.length === 0) return;
    s.queueTimer = timers.setTimeout(() => {
      s.queueTimer = undefined;
      if (s.queue.length === 0 || s.waiter || s.queueWarned) return;
      s.queueWarned = true;
      const chatId = s.attachedChatId ?? s.queue[0]!.chatId;
      log.warn({ pid: s.pid }, "remote bridge: queued message not taken by a poll");
      notify(
        chatId,
        "The session is not listening right now (no poll). Send a prompt in the terminal or wait; your message stays queued.",
      );
    }, remote.deliveryTimeoutMs);
  }

  function dropPending(s: Session): void {
    clearQueueTimer(s);
    s.queueWarned = false;
    for (const q of s.queue) setStatus(q.chatId, q.refs, "dropped");
    for (const p of s.sent.values()) {
      if (p.timer !== undefined) timers.clearTimeout(p.timer);
      setStatus(p.chatId, p.refs, "dropped");
    }
    s.sent.clear();
    s.late.clear();
    s.queue = [];
  }

  /** Remove the attachment. Queued and unconfirmed messages are dropped. A running turn still finishes. */
  function detachSession(s: Session): number {
    const dropped = s.queue.length;
    if (s.attachedChatId !== undefined && attachments.get(s.attachedChatId) === s.pid) attachments.delete(s.attachedChatId);
    s.attachedChatId = undefined;
    clearIdleTimer(s);
    dropPending(s);
    return dropped;
  }

  /** Stop the progress accumulator and clear the turn. Returns the turn that was running. */
  function endTurn(s: Session): Turn | undefined {
    const turn = s.turn;
    if (turn?.accumulator) void turn.accumulator.stop().catch(() => undefined);
    s.turn = undefined;
    return turn;
  }

  /** End a turn that will get no answer (stale, session end, bridge stop): its messages are dropped. */
  function stopTurn(s: Session): void {
    const turn = endTurn(s);
    if (turn && !turn.finishing) setStatus(turn.chatId, turn.refs, "dropped");
  }

  /** Remove the session completely (SessionEnd or dead pid). */
  function removeSession(s: Session, reason: string): void {
    const chatId = s.attachedChatId;
    if (s.waiter) {
      const w = s.waiter;
      s.waiter = undefined;
      w.cleanup();
      w.resolve({ kind: "replaced" });
    }
    detachSession(s);
    stopTurn(s);
    sessions.delete(s.pid);
    tombstones.set(s.pid, now() + TOMBSTONE_MS);
    log.info({ pid: s.pid, reason }, "remote bridge: session removed");
    if (chatId !== undefined) notify(chatId, `Session ${sessionLabel(s)} ${reason}. Detached.`);
  }

  function checkRate(chatId: string): boolean {
    const t = now();
    const recent = (rateLog.get(chatId) ?? []).filter((ts) => t - ts < RATE_WINDOW_MS);
    if (recent.length >= remote.maxMessagesPerMinute) {
      rateLog.set(chatId, recent);
      return false;
    }
    recent.push(t);
    rateLog.set(chatId, recent);
    return true;
  }

  // ---- delivery ---------------------------------------------------------

  /** Start (or restart) the delivery timer of one sent message. A busy session does not time out. */
  function armDeliveryTimer(s: Session, p: PendingDelivery): void {
    if (p.timer !== undefined) timers.clearTimeout(p.timer);
    p.timer = timers.setTimeout(() => {
      p.timer = undefined;
      if (s.sent.get(p.msg.msgId) !== p) return;
      if (s.busy) return; // wait until the session is idle (see rearmPending)
      s.sent.delete(p.msg.msgId);
      s.late.set(p.msg.msgId, { msg: p.msg, chatId: p.chatId, refs: p.refs, expiresAt: now() + LATE_CONFIRM_MS });
      setStatus(p.chatId, p.refs, "failed");
      log.warn({ pid: s.pid, msgId: p.msg.msgId }, "remote bridge: message not delivered");
      notify(p.chatId, `Not delivered to the session (no reaction in time): "${preview(p.msg.text)}"`);
    }, remote.deliveryTimeoutMs);
  }

  /** The session became idle: restart the paused delivery timers. */
  function rearmPending(s: Session): void {
    for (const p of s.sent.values()) if (p.timer === undefined) armDeliveryTimer(s, p);
  }

  /** Hand out all queued messages to the waiter (or the poll that asks) and track them as "sent". */
  function takeQueue(s: Session): RemoteQueuedMessage[] {
    const taken = s.queue;
    s.queue = [];
    clearQueueTimer(s);
    s.queueWarned = false;
    for (const item of taken) {
      const p: PendingDelivery = { msg: item.msg, chatId: item.chatId, refs: item.refs, timer: undefined };
      s.sent.set(item.msg.msgId, p);
      armDeliveryTimer(s, p);
    }
    return taken.map((q) => q.msg);
  }

  function wakeWaiter(s: Session): void {
    if (!s.waiter || s.queue.length === 0 || s.attachedChatId === undefined) return;
    const w = s.waiter;
    s.waiter = undefined;
    w.cleanup();
    if (w.signal.aborted) {
      // The client is gone. Keep the messages queued for the next poll.
      w.resolve({ kind: "timeout" });
      return;
    }
    w.resolve({ kind: "messages", messages: takeQueue(s) });
  }

  /**
   * Only a UserPromptSubmit whose prompt contains the frame header of a sent message proves delivery. Other prompts
   * are terminal prompts: they never start a chat turn and they end a stale turn.
   */
  function onUserPromptSubmit(s: Session, payload: Record<string, unknown>): void {
    s.busy = true;
    const prompt = typeof payload["prompt"] === "string" ? payload["prompt"] : "";
    const t = now();
    for (const [id, e] of s.late) if (e.expiresAt <= t) s.late.delete(id);
    const known: Array<{ msgId: number; chatId: string; text: string; refs: string[] }> = [];
    for (const p of s.sent.values()) known.push({ msgId: p.msg.msgId, chatId: p.chatId, text: p.msg.text, refs: p.refs });
    for (const e of s.late.values()) known.push({ msgId: e.msg.msgId, chatId: e.chatId, text: e.msg.text, refs: e.refs });
    const hits = known.filter((c) => prompt.includes(`${REMOTE_FRAME_HEADER_PREFIX}${c.msgId}]`));
    if (hits.length === 0 && s.turn) {
      notify(s.turn.chatId, "Turn ended: a prompt was typed in the terminal.");
    }
    stopTurn(s); // a turn that is still set here is stale (no Stop after interrupt or error)
    if (hits.length === 0) return;
    for (const h of hits) {
      const p = s.sent.get(h.msgId);
      if (p?.timer !== undefined) timers.clearTimeout(p.timer);
      s.sent.delete(h.msgId);
      s.late.delete(h.msgId);
    }
    s.turn = { chatId: hits[0].chatId, refs: hits.flatMap((h) => h.refs), echoes: hits.map((h) => h.text) };
    log.debug({ pid: s.pid, chatId: hits[0].chatId }, "remote bridge: delivery confirmed, turn origin chat");
  }

  function getAccumulator(turn: Turn): ProcessingMessageAccumulator | undefined {
    if (!remote.progress) return undefined;
    const target = channelOf(turn.chatId);
    const progress = target?.channel.progress;
    if (!target || !progress) return undefined; // e.g. a channel without a progress message
    if (!turn.accumulator) {
      turn.accumulator = createProcessingAccumulator(
        {
          createProcessingMessage: (sourceId, text) => progress.create(sourceId, text),
          updateProcessingMessage: (sourceId, messageId, text) => progress.update(sourceId, messageId, text),
        },
        target.id,
        undefined,
        config.processingUpdateIntervalMs,
        deps.redact,
      );
      turn.accumulator.start();
    }
    return turn.accumulator;
  }

  function feed(turn: Turn, events: StreamEvent[]): void {
    const acc = getAccumulator(turn);
    if (!acc) return;
    for (const e of events) {
      if (e.type === "text_delta") {
        // Each MessageDisplay event is a whole message block: separate blocks with a blank line.
        if (turn.lastText && !turn.lastText.endsWith("\n")) acc.handleEvent({ type: "text_delta", text: "\n\n" });
        turn.lastText = e.text;
      }
      acc.handleEvent(e);
    }
  }

  // ---- hooks ------------------------------------------------------------

  /** Claude Code fires StopFailure (not Stop) when a turn ends with an API error. */
  function onStopFailure(s: Session): void {
    const turn = endTurn(s);
    if (!turn) return;
    setStatus(turn.chatId, turn.refs, "failed");
    notify(turn.chatId, "Turn failed in the session (API error).");
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      timers.setTimeout(resolve, ms);
    });
  }

  /**
   * Send the final answer. Up to 3 tries, then a best effort notice. A `RemotePartialSendError` (some chunks already sent)
   * is never retried: a retry would duplicate text.
   */
  async function sendFinal(s: Session, chatKey: string, text: string): Promise<void> {
    const target = channelOf(chatKey);
    if (!target) {
      log.error({ pid: s.pid, chatId: chatKey }, "remote bridge: no channel for the final answer");
      return;
    }
    const { channel, id } = target;
    const attempts = FINAL_SEND_RETRY_DELAYS_MS.length + 1;
    for (let i = 0; i < attempts; i++) {
      try {
        await channel.sendText(id, text);
        return;
      } catch (err) {
        log.error({ err, pid: s.pid, attempt: i + 1 }, "remote bridge: final answer send failed");
        if (err instanceof RemotePartialSendError || i === attempts - 1 || stopped) break;
        await sleep(channel.retryAfterMs(err) ?? FINAL_SEND_RETRY_DELAYS_MS[i]!);
        if (stopped) break;
      }
    }
    try {
      await channel.sendText(id, channel.deliveryFailedText);
    } catch {
      // Best effort only.
    }
  }

  async function onStop(s: Session, payload: Record<string, unknown>): Promise<void> {
    const turn = s.turn;
    if (!turn || turn.finishing) return; // terminal turn: nothing goes to the chat. Or a second Stop: send once.
    turn.finishing = true;
    // The echo line (first line of the reply) is for the terminal only: hide it in the chat.
    const final = stripRemoteEcho(firstString(payload, ["last_assistant_message"])?.trim() ?? "", turn.echoes).trim();
    try {
      if (turn.accumulator) {
        try {
          await turn.accumulator.stop();
          if (final) await turn.accumulator.trimSuffixFromProcessingMessage(final);
        } catch (err) {
          log.error({ err, pid: s.pid }, "remote bridge: progress finalize failed");
        }
      }
      const text = final || "(The session finished without a text answer.)";
      const sending = sendFinal(s, turn.chatId, deps.redact ? deps.redact(text) : text);
      setStatus(turn.chatId, turn.refs, "done"); // not awaited: after the send started, before it ends
      await sending;
    } finally {
      if (s.turn === turn) s.turn = undefined;
    }
  }

  async function handleHook(event: string, pid: number, payload: unknown, cwd?: string): Promise<void> {
    try {
      if (stopped || !KNOWN_EVENTS.has(event)) return;
      const s = sessions.get(pid);
      if (!s) return;
      if (typeof cwd === "string" && cwd) s.cwd = cleanText(cwd).slice(0, REMOTE_MAX_CWD_CHARS);
      const data = asRecord(payload);
      // Subagent events carry an agent_id. They never start or end a turn.
      const isSubagent = firstString(data, ["agent_id"]) !== undefined;

      if (event === "SessionEnd") {
        // /clear and --resume end the old session and start a new one in the same process.
        const reason = data["reason"];
        if (reason === "clear" || reason === "resume") return;
        removeSession(s, "ended");
        return;
      }
      if (isSubagent && (event === "UserPromptSubmit" || event === "Stop" || event === "StopFailure")) return;

      switch (event) {
        case "UserPromptSubmit":
          onUserPromptSubmit(s, data);
          return;
        case "PreToolUse": {
          if (!s.turn) return;
          const toolName = firstString(data, ["tool_name"]);
          if (!toolName) return;
          const shownName = isSubagent ? `(subagent) ${toolName}` : toolName;
          const events: StreamEvent[] = [{ type: "tool_start", toolName: shownName }];
          const input = data["tool_input"];
          if (input !== null && typeof input === "object" && !Array.isArray(input)) {
            events.push({ type: "tool_input", toolName: shownName, input: input as Record<string, unknown> });
          }
          feed(s.turn, events);
          return;
        }
        case "MessageDisplay": {
          if (!s.turn || isSubagent) return;
          const raw = firstString(data, ["delta", "text", "message", "content", "last_assistant_message"]);
          const text = raw ? stripRemoteEcho(raw, s.turn.echoes) : raw;
          if (text) feed(s.turn, [{ type: "text_delta", text }]);
          return;
        }
        case "Notification": {
          const chatId = s.turn?.chatId ?? s.attachedChatId;
          if (chatId === undefined) return;
          const msg = firstString(data, ["message", "notification_type"]);
          if (msg) notify(chatId, `Claude Code notification: ${preview(cleanText(msg), MAX_NOTICE_CHARS)}`);
          return;
        }
        case "Stop":
          s.busy = false;
          await onStop(s, data);
          rearmPending(s);
          return;
        case "StopFailure":
          s.busy = false;
          onStopFailure(s);
          rearmPending(s);
          return;
        default:
          return;
      }
    } catch (err) {
      log.error({ err, event, pid }, "remote bridge: hook handling failed");
    }
  }

  // ---- poll -------------------------------------------------------------

  function poll(args: { pid: number; cwd: string; name: string; signal: AbortSignal }): Promise<RemotePollResult> {
    const { pid, signal } = args;
    if (stopped || signal.aborted) return Promise.resolve({ kind: "timeout" });

    const tombstone = tombstones.get(pid);
    if (tombstone !== undefined) {
      if (tombstone > now()) return Promise.resolve({ kind: "replaced" });
      tombstones.delete(pid);
    }

    const cwd = cleanText(args.cwd ?? "").slice(0, REMOTE_MAX_CWD_CHARS);
    const name = cleanText(args.name || path.basename(cwd) || `pid-${pid}`).slice(0, REMOTE_MAX_NAME_CHARS);
    let s = sessions.get(pid);
    if (!s) {
      s = { id: nextSessionId++, pid, name, cwd, queue: [], sent: new Map(), late: new Map(), busy: false };
      sessions.set(pid, s);
      log.info({ pid, name, cwd }, "remote bridge: session registered");
    } else {
      s.name = name;
      s.cwd = cwd;
    }
    const session = s;

    // A poll means the listener was re-armed (Stop, StopFailure or UserPromptSubmit hook). Without a Telegram turn
    // a "busy" flag is stale (for example after Esc: no Stop hook runs).
    if (session.busy && !session.turn) {
      session.busy = false;
      rearmPending(session);
    }

    if (session.waiter) {
      const old = session.waiter;
      session.waiter = undefined;
      old.cleanup();
      old.resolve({ kind: "replaced" });
    }

    if (session.attachedChatId !== undefined && session.queue.length > 0) {
      return Promise.resolve({ kind: "messages", messages: takeQueue(session) });
    }

    return new Promise<RemotePollResult>((resolve) => {
      const onAbort = () => {
        if (session.waiter !== waiter) return;
        session.waiter = undefined;
        waiter.cleanup();
        resolve({ kind: "timeout" });
      };
      const waiter: Waiter = {
        resolve,
        signal,
        timer: timers.setTimeout(() => {
          if (session.waiter !== waiter) return;
          session.waiter = undefined;
          waiter.cleanup();
          resolve({ kind: "timeout" });
        }, REMOTE_POLL_TIMEOUT_MS),
        cleanup: () => {
          timers.clearTimeout(waiter.timer);
          signal.removeEventListener("abort", onAbort);
        },
      };
      signal.addEventListener("abort", onAbort, { once: true });
      session.waiter = waiter;
    });
  }

  // ---- forward ----------------------------------------------------------

  function forward(chat: string, text: string, ref?: string): ForwardResult {
    if (stopped) return { accepted: false, reason: "bridge stopped" };
    const chatId = normalizeChat(chat);
    const pid = attachments.get(chatId);
    const s = pid !== undefined ? sessions.get(pid) : undefined;
    if (!s) return { accepted: false, reason: "not attached to a session" };

    let clean = cleanText(text).trim();
    if (!clean) return { accepted: false, reason: "empty message" };
    if (clean.length > remote.maxMessageChars) {
      clean = clean.slice(0, remote.maxMessageChars).trimEnd() + TRUNCATION_MARKER;
    }
    if (!checkRate(chatId)) {
      return { accepted: false, reason: `rate limit: max ${remote.maxMessagesPerMinute} messages per minute` };
    }

    const msgId = nextMsgId++;
    const refs = ref !== undefined ? [ref] : [];
    s.queue.push({ msg: { msgId, text: clean }, chatId, refs });
    setStatus(chatId, refs, "accepted");
    armIdleTimer(s);
    armQueueTimer(s);
    log.info({ chatId, pid: s.pid, msgId, chars: clean.length }, "remote bridge: message forwarded to session queue");
    wakeWaiter(s);
    return { accepted: true, msgId };
  }

  // ---- control ----------------------------------------------------------

  function resolveTarget(target: string | undefined): { session: Session } | { error: string } {
    const all = [...sessions.values()];
    if (all.length === 0) return { error: "No sessions registered. Start Claude Code with the remote hooks." };
    const t = target?.trim();
    if (!t) {
      if (all.length === 1) return { session: all[0] };
      return { error: "Several sessions found. Choose one by number or name (see status)." };
    }
    if (/^\d+$/.test(t)) {
      const s = all.find((x) => x.id === Number(t));
      return s ? { session: s } : { error: `No session with index ${t}.` };
    }
    const byName = all.filter((s) => s.name === t);
    if (byName.length === 1) return { session: byName[0] };
    if (byName.length > 1) return { error: `Several sessions are named "${t}". Use the number.` };
    return { error: `No session named "${t}".` };
  }

  /** `[attached]`, or `[attached to Slack]` when the owner chat lives in another channel than the asking chat. */
  function attachedMark(info: RemoteSessionInfo, asking: string | undefined): string {
    const owner = info.attachedChannel;
    const askingChannel = asking !== undefined ? parseChatKey(asking)?.channel : undefined;
    if (owner === undefined || owner === askingChannel) return " [attached]";
    return ` [attached to ${channels.get(owner)?.label ?? owner}]`;
  }

  function formatStatus(chatId: string | undefined): string {
    const list = listSessions();
    if (list.length === 0) return "No sessions registered.";
    return list
      .map((i) => {
        const mark = i.attachedChatId === undefined ? "" : i.attachedChatId === chatId ? " [attached to this chat]" : attachedMark(i, chatId);
        return `${i.index}. ${i.name} (${i.cwd}, pid ${i.pid})${mark}`;
      })
      .join("\n");
  }

  /** Same channel: the old text. Other channel: name the owner channel and the two ways out (spec 5.4). */
  function refusalText(s: Session, owner: string, asking: string): string {
    const ownerChannel = channelOf(owner)?.channel;
    if (!ownerChannel || parseChatKey(owner)?.channel === parseChatKey(asking)?.channel) {
      return `${s.name} is attached to another chat.`;
    }
    return (
      `Session ${s.id} (${s.name}) is attached to ${ownerChannel.label}. ` +
      `Run ${ownerChannel.detachCommand} in ${ownerChannel.label}, or attach with force to take it over.`
    );
  }

  async function control(request: RemoteControlRequest): Promise<RemoteControlResponse> {
    const reply = (ok: boolean, message: string): RemoteControlResponse => ({ ok, message, sessions: listSessions() });
    const rawChat = request.chatId?.trim();
    if (!rawChat) return reply(false, "chatId is required.");
    const chatId = normalizeChat(rawChat);
    if (!parseChatKey(chatId)) return reply(false, `Invalid chat id: ${preview(cleanText(rawChat), 40)}.`);

    switch (request.action) {
      case "status":
        return reply(true, formatStatus(chatId));
      case "attach": {
        const found = resolveTarget(request.target);
        if ("error" in found) return reply(false, found.error);
        const s = found.session;
        const owner = s.attachedChatId;
        if (owner !== undefined && owner !== chatId) {
          if (!request.force) return reply(false, refusalText(s, owner, chatId));
          // Takeover: the old chat loses the session (queue and unconfirmed messages dropped, a running turn finishes).
          detachSession(s);
          notify(owner, `Detached from ${sessionLabel(s)}: taken over by ${channelOf(chatId)?.channel.label ?? "another chat"}.`);
          log.info({ chatId, previousChatId: owner, pid: s.pid }, "remote bridge: attach forced");
        }
        const previous = attachments.get(chatId);
        if (previous !== undefined && previous !== s.pid) {
          const old = sessions.get(previous);
          if (old) detachSession(old);
          attachments.delete(chatId);
        }
        const already = s.attachedChatId === chatId;
        s.attachedChatId = chatId;
        attachments.set(chatId, s.pid);
        armIdleTimer(s);
        const message = already
          ? `Already attached to ${sessionLabel(s)}.`
          : `Attached to ${sessionLabel(s)}. Send messages now. ${channelOf(chatId)?.channel.detachCommand ?? "Detach"} to stop.`;
        if (!already) notify(chatId, message);
        log.info({ chatId, pid: s.pid }, "remote bridge: attached");
        return reply(true, message);
      }
      case "detach": {
        const pid = attachments.get(chatId);
        const s = pid !== undefined ? sessions.get(pid) : undefined;
        if (!s) {
          attachments.delete(chatId);
          return reply(false, "Not attached to a session.");
        }
        const dropped = detachSession(s);
        const message =
          `Detached from ${sessionLabel(s)}.` + (dropped > 0 ? ` ${dropped} queued message(s) were dropped.` : "");
        notify(chatId, message);
        log.info({ chatId, pid: s.pid }, "remote bridge: detached");
        return reply(true, message);
      }
      default:
        return reply(false, `Unknown action: ${String((request as { action?: unknown }).action)}`);
    }
  }

  // ---- liveness ---------------------------------------------------------

  const livenessTimer = timers.setInterval(() => {
    for (const s of [...sessions.values()]) {
      let alive = true;
      try {
        alive = isPidAlive(s.pid);
      } catch (err) {
        log.warn({ err, pid: s.pid }, "remote bridge: pid check failed");
      }
      if (!alive) removeSession(s, "process is gone");
    }
    for (const pid of [...tombstones.keys()]) {
      let alive = true;
      try {
        alive = isPidAlive(pid);
      } catch {
        // Keep the tombstone until it expires.
      }
      if (!alive || (tombstones.get(pid) ?? 0) <= now()) tombstones.delete(pid);
    }
  }, REMOTE_LIVENESS_INTERVAL_MS);
  // Do not keep the Node process alive for the check (real timers only).
  (livenessTimer as { unref?: () => void } | undefined)?.unref?.();

  function stop(): void {
    if (stopped) return;
    stopped = true;
    timers.clearInterval(livenessTimer);
    for (const s of [...sessions.values()]) {
      if (s.waiter) {
        const w = s.waiter;
        s.waiter = undefined;
        w.cleanup();
        w.resolve({ kind: "timeout" });
      }
      clearIdleTimer(s);
      dropPending(s);
      stopTurn(s);
    }
    tombstones.clear();
    sessions.clear();
    attachments.clear();
  }

  return {
    poll,
    handleHook,
    forward,
    control,
    isAttached: (chat) => attachments.has(normalizeChat(chat)),
    stop,
  };
}
