import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

marked.use(
  markedTerminal({
    reflowText: true,
    width: process.stdout.columns || 80,
    tab: 2,
  }) as any,
);

/**
 * Render markdown text to ANSI-formatted terminal output.
 */
export function renderMarkdown(text: string): string {
  const rendered = marked.parse(text) as string;
  // marked-terminal adds a trailing newline; trim it to let the caller control spacing
  return rendered.replace(/\n+$/, "");
}

/**
 * Check whether text contains markdown elements that would benefit from
 * rendered formatting. Used for smart re-render: only clear and re-render
 * streamed text if the full response actually contains markdown.
 */
export function hasMarkdownElements(text: string): boolean {
  // Fenced code blocks
  if (/```/.test(text)) return true;
  // Inline code
  if (/`.+`/.test(text)) return true;
  // Headers (# at start of line)
  if (/^#{1,6}\s/m.test(text)) return true;
  // Bold (**text** or __text__)
  if (/\*\*.+\*\*/.test(text)) return true;
  if (/__\S.*\S__/.test(text)) return true;
  // Italic (*text* but not * in list) — single * surrounded by non-space
  if (/(?<!\*)\*(?!\s)[^*]+(?<!\s)\*(?!\*)/.test(text)) return true;
  // Italic _text_ — but not snake_case (require space or start-of-string before _)
  if (/(?:^|[\s(])_(?!\s)\S.*?\S_(?:[\s,.)!?]|$)/m.test(text)) return true;
  // Unordered list (- or * at start of line followed by space)
  if (/^[-*]\s/m.test(text)) return true;
  // Ordered list (number. at start of line)
  if (/^\d+\.\s/m.test(text)) return true;
  // Links [text](url)
  if (/\[.+\]\(.+\)/.test(text)) return true;

  return false;
}
