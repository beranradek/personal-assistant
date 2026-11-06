/**
 * Fixture origin: `claude-busy.txt` and `claude-idle.txt` are written by hand from the 2026-11-05 PoC description
 * (spinner line, `esc to interrupt` footer, `✻ ... done HH:MM` line, empty `❯` prompt). `claude-permission.txt` and
 * `claude-trust.txt` are GUESSES (wording unverified), so their tests are named `heuristic_unverified`.
 * Operator step 6 replaces the fixtures with real captures.
 *
 * REAL captures (2026-11-06, Claude Code 2.1.319, tmux 3.6, pane 200x50): `claude-startup-real.txt` (startup screen, the prompt shows the
 * placeholder `Try "..."`) and `claude-idle-real.txt` (after an answer: `✻ <verb> for Ns · done HH:MM`, empty prompt).
 * `claude-suggestion-real.txt` is the real post-answer screen where the prompt line holds a predicted next prompt
 * (`❯ Díky, to je vše.`); it was rebuilt by hand from the observed lines, the surrounding answer text is shortened.
 * A plain-text capture cannot tell a suggestion from typed input, so the detector reports a prompt with text as idle, medium.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { TmuxAgentError } from "./errors.js";
import { compactBlankLines, detectState, diffNewOutput, extractNewOutput, sanitizeScreen, tailLines, wrapUntrusted } from "./screen.js";

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

  it("real startup screen (prompt placeholder text): idle, medium, evidence names the prompt with text", () => {
    const status = detect(fixture("claude-startup-real.txt"));
    expect(status).toMatchObject({ state: "idle", confidence: "medium", signal: "prompt-with-text" });
    expect(status.evidence).toEqual(["prompt with text (suggestion or typed input)", "no esc footer"]);
  });

  it("real screen after an answer (done line, empty prompt): idle, high", () => {
    expect(detect(fixture("claude-idle-real.txt"))).toMatchObject({ state: "idle", confidence: "high" });
  });

  it("real screen with a predicted next prompt in the prompt line: idle, medium", () => {
    expect(detect(fixture("claude-suggestion-real.txt"))).toMatchObject({
      state: "idle",
      confidence: "medium",
      signal: "prompt-with-text",
    });
  });

  it("a prompt with text is idle whatever the text is (not tied to the 'Try' wording)", () => {
    const screen = (text: string) =>
      `answer\n──────────────────────────────\n❯ ${text}\n──────────────────────────────\n  ⏵⏵ auto mode on (shift+tab to cycle)\n`;
    for (const text of ['Try "fix lint"', "Díky, to je vše.", "run the tests"]) {
      expect(detect(screen(text))).toMatchObject({ state: "idle", confidence: "medium" });
    }
  });

  it("a prompt with text needs the two rule lines and a footer marker, else unknown", () => {
    expect(detect("answer\n❯ some text\n  ⏵⏵ auto mode on\n")).toMatchObject({ state: "unknown" });
    expect(detect("answer\n──────────────────────────────\n❯ some text\n──────────────────────────────\n")).toMatchObject({
      state: "unknown",
    });
  });

  it("a prompt with text next to a busy signal stays busy", () => {
    const rule = "──────────────────────────────";
    expect(detect(`* Pondering… (3s · ↓ 10 tokens)\n${rule}\n❯ some text\n${rule}\n  esc to interrupt\n`)).toMatchObject({
      state: "busy",
    });
  });

  it("a numbered menu between rules is never idle", () => {
    const rule = "──────────────────────────────";
    const status = detect(`${rule}\n❯ 1. Yes\n  2. No\n${rule}\n  ⏵⏵ auto mode on\n`);
    expect(status).toMatchObject({ state: "waiting_permission", signal: "menu" });
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

describe("compactBlankLines", () => {
  it("drops leading blank lines and collapses runs of blank lines into one", () => {
    expect(compactBlankLines("\n\n  \na\n\n\n\nb\n \n\nc")).toBe("a\n\nb\n\nc");
  });

  it("keeps text without blank runs unchanged and handles empty input", () => {
    expect(compactBlankLines("a\n\nb")).toBe("a\n\nb");
    expect(compactBlankLines("")).toBe("");
    expect(compactBlankLines("\n\n")).toBe("");
  });

  it("shrinks a real capture with a long run of blank lines", () => {
    const compact = compactBlankLines(fixture("claude-startup-real.txt"));
    expect(compact.split("\n").length).toBeLessThan(8);
    expect(compact).toContain('❯ Try "refactor repl.ts"');
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

// Screens rebuilt from the real 4-message conversation of 2026-11-06 (Claude Code 2.1.319, pane 200 wide): banner, echoed messages,
// replies, then a padded bottom with a hint line and the prompt box. Texts are shortened where it does not matter.
describe("extractNewOutput (real conversation shapes)", () => {
  const RULE = "─".repeat(120);
  const FOOTER = "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent";
  const BANNER = [
    " ▐▛███▛█   Claude Code v2.1.319",
    "▝▜██████▀  Opus Plan · Claude Team",
    " ▝▝   ▝▝   ~/dev/personal-assistant",
    "",
  ];
  const EFFORT = `${" ".repeat(100)}◐ medium · /effort`;
  const TMUX_HINT = `${" ".repeat(60)}tmux detected · scroll with PgUp/PgDn · or add 'set -g mouse on' to ~/.tmux.conf for wheel scroll`;
  const FOCUS_HINT = `${" ".repeat(60)}tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and reattach`;
  const box = (footer = FOOTER) => [RULE, `❯ ${" ".repeat(60)}`, RULE, footer];
  const MSG1 = "Zpráva 1: kolik souborů má adresář src/tmux-agents a který z nich je největší? Odpověz stručně.";
  const MSG2 = "Zpráva 2: a který největší soubor je mezi těmi, které nejsou testy (bez .test.ts)?";
  const MSG3 = ["Zpráva 3 je na více řádků:", "první řádek: napiš slovo ANO,", "druhý řádek: napiš kolik řádků měla zpráva."];
  const MSG4 = "Zpráva 4, poslední: shrň jednou větou, na co jsem se tě ptala ve zprávách 1 až 3.";
  const done = (verb: string, secs: number) => `✻ ${verb} for ${secs}s · done 14:21`;
  const REPLY1 = ["  Ran 1 shell command", "", "● Adresář má 37 souborů. Největší je service.test.ts.", "", done("Churned", 3)];
  const REPLY2 = ["  Searched for 1 pattern", "", "● Největší soubor bez testů je service.ts.", "", done("Sautéed", 2)];
  const REPLY3 = ["  Searched for 1 pattern", "", "● ANO", "  3", "  Funkce sloučí řádky.", "", done("Cogitated", 4)];
  const REPLY4 = ["● Ptala ses na soubory a na zprávu 3.", "", "  Není zač, Amy.", "", done("Worked", 1)];
  const blanks = (n: number) => Array<string>(n).fill("");
  const screen = (...parts: string[][]) => parts.flat().join("\n");
  const startup = screen(BANNER, blanks(30), [EFFORT], box());
  const turn1 = [`❯ ${MSG1}${" ".repeat(20)}`, "", ...REPLY1, ""];
  const turn2 = [`❯ ${MSG2}${" ".repeat(20)}`, "", ...REPLY2, ""];
  const turn3 = [...MSG3.map((l, i) => (i === 0 ? `❯ ${l}` : `  ${l}`)), "", ...REPLY3, ""];
  const turn4 = [`❯ ${MSG4}`, "", ...REPLY4, ""];

  it("message 1: only the reply, no banner, no echo, no hint line, no prompt box", () => {
    const after = screen(BANNER, turn1, blanks(20), [EFFORT], box());
    expect(extractNewOutput(startup, after, MSG1)).toEqual({ text: REPLY1.join("\n"), method: "echo" });
  });

  it("message 2: earlier turns are not repeated (hint line `tmux detected` is dropped)", () => {
    const before = screen(BANNER, turn1, blanks(20), [EFFORT], box());
    const after = screen(BANNER, turn1, turn2, blanks(10), [TMUX_HINT], box());
    expect(extractNewOutput(before, after, MSG2)).toEqual({ text: REPLY2.join("\n"), method: "echo" });
  });

  it("message 3 (multi-line paste): echo spans several lines, `paste again to expand` footer is dropped", () => {
    const before = screen(BANNER, turn1, turn2, blanks(10), [TMUX_HINT], box());
    const after = screen(BANNER, turn1, turn2, turn3, blanks(5), [FOCUS_HINT], box("  paste again to expand"));
    expect(extractNewOutput(before, after, MSG3.join("\n"))).toEqual({ text: REPLY3.join("\n"), method: "echo" });
  });

  it("message 4: bottom is only rule, prompt and footer", () => {
    const before = screen(BANNER, turn1, turn2, turn3, blanks(5), [FOCUS_HINT], box("  paste again to expand"));
    const after = screen(BANNER, turn1, turn2, turn3, turn4, box());
    expect(extractNewOutput(before, after, MSG4)).toEqual({ text: REPLY4.join("\n"), method: "echo" });
  });

  it("uses the LAST echo when the same message was sent twice", () => {
    const after = screen(BANNER, turn1, turn1.slice(0, 1), ["", "● Druhá odpověď.", ""], box());
    expect(extractNewOutput("", after, MSG1).text).toBe("● Druhá odpověď.");
  });

  it("a multi-line message with a blank line inside is skipped by line count", () => {
    const sent = "Řádek A\n\nŘádek C";
    const after = screen(BANNER, ["❯ Řádek A", "", "  Řádek C", "", "● Hotovo.", ""], box());
    expect(extractNewOutput("", after, sent).text).toBe("● Hotovo.");
  });

  it("a wrapped echo line (no blank inside the echo) ends at the first blank line", () => {
    const after = screen(BANNER, [`❯ ${MSG1.slice(0, 80)}`, `  ${MSG1.slice(80)}`, "", "● Odpověď.", ""], box());
    expect(extractNewOutput("", after, MSG1).text).toBe("● Odpověď.");
  });

  it("a short message never matches an older, longer echo once its own echo scrolled out (tail fallback instead)", () => {
    const old = ["❯ ok thanks", "", "● Gern geschehen.", ""];
    const lines = Array.from({ length: 50 }, (_, i) => `řádek ${i}`);
    const after = screen(BANNER, old, lines, box());
    const result = extractNewOutput("", after, "ok");
    expect(result.method).not.toBe("echo");
    expect(result.text).not.toContain("Gern geschehen");
  });

  it("a short message matches its own echo exactly, also with trailing spaces", () => {
    const after = screen(BANNER, ["❯ ok thanks", "", "● Stará.", "", `❯ ok${" ".repeat(30)}`, "", "● Nová.", ""], box());
    expect(extractNewOutput("", after, "ok")).toEqual({ text: "● Nová.", method: "echo" });
  });

  it("a long multi-line paste that Claude shows as `[Pasted text #1 +12 lines]` is found by the placeholder", () => {
    const sent = Array.from({ length: 13 }, (_, i) => `řádek ${i} zprávy`).join("\n");
    const after = screen(BANNER, turn1, ["❯ [Pasted text #1 +12 lines]", "", "● Přijato.", ""], box());
    expect(extractNewOutput("", after, sent)).toEqual({ text: "● Přijato.", method: "echo" });
  });

  it("the paste placeholder is not taken for a single-line message", () => {
    const after = screen(BANNER, ["❯ [Pasted text #1 +12 lines]", "", "● Stará odpověď.", ""], box());
    expect(extractNewOutput("", after, "jednořádková zpráva").text).not.toBe("● Stará odpověď.");
  });

  it("no reply yet: empty text", () => {
    const after = screen(BANNER, [`❯ ${MSG1}`, ""], box());
    expect(extractNewOutput("", after, MSG1)).toEqual({ text: "", method: "echo" });
  });

  it("echo not found: falls back to the overlap diff, still without the chrome", () => {
    const before = screen(["a", "b"], box());
    const after = screen(["a", "b", "c", "d"], [EFFORT], box());
    expect(extractNewOutput(before, after, "něco jiného")).toEqual({ text: "c\nd", method: "overlap" });
  });

  it("echo and overlap not found: the screen tail without chrome", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `řádek ${i}`);
    const after = screen(lines, box());
    const result = extractNewOutput("zcela jiné\nřádky", after, "nic");
    expect(result.method).toBe("tail");
    expect(result.text.split("\n")).toHaveLength(40);
    expect(result.text.endsWith("řádek 59")).toBe(true);
  });

  it("a screen without a prompt box is kept as it is", () => {
    expect(extractNewOutput("", "❯ ahoj\n\n● Ano.", "ahoj").text).toBe("● Ano.");
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
