import { describe, it, expect } from "vitest";
import { formatToolSummary, countTerminalRows } from "./stream-render.js";

describe("formatToolSummary", () => {
  it("formats Bash tool with command", () => {
    expect(formatToolSummary("Bash", { command: "npm test" })).toBe("Running: npm test");
  });

  it("truncates long bash commands", () => {
    const longCmd = "a".repeat(100);
    const result = formatToolSummary("Bash", { command: longCmd });
    expect(result.length).toBeLessThanOrEqual(72); // "Running: " (9) + 60 + "..." (3)
    expect(result).toMatch(/\.\.\.$/);
  });

  it("formats Read tool with file path", () => {
    expect(formatToolSummary("Read", { file_path: "/src/foo.ts" })).toBe("Reading /src/foo.ts");
  });

  it("formats Write tool with file path", () => {
    expect(formatToolSummary("Write", { file_path: "/src/bar.ts" })).toBe("Writing /src/bar.ts");
  });

  it("formats Edit tool with file path", () => {
    expect(formatToolSummary("Edit", { file_path: "/src/baz.ts" })).toBe("Editing /src/baz.ts");
  });

  it("formats Glob tool with pattern", () => {
    expect(formatToolSummary("Glob", { pattern: "**/*.ts" })).toBe("Searching: **/*.ts");
  });

  it("formats Grep tool with pattern", () => {
    expect(formatToolSummary("Grep", { pattern: "handleLine" })).toBe("Grepping: handleLine");
  });

  it("formats WebFetch tool with URL", () => {
    expect(formatToolSummary("WebFetch", { url: "https://example.com" })).toBe("Fetching: https://example.com");
  });

  it("formats WebSearch tool with query", () => {
    expect(formatToolSummary("WebSearch", { query: "node.js streaming" })).toBe("Searching web: node.js streaming");
  });

  it("falls back to tool name for unknown tools", () => {
    expect(formatToolSummary("CustomTool", {})).toBe("CustomTool");
  });

  it("falls back to tool name when expected field is missing", () => {
    expect(formatToolSummary("Bash", {})).toBe("Bash");
  });
});

describe("countTerminalRows", () => {
  it("counts single line", () => {
    expect(countTerminalRows("hello", 80)).toBe(1);
  });

  it("counts wrapped lines", () => {
    // 100 chars at 80 columns = 2 rows
    expect(countTerminalRows("a".repeat(100), 80)).toBe(2);
  });

  it("counts multiple lines with wrapping", () => {
    // Line 1: 40 chars (1 row), Line 2: 100 chars (2 rows) = 3 rows
    expect(countTerminalRows("a".repeat(40) + "\n" + "b".repeat(100), 80)).toBe(3);
  });

  it("handles exact column-width lines", () => {
    expect(countTerminalRows("a".repeat(80), 80)).toBe(1);
  });

  it("counts empty lines as 1 row each", () => {
    expect(countTerminalRows("a\n\nb", 80)).toBe(3);
  });

  it("handles trailing newline", () => {
    expect(countTerminalRows("hello\n", 80)).toBe(2);
  });
});
