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
  const appStart = vi.fn().mockResolvedValue(undefined);
  const appStop = vi.fn().mockResolvedValue(undefined);
  const chatPostMessage = vi.fn().mockResolvedValue({ ok: true, ts: "1234567890.123456" });
  const authTest = vi.fn().mockResolvedValue({ ok: true, user_id: "U_BOT_ID" });
  const AppCtor = vi.fn(function (this: Record<string, unknown>) {
    this.message = appMessage;
    this.event = appEvent;
    this.start = appStart;
    this.stop = appStop;
    this.client = {
      chat: { postMessage: chatPostMessage },
      auth: { test: authTest },
    };
  });
  return { appMessage, appEvent, appStart, appStop, chatPostMessage, authTest, AppCtor };
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
} = {}) {
  const {
    user = "U_USER_1",
    text = "Hello bot",
    channel = "C_CHANNEL_1",
    ts = "1234567890.000001",
    thread_ts,
    bot_id,
  } = overrides;
  return {
    user,
    text,
    channel,
    ts,
    thread_ts,
    bot_id,
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
});
