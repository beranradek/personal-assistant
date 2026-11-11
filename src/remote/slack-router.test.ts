import { describe, it, expect, vi } from "vitest";
import { createSlackRouter } from "./slack-router.js";
import type { AdapterMessage } from "../core/types.js";
import type { RemoteBridge, RemoteControlResponse } from "./protocol.js";

function makeBridge(attached = false) {
  return {
    isAttached: vi.fn(() => attached),
    forward: vi.fn(() => ({ accepted: true as const, msgId: 1 })),
    control: vi.fn(async (): Promise<RemoteControlResponse> => ({ ok: true, message: "ok", sessions: [] })),
  };
}

function setup(attached = false) {
  const bridge = makeBridge(attached);
  const enqueue = vi.fn();
  const send = vi.fn(async () => undefined);
  const router = createSlackRouter({ bridge: bridge as unknown as RemoteBridge, enqueue, send });
  return { bridge, enqueue, send, router };
}

const dm = (text: string, extra: Record<string, unknown> = {}): AdapterMessage => ({
  source: "slack",
  sourceId: "D1--5.5",
  text,
  metadata: { channelId: "D1", threadId: "5.5", messageTs: "5.5", userId: "U1", channelType: "im", ...extra },
});

describe("slack router onMessage", () => {
  it("enqueues a DM when not attached", () => {
    const { router, enqueue, bridge } = setup(false);
    const msg = dm("hello");
    router.onMessage(msg);
    expect(enqueue).toHaveBeenCalledWith(msg);
    expect(bridge.forward).not.toHaveBeenCalled();
    expect(bridge.isAttached).toHaveBeenCalledWith("slack:U1");
  });

  it("forwards a DM when attached with the channel:ts ref", () => {
    const { router, enqueue, bridge } = setup(true);
    router.onMessage(dm("hello"));
    expect(bridge.forward).toHaveBeenCalledWith("slack:U1", "hello", "D1:5.5");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("forwards a thread reply in a DM using its own ts", () => {
    const { router, bridge } = setup(true);
    router.onMessage(dm("reply", { threadId: "5.5", messageTs: "6.6" }));
    expect(bridge.forward).toHaveBeenCalledWith("slack:U1", "reply", "D1:6.6");
  });

  it("enqueues an im message without metadata.userId and never reaches the bridge", () => {
    const { router, enqueue, bridge } = setup(true);
    const msg = dm("hello", { userId: undefined });
    router.onMessage(msg);
    expect(enqueue).toHaveBeenCalledWith(msg);
    expect(bridge.isAttached).not.toHaveBeenCalled();
    expect(bridge.forward).not.toHaveBeenCalled();
  });

  it("never calls the bridge for non-DM channels, even when attached", () => {
    const { router, enqueue, bridge } = setup(true);
    for (const channelType of ["channel", "group", "mpim", undefined]) {
      router.onMessage(dm("x", { channelType }));
    }
    expect(bridge.forward).not.toHaveBeenCalled();
    expect(bridge.isAttached).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(4);
  });

  it("passes non-slack sources through", () => {
    const { router, enqueue, bridge } = setup(true);
    const msg: AdapterMessage = { source: "telegram", sourceId: "1", text: "x" };
    router.onMessage(msg);
    expect(enqueue).toHaveBeenCalledWith(msg);
    expect(bridge.forward).not.toHaveBeenCalled();
  });

  it("decodes inbound Slack text before forwarding", () => {
    const { router, bridge } = setup(true);
    router.onMessage(dm("a &amp; b &lt;c&gt; <https://x.io|label> <https://y.io> <@U1>"));
    expect(bridge.forward).toHaveBeenCalledWith("slack:U1", "a & b <c> label (https://x.io) https://y.io @U1", "D1:5.5");
  });

  it("sends a DM notice when the forward is rejected", () => {
    const { router, bridge, send } = setup(true);
    bridge.forward.mockReturnValueOnce({ accepted: false, reason: "queue full" } as never);
    router.onMessage(dm("x"));
    expect(send).toHaveBeenCalledWith("U1", "Not sent to the session: queue full");
  });

  it("survives a failing notice send", async () => {
    const { router, bridge, send } = setup(true);
    bridge.forward.mockReturnValueOnce({ accepted: false, reason: "r" } as never);
    send.mockRejectedValueOnce(new Error("down"));
    expect(() => router.onMessage(dm("x"))).not.toThrow();
    await Promise.resolve();
  });
});

describe("slack router onCommand", () => {
  const cmd = (text: string, channelId = "D1") => ({ userId: "U1", text, channelId });

  it("shows help for empty, help and unknown text, with the state", async () => {
    const off = setup(false);
    for (const t of ["", "help", "bogus"]) {
      const out = await off.router.onCommand(cmd(t));
      expect(out).toContain("/cc attach");
      expect(out).toContain("Now: not attached.");
    }
    expect(await setup(true).router.onCommand(cmd(""))).toContain("Now: attached.");
    expect(off.bridge.control).not.toHaveBeenCalled();
  });

  it("status returns the bridge message", async () => {
    const { router, bridge } = setup();
    bridge.control.mockResolvedValueOnce({ ok: true, message: "1: proj", sessions: [] });
    expect(await router.onCommand(cmd("status"))).toBe("1: proj");
    expect(bridge.control).toHaveBeenCalledWith({ action: "status", chatId: "slack:U1" });
  });

  it.each([
    ["attach", { action: "attach", chatId: "slack:U1" }],
    ["attach 2", { action: "attach", chatId: "slack:U1", target: "2" }],
    ["attach my proj", { action: "attach", chatId: "slack:U1", target: "my proj" }],
    ["ATTACH 2 force", { action: "attach", chatId: "slack:U1", target: "2", force: true }],
    ["detach", { action: "detach", chatId: "slack:U1" }],
  ])("parses %s", async (text, expected) => {
    const { router, bridge } = setup();
    expect(await router.onCommand(cmd(text))).toBeUndefined();
    expect(bridge.control).toHaveBeenCalledWith(expected);
  });

  it("returns failures and adds a force hint for a held session", async () => {
    const { router, bridge } = setup();
    bridge.control.mockResolvedValue({ ok: false, message: "p is attached to another chat.", sessions: [] });
    expect(await router.onCommand(cmd("attach 1"))).toBe("p is attached to another chat. To take it over: /cc attach 1 force");
    expect(await router.onCommand(cmd("attach 1 force"))).toBe("p is attached to another chat.");
    bridge.control.mockResolvedValue({ ok: false, message: "Not attached to a session.", sessions: [] });
    expect(await router.onCommand(cmd("detach"))).toBe("Not attached to a session.");
  });

  it("does not repeat the force advice of a cross-channel refusal", async () => {
    const { router, bridge } = setup();
    const message = "Session 1 (p) is attached to Telegram. Run /detach in Telegram, or attach with force to take it over.";
    bridge.control.mockResolvedValue({ ok: false, message, sessions: [] });
    expect(await router.onCommand(cmd("attach 1"))).toBe(message);
  });

  it("reports a control exception without throwing", async () => {
    const { router, bridge } = setup();
    bridge.control.mockRejectedValueOnce(new Error("boom with internal detail"));
    expect(await router.onCommand(cmd("status"))).toBe("Command failed. Please try again.");
  });

  it("pa <text> enqueues to the DM with an empty thread", async () => {
    const { router, enqueue } = setup();
    expect(await router.onCommand(cmd("pa what is up"))).toBeUndefined();
    expect(enqueue).toHaveBeenCalledWith({
      source: "slack",
      sourceId: "D1--",
      text: "what is up",
      metadata: { channelId: "D1", threadId: "", userId: "U1", channelType: "im" },
    });
  });

  it("pa without text returns usage, pa outside a DM is refused", async () => {
    const { router, enqueue } = setup();
    expect(await router.onCommand(cmd("pa"))).toMatch(/^Usage: \/cc pa/);
    expect(await router.onCommand(cmd("pa hi", "C1"))).toMatch(/direct message/);
    expect(await router.onCommand({ userId: "U1", text: "pa hi" })).toMatch(/direct message/);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
