import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRemoteBridge, REMOTE_LIVENESS_INTERVAL_MS, type RemoteBridgeDeps, type RemoteTelegramSender } from "./bridge.js";
import { REMOTE_FRAME_HEADER_PREFIX, REMOTE_POLL_TIMEOUT_MS, type RemoteBridge, type RemotePollResult } from "./protocol.js";
import { ClaudeCodeRemoteConfigSchema } from "../core/types.js";

const CHAT = "111";
const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

interface Harness {
  bridge: RemoteBridge;
  sender: RemoteTelegramSender & {
    sendMessage: ReturnType<typeof vi.fn>;
    createProcessingMessage: ReturnType<typeof vi.fn>;
    updateProcessingMessage: ReturnType<typeof vi.fn>;
  };
  alive: Set<number>;
}

function setup(remote: Record<string, unknown> = {}, extra: Partial<RemoteBridgeDeps> = {}): Harness {
  const sender = {
    sendMessage: vi.fn(async () => undefined),
    createProcessingMessage: vi.fn(async () => "pm-1"),
    updateProcessingMessage: vi.fn(async () => undefined),
  };
  const alive = new Set<number>([100, 200]);
  const bridge = createRemoteBridge({
    config: { remote: ClaudeCodeRemoteConfigSchema.parse({ enabled: true, ...remote }), processingUpdateIntervalMs: 5000 },
    sender,
    isPidAlive: (pid) => alive.has(pid),
    logger: noopLogger,
    ...extra,
  });
  return { bridge, sender, alive };
}

function startPoll(bridge: RemoteBridge, pid = 100, name = "ws", signal = new AbortController().signal) {
  const results: RemotePollResult[] = [];
  const promise = bridge.poll({ pid, cwd: `/w/${name}`, name, signal }).then((r) => {
    results.push(r);
    return r;
  });
  return { promise, results };
}

/** Prompt of a rewake turn: a wrapper that contains the stderr frame text of our hook. */
function framePrompt(...ids: number[]): string {
  const frames = ids.map((id) => `${REMOTE_FRAME_HEADER_PREFIX}${id}]\nmessage text`).join("\n\n");
  return `<task-notification><summary>Stop hook feedback</summary></task-notification><system-reminder>Stop hook blocking error ${frames}</system-reminder>`;
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function attach(bridge: RemoteBridge, target?: string) {
  return bridge.control({ action: "attach", chatId: CHAT, target });
}

describe("RemoteBridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("sessions, attach and detach", () => {
    it("registers a session on first poll and lists it in status", async () => {
      const { bridge } = setup();
      startPoll(bridge, 100, "alpha");
      const res = await bridge.control({ action: "status", chatId: CHAT });
      expect(res.ok).toBe(true);
      expect(res.sessions).toEqual([{ index: 1, name: "alpha", cwd: "/w/alpha", pid: 100 }]);
      expect(res.message).toContain("1. alpha");
      bridge.stop();
    });

    it("status says so when there are no sessions", async () => {
      const { bridge } = setup();
      const res = await bridge.control({ action: "status", chatId: CHAT });
      expect(res).toMatchObject({ ok: true, sessions: [] });
      expect(res.message).toMatch(/no sessions/i);
      bridge.stop();
    });

    it("rejects control without chatId", async () => {
      const { bridge } = setup();
      startPoll(bridge);
      const res = await bridge.control({ action: "attach" });
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/chatId/);
      bridge.stop();
    });

    it("attaches the only session without target and notifies Telegram", async () => {
      const { bridge, sender } = setup();
      startPoll(bridge);
      const res = await attach(bridge);
      expect(res.ok).toBe(true);
      expect(res.sessions[0].attachedChatId).toBe(CHAT);
      expect(bridge.isAttached(CHAT)).toBe(true);
      expect(sender.sendMessage).toHaveBeenCalledWith(CHAT, expect.stringContaining("Attached to ws"));
      bridge.stop();
    });

    it("fails to attach when there is no session", async () => {
      const { bridge } = setup();
      const res = await attach(bridge);
      expect(res.ok).toBe(false);
      expect(bridge.isAttached(CHAT)).toBe(false);
      bridge.stop();
    });

    it("requires a target when several sessions exist", async () => {
      const { bridge } = setup();
      startPoll(bridge, 100, "a");
      startPoll(bridge, 200, "b");
      const res = await attach(bridge);
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/choose/i);
      expect(bridge.isAttached(CHAT)).toBe(false);
      bridge.stop();
    });

    it("attaches by index and by name", async () => {
      const { bridge } = setup();
      startPoll(bridge, 100, "a");
      startPoll(bridge, 200, "b");
      expect((await attach(bridge, "2")).sessions.find((s) => s.attachedChatId)?.pid).toBe(200);
      expect((await attach(bridge, "a")).sessions.find((s) => s.attachedChatId)?.pid).toBe(100);
      bridge.stop();
    });

    it("rejects unknown index and unknown name", async () => {
      const { bridge } = setup();
      startPoll(bridge, 100, "a");
      expect((await attach(bridge, "5")).ok).toBe(false);
      expect((await attach(bridge, "zzz")).ok).toBe(false);
      bridge.stop();
    });

    it("keeps one attached session per chat: attach to another switches", async () => {
      const { bridge } = setup();
      startPoll(bridge, 100, "a");
      startPoll(bridge, 200, "b");
      await attach(bridge, "1");
      const res = await attach(bridge, "2");
      expect(res.sessions.filter((s) => s.attachedChatId === CHAT).map((s) => s.pid)).toEqual([200]);
      bridge.stop();
    });

    it("does not let a second chat take an attached session", async () => {
      const { bridge } = setup();
      startPoll(bridge);
      await attach(bridge);
      const res = await bridge.control({ action: "attach", chatId: "222" });
      expect(res.ok).toBe(false);
      expect(bridge.isAttached("222")).toBe(false);
      bridge.stop();
    });

    it("attach twice says already attached and does not notify again", async () => {
      const { bridge, sender } = setup();
      startPoll(bridge);
      await attach(bridge);
      const res = await attach(bridge);
      expect(res.ok).toBe(true);
      expect(res.message).toMatch(/already/i);
      expect(sender.sendMessage).toHaveBeenCalledTimes(1);
      bridge.stop();
    });

    it("detaches, notifies, and rejects detach when not attached", async () => {
      const { bridge, sender } = setup();
      startPoll(bridge);
      expect((await bridge.control({ action: "detach", chatId: CHAT })).ok).toBe(false);
      await attach(bridge);
      sender.sendMessage.mockClear();
      const res = await bridge.control({ action: "detach", chatId: CHAT });
      expect(res.ok).toBe(true);
      expect(bridge.isAttached(CHAT)).toBe(false);
      expect(sender.sendMessage).toHaveBeenCalledWith(CHAT, expect.stringContaining("Detached"));
      bridge.stop();
    });

    it("detach drops queued messages", async () => {
      const { bridge } = setup();
      startPoll(bridge);
      await attach(bridge);
      await flush();
      // first message goes to the waiting poll; the second stays queued (no waiter)
      bridge.forward(CHAT, "one");
      await flush();
      bridge.forward(CHAT, "two");
      const res = await bridge.control({ action: "detach", chatId: CHAT });
      expect(res.message).toMatch(/1 queued/);
      bridge.stop();
    });

    it("strips control characters from the session name and cwd", async () => {
      const { bridge } = setup();
      void bridge.poll({ pid: 100, cwd: "/w/\u001b[31mx", name: "na\u0000me", signal: new AbortController().signal });
      const res = await bridge.control({ action: "status", chatId: CHAT });
      expect(res.sessions[0].name).toBe("name");
      expect(res.sessions[0].cwd).toBe("/w/[31mx");
      bridge.stop();
    });
  });

  describe("forward", () => {
    it("rejects when not attached", () => {
      const { bridge } = setup();
      expect(bridge.forward(CHAT, "hi")).toEqual({ accepted: false, reason: expect.stringMatching(/not attached/) });
      bridge.stop();
    });

    it("rejects empty text after cleaning", async () => {
      const { bridge } = setup();
      startPoll(bridge);
      await attach(bridge);
      expect(bridge.forward(CHAT, " \u0001\u0002 \n").accepted).toBe(false);
      bridge.stop();
    });

    it("strips control characters but keeps newline and tab", async () => {
      const { bridge } = setup();
      const p = startPoll(bridge);
      await attach(bridge);
      bridge.forward(CHAT, "a\u0000b\u001b[0mc\r\nd\te\u0085");
      const r = await p.promise;
      expect(r).toEqual({ kind: "messages", messages: [{ msgId: 1, text: "ab[0mc\nd\te" }] });
      bridge.stop();
    });

    it("truncates long text with a marker", async () => {
      const { bridge } = setup({ maxMessageChars: 10 });
      const p = startPoll(bridge);
      await attach(bridge);
      bridge.forward(CHAT, "x".repeat(50));
      const r = await p.promise;
      if (r.kind !== "messages") throw new Error("expected messages");
      expect(r.messages[0].text.startsWith("x".repeat(10))).toBe(true);
      expect(r.messages[0].text).toMatch(/truncated/);
      expect(r.messages[0].text.length).toBeLessThan(50);
      bridge.stop();
    });

    it("applies a per-chat rate limit with a sliding window", async () => {
      const { bridge } = setup({ maxMessagesPerMinute: 2 });
      startPoll(bridge);
      await attach(bridge);
      expect(bridge.forward(CHAT, "1").accepted).toBe(true);
      expect(bridge.forward(CHAT, "2").accepted).toBe(true);
      const third = bridge.forward(CHAT, "3");
      expect(third).toEqual({ accepted: false, reason: expect.stringMatching(/rate limit/) });
      await vi.advanceTimersByTimeAsync(60_001);
      expect(bridge.forward(CHAT, "4").accepted).toBe(true);
      bridge.stop();
    });

    it("gives increasing message ids", async () => {
      const { bridge } = setup();
      startPoll(bridge);
      await attach(bridge);
      const a = bridge.forward(CHAT, "a");
      const b = bridge.forward(CHAT, "b");
      expect(a).toEqual({ accepted: true, msgId: 1 });
      expect(b).toEqual({ accepted: true, msgId: 2 });
      bridge.stop();
    });
  });

  describe("long poll", () => {
    it("times out with kind timeout after the poll timeout", async () => {
      const { bridge } = setup();
      const p = startPoll(bridge);
      await vi.advanceTimersByTimeAsync(REMOTE_POLL_TIMEOUT_MS - 1);
      expect(p.results).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(p.results).toEqual([{ kind: "timeout" }]);
      bridge.stop();
    });

    it("replaces an older poll of the same pid", async () => {
      const { bridge } = setup();
      const first = startPoll(bridge);
      const second = startPoll(bridge);
      await flush();
      expect(first.results).toEqual([{ kind: "replaced" }]);
      expect(second.results).toEqual([]);
      bridge.stop();
      await second.promise;
    });

    it("returns queued messages at once, in order", async () => {
      const { bridge } = setup();
      startPoll(bridge); // registers
      await attach(bridge);
      // let the registering poll take message 0, then queue two while no waiter exists
      bridge.forward(CHAT, "zero");
      await flush();
      bridge.forward(CHAT, "one");
      bridge.forward(CHAT, "two");
      const r = await startPoll(bridge).promise;
      expect(r).toEqual({
        kind: "messages",
        messages: [
          { msgId: 2, text: "one" },
          { msgId: 3, text: "two" },
        ],
      });
      bridge.stop();
    });

    it("wakes a waiting poll when a message is forwarded", async () => {
      const { bridge } = setup();
      const p = startPoll(bridge);
      await attach(bridge);
      await flush();
      expect(p.results).toEqual([]);
      bridge.forward(CHAT, "hello");
      await flush();
      expect(p.results).toEqual([{ kind: "messages", messages: [{ msgId: 1, text: "hello" }] }]);
      bridge.stop();
    });

    it("does not hand out messages to a poll of an unattached session", async () => {
      const { bridge } = setup();
      startPoll(bridge, 100, "a");
      const other = startPoll(bridge, 200, "b");
      await attach(bridge, "1");
      bridge.forward(CHAT, "hi");
      await flush();
      expect(other.results).toEqual([]);
      bridge.stop();
    });

    it("resolves timeout when the signal aborts and removes the waiter", async () => {
      const { bridge } = setup();
      const ac = new AbortController();
      const p = startPoll(bridge, 100, "ws", ac.signal);
      ac.abort();
      await flush();
      expect(p.results).toEqual([{ kind: "timeout" }]);
      // later messages are queued, not lost to the dead waiter
      await attach(bridge);
      bridge.forward(CHAT, "x");
      const r = await startPoll(bridge).promise;
      expect(r).toEqual({ kind: "messages", messages: [{ msgId: 1, text: "x" }] });
      bridge.stop();
    });

    it("resolves timeout at once for an already aborted signal", async () => {
      const { bridge } = setup();
      const ac = new AbortController();
      ac.abort();
      expect(await bridge.poll({ pid: 100, cwd: "/w", name: "w", signal: ac.signal })).toEqual({ kind: "timeout" });
      bridge.stop();
    });

    it("stop resolves pending polls", async () => {
      const { bridge } = setup();
      const p = startPoll(bridge);
      bridge.stop();
      await flush();
      expect(p.results).toEqual([{ kind: "timeout" }]);
    });
  });

  describe("delivery confirmation", () => {
    async function deliver(h: Harness, text = "do it") {
      const p = startPoll(h.bridge);
      await attach(h.bridge);
      h.bridge.forward(CHAT, text);
      await p.promise;
    }

    it("sends a not-delivered notice after the timeout without hook events", async () => {
      const h = setup({ deliveryTimeoutMs: 1000 });
      await deliver(h, "hello world");
      h.sender.sendMessage.mockClear();
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.sender.sendMessage).toHaveBeenCalledTimes(1);
      expect(h.sender.sendMessage).toHaveBeenCalledWith(CHAT, expect.stringContaining("hello world"));
      expect(h.sender.sendMessage.mock.calls[0][1]).toMatch(/not delivered/i);
      h.bridge.stop();
    });

    it("sends no notice when a hook event from the pid arrives in time", async () => {
      const h = setup({ deliveryTimeoutMs: 1000 });
      await deliver(h);
      h.sender.sendMessage.mockClear();
      await h.bridge.handleHook("UserPromptSubmit", 100, { prompt: framePrompt(1) });
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.sender.sendMessage).not.toHaveBeenCalled();
      h.bridge.stop();
    });

    it("a hook event from another pid does not confirm", async () => {
      const h = setup({ deliveryTimeoutMs: 1000 });
      await deliver(h);
      startPoll(h.bridge, 200, "other");
      h.sender.sendMessage.mockClear();
      await h.bridge.handleHook("UserPromptSubmit", 200, {});
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.sender.sendMessage).toHaveBeenCalledTimes(1);
      h.bridge.stop();
    });

    it("the timed-out message is dropped (notice only once)", async () => {
      const h = setup({ deliveryTimeoutMs: 1000 });
      await deliver(h);
      h.sender.sendMessage.mockClear();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.sender.sendMessage).toHaveBeenCalledTimes(1);
      h.bridge.stop();
    });

    it("ignores unknown events (no confirmation)", async () => {
      const h = setup({ deliveryTimeoutMs: 1000 });
      await deliver(h);
      h.sender.sendMessage.mockClear();
      await h.bridge.handleHook("SomethingElse", 100, {});
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.sender.sendMessage).toHaveBeenCalledTimes(1);
      h.bridge.stop();
    });
  });

  describe("delivery confirmation by UserPromptSubmit marker", () => {
    async function deliver(h: Harness, texts: string[] = ["do it"]) {
      const p = startPoll(h.bridge);
      await attach(h.bridge);
      for (const x of texts) h.bridge.forward(CHAT, x);
      await p.promise;
    }

    it("PreToolUse, MessageDisplay and Stop never confirm delivery", async () => {
      const h = setup({ deliveryTimeoutMs: 1000 });
      await deliver(h);
      h.sender.sendMessage.mockClear();
      await h.bridge.handleHook("PreToolUse", 100, { tool_name: "Bash", tool_input: { command: "ls" } });
      await h.bridge.handleHook("MessageDisplay", 100, { delta: "x", final: true });
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "terminal answer" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.sender.sendMessage).toHaveBeenCalledTimes(1);
      expect(h.sender.sendMessage.mock.calls[0][1]).toMatch(/not delivered/i);
      expect(h.sender.createProcessingMessage).not.toHaveBeenCalled();
      h.bridge.stop();
    });

    it("a UserPromptSubmit without a marker does not confirm and starts no Telegram turn", async () => {
      const h = setup({ deliveryTimeoutMs: 1000 });
      await deliver(h);
      h.sender.sendMessage.mockClear();
      await h.bridge.handleHook("UserPromptSubmit", 100, { prompt: "typed in terminal" });
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "terminal answer" });
      expect(h.sender.sendMessage).not.toHaveBeenCalledWith(CHAT, "terminal answer");
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.sender.sendMessage.mock.calls.at(-1)?.[1]).toMatch(/not delivered/i);
      h.bridge.stop();
    });

    it("a marker with a wrong id does not confirm (id 1 is not id 11)", async () => {
      const h = setup({ deliveryTimeoutMs: 1000 });
      await deliver(h);
      h.sender.sendMessage.mockClear();
      await h.bridge.handleHook("UserPromptSubmit", 100, { prompt: framePrompt(11) });
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "no" });
      expect(h.sender.sendMessage).not.toHaveBeenCalledWith(CHAT, "no");
      h.bridge.stop();
    });

    it("confirms all ids found in one prompt", async () => {
      const h = setup({ deliveryTimeoutMs: 1000 });
      await deliver(h, ["a", "b"]);
      await startPoll(h.bridge).promise; // takes "b" (the first poll got only "a")
      h.sender.sendMessage.mockClear();
      await h.bridge.handleHook("UserPromptSubmit", 100, { prompt: framePrompt(1, 2) });
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.sender.sendMessage).not.toHaveBeenCalled();
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "both" });
      expect(h.sender.sendMessage).toHaveBeenCalledWith(CHAT, "both");
      h.bridge.stop();
    });

    it("busy terminal turn + forwarded message: terminal Stop is not sent, rewake Stop is sent", async () => {
      const h = setup({ deliveryTimeoutMs: 1000 });
      const p = startPoll(h.bridge);
      await attach(h.bridge);
      await h.bridge.handleHook("UserPromptSubmit", 100, { prompt: "terminal work" });
      h.bridge.forward(CHAT, "from telegram");
      await p.promise;
      h.sender.sendMessage.mockClear();
      await h.bridge.handleHook("PreToolUse", 100, { tool_name: "Bash", tool_input: { command: "ls" } });
      await h.bridge.handleHook("MessageDisplay", 100, { delta: "terminal text", final: true });
      await vi.advanceTimersByTimeAsync(10_000); // busy: no "not delivered" notice
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "terminal answer" });
      expect(h.sender.sendMessage).not.toHaveBeenCalled();
      expect(h.sender.createProcessingMessage).not.toHaveBeenCalled();
      // rewake turn
      await h.bridge.handleHook("UserPromptSubmit", 100, { prompt: framePrompt(1) });
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.sender.sendMessage).not.toHaveBeenCalled(); // timer was cleared by the confirmation
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "telegram answer" });
      expect(h.sender.sendMessage).toHaveBeenCalledTimes(1);
      expect(h.sender.sendMessage).toHaveBeenCalledWith(CHAT, "telegram answer");
      h.bridge.stop();
    });
  });

  describe("busy session and delivery timeout", () => {
    it("does not fire while busy and (re)starts the timer when the session becomes idle", async () => {
      const h = setup({ deliveryTimeoutMs: 1000 });
      const p = startPoll(h.bridge);
      await attach(h.bridge);
      await h.bridge.handleHook("UserPromptSubmit", 100, { prompt: "terminal" });
      h.bridge.forward(CHAT, "queued");
      await p.promise;
      h.sender.sendMessage.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.sender.sendMessage).not.toHaveBeenCalled();
      await h.bridge.handleHook("Stop", 100, {});
      await vi.advanceTimersByTimeAsync(999);
      expect(h.sender.sendMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.sender.sendMessage).toHaveBeenCalledWith(CHAT, expect.stringMatching(/not delivered/i));
      h.bridge.stop();
    });

    it("StopFailure also makes the session idle", async () => {
      const h = setup({ deliveryTimeoutMs: 1000 });
      const p = startPoll(h.bridge);
      await attach(h.bridge);
      await h.bridge.handleHook("UserPromptSubmit", 100, { prompt: "terminal" });
      h.bridge.forward(CHAT, "queued");
      await p.promise;
      h.sender.sendMessage.mockClear();
      await h.bridge.handleHook("StopFailure", 100, {});
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.sender.sendMessage).toHaveBeenCalledWith(CHAT, expect.stringMatching(/not delivered/i));
      h.bridge.stop();
    });

    it("a late matching UserPromptSubmit after the notice still makes the turn Telegram-origin", async () => {
      const h = setup({ deliveryTimeoutMs: 1000 });
      const p = startPoll(h.bridge);
      await attach(h.bridge);
      h.bridge.forward(CHAT, "slow");
      await p.promise;
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.sender.sendMessage).toHaveBeenCalledWith(CHAT, expect.stringMatching(/not delivered/i));
      h.sender.sendMessage.mockClear();
      await h.bridge.handleHook("UserPromptSubmit", 100, { prompt: framePrompt(1) });
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "late answer" });
      expect(h.sender.sendMessage).toHaveBeenCalledTimes(1);
      expect(h.sender.sendMessage).toHaveBeenCalledWith(CHAT, "late answer");
      h.bridge.stop();
    });

    it("forgets timed-out messages after 5 minutes", async () => {
      const h = setup({ deliveryTimeoutMs: 1000 });
      const p = startPoll(h.bridge);
      await attach(h.bridge);
      h.bridge.forward(CHAT, "slow");
      await p.promise;
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 2000);
      h.sender.sendMessage.mockClear();
      await h.bridge.handleHook("UserPromptSubmit", 100, { prompt: framePrompt(1) });
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "too late" });
      expect(h.sender.sendMessage).not.toHaveBeenCalled();
      h.bridge.stop();
    });
  });

  describe("stale turns and StopFailure", () => {
    async function startTelegramTurn(h: Harness) {
      const p = startPoll(h.bridge);
      await attach(h.bridge);
      h.bridge.forward(CHAT, "work");
      await p.promise;
      await h.bridge.handleHook("UserPromptSubmit", 100, { prompt: framePrompt(1) });
      h.sender.sendMessage.mockClear();
    }

    it("StopFailure on a Telegram turn sends a short notice and no final answer", async () => {
      const h = setup();
      await startTelegramTurn(h);
      await h.bridge.handleHook("StopFailure", 100, { error: "rate_limit" });
      expect(h.sender.sendMessage).toHaveBeenCalledTimes(1);
      expect(h.sender.sendMessage.mock.calls[0][1]).toMatch(/turn failed/i);
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "zombie" });
      expect(h.sender.sendMessage).toHaveBeenCalledTimes(1);
      h.bridge.stop();
    });

    it("StopFailure on a terminal turn sends nothing", async () => {
      const h = setup();
      startPoll(h.bridge);
      await attach(h.bridge);
      h.sender.sendMessage.mockClear();
      await h.bridge.handleHook("UserPromptSubmit", 100, { prompt: "terminal" });
      await h.bridge.handleHook("StopFailure", 100, {});
      expect(h.sender.sendMessage).not.toHaveBeenCalled();
      h.bridge.stop();
    });

    it("a terminal prompt after an interrupted Telegram turn clears the stale turn (no final send)", async () => {
      const h = setup();
      await startTelegramTurn(h);
      await h.bridge.handleHook("PreToolUse", 100, { tool_name: "Bash", tool_input: { command: "sleep 100" } });
      // user interrupts: no Stop event. Then types in the terminal.
      h.sender.sendMessage.mockClear();
      await h.bridge.handleHook("UserPromptSubmit", 100, { prompt: "new terminal prompt" });
      expect(h.sender.sendMessage).toHaveBeenCalledWith(CHAT, "Turn ended: a prompt was typed in the terminal.");
      h.sender.sendMessage.mockClear();
      await h.bridge.handleHook("PreToolUse", 100, { tool_name: "Read", tool_input: { file_path: "/x" } });
      await vi.advanceTimersByTimeAsync(10_000);
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "terminal answer" });
      expect(h.sender.sendMessage).not.toHaveBeenCalled();
      h.bridge.stop();
    });

    it("a new rewake prompt replaces a stale turn", async () => {
      const h = setup();
      await startTelegramTurn(h);
      const p2 = startPoll(h.bridge);
      h.bridge.forward(CHAT, "second");
      await p2.promise;
      await h.bridge.handleHook("UserPromptSubmit", 100, { prompt: framePrompt(2) });
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "second answer" });
      expect(h.sender.sendMessage).toHaveBeenCalledTimes(1);
      expect(h.sender.sendMessage).toHaveBeenCalledWith(CHAT, "second answer");
      h.bridge.stop();
    });
  });

  describe("MessageDisplay blocks", () => {
    it("separates consecutive blocks with a blank line", async () => {
      const h = setup();
      const p = startPoll(h.bridge);
      await attach(h.bridge);
      h.bridge.forward(CHAT, "x");
      await p.promise;
      await h.bridge.handleHook("UserPromptSubmit", 100, { prompt: framePrompt(1) });
      await h.bridge.handleHook("MessageDisplay", 100, { delta: "First block.", final: false });
      await h.bridge.handleHook("MessageDisplay", 100, { delta: "Second block.\n", final: false });
      await h.bridge.handleHook("MessageDisplay", 100, { delta: "Third block.", final: true });
      await h.bridge.handleHook("PreToolUse", 100, { tool_name: "Bash", tool_input: { command: "ls" } });
      await vi.advanceTimersByTimeAsync(5000);
      const text = h.sender.createProcessingMessage.mock.calls[0][1] as string;
      expect(text).toContain("First block.\n\nSecond block.\nThird block.");
      h.bridge.stop();
    });
  });

  describe("poll abort race", () => {
    it("keeps messages queued when the waiter signal is already aborted at hand-out", async () => {
      const h = setup();
      // A signal that is aborted but did not fire its event (race).
      const fake = { aborted: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
      const first = h.bridge.poll({ pid: 100, cwd: "/w/ws", name: "ws", signal: fake as unknown as AbortSignal });
      await attach(h.bridge);
      fake.aborted = true;
      h.bridge.forward(CHAT, "keep me");
      expect(await first).toEqual({ kind: "timeout" });
      // the message was not marked sent: no delivery timeout notice (only the "not listening" notice, once)
      h.sender.sendMessage.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.sender.sendMessage).toHaveBeenCalledTimes(1);
      expect(h.sender.sendMessage.mock.calls[0][1]).toMatch(/not listening/);
      const r = await startPoll(h.bridge).promise;
      expect(r).toEqual({ kind: "messages", messages: [{ msgId: 1, text: "keep me" }] });
      h.bridge.stop();
    });
  });

  describe("turns, progress and final answer", () => {
    async function startTurn(h: Harness) {
      const p = startPoll(h.bridge);
      await attach(h.bridge);
      h.bridge.forward(CHAT, "work");
      await p.promise;
      h.sender.sendMessage.mockClear();
      await h.bridge.handleHook("UserPromptSubmit", 100, { prompt: framePrompt(1) });
    }

    it("sends the final answer from Stop exactly once", async () => {
      const h = setup();
      await startTurn(h);
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "All done." });
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "All done." });
      expect(h.sender.sendMessage).toHaveBeenCalledTimes(1);
      expect(h.sender.sendMessage).toHaveBeenCalledWith(CHAT, "All done.");
      h.bridge.stop();
    });

    it("does not send anything for a terminal turn", async () => {
      const h = setup();
      startPoll(h.bridge);
      await attach(h.bridge);
      h.sender.sendMessage.mockClear();
      await h.bridge.handleHook("UserPromptSubmit", 100, { prompt: "typed in terminal" });
      await h.bridge.handleHook("PreToolUse", 100, { tool_name: "Bash", tool_input: { command: "ls" } });
      await h.bridge.handleHook("MessageDisplay", 100, { text: "hi" });
      await vi.advanceTimersByTimeAsync(10_000);
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "terminal answer" });
      expect(h.sender.sendMessage).not.toHaveBeenCalled();
      expect(h.sender.createProcessingMessage).not.toHaveBeenCalled();
      h.bridge.stop();
    });

    it("a terminal turn after a Telegram turn is ignored again", async () => {
      const h = setup();
      await startTurn(h);
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "A" });
      h.sender.sendMessage.mockClear();
      await h.bridge.handleHook("UserPromptSubmit", 100, {});
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "B" });
      expect(h.sender.sendMessage).not.toHaveBeenCalled();
      h.bridge.stop();
    });

    it("creates one processing message after the first tool and updates it", async () => {
      const h = setup();
      await startTurn(h);
      await h.bridge.handleHook("MessageDisplay", 100, { delta: "Thinking about it. ", final: false });
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.sender.createProcessingMessage).not.toHaveBeenCalled(); // accumulator waits for a tool
      await h.bridge.handleHook("PreToolUse", 100, { tool_name: "Bash", tool_input: { command: "ls -la" } });
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.sender.createProcessingMessage).toHaveBeenCalledTimes(1);
      const [sourceId, text] = h.sender.createProcessingMessage.mock.calls[0];
      expect(sourceId).toBe(CHAT);
      expect(text).toContain("Thinking about it.");
      expect(text).toContain("Running: ls -la");
      await h.bridge.handleHook("PreToolUse", 100, { tool_name: "Read", tool_input: { file_path: "/a/b" } });
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.sender.createProcessingMessage).toHaveBeenCalledTimes(1);
      expect(h.sender.updateProcessingMessage).toHaveBeenCalledWith(CHAT, "pm-1", expect.stringContaining("Reading /a/b"), undefined);
      h.bridge.stop();
    });

    it("trims the final text from the processing message, then sends it as a new message", async () => {
      const h = setup();
      await startTurn(h);
      await h.bridge.handleHook("PreToolUse", 100, { tool_name: "Bash", tool_input: { command: "ls" } });
      await h.bridge.handleHook("MessageDisplay", 100, { delta: "The answer is 42", final: true });
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "The answer is 42" });
      expect(h.sender.createProcessingMessage).toHaveBeenCalledTimes(1);
      const lastUpdate = h.sender.updateProcessingMessage.mock.calls.at(-1);
      expect(lastUpdate?.[2]).not.toContain("The answer is 42");
      expect(lastUpdate?.[2]).toContain("Running: ls");
      expect(h.sender.sendMessage).toHaveBeenCalledWith(CHAT, "The answer is 42");
      // trim happens before the final message is sent
      const trimOrder = h.sender.updateProcessingMessage.mock.invocationCallOrder.at(-1) as number;
      const sendOrder = h.sender.sendMessage.mock.invocationCallOrder.at(-1) as number;
      expect(trimOrder).toBeLessThan(sendOrder);
      h.bridge.stop();
    });

    it("skips progress when config.progress is false but still sends the final answer", async () => {
      const h = setup({ progress: false });
      await startTurn(h);
      await h.bridge.handleHook("PreToolUse", 100, { tool_name: "Bash", tool_input: { command: "ls" } });
      await vi.advanceTimersByTimeAsync(10_000);
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "ok" });
      expect(h.sender.createProcessingMessage).not.toHaveBeenCalled();
      expect(h.sender.sendMessage).toHaveBeenCalledWith(CHAT, "ok");
      h.bridge.stop();
    });

    it("sends a placeholder when Stop has no message text", async () => {
      const h = setup();
      await startTurn(h);
      await h.bridge.handleHook("Stop", 100, {});
      expect(h.sender.sendMessage).toHaveBeenCalledTimes(1);
      expect(h.sender.sendMessage.mock.calls[0][1]).toMatch(/without a text answer/);
      h.bridge.stop();
    });

    it("applies redact to the final answer", async () => {
      const h = setup({}, { redact: (t) => t.replace(/secret/g, "[X]") });
      await startTurn(h);
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "the secret" });
      expect(h.sender.sendMessage).toHaveBeenCalledWith(CHAT, "the [X]");
      h.bridge.stop();
    });

    it("handles unknown payload shapes without throwing", async () => {
      const h = setup();
      await startTurn(h);
      for (const payload of [null, undefined, 42, "str", [], { tool_name: 5 }, { tool_input: "x" }]) {
        await expect(h.bridge.handleHook("PreToolUse", 100, payload)).resolves.toBeUndefined();
        await expect(h.bridge.handleHook("MessageDisplay", 100, payload)).resolves.toBeUndefined();
        await expect(h.bridge.handleHook("Notification", 100, payload)).resolves.toBeUndefined();
      }
      await expect(h.bridge.handleHook("Stop", 999, {})).resolves.toBeUndefined();
      h.bridge.stop();
    });

    it("sends a short notice for Notification when attached", async () => {
      const h = setup();
      startPoll(h.bridge);
      await attach(h.bridge);
      h.sender.sendMessage.mockClear();
      await h.bridge.handleHook("Notification", 100, { message: "Claude needs your attention" });
      expect(h.sender.sendMessage).toHaveBeenCalledWith(CHAT, expect.stringContaining("Claude needs your attention"));
      h.bridge.stop();
    });

    it("does not send Notification when not attached", async () => {
      const h = setup();
      startPoll(h.bridge);
      await h.bridge.handleHook("Notification", 100, { message: "x" });
      expect(h.sender.sendMessage).not.toHaveBeenCalled();
      h.bridge.stop();
    });

    it("still delivers the final answer of a running turn after /detach", async () => {
      const h = setup();
      await startTurn(h);
      await h.bridge.control({ action: "detach", chatId: CHAT });
      h.sender.sendMessage.mockClear();
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "late" });
      expect(h.sender.sendMessage).toHaveBeenCalledWith(CHAT, "late");
      h.bridge.stop();
    });
    it("hides the terminal echo line in the processing message and in the final answer", async () => {
      const h = setup();
      await startTurn(h);
      await h.bridge.handleHook("MessageDisplay", 100, { delta: "Zpráva: open alza\n\nOn it.", final: false });
      await h.bridge.handleHook("PreToolUse", 100, { tool_name: "Bash", tool_input: { command: "ls" } });
      await vi.advanceTimersByTimeAsync(5000);
      const [, shown] = h.sender.createProcessingMessage.mock.calls[0]!;
      expect(shown).toContain("On it.");
      expect(shown).not.toContain("Zpráva:");
      h.sender.sendMessage.mockClear();
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "Zpráva: open alza\n\nDone, 3 results." });
      expect(h.sender.sendMessage).toHaveBeenCalledWith(CHAT, "Done, 3 results.");
      h.bridge.stop();
    });
  });

  describe("SessionEnd, liveness and idle", () => {
    it("SessionEnd unregisters the session, detaches and notifies", async () => {
      const h = setup();
      const p = startPoll(h.bridge);
      await attach(h.bridge);
      h.sender.sendMessage.mockClear();
      await h.bridge.handleHook("SessionEnd", 100, {});
      expect(h.bridge.isAttached(CHAT)).toBe(false);
      expect((await h.bridge.control({ action: "status", chatId: CHAT })).sessions).toEqual([]);
      expect(h.sender.sendMessage).toHaveBeenCalledWith(CHAT, expect.stringMatching(/ended/));
      expect(await p.promise).toEqual({ kind: "replaced" });
      h.bridge.stop();
    });

    it("SessionEnd during a Telegram turn sends no final answer", async () => {
      const h = setup();
      const p = startPoll(h.bridge);
      await attach(h.bridge);
      h.bridge.forward(CHAT, "x");
      await p.promise;
      await h.bridge.handleHook("UserPromptSubmit", 100, { prompt: framePrompt(1) });
      h.sender.sendMessage.mockClear();
      await h.bridge.handleHook("SessionEnd", 100, {});
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "zombie" });
      expect(h.sender.sendMessage).toHaveBeenCalledTimes(1);
      expect(h.sender.sendMessage).not.toHaveBeenCalledWith(CHAT, "zombie");
      h.bridge.stop();
    });

    it("removes a dead session at the 30 s liveness check", async () => {
      const h = setup();
      startPoll(h.bridge, 100, "a");
      startPoll(h.bridge, 200, "b");
      await attach(h.bridge, "1");
      h.alive.delete(100);
      h.sender.sendMessage.mockClear();
      await vi.advanceTimersByTimeAsync(REMOTE_LIVENESS_INTERVAL_MS);
      expect(h.bridge.isAttached(CHAT)).toBe(false);
      const status = await h.bridge.control({ action: "status", chatId: CHAT });
      expect(status.sessions.map((s) => s.pid)).toEqual([200]);
      expect(h.sender.sendMessage).toHaveBeenCalledWith(CHAT, expect.stringMatching(/process is gone/));
      h.bridge.stop();
    });

    it("keeps live sessions at the liveness check", async () => {
      const h = setup();
      startPoll(h.bridge);
      await attach(h.bridge);
      await vi.advanceTimersByTimeAsync(REMOTE_LIVENESS_INTERVAL_MS * 3);
      expect(h.bridge.isAttached(CHAT)).toBe(true);
      h.bridge.stop();
    });

    it("detaches after the idle timeout without Telegram traffic", async () => {
      const h = setup({ idleDetachMinutes: 10 });
      const p = startPoll(h.bridge);
      await attach(h.bridge);
      h.sender.sendMessage.mockClear();
      await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
      expect(h.bridge.isAttached(CHAT)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.bridge.isAttached(CHAT)).toBe(false);
      expect(h.sender.sendMessage).toHaveBeenCalledWith(CHAT, expect.stringMatching(/no Telegram messages/));
      // the session stays registered (the poll only ended by its own 55 s timeout)
      expect(p.results).toEqual([{ kind: "timeout" }]);
      expect((await h.bridge.control({ action: "status", chatId: CHAT })).sessions).toHaveLength(1);
      h.bridge.stop();
    });

    it("Telegram traffic resets the idle timer", async () => {
      const h = setup({ idleDetachMinutes: 10 });
      startPoll(h.bridge);
      await attach(h.bridge);
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      h.bridge.forward(CHAT, "ping");
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      expect(h.bridge.isAttached(CHAT)).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.bridge.isAttached(CHAT)).toBe(false);
      h.bridge.stop();
    });

    it("stop clears timers: no idle or liveness activity afterwards", async () => {
      const h = setup({ idleDetachMinutes: 1 });
      startPoll(h.bridge);
      await attach(h.bridge);
      h.bridge.stop();
      h.sender.sendMessage.mockClear();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(h.sender.sendMessage).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("round 2 fixes", () => {
    async function telegramTurn(h: Harness, pid = 100) {
      const p = startPoll(h.bridge, pid);
      await attach(h.bridge);
      h.bridge.forward(CHAT, "work");
      await p.promise;
      await h.bridge.handleHook("UserPromptSubmit", pid, { prompt: framePrompt(1) });
      h.sender.sendMessage.mockClear();
    }

    it("warns once when a queued message is not taken by a poll, and keeps it queued", async () => {
      const h = setup({ deliveryTimeoutMs: 1000 });
      const p = startPoll(h.bridge);
      await attach(h.bridge);
      h.bridge.forward(CHAT, "one"); // the waiter takes it at once
      await p.promise;
      await h.bridge.handleHook("UserPromptSubmit", 100, { prompt: framePrompt(1) });
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "ok" });
      h.sender.sendMessage.mockClear();
      h.bridge.forward(CHAT, "two"); // no waiter now
      await vi.advanceTimersByTimeAsync(999);
      expect(h.sender.sendMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.sender.sendMessage).toHaveBeenCalledTimes(1);
      expect(h.sender.sendMessage.mock.calls[0][1]).toMatch(/not listening right now/);
      h.bridge.forward(CHAT, "three");
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.sender.sendMessage).toHaveBeenCalledTimes(1); // once per batch
      const r = await startPoll(h.bridge).promise;
      expect(r).toEqual({
        kind: "messages",
        messages: [expect.objectContaining({ text: "two" }), expect.objectContaining({ text: "three" })],
      });
      h.bridge.stop();
    });

    it("does not warn when a poll takes the message in time", async () => {
      const h = setup({ deliveryTimeoutMs: 1000 });
      const ctrl = new AbortController();
      startPoll(h.bridge, 100, "ws", ctrl.signal);
      await attach(h.bridge);
      ctrl.abort(); // the first poll ends: no waiter
      h.bridge.forward(CHAT, "x"); // queued
      h.sender.sendMessage.mockClear();
      await vi.advanceTimersByTimeAsync(500);
      await startPoll(h.bridge).promise; // takes it
      await h.bridge.handleHook("UserPromptSubmit", 100, { prompt: framePrompt(1) });
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.sender.sendMessage).not.toHaveBeenCalled();
      h.bridge.stop();
    });

    it("a poll clears a stale busy flag (no Stop after Esc), so delivery timers run again", async () => {
      const h = setup({ deliveryTimeoutMs: 1000 });
      const p = startPoll(h.bridge);
      await attach(h.bridge);
      await h.bridge.handleHook("UserPromptSubmit", 100, { prompt: "terminal work" }); // busy, then Esc: no Stop
      h.bridge.forward(CHAT, "hello");
      await p.promise;
      h.sender.sendMessage.mockClear();
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.sender.sendMessage).not.toHaveBeenCalled(); // still busy: timer paused
      startPoll(h.bridge); // listener re-armed
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.sender.sendMessage).toHaveBeenCalledWith(CHAT, expect.stringMatching(/Not delivered/));
      h.bridge.stop();
    });

    it("retries the final answer and sends it on the 3rd try (1 s, 3 s delays)", async () => {
      const h = setup();
      await telegramTurn(h);
      h.sender.sendMessage.mockRejectedValueOnce(new Error("net")).mockRejectedValueOnce(new Error("net"));
      const done = h.bridge.handleHook("Stop", 100, { last_assistant_message: "answer" });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.sender.sendMessage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.sender.sendMessage).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2999);
      expect(h.sender.sendMessage).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(h.sender.sendMessage).toHaveBeenCalledTimes(3);
      expect(h.sender.sendMessage).toHaveBeenLastCalledWith(CHAT, "answer");
      h.bridge.stop();
    });

    it("sends a failure notice when all 3 tries fail, and honours retry_after", async () => {
      const h = setup();
      await telegramTurn(h);
      const err = Object.assign(new Error("429"), { parameters: { retry_after: 7 } });
      h.sender.sendMessage.mockRejectedValueOnce(err).mockRejectedValueOnce(new Error("x")).mockRejectedValueOnce(new Error("x"));
      const done = h.bridge.handleHook("Stop", 100, { last_assistant_message: "answer" });
      await vi.advanceTimersByTimeAsync(6999);
      expect(h.sender.sendMessage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.sender.sendMessage).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(3000);
      await done;
      expect(h.sender.sendMessage).toHaveBeenCalledTimes(4);
      expect(h.sender.sendMessage).toHaveBeenLastCalledWith(CHAT, "Answer could not be delivered (Telegram error).");
      h.bridge.stop();
    });

    it("a second Stop during the retries does not send a second answer", async () => {
      const h = setup();
      await telegramTurn(h);
      h.sender.sendMessage.mockRejectedValueOnce(new Error("net"));
      const first = h.bridge.handleHook("Stop", 100, { last_assistant_message: "answer" });
      await vi.advanceTimersByTimeAsync(0);
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "answer" });
      await vi.advanceTimersByTimeAsync(1000);
      await first;
      expect(h.sender.sendMessage).toHaveBeenCalledTimes(2);
      h.bridge.stop();
    });

    it("SessionEnd resolves a pending waiter with replaced and a late poll of the pid is replaced (tombstone)", async () => {
      const h = setup();
      const p = startPoll(h.bridge);
      await h.bridge.handleHook("SessionEnd", 100, { reason: "other" });
      expect(await p.promise).toEqual({ kind: "replaced" });
      expect(await startPoll(h.bridge).promise).toEqual({ kind: "replaced" });
      expect((await h.bridge.control({ action: "status", chatId: CHAT })).sessions).toEqual([]);
      await vi.advanceTimersByTimeAsync(60_001);
      startPoll(h.bridge); // tombstone expired: registers again
      expect((await h.bridge.control({ action: "status", chatId: CHAT })).sessions).toHaveLength(1);
      h.bridge.stop();
    });

    it("the liveness check clears a tombstone when the pid is dead", async () => {
      const h = setup();
      startPoll(h.bridge);
      await h.bridge.handleHook("SessionEnd", 100, {});
      h.alive.delete(100);
      await vi.advanceTimersByTimeAsync(REMOTE_LIVENESS_INTERVAL_MS);
      h.alive.add(100); // the pid is reused by a new process
      startPoll(h.bridge);
      expect((await h.bridge.control({ action: "status", chatId: CHAT })).sessions).toHaveLength(1);
      h.bridge.stop();
    });

    it.each(["clear", "resume"])("ignores SessionEnd with reason %s", async (reason) => {
      const h = setup();
      startPoll(h.bridge);
      await attach(h.bridge);
      await h.bridge.handleHook("SessionEnd", 100, { reason });
      expect(h.bridge.isAttached(CHAT)).toBe(true);
      expect((await h.bridge.control({ action: "status", chatId: CHAT })).sessions).toHaveLength(1);
      h.bridge.stop();
    });

    it("session numbers are stable: not reused and not shifted after a removal", async () => {
      const h = setup();
      startPoll(h.bridge, 100, "a");
      startPoll(h.bridge, 200, "b");
      await h.bridge.handleHook("SessionEnd", 100, {});
      const status = await h.bridge.control({ action: "status", chatId: CHAT });
      expect(status.sessions.map((s) => s.index)).toEqual([2]);
      expect(status.message).toContain("2. b");
      h.alive.add(300);
      startPoll(h.bridge, 300, "c");
      const res = await attach(h.bridge, "3");
      expect(res.sessions.find((s) => s.attachedChatId)?.pid).toBe(300);
      expect((await attach(h.bridge, "1")).ok).toBe(false);
      h.bridge.stop();
    });

    it("subagent events: MessageDisplay ignored, PreToolUse prefixed, no turn start or end", async () => {
      const h = setup();
      await telegramTurn(h);
      await h.bridge.handleHook("MessageDisplay", 100, { delta: "sub text", agent_id: "ag1" });
      await h.bridge.handleHook("PreToolUse", 100, { tool_name: "Grep", tool_input: { pattern: "x" }, agent_id: "ag1" });
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "sub done", agent_id: "ag1" });
      await h.bridge.handleHook("UserPromptSubmit", 100, { prompt: "sub prompt", agent_id: "ag1" });
      await vi.advanceTimersByTimeAsync(5000);
      const text = h.sender.createProcessingMessage.mock.calls[0][1] as string;
      expect(text).toContain("(subagent) Grep");
      expect(text).not.toContain("sub text");
      expect(h.sender.sendMessage).not.toHaveBeenCalled();
      await h.bridge.handleHook("Stop", 100, { last_assistant_message: "real answer" });
      expect(h.sender.sendMessage).toHaveBeenCalledWith(CHAT, "real answer");
      h.bridge.stop();
    });

    it("caps cwd at 300 and name at 80 characters", async () => {
      const h = setup();
      void h.bridge.poll({ pid: 100, cwd: "c".repeat(500), name: "n".repeat(200), signal: new AbortController().signal });
      const s = (await h.bridge.control({ action: "status", chatId: CHAT })).sessions[0]!;
      expect(s.cwd).toHaveLength(300);
      expect(s.name).toHaveLength(80);
      await h.bridge.handleHook("PreToolUse", 100, {}, "d".repeat(500));
      expect((await h.bridge.control({ action: "status", chatId: CHAT })).sessions[0]!.cwd).toHaveLength(300);
      h.bridge.stop();
    });

    it("does not send the terminal-prompt notice for a terminal turn", async () => {
      const h = setup();
      startPoll(h.bridge);
      await attach(h.bridge);
      h.sender.sendMessage.mockClear();
      await h.bridge.handleHook("UserPromptSubmit", 100, { prompt: "a" });
      await h.bridge.handleHook("UserPromptSubmit", 100, { prompt: "b" });
      expect(h.sender.sendMessage).not.toHaveBeenCalled();
      h.bridge.stop();
    });
  });
});
