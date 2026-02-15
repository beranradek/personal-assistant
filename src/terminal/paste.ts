import { Transform, type TransformCallback } from "node:stream";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export interface PasteInterceptorOptions {
  onPaste: (text: string) => void;
}

/**
 * Creates a Transform stream that intercepts bracketed paste sequences.
 *
 * Terminals that support bracketed paste wrap pasted text in escape sequences:
 *   \x1b[200~  <pasted text>  \x1b[201~
 *
 * This transform buffers the pasted text and delivers it as a single unit
 * via the onPaste callback, while passing normal keystrokes through unchanged.
 */
export function createPasteInterceptor(options: PasteInterceptorOptions): Transform {
  let pasteBuffer = "";
  let isPasting = false;

  return new Transform({
    decodeStrings: false,
    encoding: "utf-8",

    transform(chunk: string, _encoding: BufferEncoding, callback: TransformCallback) {
      let data = chunk;

      // Check for paste start marker
      const startIdx = data.indexOf(PASTE_START);
      if (startIdx !== -1 && !isPasting) {
        // Pass through anything before the paste marker
        const before = data.slice(0, startIdx);
        if (before) this.push(before);

        isPasting = true;
        pasteBuffer = "";
        data = data.slice(startIdx + PASTE_START.length);
      }

      if (isPasting) {
        const endIdx = data.indexOf(PASTE_END);
        if (endIdx !== -1) {
          pasteBuffer += data.slice(0, endIdx);
          isPasting = false;
          options.onPaste(pasteBuffer);
          pasteBuffer = "";

          // Pass through anything after the paste end marker
          const after = data.slice(endIdx + PASTE_END.length);
          if (after) this.push(after);
        } else {
          pasteBuffer += data;
        }
      } else {
        this.push(data);
      }

      callback();
    },
  });
}

export function enableBracketedPaste(): void {
  process.stdout.write("\x1b[?2004h");
}

export function disableBracketedPaste(): void {
  process.stdout.write("\x1b[?2004l");
}
