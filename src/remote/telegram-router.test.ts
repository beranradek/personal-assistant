import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTelegramRouter } from "./telegram-router.js";
import type { RemoteBridge, RemoteControlResponse } from "./protocol.js";
import type { AdapterMessage } from "../core/types.js";

const CHAT = "111";

function msg(text: string, extra: Partial<AdapterMessage> = {}): AdapterMessage {
  return { source: "telegram", sourceId: CHAT, text, metadata: { user: "u" }, ...extra };
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("createTelegramRouter", () => {
  let attached: boolean;
  let control: ReturnType<typeof vi.fn>;
  let forward: ReturnType<typeof vi.fn>;
  let enqueue: ReturnType<typeof vi.fn>;
  let send: ReturnType<typeof vi.fn>;
  let route: (m: AdapterMessage) => void;

  beforeEach(() => {
    attached = false;
    control = vi.fn(async (): Promise<RemoteControlResponse> => ({ ok: true, message: "done", sessions: [] }));
    forward = vi.fn(() => ({ accepted: true, msgId: 1 }));
    enqueue = vi.fn();
    send = vi.fn(async () => undefined);
    const bridge = { control, forward, isAttached: () => attached, poll: vi.fn(), handleHook: vi.fn(), stop: vi.fn() } as unknown as RemoteBridge;
    route = createTelegramRouter({ bridge, enqueue, send });
  });

  it("enqueues normal text when not attached", () => {
    const m = msg("hello");
    route(m);
    expect(enqueue).toHaveBeenCalledWith(m);
    expect(forward).not.toHaveBeenCalled();
  });

  it("forwards normal text to the bridge when attached", () => {
    attached = true;
    route(msg("hello"));
    expect(forward).toHaveBeenCalledWith(CHAT, "hello");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("tells the user when forward is rejected", async () => {
    attached = true;
    forward.mockReturnValue({ accepted: false, reason: "rate limit" });
    route(msg("hello"));
    await tick();
    expect(send).toHaveBeenCalledWith(CHAT, expect.stringContaining("rate limit"));
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("/attach without argument calls control attach without target; success is not echoed (bridge confirms)", async () => {
    route(msg("/attach"));
    await tick();
    expect(control).toHaveBeenCalledWith({ action: "attach", chatId: CHAT });
    expect(send).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("/attach 2 passes the target", async () => {
    route(msg("/attach 2"));
    await tick();
    expect(control).toHaveBeenCalledWith({ action: "attach", chatId: CHAT, target: "2" });
  });

  it("/attach with a name passes the name", async () => {
    route(msg("/attach my-session"));
    await tick();
    expect(control).toHaveBeenCalledWith({ action: "attach", chatId: CHAT, target: "my-session" });
  });

  it("replies with the error message when attach fails", async () => {
    control.mockResolvedValue({ ok: false, message: "Choose one", sessions: [] });
    route(msg("/attach"));
    await tick();
    expect(send).toHaveBeenCalledWith(CHAT, "Choose one");
  });

  it("/detach calls control detach and replies only on failure", async () => {
    route(msg("/detach"));
    await tick();
    expect(control).toHaveBeenCalledWith({ action: "detach", chatId: CHAT });
    expect(send).not.toHaveBeenCalled();
    control.mockResolvedValue({ ok: false, message: "Not attached", sessions: [] });
    route(msg("/detach"));
    await tick();
    expect(send).toHaveBeenCalledWith(CHAT, "Not attached");
  });

  it("/status always replies with the message", async () => {
    control.mockResolvedValue({ ok: true, message: "1. ws", sessions: [] });
    route(msg("/status"));
    await tick();
    expect(control).toHaveBeenCalledWith({ action: "status", chatId: CHAT });
    expect(send).toHaveBeenCalledWith(CHAT, "1. ws");
  });

  it("commands work with a bot name suffix and any case", async () => {
    route(msg("/Status@my_bot"));
    await tick();
    expect(control).toHaveBeenCalledWith({ action: "status", chatId: CHAT });
  });

  it("/pa <text> goes to the normal queue with text replaced, even when attached", () => {
    attached = true;
    route(msg("/pa what is the weather?"));
    expect(enqueue).toHaveBeenCalledWith({
      source: "telegram",
      sourceId: CHAT,
      text: "what is the weather?",
      metadata: { user: "u" },
    });
    expect(forward).not.toHaveBeenCalled();
  });

  it("/pa keeps multi-line text", () => {
    route(msg("/pa line one\nline two"));
    expect(enqueue.mock.calls[0][0].text).toBe("line one\nline two");
  });

  it("/pa without text shows usage and does not enqueue", async () => {
    route(msg("/pa"));
    await tick();
    expect(enqueue).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(CHAT, expect.stringContaining("/pa"));
  });

  it("other slash text follows the normal path (forward when attached, queue otherwise)", () => {
    route(msg("/help me"));
    expect(enqueue).toHaveBeenCalledTimes(1);
    attached = true;
    route(msg("/compact now"));
    expect(forward).toHaveBeenCalledWith(CHAT, "/compact now");
  });

  it("text that merely contains a command is not a command", () => {
    route(msg("please /detach me"));
    expect(control).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("passes non-telegram messages straight to the queue", () => {
    attached = true;
    const m = msg("/status", { source: "slack" });
    route(m);
    expect(enqueue).toHaveBeenCalledWith(m);
    expect(control).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it("reports a control failure to the chat", async () => {
    control.mockRejectedValue(new Error("boom"));
    route(msg("/status"));
    await tick();
    expect(send).toHaveBeenCalledWith(CHAT, expect.stringContaining("boom"));
  });

  it("does not throw when send rejects", async () => {
    send.mockRejectedValue(new Error("tg down"));
    control.mockResolvedValue({ ok: true, message: "x", sessions: [] });
    expect(() => route(msg("/status"))).not.toThrow();
    await tick();
  });

  describe("adapter message texts (attachments and voice)", () => {
    it("forwards a document message text to the attached session", () => {
      attached = true;
      const text = "Received document and saved it to documents/telegram-inbox/a.pdf\n\nUser caption:\n/status please";
      route(msg(text, { metadata: { inputType: "document", attachments: ["documents/telegram-inbox/a.pdf"] } }));
      expect(forward).toHaveBeenCalledWith(CHAT, text);
      expect(control).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it("forwards an image message text to the attached session, else enqueues it", () => {
      const text = "Received image and saved it to images/x.jpg";
      const m = msg(text, { metadata: { inputType: "image" } });
      route(m);
      expect(enqueue).toHaveBeenCalledWith(m);
      attached = true;
      route(m);
      expect(forward).toHaveBeenCalledWith(CHAT, text);
    });

    it("forwards a voice transcript as text and never parses it as a command", () => {
      attached = true;
      route(msg("/detach", { metadata: { inputType: "audio" } }));
      expect(control).not.toHaveBeenCalled();
      expect(forward).toHaveBeenCalledWith(CHAT, "/detach");
    });
  });

  describe("commands for other bots", () => {
    function routeFor(botUsername?: string) {
      const bridge = { control, forward, isAttached: () => attached } as unknown as RemoteBridge;
      return createTelegramRouter({ bridge, enqueue, send, ...(botUsername ? { botUsername } : {}) });
    }

    it("handles /cmd@thisbot (any case) and plain /cmd when the bot username is known", async () => {
      const r = routeFor("My_Bot");
      r(msg("/status@my_bot"));
      r(msg("/status"));
      await tick();
      expect(control).toHaveBeenCalledTimes(2);
    });

    it("does not handle /attach@otherbot: it follows the normal path", () => {
      const r = routeFor("my_bot");
      r(msg("/attach@otherbot 2"));
      expect(control).not.toHaveBeenCalled();
      expect(enqueue).toHaveBeenCalledTimes(1);
      attached = true;
      r(msg("/detach@otherbot"));
      expect(control).not.toHaveBeenCalled();
      expect(forward).toHaveBeenCalledWith(CHAT, "/detach@otherbot");
    });

    it("accepts any bot suffix when the bot username is unknown (current behaviour)", async () => {
      route(msg("/status@otherbot"));
      await tick();
      expect(control).toHaveBeenCalledWith({ action: "status", chatId: CHAT });
    });
  });
});
