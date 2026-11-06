import { describe, it, expect } from "vitest";
import { TmuxAgentError } from "./errors.js";
import {
  PROJECT_PATTERN,
  SESSION_PATTERN,
  buildSessionName,
  isOwnedName,
  isSingleLine,
  validateProject,
  validateText,
} from "./names.js";

const opts = { maxChars: 100, allowedSlash: ["/clear", "/compact"] };

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof TmuxAgentError ? err.code : "OTHER";
  }
  return undefined;
}

describe("validateProject", () => {
  it.each(["my-proj", "a", "0abc", "a".repeat(32)])("accepts %s", (name) => {
    expect(validateProject(name)).toBe(name);
  });

  it.each(["", "A", "-x", "a b", "a;b", "$(x)", "a".repeat(33), "příliš", "..", "a#b"])("rejects %j", (name) => {
    expect(code(() => validateProject(name))).toBe("INVALID_INPUT");
  });

  it("exposes the patterns used by the tool layer", () => {
    expect(PROJECT_PATTERN.test("my-proj")).toBe(true);
    expect(SESSION_PATTERN.test("pa-my-proj-1a2b")).toBe(true);
  });
});

describe("session names", () => {
  it("builds pa-<project>-<4hex> from the random source", () => {
    expect(buildSessionName("my-proj", () => 0)).toBe("pa-my-proj-0000");
    expect(buildSessionName("my-proj", () => 0.5)).toBe("pa-my-proj-8000");
    expect(buildSessionName("my-proj", () => 0.99999999)).toMatch(/^pa-my-proj-[0-9a-f]{4}$/);
  });

  it("uses a random suffix by default", () => {
    expect(buildSessionName("x")).toMatch(/^pa-x-[0-9a-f]{4}$/);
  });

  it("validates the project when building", () => {
    expect(code(() => buildSessionName("A b"))).toBe("INVALID_INPUT");
  });

  it("isOwnedName accepts only the exact shape", () => {
    expect(isOwnedName("pa-x-1a2b")).toBe(true);
    for (const bad of ["pa-x", "PA-x-1a2b", "pa-x-1a2bz", "pa-x-1a2b; ls", "foo", ""]) {
      expect(isOwnedName(bad)).toBe(false);
    }
  });
});

describe("validateText", () => {
  it("accepts tab, newline, Czech text and emoji", () => {
    expect(validateText("a\tb\nc", opts)).toBe("a\tb\nc");
    expect(validateText("Příliš žluťoučký kůň", opts)).toBe("Příliš žluťoučký kůň");
    expect(validateText("hello 🙂", opts)).toBe("hello 🙂");
  });

  it("normalizes CRLF to LF", () => {
    expect(validateText("a\r\nb", opts)).toBe("a\nb");
  });

  it.each(["\x1b[31m", "a\x00b", "a\x7f", "a\u009bb", "a\u0080", "a\u009f", "a\rb"])("rejects control characters in %j", (text) => {
    expect(code(() => validateText(text, opts))).toBe("INVALID_INPUT");
  });

  it("rejects empty, blank and over-limit text", () => {
    expect(code(() => validateText("", opts))).toBe("INVALID_INPUT");
    expect(code(() => validateText("  \n ", opts))).toBe("INVALID_INPUT");
    expect(code(() => validateText("x".repeat(101), opts))).toBe("INVALID_INPUT");
    expect(validateText("x".repeat(100), opts)).toHaveLength(100);
  });

  it.each(["!rm -rf x", "  !ls", " /permissions", "/config", "# note", "\n/permissions", "\n\n!x"])(
    "rejects text starting with a guarded character: %j",
    (text) => {
      expect(code(() => validateText(text, opts))).toBe("INVALID_INPUT");
    },
  );

  it("allows the kind's slash commands, single line only", () => {
    expect(validateText("/clear", opts)).toBe("/clear");
    expect(validateText("/compact keep the plan", opts)).toBe("/compact keep the plan");
    expect(code(() => validateText("/clear\nfoo", opts))).toBe("INVALID_INPUT");
    expect(code(() => validateText("/clearx", opts))).toBe("INVALID_INPUT");
  });

  it("rejects /clear when allowedSlash is empty", () => {
    expect(code(() => validateText("/clear", { ...opts, allowedSlash: [] }))).toBe("INVALID_INPUT");
  });

  it("allows ! and / later in the line", () => {
    expect(validateText("run ls !important and /tmp", opts)).toBe("run ls !important and /tmp");
    expect(validateText("first\n!second\n/third", opts)).toBe("first\n!second\n/third");
  });
});

describe("isSingleLine", () => {
  it("detects newlines", () => {
    expect(isSingleLine("one line")).toBe(true);
    expect(isSingleLine("two\nlines")).toBe(false);
  });
});
