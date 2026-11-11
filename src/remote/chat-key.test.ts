import { describe, it, expect } from "vitest";
import { makeChatKey, parseChatKey } from "./chat-key.js";

describe("makeChatKey", () => {
  it("namespaces the id with the channel", () => {
    expect(makeChatKey("telegram", "123")).toBe("telegram:123");
    expect(makeChatKey("slack", "U123")).toBe("slack:U123");
  });
});

describe("parseChatKey", () => {
  it("parses valid keys", () => {
    expect(parseChatKey("telegram:123")).toEqual({ channel: "telegram", id: "123" });
    expect(parseChatKey("slack:U123")).toEqual({ channel: "slack", id: "U123" });
  });

  it("treats a bare integer (also negative) as a legacy telegram chat id", () => {
    expect(parseChatKey("42")).toEqual({ channel: "telegram", id: "42" });
    expect(parseChatKey("-1001234")).toEqual({ channel: "telegram", id: "-1001234" });
  });

  it("returns undefined for empty, unknown channel or empty id", () => {
    expect(parseChatKey("")).toBeUndefined();
    expect(parseChatKey("discord:1")).toBeUndefined();
    expect(parseChatKey("slack:")).toBeUndefined();
    expect(parseChatKey("abc")).toBeUndefined();
    expect(parseChatKey("4a2")).toBeUndefined();
  });

  it("splits at the first colon", () => {
    expect(parseChatKey("slack:U1:extra")).toEqual({ channel: "slack", id: "U1:extra" });
  });

  it("round-trips makeChatKey", () => {
    expect(parseChatKey(makeChatKey("slack", "U9"))).toEqual({ channel: "slack", id: "U9" });
  });
});
