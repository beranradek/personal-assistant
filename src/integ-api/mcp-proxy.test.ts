import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIntegMcpProxy } from "./mcp-proxy.js";

describe("integ MCP proxy", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })) as never);
  });

  it("exposes Gmail, Calendar, and Slack through typed PA proxy operations", async () => {
    const proxy = createIntegMcpProxy({ bind: "127.0.0.1", port: 19100 });
    await proxy.gmail({ action: "read", messageId: "mail/1" });
    await proxy.calendar({ action: "rsvp", eventId: "evt/1", responseStatus: "accepted" });
    await proxy.slack({ action: "messages", channelId: "channel/1", limit: 20 });

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls[0]?.[0]).toBe("http://127.0.0.1:19100/gmail/messages/mail%2F1");
    expect(calls[1]?.[0]).toBe("http://127.0.0.1:19100/calendar/event/evt%2F1/rsvp");
    expect(calls[1]?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ responseStatus: "accepted", sendUpdates: "none" }) });
    expect(calls[2]?.[0]).toBe("http://127.0.0.1:19100/slack/messages/channel%2F1?limit=20");
    expect(calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
  });

  it("rejects a non-loopback integ-api endpoint", () => {
    expect(() => createIntegMcpProxy({ bind: "example.test", port: 19100 })).toThrow("loopback bind");
  });

  it("rejects incomplete proxy inputs before making a network request", async () => {
    const proxy = createIntegMcpProxy({ port: 19100 });

    await expect(proxy.calendar({ action: "rsvp" })).rejects.toThrow("eventId is required");
    await expect(proxy.slack({ action: "messages" })).rejects.toThrow("channelId is required");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed on an unknown operation instead of routing it to an external mutation", async () => {
    const proxy = createIntegMcpProxy({ port: 19100 });

    await expect(proxy.calendar({ action: "unexpected", eventId: "evt", responseStatus: "accepted" } as never)).rejects.toThrow("Unsupported calendar action");
    await expect(proxy.gmail({ action: "unexpected" } as never)).rejects.toThrow("Unsupported Gmail action");
    await expect(proxy.slack({ action: "unexpected" } as never)).rejects.toThrow("Unsupported Slack action");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("validates RSVP enum values before issuing its external request", async () => {
    const proxy = createIntegMcpProxy({ port: 19100 });

    await expect(proxy.calendar({ action: "rsvp", eventId: "evt", responseStatus: "unexpected" } as never)).rejects.toThrow("Unsupported RSVP responseStatus");
    await expect(proxy.calendar({ action: "rsvp", eventId: "evt", responseStatus: "accepted", sendUpdates: "unexpected" } as never)).rejects.toThrow("Unsupported RSVP sendUpdates");
    expect(fetch).not.toHaveBeenCalled();
  });
});
