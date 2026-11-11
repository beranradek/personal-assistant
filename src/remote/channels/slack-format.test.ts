import { describe, it, expect } from "vitest";
import { chunkSlackText, decodeSlackInbound, escapeSlack, toSlackMrkdwn, SLACK_CHUNK_LIMIT } from "./slack-format.js";

describe("toSlackMrkdwn", () => {
  it("converts bold, heading, link and bullets", () => {
    expect(toSlackMrkdwn("**bold** text")).toBe("*bold* text");
    expect(toSlackMrkdwn("## Title")).toBe("*Title*");
    expect(toSlackMrkdwn("# **Both**")).toBe("*Both*");
    expect(toSlackMrkdwn("see [docs](https://x.io/a?b=1&c=2)")).toBe("see <https://x.io/a?b=1&amp;c=2|docs>");
    expect(toSlackMrkdwn("- one\n* two\n  - **three**")).toBe("• one\n• two\n  • *three*");
  });

  it("keeps formatting in code fences and inline code but escapes entities", () => {
    expect(toSlackMrkdwn("```ts\nconst a = 1 < 2 && **x**;\n```")).toBe("```ts\nconst a = 1 &lt; 2 &amp;&amp; **x**;\n```");
    expect(toSlackMrkdwn("use `a<b` and **b**")).toBe("use `a&lt;b` and *b*");
  });

  it("escapes text after a fence closed on the same line and keeps later lines escaped", () => {
    expect(toSlackMrkdwn("```a``` <!channel> <@U1>\n<!here>")).toBe("```a``` &lt;!channel&gt; &lt;@U1&gt;\n&lt;!here&gt;");
  });

  it("opens a fence on a line with text before the marker and toggles on an odd count only", () => {
    expect(toSlackMrkdwn("x <b> ```y <i>\n<c>\n``` <d>\n<e>")).toBe("x &lt;b&gt; ```y &lt;i&gt;\n&lt;c&gt;\n``` &lt;d&gt;\n&lt;e&gt;");
  });

  it("closes an unbalanced fence and keeps <!channel> inside a fence inert", () => {
    expect(toSlackMrkdwn("```\n<!channel>")).toBe("```\n&lt;!channel&gt;\n```");
  });

  it("escapes & < > outside code and makes mentions inert", () => {
    expect(toSlackMrkdwn("a & b <c>")).toBe("a &amp; b &lt;c&gt;");
    expect(toSlackMrkdwn("<!channel> <@U1>")).toBe("&lt;!channel&gt; &lt;@U1&gt;");
  });

  it("handles empty text and closes an unbalanced fence", () => {
    expect(toSlackMrkdwn("")).toBe("");
    expect(toSlackMrkdwn("```\ncode")).toBe("```\ncode\n```");
  });

  it("does not break on a very long line", () => {
    const line = "word ".repeat(5000);
    expect(toSlackMrkdwn(line)).toBe(line);
  });
});

describe("chunkSlackText", () => {
  it("returns one chunk for short text and none for empty text", () => {
    expect(chunkSlackText("hi")).toEqual(["hi"]);
    expect(chunkSlackText("")).toEqual([]);
    expect(chunkSlackText("  \n ")).toEqual([]);
  });

  it("splits on newline first, joined chunks equal the input", () => {
    const text = Array.from({ length: 400 }, (_, i) => `line number ${i}`).join("\n");
    const chunks = chunkSlackText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(SLACK_CHUNK_LIMIT);
      expect(c.trim()).not.toBe("");
    }
    expect(chunks.join("")).toBe(text);
    expect(chunks[0]!.endsWith("\n")).toBe(true);
  });

  it("splits on a space when there is no newline", () => {
    const text = "word ".repeat(2000);
    const chunks = chunkSlackText(text, 100);
    expect(chunks.every((c) => c.length <= 100 && c.endsWith(" "))).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("hard-cuts when there is no break", () => {
    const text = "x".repeat(10_000);
    const chunks = chunkSlackText(text);
    expect(chunks.every((c) => c.length <= SLACK_CHUNK_LIMIT)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("does not cut inside an entity", () => {
    const text = "a".repeat(5) + "&amp;" + "b".repeat(20);
    const chunks = chunkSlackText(text, 12);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((c) => !/&[a-z]{0,3}$/.test(c))).toBe(true);
  });

  it("does not cut inside a link", () => {
    const text = "aaaa bbbb c <https://x.io/a|my label> dddd eeee";
    const chunks = chunkSlackText(text, 36);
    expect(chunks.join("")).toBe(text);
    for (const c of chunks) expect((c.match(/</g) ?? []).length).toBe((c.match(/>/g) ?? []).length);
  });

  it("closes a fence at the cut and reopens it in the next chunk", () => {
    const code = Array.from({ length: 60 }, (_, i) => `code ${i}`).join("\n");
    const chunks = chunkSlackText("```\n" + code + "\n```\nafter", 200);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(200);
      expect((c.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(chunks[1]!.startsWith("```\n")).toBe(true);
    expect(chunks.join("").replace(/```\n?/g, "").replace(/\n/g, "")).toBe(
      ("```\n" + code + "\n```\nafter").replace(/```\n?/g, "").replace(/\n/g, ""),
    );
  });
});

describe("decodeSlackInbound", () => {
  it("decodes entities, links and mentions", () => {
    expect(decodeSlackInbound("a &amp; b &lt;c&gt;")).toBe("a & b <c>");
    expect(decodeSlackInbound("<https://x.io|label>")).toBe("label (https://x.io)");
    expect(decodeSlackInbound("<https://x.io>")).toBe("https://x.io");
    expect(decodeSlackInbound("hi <@U1>")).toBe("hi @U1");
    expect(decodeSlackInbound("plain text")).toBe("plain text");
  });

  it("decodes &amp;lt; only once", () => {
    expect(decodeSlackInbound("&amp;lt;")).toBe("&lt;");
  });
});

describe("escapeSlack", () => {
  it("escapes the three characters", () => {
    expect(escapeSlack("<a & b>")).toBe("&lt;a &amp; b&gt;");
  });
});
