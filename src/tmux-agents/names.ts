import { randomInt } from "node:crypto";
import { TmuxAgentError } from "./errors.js";

/** Project label: lowercase letters, digits and dashes. No `#`, no `.`, no `:` (tmux target and format characters). */
export const PROJECT_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Session label `pa-<project>-<4 hex>`. Only a label: tmux calls target stored ids. */
export const SESSION_PATTERN = /^pa-[a-z0-9][a-z0-9-]{0,31}-[0-9a-f]{4}$/;

/** C0 controls except tab and newline, DEL and C1 controls (U+0080-U+009F). Lone CR is rejected too. */
const FORBIDDEN_CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
/** Leading characters that the agent TUI treats specially: shell line, memory note, slash command. */
const GUARDED_LEADING = new Set(["!", "#", "/"]);

export function validateProject(project: string): string {
  if (!PROJECT_PATTERN.test(project)) {
    throw new TmuxAgentError("INVALID_INPUT", `Invalid project name (use a-z, 0-9 and dashes, 1-32 characters): ${project}`);
  }
  return project;
}

/** Build `pa-<project>-<4 hex>`. `rand` returns a number in [0, 1); the default is cryptographically random. */
export function buildSessionName(project: string, rand?: () => number): string {
  validateProject(project);
  const value = rand ? Math.floor(rand() * 0x10000) : randomInt(0x10000);
  return `pa-${project}-${value.toString(16).padStart(4, "0")}`;
}

export function isSingleLine(text: string): boolean {
  return !text.includes("\n");
}

export interface TextRules {
  maxChars: number;
  /** Slash commands of the agent kind that may start the text. */
  allowedSlash: readonly string[];
}

/**
 * Validate text that will be typed into an agent TUI and return it with CRLF normalized to LF.
 * Rejects control characters, empty or too long text, and text where ANY line starts with `!`, `#` or `/`
 * (after leading whitespace) unless it is a single-line allowed slash command. Every line is checked because
 * without bracketed paste the terminal turns each pasted line into its own submitted input.
 */
export function validateText(text: string, rules: TextRules): string {
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.trim() === "") {
    throw new TmuxAgentError("INVALID_INPUT", "Text is empty");
  }
  if (normalized.length > rules.maxChars) {
    throw new TmuxAgentError("INVALID_INPUT", `Text is longer than ${rules.maxChars} characters`);
  }
  if (FORBIDDEN_CONTROL.test(normalized)) {
    throw new TmuxAgentError("INVALID_INPUT", "Text contains control characters");
  }
  for (const line of normalized.split("\n")) {
    const head = line.trimStart();
    if (!GUARDED_LEADING.has(head[0] ?? "")) continue;
    const command = head.split(/\s/, 1)[0] ?? "";
    if (!(rules.allowedSlash.includes(command) && isSingleLine(normalized.trimStart()))) {
      throw new TmuxAgentError("INVALID_INPUT", "No line of the text may start with '!', '#' or '/' (rephrase the task)");
    }
  }
  return normalized;
}
