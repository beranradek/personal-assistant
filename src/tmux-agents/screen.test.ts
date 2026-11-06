/**
 * Fixture origin: `claude-busy.txt` and `claude-idle.txt` are written by hand from the 2026-11-05 PoC description
 * (spinner line, `esc to interrupt` footer, `✻ ... done HH:MM` line, empty `❯` prompt). `claude-permission.txt` and
 * `claude-trust.txt` are GUESSES (wording unverified), so their tests are named `heuristic_unverified`.
 * Operator step 6 replaces the fixtures with real captures.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { TmuxAgentError } from "./errors.js";
import { detectState, diffNewOutput, sanitizeScreen, tailLines, wrapUntrusted } from "./screen.js";

const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");
const detect = (text: string) => detectState("claude@1", text);

describe("detectState claude@1", () => {
  it("busy fixture: busy, high, evidence lists both signals", () => {
    const status = detect(fixture("claude-busy.txt"));
    expect(status).toMatchObject({ state: "busy", confidence: "high", detector: "claude@1" });
    expect(status.signal).toBe("spinner+esc-footer");
    expect(status.evidence).toEqual(["spinner line", "footer: esc to interrupt"]);
  });

  it("idle fixture: idle, high", () => {
    expect(detect(fixture("claude-idle.txt"))).toMatchObject({ state: "idle", confidence: "high" });
  });

  it("only the empty prompt and no done line: idle, medium", () => {
    expect(detect("some text\n\n❯ \n  ? for shortcuts\n")).toMatchObject({ state: "idle", confidence: "medium" });
  });

  it("only the esc footer without a spinner: busy, medium", () => {
    expect(detect("working on it\n  esc to interrupt\n")).toMatchObject({ state: "busy", confidence: "medium" });
  });

  it("only a spinner: busy, medium", () => {
    expect(detect("* Pondering… (3s · ↓ 10 tokens)\n")).toMatchObject({ state: "busy", confidence: "medium" });
  });

  it("heuristic_unverified: permission fixture", () => {
    expect(detect(fixture("claude-permission.txt"))).toMatchObject({ state: "waiting_permission", confidence: "low" });
  });

  it("heuristic_unverified: trust fixture", () => {
    expect(detect(fixture("claude-trust.txt"))).toMatchObject({ state: "waiting_trust", confidence: "low" });
  });

  it("generic menu with unknown wording: a selected numbered option is waiting_permission, low", () => {
    const status = detect("Some new dialog title\n\n  ❯ 1. Allow once\n    2. Deny\n");
    expect(status).toMatchObject({ state: "waiting_permission", confidence: "low", signal: "menu" });
    expect(status.evidence).toEqual(["menu: selected numbered option"]);
    expect(detect("│ ❯ 1. Yes │\n│   2. No │\n")).toMatchObject({ state: "waiting_permission" });
  });

  it("generic menu: an 'Esc to cancel' footer alone is waiting_permission, low", () => {
    const status = detect("Pick one\n  Enter to confirm · Esc to cancel\n");
    expect(status).toMatchObject({ state: "waiting_permission", confidence: "low", signal: "menu" });
    expect(status.evidence).toEqual(["menu footer: esc to cancel"]);
  });

  it("an empty prompt is not mistaken for a menu", () => {
    expect(detect("done\n\n❯ \n  ? for shortcuts\n")).toMatchObject({ state: "idle" });
  });

  it("empty or garbage screen: unknown, low", () => {
    expect(detect(fixture("claude-empty.txt"))).toMatchObject({ state: "unknown", confidence: "low", evidence: [] });
    expect(detect("\u0000garbage ☃ ???")).toMatchObject({ state: "unknown", confidence: "low" });
  });

  it("conflicting screen (spinner and empty prompt, no footer): busy, low", () => {
    expect(detect("* Pondering… (3s · ↓ 10 tokens)\n❯ \n")).toMatchObject({ state: "busy", confidence: "low" });
  });

  it("ignores history above the detection tail", () => {
    const history = "* Pondering… (3s · ↓ 10 tokens)  esc to interrupt\n" + "line\n".repeat(40);
    expect(detect(`${history}❯ \n`)).toMatchObject({ state: "idle" });
  });

  it("strips ANSI before detecting", () => {
    expect(detect("\x1b[1m\x1b[32m✻ Worked for 2s · done 12:00\x1b[0m\n❯ \n")).toMatchObject({ state: "idle", confidence: "high" });
  });

  it("throws for an unknown detector id", () => {
    expect(() => detectState("nope", "x")).toThrow(TmuxAgentError);
  });

  it("never puts raw screen text into evidence", () => {
    const status = detect("password=hunter2 secret\n* Pondering… (3s)\nesc to interrupt\n");
    expect(JSON.stringify(status)).not.toContain("hunter2");
  });
});

describe("sanitizeScreen", () => {
  it("strips ANSI CSI and OSC sequences and normalizes CRLF", () => {
    const raw = "\x1b[31mred\x1b[0m \x1b]0;title\x07text\r\nnext\x1b[2K\x1b(B line";
    expect(sanitizeScreen(raw)).toBe("red text\nnext line");
  });

  it("keeps Unicode symbols and drops other control characters", () => {
    expect(sanitizeScreen("❯ ✻ … \u0007ok")).toBe("❯ ✻ … ok");
  });
});

describe("tailLines", () => {
  it("returns the last n lines without trailing blank lines", () => {
    expect(tailLines("a\nb\nc\nd\n\n\n", 2)).toBe("c\nd");
    expect(tailLines("a\nb", 5)).toBe("a\nb");
    expect(tailLines("", 3)).toBe("");
  });
});

describe("diffNewOutput", () => {
  it("returns appended lines", () => {
    expect(diffNewOutput("a\nb", "a\nb\nc\nd")).toEqual({ text: "c\nd", overlap: true });
  });

  it("returns an empty string when nothing changed", () => {
    expect(diffNewOutput("a\nb\n", "a\nb")).toEqual({ text: "", overlap: true });
  });

  it("uses the longest suffix overlap for scrolled screens", () => {
    expect(diffNewOutput("a\nb\nc", "b\nc\nd\ne")).toEqual({ text: "d\ne", overlap: true });
  });

  it("returns the whole after text without overlap", () => {
    expect(diffNewOutput("a\nb", "x\ny")).toEqual({ text: "x\ny", overlap: false });
  });
});

describe("wrapUntrusted", () => {
  const redact = (t: string) => t.replace(/sk-[a-zA-Z0-9_-]{20,}/g, "[REDACTED]").replace(/Bearer\s+\S+/g, "[REDACTED]");

  it("redacts keys and tokens and sets the flag", () => {
    const result = wrapUntrusted("key sk-abcdefghijklmnopqrstuvwxyz and Bearer abc.def", redact);
    expect(result).toEqual({ output: "key [REDACTED] and [REDACTED]", redacted: true, truncated: false });
  });

  it("leaves clean text alone", () => {
    expect(wrapUntrusted("hello", redact)).toEqual({ output: "hello", redacted: false, truncated: false });
  });

  it("keeps the newest bytes when over the cap", () => {
    const result = wrapUntrusted("A".repeat(50) + "tail", redact, 10);
    expect(result.truncated).toBe(true);
    expect(result.output).toBe("AAAAAAtail");
  });

  it("caps at 64 KB by default and never splits a character", () => {
    const result = wrapUntrusted("é".repeat(40_000), redact);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(64 * 1024);
    expect(result.output).not.toContain("�");
  });
});
