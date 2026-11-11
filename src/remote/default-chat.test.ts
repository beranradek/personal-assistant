import { describe, expect, it } from "vitest";
import { buildDefaultChatIds, resolveControlChat } from "./default-chat.js";

const both = buildDefaultChatIds({ telegram: 42, slack: "U1" });

describe("buildDefaultChatIds", () => {
  it("namespaces the first id of each channel and skips missing ones", () => {
    expect(both).toEqual({ telegram: "telegram:42", slack: "slack:U1" });
    expect(buildDefaultChatIds({ telegram: undefined, slack: "U1" })).toEqual({ slack: "slack:U1" });
  });
});

describe("resolveControlChat", () => {
  it("keeps an explicit chatId (including a bare numeric one)", () => {
    expect(resolveControlChat({ action: "attach", chatId: "7" }, { defaultChatIds: both })).toEqual({
      request: { action: "attach", chatId: "7" },
    });
  });
  it("uses request.channel first", () => {
    expect(resolveControlChat({ action: "attach", channel: "slack" }, { defaultChatIds: both, defaultChannel: "telegram" })).toEqual({
      request: { action: "attach", channel: "slack", chatId: "slack:U1" },
    });
  });
  it("uses defaultChannel, then telegram, then slack", () => {
    const chat = (d: Parameters<typeof resolveControlChat>[1]) => {
      const r = resolveControlChat({ action: "attach" }, d);
      return "request" in r ? r.request.chatId : r.error;
    };
    expect(chat({ defaultChatIds: both, defaultChannel: "slack" })).toBe("slack:U1");
    expect(chat({ defaultChatIds: both })).toBe("telegram:42");
    expect(chat({ defaultChatIds: { slack: "slack:U1" } })).toBe("slack:U1");
    expect(chat({ defaultChatIds: { telegram: "telegram:42" }, defaultChannel: "slack" })).toBe("telegram:42");
  });
  it("errors when the requested channel is not enabled", () => {
    expect(resolveControlChat({ action: "attach", channel: "slack" }, { defaultChatIds: { telegram: "telegram:42" } })).toEqual({
      error: "Channel slack is not enabled or has no allowed user.",
    });
  });
  it("errors when nothing is configured", () => {
    expect(resolveControlChat({ action: "attach" }, {})).toHaveProperty("error");
  });
  it("leaves detach and status without chat or channel to the bridge", () => {
    expect(resolveControlChat({ action: "detach" }, { defaultChatIds: both })).toEqual({ request: { action: "detach" } });
    expect(resolveControlChat({ action: "status", channel: "slack" }, { defaultChatIds: both })).toEqual({
      request: { action: "status", channel: "slack", chatId: "slack:U1" },
    });
  });
});
