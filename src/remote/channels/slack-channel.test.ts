import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSlackChannel, type SlackChannelConfig } from "./slack-channel.js";
import { RemotePartialSendError } from "../protocol.js";
import type { SlackRemoteApi } from "../../adapters/slack.js";

const CONFIG: SlackChannelConfig = { progress: false, reactions: true, format: "mrkdwn" };

function makeApi() {
  return {
    openDm: vi.fn(async () => "D1"),
    postMessage: vi.fn(async () => "1.1"),
    updateMessage: vi.fn(async () => undefined),
    addReaction: vi.fn(async () => undefined),
    removeReaction: vi.fn(async () => undefined),
  } satisfies SlackRemoteApi;
}

const slackError = (error: string) => Object.assign(new Error(`An API error occurred: ${error}`), { data: { error } });
const longText = () => Array.from({ length: 400 }, (_, i) => `line number ${i}`).join("\n"); // 2 chunks

describe("createSlackChannel", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("has the Slack identity and texts", () => {
    const channel = createSlackChannel(makeApi(), CONFIG);
    expect(channel.id).toBe("slack");
    expect(channel.label).toBe("Slack");
    expect(channel.detachCommand).toBe("/cc detach");
    expect(channel.deliveryFailedText).toBe("Answer could not be delivered (Slack error).");
  });

  describe("sendText", () => {
    it("opens the DM once, posts converted text to the DM id", async () => {
      const api = makeApi();
      const channel = createSlackChannel(api, CONFIG);
      await channel.sendText("U1", "**hi** <!channel>");
      await channel.sendText("U1", "again");
      expect(api.openDm).toHaveBeenCalledTimes(1);
      expect(api.openDm).toHaveBeenCalledWith("U1");
      expect(api.postMessage).toHaveBeenNthCalledWith(1, "D1", "*hi* &lt;!channel&gt;", undefined);
    });

    it("does not cache a failed openDm", async () => {
      const api = makeApi();
      api.openDm.mockRejectedValueOnce(new Error("boom"));
      const channel = createSlackChannel(api, CONFIG);
      await expect(channel.sendText("U1", "x")).rejects.toThrow("boom");
      await channel.sendText("U1", "x");
      expect(api.openDm).toHaveBeenCalledTimes(2);
      expect(api.postMessage).toHaveBeenCalledTimes(1);
    });

    it("sends chunks in order with 1 s pacing", async () => {
      const api = makeApi();
      const p = createSlackChannel(api, CONFIG).sendText("U1", longText());
      await vi.advanceTimersByTimeAsync(0);
      expect(api.postMessage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(api.postMessage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(api.postMessage).toHaveBeenCalledTimes(2);
      const joined = api.postMessage.mock.calls.map((c) => c[1]).join("");
      expect(joined).toBe(longText());
    });

    it("retries one chunk 3 times, waiting retryAfter on a rate limit", async () => {
      const api = makeApi();
      const limited = Object.assign(new Error("rl"), { code: "slack_webapi_rate_limited_error", retryAfter: 3 });
      api.postMessage.mockRejectedValueOnce(limited).mockRejectedValueOnce(new Error("x"));
      const p = createSlackChannel(api, CONFIG).sendText("U1", "hi");
      await vi.advanceTimersByTimeAsync(2999);
      expect(api.postMessage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(1000);
      await p;
      expect(api.postMessage).toHaveBeenCalledTimes(3);
    });

    it("rejects with the original error when the first chunk fails 3 times", async () => {
      const api = makeApi();
      api.postMessage.mockRejectedValue(new Error("down"));
      const p = createSlackChannel(api, CONFIG).sendText("U1", "hi");
      const assertion = expect(p).rejects.toThrow("down");
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(api.postMessage).toHaveBeenCalledTimes(3);
    });

    it("throws RemotePartialSendError when a later chunk fails after others were sent", async () => {
      const api = makeApi();
      api.postMessage.mockResolvedValueOnce("1.1").mockRejectedValue(new Error("down"));
      const p = createSlackChannel(api, CONFIG).sendText("U1", longText());
      const assertion = expect(p).rejects.toBeInstanceOf(RemotePartialSendError);
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
    });

    it("truncates above 20 chunks with a marker", async () => {
      const api = makeApi();
      const text = "x".repeat(3500 * 25);
      const p = createSlackChannel(api, CONFIG).sendText("U1", text);
      await vi.advanceTimersByTimeAsync(60_000);
      await p;
      expect(api.postMessage).toHaveBeenCalledTimes(20);
      expect(String(api.postMessage.mock.calls[19]![1]).endsWith("(answer truncated, 6 more parts not sent)")).toBe(true);
      expect(String(api.postMessage.mock.calls[0]![1])).not.toContain("truncated");
    });

    it("format plain escapes only and sets mrkdwn:false", async () => {
      const api = makeApi();
      await createSlackChannel(api, { ...CONFIG, format: "plain" }).sendText("U1", "**a** <b>");
      expect(api.postMessage).toHaveBeenCalledWith("D1", "**a** &lt;b&gt;", { mrkdwn: false });
    });
  });

  describe("retryAfterMs", () => {
    it("maps seconds to ms, caps, and returns undefined for other errors", () => {
      const { retryAfterMs } = createSlackChannel(makeApi(), CONFIG);
      const rl = (retryAfter: unknown) => ({ code: "slack_webapi_rate_limited_error", retryAfter });
      expect(retryAfterMs(rl(3))).toBe(3000);
      expect(retryAfterMs(rl(9999))).toBe(30_000);
      expect(retryAfterMs(rl(undefined))).toBeUndefined();
      expect(retryAfterMs(new Error("x"))).toBeUndefined();
      expect(retryAfterMs(null)).toBeUndefined();
    });
  });

  describe("setTurnStatus", () => {
    const ref = "D1:5.5";
    it("maps statuses to reactions", async () => {
      const api = makeApi();
      const ch = createSlackChannel(api, CONFIG);
      await ch.setTurnStatus!("U1", ref, "accepted");
      expect(api.addReaction.mock.calls).toEqual([["D1", "5.5", "eyes"]]);
      await ch.setTurnStatus!("U1", ref, "done");
      expect(api.removeReaction).toHaveBeenLastCalledWith("D1", "5.5", "eyes");
      expect(api.addReaction).toHaveBeenLastCalledWith("D1", "5.5", "white_check_mark");
      await ch.setTurnStatus!("U1", ref, "failed");
      expect(api.addReaction).toHaveBeenLastCalledWith("D1", "5.5", "x");
      api.addReaction.mockClear();
      await ch.setTurnStatus!("U1", ref, "dropped");
      expect(api.removeReaction).toHaveBeenCalledTimes(3);
      expect(api.addReaction).not.toHaveBeenCalled();
    });

    it.each(["already_reacted", "no_reaction", "message_not_found", "too_many_reactions", "thread_locked"])(
      "ignores %s silently",
      async (name) => {
        const api = makeApi();
        api.addReaction.mockRejectedValue(slackError(name));
        await expect(createSlackChannel(api, CONFIG).setTurnStatus!("U1", ref, "accepted")).resolves.toBeUndefined();
      },
    );

    it("swallows other errors without leaking the token", async () => {
      const api = makeApi();
      api.addReaction.mockRejectedValue(new Error("auth failed with xoxb-1234567890-abcdefghij"));
      const out: string[] = [];
      const spy = vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true));
      await expect(createSlackChannel(api, CONFIG).setTurnStatus!("U1", ref, "accepted")).resolves.toBeUndefined();
      spy.mockRestore();
      expect(out.join("")).not.toContain("xoxb-1234567890");
    });

    it("makes no calls when reactions are off", async () => {
      const api = makeApi();
      await createSlackChannel(api, { ...CONFIG, reactions: false }).setTurnStatus!("U1", ref, "accepted");
      expect(api.addReaction).not.toHaveBeenCalled();
      expect(api.removeReaction).not.toHaveBeenCalled();
    });

    it("serializes calls of one ref", async () => {
      const api = makeApi();
      let release!: () => void;
      api.addReaction.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
      const ch = createSlackChannel(api, CONFIG);
      const first = ch.setTurnStatus!("U1", ref, "accepted");
      const second = ch.setTurnStatus!("U1", ref, "done");
      await vi.advanceTimersByTimeAsync(0);
      expect(api.removeReaction).not.toHaveBeenCalled();
      release();
      await Promise.all([first, second]);
      expect(api.removeReaction).toHaveBeenCalledTimes(1);
    });

    it("a hanging status never blocks sendText", async () => {
      const api = makeApi();
      api.addReaction.mockImplementation(() => new Promise<void>(() => undefined));
      const ch = createSlackChannel(api, CONFIG);
      void ch.setTurnStatus!("U1", ref, "accepted");
      await ch.sendText("U1", "hi");
      expect(api.postMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe("progress", () => {
    it("is absent unless slack.progress is set", () => {
      expect(createSlackChannel(makeApi(), CONFIG).progress).toBeUndefined();
    });

    it("creates and updates an escaped message in the DM", async () => {
      const api = makeApi();
      const ch = createSlackChannel(api, { ...CONFIG, progress: true });
      expect(await ch.progress!.create("U1", "a <b>")).toBe("1.1");
      expect(api.postMessage).toHaveBeenCalledWith("D1", "a &lt;b&gt;");
      await ch.progress!.update("U1", "1.1", "c & d");
      expect(api.updateMessage).toHaveBeenCalledWith("D1", "1.1", "c &amp; d");
    });
  });
});
