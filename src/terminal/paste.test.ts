import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPasteTracker, enableBracketedPaste, disableBracketedPaste } from "./paste.js";

describe("createPasteTracker", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns normal lines unchanged when no paste is active", () => {
    const paste = createPasteTracker();
    expect(paste.handleLine("hello")).toBe("hello");
    expect(paste.handleLine("world")).toBe("world");
  });

  it("buffers lines during a multiline paste and combines on final line", () => {
    const paste = createPasteTracker();

    // Multiline paste "A\nB\nC" + Enter:
    // paste-start → LINE "A" → LINE "B" → paste-end → LINE "C"
    paste.handleKeypress("paste-start");
    expect(paste.handleLine("A")).toBeNull();
    expect(paste.handleLine("B")).toBeNull();
    paste.handleKeypress("paste-end");
    expect(paste.handleLine("C")).toBe("A\nB\nC");
  });

  it("handles single-line paste (no buffering needed)", () => {
    const paste = createPasteTracker();

    // Single-line paste: paste-start → paste-end → Enter → LINE
    paste.handleKeypress("paste-start");
    paste.handleKeypress("paste-end");
    expect(paste.handleLine("single line")).toBe("single line");
  });

  it("handles paste with trailing newline (empty final line)", () => {
    const paste = createPasteTracker();

    // Paste "A\nB\n" — trailing newline means last line from Enter is empty
    paste.handleKeypress("paste-start");
    expect(paste.handleLine("A")).toBeNull();
    expect(paste.handleLine("B")).toBeNull();
    paste.handleKeypress("paste-end");
    expect(paste.handleLine("")).toBe("A\nB\n");
  });

  it("handles sequential pastes independently", () => {
    const paste = createPasteTracker();

    // First paste
    paste.handleKeypress("paste-start");
    expect(paste.handleLine("first")).toBeNull();
    paste.handleKeypress("paste-end");
    expect(paste.handleLine("end1")).toBe("first\nend1");

    // Normal line between pastes
    expect(paste.handleLine("normal")).toBe("normal");

    // Second paste
    paste.handleKeypress("paste-start");
    expect(paste.handleLine("second")).toBeNull();
    paste.handleKeypress("paste-end");
    expect(paste.handleLine("end2")).toBe("second\nend2");
  });

  it("ignores unrelated keypress events", () => {
    const paste = createPasteTracker();

    paste.handleKeypress("up");
    paste.handleKeypress("down");
    paste.handleKeypress("return");
    paste.handleKeypress(undefined);
    expect(paste.handleLine("still normal")).toBe("still normal");
  });

  it("handles two-line paste correctly", () => {
    const paste = createPasteTracker();

    // Paste "A\nB" + Enter:
    // paste-start → LINE "A" → paste-end → LINE "B"
    paste.handleKeypress("paste-start");
    expect(paste.handleLine("A")).toBeNull();
    paste.handleKeypress("paste-end");
    expect(paste.handleLine("B")).toBe("A\nB");
  });

  it("handles large multiline paste", () => {
    const paste = createPasteTracker();

    paste.handleKeypress("paste-start");
    for (let i = 0; i < 99; i++) {
      expect(paste.handleLine(`line ${i}`)).toBeNull();
    }
    paste.handleKeypress("paste-end");
    const result = paste.handleLine("line 99");
    expect(result).not.toBeNull();
    expect(result!.split("\n")).toHaveLength(100);
    expect(result!.startsWith("line 0\n")).toBe(true);
    expect(result!.endsWith("\nline 99")).toBe(true);
  });
});

describe("enableBracketedPaste / disableBracketedPaste", () => {
  it("writes enable escape sequence to stdout", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    enableBracketedPaste();
    expect(writeSpy).toHaveBeenCalledWith("\x1b[?2004h");
  });

  it("writes disable escape sequence to stdout", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    disableBracketedPaste();
    expect(writeSpy).toHaveBeenCalledWith("\x1b[?2004l");
  });
});
