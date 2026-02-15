import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown.js";

describe("renderMarkdown", () => {
  it("renders plain text", () => {
    const result = renderMarkdown("hello world");
    expect(result).toContain("hello world");
  });

  it("renders bold text with ANSI codes", () => {
    const result = renderMarkdown("**bold text**");
    // Should contain the text and be different from plain text (ANSI codes added)
    expect(result).toContain("bold text");
    expect(result).not.toBe("**bold text**");
  });

  it("renders headings", () => {
    const result = renderMarkdown("# Heading One");
    expect(result).toContain("Heading One");
    // Heading should have some formatting applied
    expect(result.length).toBeGreaterThan("Heading One".length);
  });

  it("renders code blocks", () => {
    const result = renderMarkdown("```js\nconst x = 1;\n```");
    expect(result).toContain("const x = 1");
  });

  it("renders inline code", () => {
    const result = renderMarkdown("Use `npm install` to install");
    expect(result).toContain("npm install");
  });

  it("strips trailing newlines", () => {
    const result = renderMarkdown("hello");
    expect(result).not.toMatch(/\n+$/);
  });

  it("handles multiline markdown", () => {
    const md = `# Title

Some paragraph with **bold** and \`code\`.

- Item one
- Item two
`;
    const result = renderMarkdown(md);
    expect(result).toContain("Title");
    expect(result).toContain("bold");
    expect(result).toContain("Item one");
    expect(result).toContain("Item two");
  });
});
