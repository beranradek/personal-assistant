/**
 * Pure screen helpers: sanitizing captured panes, detecting the agent state, diffing captures and wrapping
 * output as untrusted data. No I/O. Detectors are heuristics: every result carries `signal`, `confidence`
 * and `evidence` so callers can see how fragile it is.
 */
import { TmuxAgentError } from "./errors.js";

export type AgentState = "busy" | "idle" | "waiting_permission" | "waiting_trust" | "unknown";
export type Confidence = "high" | "medium" | "low";

export interface ScreenStatus {
  state: AgentState;
  /** Short machine-readable name of the matched pattern combination. */
  signal: string;
  confidence: Confidence;
  /** Names of the matched patterns (never raw screen text). */
  evidence: string[];
  /** Detector id, for example `claude@1`. */
  detector: string;
}

export const MAX_OUTPUT_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Sanitizing and slicing
// ---------------------------------------------------------------------------

const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_OTHER = /\x1b(?:[()*+][0-9A-Za-z]|[@-Z\\-_])/g;
const OTHER_CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Strip ANSI escape sequences and control characters, normalize line endings. Keeps Unicode. */
export function sanitizeScreen(raw: string): string {
  return raw
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(ANSI_OTHER, "")
    .replace(/\r\n/g, "\n")
    .replace(OTHER_CONTROL, "");
}

function splitTrimmed(text: string): string[] {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines;
}

/** The last `n` lines without trailing blank lines. */
export function tailLines(text: string, n: number): string {
  return splitTrimmed(text).slice(-n).join("\n");
}

/**
 * Drop leading blank-only lines and collapse every run of blank-only lines into one. A captured pane has a fixed height, so a short
 * conversation is padded with a long run of blank lines that only costs tokens.
 */
export function compactBlankLines(text: string): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const blank = line.trim() === "";
    if (blank && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(blank ? "" : line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/**
 * Text that was added between two captures. Uses the longest overlap between the end of `before` and the
 * start of `after` (a screen that scrolled). Without any overlap the whole `after` is returned and
 * `overlap` is false.
 */
export function diffNewOutput(before: string, after: string): { text: string; overlap: boolean } {
  const b = splitTrimmed(before);
  const a = splitTrimmed(after);
  for (let k = Math.min(b.length, a.length); k >= 1; k--) {
    let same = true;
    for (let i = 0; i < k; i++) {
      if (b[b.length - k + i] !== a[i]) {
        same = false;
        break;
      }
    }
    if (same) return { text: a.slice(k).join("\n"), overlap: true };
  }
  return { text: a.join("\n"), overlap: false };
}

export interface UntrustedOutput {
  output: string;
  redacted: boolean;
  truncated: boolean;
}

/** Redact, then keep at most `maxBytes` bytes from the END (the newest screen lines matter most). */
export function wrapUntrusted(
  text: string,
  redact: (text: string) => string,
  maxBytes: number = MAX_OUTPUT_BYTES,
): UntrustedOutput {
  const redactedText = redact(text);
  const redacted = redactedText !== text;
  const bytes = Buffer.from(redactedText, "utf8");
  if (bytes.length <= maxBytes) return { output: redactedText, redacted, truncated: false };
  const output = bytes.subarray(bytes.length - maxBytes).toString("utf8").replace(/^�+/, "");
  return { output, redacted, truncated: true };
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

type Detector = (screen: string) => Omit<ScreenStatus, "detector">;

const CLAUDE_SPINNER = /^\s*[*✻✽✶✳✢]\s+\S+…\s*\(\d+s/m;
const CLAUDE_ESC_FOOTER = /esc to interrupt/i;
const CLAUDE_DONE_LINE = /^\s*✻\s+.+\bfor\s+\d+\w*\s*·\s*done\b/m;
const CLAUDE_EMPTY_PROMPT = /^\s*❯\s*$/m;
// Claude Code draws the prompt box as `rule / ❯ text / rule` with a footer (`⏵⏵ ...`, `? for shortcuts`) and sometimes a
// `/effort` line above the box. The prompt line may hold dim placeholder or predicted-prompt text that a plain-text capture
// cannot tell from typed input. Real captures: Claude Code 2.1.319.
const CLAUDE_RULE = /^\s*[─━]{10,}\s*$/;
const CLAUDE_TEXT_PROMPT = /^\s*❯\s+\S/;
const CLAUDE_FOOTER_MARK = /⏵⏵|\/effort|\? for shortcuts/;
// Guesses until real captures exist (operator step 6).
const CLAUDE_TRUST = /Do you trust the files in this folder\?/i;
const CLAUDE_PERMISSION = /Do you want to proceed\?/i;
// Generic menu: a selected numbered option (`❯ 1. Yes`) or an "Esc to cancel" footer. Catches dialogs whose wording is unknown,
// so that Enter is never sent into a menu whose default answer may be "yes".
const CLAUDE_MENU_SELECTION = /^[\s│|]*❯\s*\d+\.\s+\S/m;
const CLAUDE_MENU_FOOTER = /esc to cancel/i;

/** Only the bottom of the screen describes the current state; older lines are history. */
const DETECTION_TAIL_LINES = 25;

/** A `❯ <text>` prompt line between two rule lines, with a footer marker next to the box. Menus never get here (checked before). */
function hasPromptWithText(tail: string): boolean {
  const lines = tail.split("\n");
  for (let i = 1; i < lines.length - 1; i++) {
    if (!CLAUDE_TEXT_PROMPT.test(lines[i]!) || !CLAUDE_RULE.test(lines[i - 1]!) || !CLAUDE_RULE.test(lines[i + 1]!)) continue;
    return lines.slice(Math.max(0, i - 2)).some((line) => CLAUDE_FOOTER_MARK.test(line));
  }
  return false;
}

function detectClaude(screen: string): Omit<ScreenStatus, "detector"> {
  const tail = tailLines(screen, DETECTION_TAIL_LINES);
  if (CLAUDE_TRUST.test(tail)) {
    return { state: "waiting_trust", signal: "trust-dialog", confidence: "low", evidence: ["trust dialog text"] };
  }
  if (CLAUDE_PERMISSION.test(tail)) {
    return {
      state: "waiting_permission",
      signal: "permission-prompt",
      confidence: "low",
      evidence: ["permission prompt text"],
    };
  }
  const menuSelection = CLAUDE_MENU_SELECTION.test(tail);
  if (menuSelection || CLAUDE_MENU_FOOTER.test(tail)) {
    return {
      state: "waiting_permission",
      signal: "menu",
      confidence: "low",
      evidence: [menuSelection ? "menu: selected numbered option" : "menu footer: esc to cancel"],
    };
  }

  const spinner = CLAUDE_SPINNER.test(tail);
  const footer = CLAUDE_ESC_FOOTER.test(tail);
  const prompt = CLAUDE_EMPTY_PROMPT.test(tail);
  const done = CLAUDE_DONE_LINE.test(tail);

  if (spinner && footer) {
    return {
      state: "busy",
      signal: "spinner+esc-footer",
      confidence: "high",
      evidence: ["spinner line", "footer: esc to interrupt"],
    };
  }
  if (footer) {
    return { state: "busy", signal: "esc-footer", confidence: "medium", evidence: ["footer: esc to interrupt"] };
  }
  if (spinner) {
    // A spinner next to an empty prompt and no footer contradicts itself.
    return prompt
      ? { state: "busy", signal: "spinner+prompt-conflict", confidence: "low", evidence: ["spinner line", "empty prompt"] }
      : { state: "busy", signal: "spinner", confidence: "medium", evidence: ["spinner line"] };
  }
  if (prompt && done) {
    return {
      state: "idle",
      signal: "done-line+prompt",
      confidence: "high",
      evidence: ["done line", "empty prompt", "no esc footer"],
    };
  }
  if (prompt) {
    return { state: "idle", signal: "prompt", confidence: "medium", evidence: ["empty prompt", "no esc footer"] };
  }
  if (hasPromptWithText(tail)) {
    return {
      state: "idle",
      signal: "prompt-with-text",
      confidence: "medium",
      evidence: ["prompt with text (suggestion or typed input)", "no esc footer"],
    };
  }
  if (done) {
    return { state: "idle", signal: "done-line", confidence: "medium", evidence: ["done line"] };
  }
  return { state: "unknown", signal: "no-match", confidence: "low", evidence: [] };
}

const DETECTORS: Readonly<Record<string, Detector>> = {
  "claude@1": detectClaude,
};

export function detectState(detectorId: string, screen: string): ScreenStatus {
  const detector = Object.hasOwn(DETECTORS, detectorId) ? DETECTORS[detectorId] : undefined;
  if (!detector) throw new TmuxAgentError("INVALID_INPUT", `Unknown screen detector: ${detectorId}`);
  return { ...detector(sanitizeScreen(screen)), detector: detectorId };
}
