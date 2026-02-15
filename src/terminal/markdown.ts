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
