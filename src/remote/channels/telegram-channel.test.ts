import { describe, it, expect, vi } from "vitest";
import { createTelegramChannel } from "./telegram-channel.js";
import type { Adapter } from "../../core/types.js";

function makeAdapter(withProgress = true) {
  const adapter = {
    name: "telegram",
    start: vi.fn(),
    stop: vi.fn(),
    sendResponse: vi.fn(async () => undefined),
    ...(withProgress
      ? {
          createProcessingMessage: vi.fn(async () => "pm-7"),
          updateProcessingMessage: vi.fn(async () => undefined),
        }
      : {}),
  };
  return adapter as unknown as Adapter & {
    sendResponse: ReturnType<typeof vi.fn>;
    createProcessingMessage: ReturnType<typeof vi.fn>;
    updateProcessingMessage: ReturnType<typeof vi.fn>;
  };
}

describe("createTelegramChannel", () => {
  it("has the Telegram identity and texts, and no turn status", () => {
    const channel = createTelegramChannel(makeAdapter());
    expect(channel.id).toBe("telegram");
    expect(channel.label).toBe("Telegram");
    expect(channel.detachCommand).toBe("/detach");
    expect(channel.deliveryFailedText).toBe("Answer could not be delivered (Telegram error).");
    expect(channel.setTurnStatus).toBeUndefined();
  });

  it("sendText uses sendResponse with a system response kind and the raw chat id", async () => {
    const adapter = makeAdapter();
    await createTelegramChannel(adapter).sendText("111", "hello");
    expect(adapter.sendResponse).toHaveBeenCalledWith({
      source: "telegram",
      sourceId: "111",
      text: "hello",
      metadata: { responseKind: "system" },
    });
  });

  it("sendText rejects when the adapter rejects", async () => {
    const adapter = makeAdapter();
    adapter.sendResponse.mockRejectedValueOnce(new Error("boom"));
    await expect(createTelegramChannel(adapter).sendText("1", "x")).rejects.toThrow("boom");
  });

  it("progress delegates to the processing message functions", async () => {
    const adapter = makeAdapter();
    const channel = createTelegramChannel(adapter);
    await expect(channel.progress!.create("111", "start")).resolves.toBe("pm-7");
    await channel.progress!.update("111", "pm-7", "more");
    expect(adapter.createProcessingMessage).toHaveBeenCalledWith("111", "start");
    expect(adapter.updateProcessingMessage).toHaveBeenCalledWith("111", "pm-7", "more");
  });

  it("has no progress when the adapter cannot create processing messages", () => {
    expect(createTelegramChannel(makeAdapter(false)).progress).toBeUndefined();
  });

  it("retryAfterMs reads parameters.retry_after (seconds), capped at 30 s", () => {
    const { retryAfterMs } = createTelegramChannel(makeAdapter());
    expect(retryAfterMs({ parameters: { retry_after: 2 } })).toBe(2000);
    expect(retryAfterMs({ parameters: { retry_after: 500 } })).toBe(30_000);
    expect(retryAfterMs({ parameters: { retry_after: 0 } })).toBeUndefined();
    expect(retryAfterMs({ parameters: { retry_after: "3" } })).toBeUndefined();
    expect(retryAfterMs(new Error("x"))).toBeUndefined();
    expect(retryAfterMs(null)).toBeUndefined();
  });
});
