/**
 * Format a tool summary for terminal display during streaming.
 */
export function formatToolSummary(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const MAX_CMD_LEN = 60;

  switch (toolName) {
    case "Bash": {
      const cmd = input.command as string | undefined;
      if (!cmd) return toolName;
      const truncated =
        cmd.length > MAX_CMD_LEN ? cmd.slice(0, MAX_CMD_LEN) + "..." : cmd;
      return `Running: ${truncated}`;
    }
    case "Read": {
      const fp = input.file_path as string | undefined;
      return fp ? `Reading ${fp}` : toolName;
    }
    case "Write": {
      const fp = input.file_path as string | undefined;
      return fp ? `Writing ${fp}` : toolName;
    }
    case "Edit": {
      const fp = input.file_path as string | undefined;
      return fp ? `Editing ${fp}` : toolName;
    }
    case "Glob": {
      const pat = input.pattern as string | undefined;
      return pat ? `Searching: ${pat}` : toolName;
    }
    case "Grep": {
      const pat = input.pattern as string | undefined;
      return pat ? `Grepping: ${pat}` : toolName;
    }
    case "WebFetch": {
      const url = input.url as string | undefined;
      return url ? `Fetching: ${url}` : toolName;
    }
    case "WebSearch": {
      const q = input.query as string | undefined;
      return q ? `Searching web: ${q}` : toolName;
    }
    default:
      return toolName;
  }
}

/**
 * Count the number of terminal rows that a string occupies, accounting for
 * line wrapping at the given column width.
 */
export function countTerminalRows(text: string, columns: number): number {
  const lines = text.split("\n");
  let rows = 0;
  for (const line of lines) {
    if (line.length === 0) {
      rows += 1;
    } else {
      rows += Math.ceil(line.length / columns);
    }
  }
  return rows;
}
