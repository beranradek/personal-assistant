export interface PasteTracker {
  /** Call on each keypress event from stdin. */
  handleKeypress(keyName: string | undefined): void;
  /**
   * Call on each readline "line" event.
   * Returns `null` when the line is buffered (mid-paste).
   * Returns the final combined string when ready to process.
   */
  handleLine(line: string): string | null;
}

/**
 * Creates a paste tracker that uses readline keypress events to detect
 * bracketed paste boundaries.
 *
 * Node.js v22+ readline natively recognizes `\x1b[200~` as "paste-start"
 * and `\x1b[201~` as "paste-end" keypress events when reading from a TTY.
 * This tracker uses those events to buffer intermediate line events during
 * a multiline paste and combine them into a single string.
 *
 * Event ordering for multiline paste "A\nB\nC" + Enter:
 *   paste-start → LINE "A" → LINE "B" → paste-end → LINE "C" (from Enter)
 *
 * Single-line paste: paste-start → paste-end → user presses Enter → LINE
 */
export function createPasteTracker(): PasteTracker {
  let pasting = false;
  let buffer: string[] = [];

  return {
    handleKeypress(keyName: string | undefined): void {
      if (keyName === "paste-start") {
        pasting = true;
        buffer = [];
      } else if (keyName === "paste-end") {
        pasting = false;
      }
    },

    handleLine(line: string): string | null {
      if (pasting) {
        // Mid-paste: buffer this line, don't process yet
        buffer.push(line);
        return null;
      }

      if (buffer.length > 0) {
        // First line after paste-end: combine buffered lines with this final one
        buffer.push(line);
        const combined = buffer.join("\n");
        buffer = [];
        return combined;
      }

      // Normal line (no paste in progress)
      return line;
    },
  };
}

export function enableBracketedPaste(): void {
  process.stdout.write("\x1b[?2004h");
}

export function disableBracketedPaste(): void {
  process.stdout.write("\x1b[?2004l");
}
