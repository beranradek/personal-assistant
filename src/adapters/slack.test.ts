import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AdapterMessage } from "../core/types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));

const mocks = vi.hoisted(() => {
  const appMessage = vi.fn();
  const appEvent = vi.fn();
  const appCommand = vi.fn();
  const reactionsAdd = vi.fn().mockResolvedValue({ ok: true });
  const reactionsRemove = vi.fn().mockResolvedValue({ ok: true });
  const conversationsOpen = vi.fn().mockResolvedValue({ ok: true, channel: { id: "D_DM_1" } });
  const appStart = vi.fn().mockResolvedValue(undefined);
  const appStop = vi.fn().mockResolvedValue(undefined);
  const chatPostMessage = vi.fn().mockResolvedValue({ ok: true, ts: "1234567890.123456" });
  const chatUpdate = vi.fn().mockResolvedValue({ ok: true });
  const authTest = vi.fn().mockResolvedValue({ ok: true, user_id: "U_BOT_ID" });
  const AppCtor = vi.fn(function (this: Record<string, unknown>) {
    this.message = appMessage;
    this.event = appEvent;
    this.command = appCommand;
    this.start = appStart;
    this.stop = appStop;
    this.client = {
      chat: { postMessage: chatPostMessage, update: chatUpdate },
      auth: { test: authTest },
      reactions: { add: reactionsAdd, remove: reactionsRemove },
      conversations: { open: conversationsOpen },
    };
  });
  return { appMessage, appEvent, appCommand, reactionsAdd, reactionsRemove, conversationsOpen, appStart, appStop, chatPostMessage, chatUpdate, authTest, AppCtor };
});

vi.mock("../core/logger.js", () => ({
  createLogger: () => mockLog,
}));

vi.mock("@slack/bolt", () => ({
  App: mocks.AppCtor,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createSlackAdapter } from "./slack.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig() {
  return {
    botToken: "xoxb-test-bot-token",
    appToken: "xapp-test-app-token",
    allowedUserIds: ["U_USER_1", "U_USER_2"],
    socketMode: true,
  };
}

function makeSlackMessageEvent(overrides: {
  user?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
  channel_type?: string;
} = {}) {
  const {
    user = "U_USER_1",
    text = "Hello bot",
    channel = "C_CHANNEL_1",
    ts = "1234567890.000001",
    thread_ts,
    bot_id,
    subtype,
    channel_type,
  } = overrides;
  return {
    user,
    text,
    channel,
    ts,
    thread_ts,
    bot_id,
    subtype,
    channel_type,
  };
}

function makeSayFn() {
  return vi.fn().mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Slack Adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // createSlackAdapter
  // -------------------------------------------------------------------------
  describe("createSlackAdapter", () => {
    it('creates adapter with name "slack"', () => {
      const onMessage = vi.fn();
      const adapter = createSlackAdapter(makeConfig(), onMessage);

      expect(adapter.name).toBe("slack");
    });

    it("has start, stop, and sendResponse methods", () => {
      const onMessage = vi.fn();
      const adapter = createSlackAdapter(makeConfig(), onMessage);

      expect(typeof adapter.start).toBe("function");
      expect(typeof adapter.stop).toBe("function");
      expect(typeof adapter.sendResponse).toBe("function");
    });

    it("creates a Bolt App with the provided tokens and socket mode", () => {
      const onMessage = vi.fn();
      createSlackAdapter(makeConfig(), onMessage);

      expect(mocks.AppCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          token: "xoxb-test-bot-token",
          appToken: "xapp-test-app-token",
          socketMode: true,
        }),
      );
    });

    it("registers a message handler on the app", () => {
      const onMessage = vi.fn();
      createSlackAdapter(makeConfig(), onMessage);

      expect(mocks.appMessage).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  // -------------------------------------------------------------------------
  // Allowed user IDs filtering
  // -------------------------------------------------------------------------
  describe("allowedUserIds filtering", () => {
    it("throws if allowedUserIds is empty", () => {
      const onMessage = vi.fn();
      const config = { ...makeConfig(), allowedUserIds: [] as string[] };

      expect(() => createSlackAdapter(config, onMessage)).toThrow(
        /requires at least one allowed user ID/,
      );
    });

    it("accepts messages from allowed user IDs", async () => {
      const onMessage = vi.fn();
      createSlackAdapter(makeConfig(), onMessage);

      const handler = mocks.appMessage.mock.calls[0][0];
      const event = makeSlackMessageEvent({ user: "U_USER_1", text: "Hello" });

      await handler({ message: event, say: makeSayFn() });

      expect(onMessage).toHaveBeenCalledTimes(1);
    });

    it("rejects messages from unauthorized user IDs", async () => {
      const onMessage = vi.fn();
      createSlackAdapter(makeConfig(), onMessage);

      const handler = mocks.appMessage.mock.calls[0][0];
      const event = makeSlackMessageEvent({ user: "U_UNAUTHORIZED", text: "Hello" });

      await handler({ message: event, say: makeSayFn() });

      expect(onMessage).not.toHaveBeenCalled();
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "U_UNAUTHORIZED" }),
        expect.stringContaining("unauthorized"),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Slack event to AdapterMessage conversion
  // -------------------------------------------------------------------------
  describe("Slack event to AdapterMessage conversion", () => {
    it("converts a Slack message event to AdapterMessage format", async () => {
      const onMessage = vi.fn();
      createSlackAdapter(makeConfig(), onMessage);

      const handler = mocks.appMessage.mock.calls[0][0];
      const event = makeSlackMessageEvent({
        user: "U_USER_1",
        text: "Hello bot",
        channel: "C_CHANNEL_1",
        ts: "1234567890.000001",
      });

      await handler({ message: event, say: makeSayFn() });

      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "slack",
          text: "Hello bot",
        }),
      );
    });

    it("uses channel ID as sourceId when there is no thread", async () => {
      const onMessage = vi.fn();
      createSlackAdapter(makeConfig(), onMessage);

      const handler = mocks.appMessage.mock.calls[0][0];
      const event = makeSlackMessageEvent({
        channel: "C_CHANNEL_1",
        ts: "1234567890.000001",
      });

      await handler({ message: event, say: makeSayFn() });

      const msg: AdapterMessage = onMessage.mock.calls[0][0];
      // sourceId encodes channel; when no thread, thread_ts should be the message ts
      expect(msg.sourceId).toContain("C_CHANNEL_1");
    });

    it("includes thread_ts in sourceId for threaded messages", async () => {
      const onMessage = vi.fn();
      createSlackAdapter(makeConfig(), onMessage);

      const handler = mocks.appMessage.mock.calls[0][0];
      const event = makeSlackMessageEvent({
        channel: "C_CHANNEL_1",
        ts: "1234567890.000002",
        thread_ts: "1234567890.000001",
      });

      await handler({ message: event, say: makeSayFn() });

      const msg: AdapterMessage = onMessage.mock.calls[0][0];
      // sourceId for threads: slack--{channelId}--{threadTs}
      expect(msg.sourceId).toBe("C_CHANNEL_1--1234567890.000001");
    });

    it("uses message ts as thread when no thread_ts is present", async () => {
      const onMessage = vi.fn();
      createSlackAdapter(makeConfig(), onMessage);

      const handler = mocks.appMessage.mock.calls[0][0];
      const event = makeSlackMessageEvent({
        channel: "C_CHANNEL_1",
        ts: "1234567890.000001",
      });

      await handler({ message: event, say: makeSayFn() });

      const msg: AdapterMessage = onMessage.mock.calls[0][0];
      // When no thread_ts, uses the message ts for threading
      expect(msg.sourceId).toBe("C_CHANNEL_1--1234567890.000001");
    });

    it("includes thread metadata in the message", async () => {
      const onMessage = vi.fn();
      createSlackAdapter(makeConfig(), onMessage);

      const handler = mocks.appMessage.mock.calls[0][0];
      const event = makeSlackMessageEvent({
        channel: "C_CHANNEL_1",
        ts: "1234567890.000002",
        thread_ts: "1234567890.000001",
        user: "U_USER_1",
      });

      await handler({ message: event, say: makeSayFn() });

      const msg: AdapterMessage = onMessage.mock.calls[0][0];
      expect(msg.metadata).toEqual(
        expect.objectContaining({
          threadId: "1234567890.000001",
          channelId: "C_CHANNEL_1",
          userId: "U_USER_1",
        }),
      );
    });

    it("skips messages without text", async () => {
      const onMessage = vi.fn();
      createSlackAdapter(makeConfig(), onMessage);

      const handler = mocks.appMessage.mock.calls[0][0];
      const event = makeSlackMessageEvent();
      event.text = undefined as unknown as string;

      await handler({ message: event, say: makeSayFn() });

      expect(onMessage).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Ignores bot's own messages
  // -------------------------------------------------------------------------
  describe("ignores bot's own messages", () => {
    it("ignores messages with a bot_id", async () => {
      const onMessage = vi.fn();
      createSlackAdapter(makeConfig(), onMessage);

      const handler = mocks.appMessage.mock.calls[0][0];
      const event = makeSlackMessageEvent({
        bot_id: "B_BOT_123",
        text: "Bot message",
      });

      await handler({ message: event, say: makeSayFn() });

      expect(onMessage).not.toHaveBeenCalled();
    });

    it("processes normal user messages", async () => {
      const onMessage = vi.fn();
      createSlackAdapter(makeConfig(), onMessage);

      const handler = mocks.appMessage.mock.calls[0][0];
      const event = makeSlackMessageEvent({
        user: "U_USER_1",
        text: "Hello",
      });

      await handler({ message: event, say: makeSayFn() });

      expect(onMessage).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // sendResponse
  // -------------------------------------------------------------------------
  describe("sendResponse", () => {
    it("replies in the correct channel and thread", async () => {
      const onMessage = vi.fn();
      const adapter = createSlackAdapter(makeConfig(), onMessage);

      const message: AdapterMessage = {
        source: "slack",
        sourceId: "C_CHANNEL_1--1234567890.000001",
        text: "Here is the answer",
        metadata: {
          threadId: "1234567890.000001",
          channelId: "C_CHANNEL_1",
        },
      };

      await adapter.sendResponse(message);

      expect(mocks.chatPostMessage).toHaveBeenCalledWith({
        channel: "C_CHANNEL_1",
        text: "Here is the answer",
        thread_ts: "1234567890.000001",
      });
    });

    it("extracts channel and thread from sourceId when no metadata", async () => {
      const onMessage = vi.fn();
      const adapter = createSlackAdapter(makeConfig(), onMessage);

      const message: AdapterMessage = {
        source: "slack",
        sourceId: "C_CHANNEL_1--1234567890.000001",
        text: "Reply without metadata",
      };

      await adapter.sendResponse(message);

      expect(mocks.chatPostMessage).toHaveBeenCalledWith({
        channel: "C_CHANNEL_1",
        text: "Reply without metadata",
        thread_ts: "1234567890.000001",
      });
    });

    it("logs error when sendResponse fails", async () => {
      const onMessage = vi.fn();
      const adapter = createSlackAdapter(makeConfig(), onMessage);

      mocks.chatPostMessage.mockRejectedValueOnce(new Error("API error"));

      const message: AdapterMessage = {
        source: "slack",
        sourceId: "C_CHANNEL_1--1234567890.000001",
        text: "Will fail",
      };

      await expect(adapter.sendResponse(message)).rejects.toThrow("API error");
      expect(mockLog.error).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // start / stop
  // -------------------------------------------------------------------------
  describe("start / stop", () => {
    it("start() starts the Bolt app", async () => {
      const onMessage = vi.fn();
      const adapter = createSlackAdapter(makeConfig(), onMessage);

      await adapter.start();

      expect(mocks.appStart).toHaveBeenCalledTimes(1);
    });

    it("stop() stops the Bolt app", async () => {
      const onMessage = vi.fn();
      const adapter = createSlackAdapter(makeConfig(), onMessage);

      await adapter.stop();

      expect(mocks.appStop).toHaveBeenCalledTimes(1);
    });

    it("logs when starting and stopping", async () => {
      const onMessage = vi.fn();
      const adapter = createSlackAdapter(makeConfig(), onMessage);

      await adapter.start();
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining("starting"),
      );

      await adapter.stop();
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining("stopped"),
      );
    });
  });

  // -------------------------------------------------------------------------
  // createProcessingMessage
  // -------------------------------------------------------------------------
  describe("createProcessingMessage", () => {
    it("posts a message in the correct thread and returns ts", async () => {
      const onMessage = vi.fn();
      mocks.chatPostMessage.mockResolvedValueOnce({
        ok: true,
        ts: "1234567890.999999",
      });
      const adapter = createSlackAdapter(makeConfig(), onMessage);

      const messageId = await adapter.createProcessingMessage!(
        "C_CHANNEL_1--1234567890.000001",
        "Processing...",
      );

      expect(mocks.chatPostMessage).toHaveBeenCalledWith({
        channel: "C_CHANNEL_1",
        text: "Processing...",
        thread_ts: "1234567890.000001",
      });
      expect(messageId).toBe("1234567890.999999");
    });

    it("uses metadata for channel/thread when provided", async () => {
      const onMessage = vi.fn();
      mocks.chatPostMessage.mockResolvedValueOnce({
        ok: true,
        ts: "1234567890.999999",
      });
      const adapter = createSlackAdapter(makeConfig(), onMessage);

      await adapter.createProcessingMessage!(
        "C_CHANNEL_1--1234567890.000001",
        "Processing...",
        { channelId: "C_META_CHANNEL", threadId: "1234567890.000002" },
      );

      expect(mocks.chatPostMessage).toHaveBeenCalledWith({
        channel: "C_META_CHANNEL",
        text: "Processing...",
        thread_ts: "1234567890.000002",
      });
    });
  });

  // -------------------------------------------------------------------------
  // updateProcessingMessage
  // -------------------------------------------------------------------------
  describe("updateProcessingMessage", () => {
    it("updates an existing message with new text in the correct channel", async () => {
      const onMessage = vi.fn();
      const adapter = createSlackAdapter(makeConfig(), onMessage);

      await adapter.updateProcessingMessage!(
        "C_CHANNEL_1--1234567890.000001",
        "1234567890.999999",
        "Updated content",
      );

      expect(mocks.chatUpdate).toHaveBeenCalledWith({
        channel: "C_CHANNEL_1",
        ts: "1234567890.999999",
        text: "Updated content",
      });
    });

    it("logs error when update fails", async () => {
      const onMessage = vi.fn();
      const adapter = createSlackAdapter(makeConfig(), onMessage);
      mocks.chatUpdate.mockRejectedValueOnce(new Error("update failed"));

      await expect(
        adapter.updateProcessingMessage!(
          "C_CHANNEL_1--1234567890.000001",
          "1234567890.999999",
          "text",
        ),
      ).rejects.toThrow("update failed");
      expect(mockLog.error).toHaveBeenCalled();
    });
  });
  // -------------------------------------------------------------------------
  // Hardening (plan task 4)
  // -------------------------------------------------------------------------
  describe("hardening", () => {
    async function send(event: Record<string, unknown>, onMessage = vi.fn()) {
      createSlackAdapter(makeConfig(), onMessage);
      const handler = mocks.appMessage.mock.calls[0][0];
      await handler({ message: event, say: makeSayFn() });
      return onMessage;
    }

    it("drops a message without user", async () => {
      const event = { ...makeSlackMessageEvent(), user: undefined };
      expect(await send(event)).not.toHaveBeenCalled();
    });

    it("drops a message with a subtype", async () => {
      expect(await send(makeSlackMessageEvent({ subtype: "message_changed" }))).not.toHaveBeenCalled();
    });

    it("drops a non-allowlisted user", async () => {
      expect(await send(makeSlackMessageEvent({ user: "U_OTHER" }))).not.toHaveBeenCalled();
    });

    it("passes channelType in metadata", async () => {
      const onMessage = await send(makeSlackMessageEvent({ channel_type: "im" }));
      expect(onMessage.mock.calls[0][0].metadata).toEqual(expect.objectContaining({ channelType: "im" }));
    });

    it("drops duplicate channel:ts events", async () => {
      const onMessage = vi.fn();
      createSlackAdapter(makeConfig(), onMessage);
      const handler = mocks.appMessage.mock.calls[0][0];
      const event = makeSlackMessageEvent();
      await handler({ message: event, say: makeSayFn() });
      await handler({ message: event, say: makeSayFn() });
      expect(onMessage).toHaveBeenCalledTimes(1);
    });

    it("dedupe entries expire and the set is size capped", async () => {
      vi.useFakeTimers();
      try {
        const onMessage = vi.fn();
        createSlackAdapter(makeConfig(), onMessage);
        const handler = mocks.appMessage.mock.calls[0][0];
        const event = makeSlackMessageEvent({ ts: "1.1" });
        await handler({ message: event, say: makeSayFn() });
        vi.advanceTimersByTime(11 * 60 * 1000);
        await handler({ message: event, say: makeSayFn() });
        expect(onMessage).toHaveBeenCalledTimes(2);

        // size cap: 1001 distinct events evict the oldest ("1.1" is re-accepted)
        for (let i = 0; i < 1001; i++) {
          await handler({ message: makeSlackMessageEvent({ ts: `2.${i}` }), say: makeSayFn() });
        }
        onMessage.mockClear();
        await handler({ message: event, say: makeSayFn() });
        expect(onMessage).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("creates Bolt App with rate limit, retry and timeout options", () => {
      createSlackAdapter(makeConfig(), vi.fn());
      expect(mocks.AppCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          clientOptions: {
            rejectRateLimitedCalls: true,
            retryConfig: { retries: 2 },
            timeout: 15000,
          },
        }),
      );
    });

    it("sendResponse omits thread_ts when thread id is empty", async () => {
      const adapter = createSlackAdapter(makeConfig(), vi.fn());
      await adapter.sendResponse({
        source: "slack",
        sourceId: "D1--",
        text: "hi",
        metadata: { channelId: "D1", threadId: "" },
      } as AdapterMessage);
      const arg = mocks.chatPostMessage.mock.calls[0][0];
      expect(arg).toEqual({ channel: "D1", text: "hi" });
      expect("thread_ts" in arg).toBe(false);
    });

    it("never logs bot or app tokens", async () => {
      const onMessage = vi.fn(() => {
        throw new Error("boom");
      });
      await send(makeSlackMessageEvent(), onMessage);
      await send(makeSlackMessageEvent({ user: "U_OTHER" }));
      const logged = JSON.stringify(Object.values(mockLog).flatMap((f) => f.mock.calls));
      expect(logged).not.toContain("xoxb-test");
      expect(logged).not.toContain("xapp-test");
    });
  });

  // -------------------------------------------------------------------------
  // /cc command
  // -------------------------------------------------------------------------
  describe("/cc command", () => {
    function setup(onCommand?: (c: unknown) => unknown) {
      createSlackAdapter(makeConfig(), vi.fn(), { onCommand: onCommand as never });
      const call = mocks.appCommand.mock.calls[0];
      return { name: call[0] as string, handler: call[1] as (a: unknown) => Promise<void> };
    }
    const cmd = (user_id = "U_USER_1") => ({ user_id, text: "status", channel_id: "D1" });

    it("registers /cc", () => {
      expect(setup().name).toBe("/cc");
    });

    it("acks empty and skips the handler for non-allowlisted users", async () => {
      const onCommand = vi.fn();
      const { handler } = setup(onCommand);
      const ack = vi.fn();
      await handler({ command: cmd("U_OTHER"), ack });
      expect(onCommand).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledTimes(1);
      expect(ack).toHaveBeenCalledWith();
    });

    it("calls the handler and passes ephemeral text through, ack once", async () => {
      const onCommand = vi.fn().mockResolvedValue("Attached.");
      const { handler } = setup(onCommand);
      const ack = vi.fn();
      await handler({ command: cmd(), ack });
      expect(onCommand).toHaveBeenCalledWith({ userId: "U_USER_1", text: "status", channelId: "D1" });
      expect(ack).toHaveBeenCalledTimes(1);
      expect(ack).toHaveBeenCalledWith({ response_type: "ephemeral", text: "Attached." });
    });

    it("acks empty when the handler returns nothing", async () => {
      const { handler } = setup(vi.fn().mockResolvedValue(undefined));
      const ack = vi.fn();
      await handler({ command: cmd(), ack });
      expect(ack).toHaveBeenCalledTimes(1);
      expect(ack).toHaveBeenCalledWith();
    });

    it("acks a short ephemeral error when the handler throws", async () => {
      const { handler } = setup(vi.fn().mockRejectedValue(new Error("secret internals")));
      const ack = vi.fn();
      await handler({ command: cmd(), ack });
      expect(ack).toHaveBeenCalledTimes(1);
      const arg = ack.mock.calls[0][0];
      expect(arg.response_type).toBe("ephemeral");
      expect(arg.text).not.toContain("secret internals");
    });
  });

  // -------------------------------------------------------------------------
  // SlackRemoteApi
  // -------------------------------------------------------------------------
  describe("remote api", () => {
    it("openDm caches successes and does not cache failures", async () => {
      const { remote } = createSlackAdapter(makeConfig(), vi.fn());
      mocks.conversationsOpen.mockRejectedValueOnce(new Error("fail"));
      await expect(remote.openDm("U1")).rejects.toThrow("fail");
      expect(await remote.openDm("U1")).toBe("D_DM_1");
      expect(await remote.openDm("U1")).toBe("D_DM_1");
      expect(mocks.conversationsOpen).toHaveBeenCalledTimes(2);
      expect(mocks.conversationsOpen).toHaveBeenCalledWith({ users: "U1" });
    });

    it("openDm rejects when no channel id is returned", async () => {
      const { remote } = createSlackAdapter(makeConfig(), vi.fn());
      mocks.conversationsOpen.mockResolvedValueOnce({ ok: true });
      await expect(remote.openDm("U1")).rejects.toThrow(/no channel id/);
    });

    it("postMessage, updateMessage and reactions call the Web API", async () => {
      const { remote } = createSlackAdapter(makeConfig(), vi.fn());
      expect(await remote.postMessage("D1", "x", { mrkdwn: false })).toBe("1234567890.123456");
      expect(mocks.chatPostMessage).toHaveBeenCalledWith({ channel: "D1", text: "x", mrkdwn: false });
      await remote.updateMessage("D1", "1.1", "y");
      expect(mocks.chatUpdate).toHaveBeenCalledWith({ channel: "D1", ts: "1.1", text: "y" });
      await remote.addReaction("D1", "1.1", "eyes");
      expect(mocks.reactionsAdd).toHaveBeenCalledWith({ channel: "D1", timestamp: "1.1", name: "eyes" });
      await remote.removeReaction("D1", "1.1", "eyes");
      expect(mocks.reactionsRemove).toHaveBeenCalledWith({ channel: "D1", timestamp: "1.1", name: "eyes" });
    });
  });
});
