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
  const botOn = vi.fn();
  const botStart = vi.fn().mockResolvedValue(undefined);
  const botStop = vi.fn().mockResolvedValue(undefined);
  const botApiSendMessage = vi.fn().mockResolvedValue(undefined);
  const BotCtor = vi.fn(function (this: Record<string, unknown>) {
    this.on = botOn;
    this.start = botStart;
    this.stop = botStop;
    this.api = { sendMessage: botApiSendMessage };
  });
  return { botOn, botStart, botStop, botApiSendMessage, BotCtor };
});

vi.mock("../core/logger.js", () => ({
  createLogger: () => mockLog,
}));

vi.mock("grammy", () => ({
  Bot: mocks.BotCtor,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createTelegramAdapter, chunkText } from "./telegram.js";
import { Bot } from "grammy";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig() {
  return {
    botToken: "123456:ABC-DEF",
    allowedUserIds: [111, 222],
    mode: "polling" as const,
  };
}

function makeMockContext(overrides: {
  userId?: number;
  text?: string;
  chatId?: number;
  firstName?: string;
  username?: string;
} = {}) {
  const {
    userId = 111,
    text = "Hello bot",
    chatId = 999,
    firstName = "Test",
    username = "testuser",
  } = overrides;
  return {
    message: {
      text,
      from: {
        id: userId,
        first_name: firstName,
        username,
      },
      chat: {
        id: chatId,
      },
    },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Telegram Adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // createTelegramAdapter
  // -------------------------------------------------------------------------
  describe("createTelegramAdapter", () => {
    it('creates adapter with name "telegram"', () => {
      const onMessage = vi.fn();
      const adapter = createTelegramAdapter(makeConfig(), onMessage);

      expect(adapter.name).toBe("telegram");
    });

    it("has start, stop, and sendResponse methods", () => {
      const onMessage = vi.fn();
      const adapter = createTelegramAdapter(makeConfig(), onMessage);

      expect(typeof adapter.start).toBe("function");
      expect(typeof adapter.stop).toBe("function");
      expect(typeof adapter.sendResponse).toBe("function");
    });

    it("creates a Grammy Bot with the provided token", () => {
      const onMessage = vi.fn();
      createTelegramAdapter(makeConfig(), onMessage);

      expect(Bot).toHaveBeenCalledWith("123456:ABC-DEF");
    });

    it("registers a message:text handler on the bot", () => {
      const onMessage = vi.fn();
      createTelegramAdapter(makeConfig(), onMessage);

      expect(mocks.botOn).toHaveBeenCalledWith("message:text", expect.any(Function));
    });
  });

  // -------------------------------------------------------------------------
  // Allowed user IDs filtering
  // -------------------------------------------------------------------------
  describe("allowedUserIds filtering", () => {
    it("accepts messages from allowed user IDs", async () => {
      const onMessage = vi.fn();
      createTelegramAdapter(makeConfig(), onMessage);

      // Get the handler that was registered
      const handler = mocks.botOn.mock.calls[0][1];
      const ctx = makeMockContext({ userId: 111, text: "Hello" });

      await handler(ctx);

      expect(onMessage).toHaveBeenCalledTimes(1);
    });

    it("rejects messages from unauthorized user IDs", async () => {
      const onMessage = vi.fn();
      createTelegramAdapter(makeConfig(), onMessage);

      const handler = mocks.botOn.mock.calls[0][1];
      const ctx = makeMockContext({ userId: 999, text: "Hello" });

      await handler(ctx);

      expect(onMessage).not.toHaveBeenCalled();
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 999 }),
        expect.stringContaining("unauthorized"),
      );
    });

    it("accepts all users when allowedUserIds is empty", async () => {
      const onMessage = vi.fn();
      const config = { ...makeConfig(), allowedUserIds: [] };
      createTelegramAdapter(config, onMessage);

      const handler = mocks.botOn.mock.calls[0][1];
      const ctx = makeMockContext({ userId: 999, text: "Hello" });

      await handler(ctx);

      expect(onMessage).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Grammy context to AdapterMessage conversion
  // -------------------------------------------------------------------------
  describe("Grammy context to AdapterMessage conversion", () => {
    it("converts Grammy context to AdapterMessage format", async () => {
      const onMessage = vi.fn();
      createTelegramAdapter(makeConfig(), onMessage);

      const handler = mocks.botOn.mock.calls[0][1];
      const ctx = makeMockContext({
        userId: 111,
        text: "Hello bot",
        chatId: 999,
        firstName: "Test",
        username: "testuser",
      });

      await handler(ctx);

      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "telegram",
          sourceId: "999",
          text: "Hello bot",
          metadata: expect.objectContaining({
            userName: "testuser",
          }),
        }),
      );
    });

    it("uses chat ID as sourceId", async () => {
      const onMessage = vi.fn();
      createTelegramAdapter(makeConfig(), onMessage);

      const handler = mocks.botOn.mock.calls[0][1];
      const ctx = makeMockContext({ chatId: 42 });

      await handler(ctx);

      const message: AdapterMessage = onMessage.mock.calls[0][0];
      expect(message.sourceId).toBe("42");
    });

    it("skips messages without text", async () => {
      const onMessage = vi.fn();
      createTelegramAdapter(makeConfig(), onMessage);

      const handler = mocks.botOn.mock.calls[0][1];
      const ctx = makeMockContext();
      ctx.message.text = undefined as unknown as string;

      await handler(ctx);

      expect(onMessage).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // sendResponse
  // -------------------------------------------------------------------------
  describe("sendResponse", () => {
    it("sends text back via bot API", async () => {
      const onMessage = vi.fn();
      const adapter = createTelegramAdapter(makeConfig(), onMessage);

      const message: AdapterMessage = {
        source: "telegram",
        sourceId: "999",
        text: "Here is the answer",
      };

      await adapter.sendResponse(message);

      expect(mocks.botApiSendMessage).toHaveBeenCalledWith(
        999,
        "Here is the answer",
      );
    });

    it("parses sourceId as number for chat ID", async () => {
      const onMessage = vi.fn();
      const adapter = createTelegramAdapter(makeConfig(), onMessage);

      const message: AdapterMessage = {
        source: "telegram",
        sourceId: "12345",
        text: "Reply",
      };

      await adapter.sendResponse(message);

      expect(mocks.botApiSendMessage).toHaveBeenCalledWith(12345, "Reply");
    });
  });

  // -------------------------------------------------------------------------
  // Long message chunking
  // -------------------------------------------------------------------------
  describe("long message chunking", () => {
    it("sends message as-is when under 4096 chars", async () => {
      const onMessage = vi.fn();
      const adapter = createTelegramAdapter(makeConfig(), onMessage);

      const text = "A".repeat(4096);
      await adapter.sendResponse({
        source: "telegram",
        sourceId: "999",
        text,
      });

      expect(mocks.botApiSendMessage).toHaveBeenCalledTimes(1);
      expect(mocks.botApiSendMessage).toHaveBeenCalledWith(999, text);
    });

    it("chunks long messages at 4096 chars", async () => {
      const onMessage = vi.fn();
      const adapter = createTelegramAdapter(makeConfig(), onMessage);

      const text = "A".repeat(5000);
      await adapter.sendResponse({
        source: "telegram",
        sourceId: "999",
        text,
      });

      expect(mocks.botApiSendMessage).toHaveBeenCalledTimes(2);
      expect(mocks.botApiSendMessage.mock.calls[0][1]).toHaveLength(4096);
      expect(mocks.botApiSendMessage.mock.calls[1][1]).toHaveLength(904);
    });
  });

  // -------------------------------------------------------------------------
  // chunkText utility
  // -------------------------------------------------------------------------
  describe("chunkText", () => {
    it("returns single chunk for short text", () => {
      const chunks = chunkText("Hello", 4096);
      expect(chunks).toEqual(["Hello"]);
    });

    it("splits text at the limit boundary", () => {
      const text = "A".repeat(8192);
      const chunks = chunkText(text, 4096);
      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toHaveLength(4096);
      expect(chunks[1]).toHaveLength(4096);
    });

    it("handles text exactly at limit", () => {
      const text = "A".repeat(4096);
      const chunks = chunkText(text, 4096);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toHaveLength(4096);
    });

    it("returns array with empty string for empty input", () => {
      const chunks = chunkText("", 4096);
      expect(chunks).toEqual([""]);
    });
  });

  // -------------------------------------------------------------------------
  // start / stop
  // -------------------------------------------------------------------------
  describe("start / stop", () => {
    it("start() begins polling", async () => {
      const onMessage = vi.fn();
      const adapter = createTelegramAdapter(makeConfig(), onMessage);

      await adapter.start();

      expect(mocks.botStart).toHaveBeenCalledTimes(1);
    });

    it("stop() stops the bot", async () => {
      const onMessage = vi.fn();
      const adapter = createTelegramAdapter(makeConfig(), onMessage);

      await adapter.stop();

      expect(mocks.botStop).toHaveBeenCalledTimes(1);
    });

    it("logs when starting and stopping", async () => {
      const onMessage = vi.fn();
      const adapter = createTelegramAdapter(makeConfig(), onMessage);

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
