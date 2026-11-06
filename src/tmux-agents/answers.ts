/**
 * The exact answer of an agent, taken from Claude Code hooks instead of the screen.
 *
 * Why: the screen of a fullscreen agent is only a viewport. A long answer does not fit, and the viewport may be scrolled away
 * from the end. The `Stop` hook of Claude Code gets the complete text of the final response (`last_assistant_message`) and the
 * `UserPromptSubmit` hook gets the prompt; both carry the same `prompt_id`. Every tmux session has its own answer file, so
 * the answer of one agent is never read for another, and the `prompt_id` pairs an answer with the message that started it.
 *
 * The hook definitions are OURS: the service writes a settings file per session and passes it with `--settings`. Project
 * settings stay off (`--setting-sources user`, see D20). The payload is data for the service only, never an instruction.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ANSWERS_DIR = ["tmux-agents", "answers"] as const;

export const ANSWER_EVENTS = ["UserPromptSubmit", "Stop"] as const;

export function answerFilePath(dataDir: string, session: string): string {
  return path.join(dataDir, ...ANSWERS_DIR, `${session}.jsonl`);
}

export function answerSettingsPath(dataDir: string, session: string): string {
  return path.join(dataDir, ...ANSWERS_DIR, `${session}.settings.json`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Settings JSON (for `--settings <file>`): both hooks append their stdin payload to `answerFile`, one JSON per line. */
export function buildAnswerSettings(answerFile: string): string {
  const quoted = shellQuote(answerFile);
  const hook = { type: "command", command: `cat >> ${quoted}; echo >> ${quoted}` };
  return JSON.stringify({ hooks: Object.fromEntries(ANSWER_EVENTS.map((event) => [event, [{ hooks: [hook] }]])) });
}

/** Create the answers directory (private) and write the settings file of a session. Returns the settings path. */
export async function writeAnswerSettings(dataDir: string, session: string): Promise<string> {
  const settingsPath = answerSettingsPath(dataDir, session);
  await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(settingsPath, buildAnswerSettings(answerFilePath(dataDir, session)), { mode: 0o600 });
  return settingsPath;
}

/** Best effort: answers are agent output, so they do not outlive the session. */
export async function removeAnswerFiles(dataDir: string, session: string): Promise<void> {
  for (const file of [answerFilePath(dataDir, session), answerSettingsPath(dataDir, session)]) {
    await fs.promises.rm(file, { force: true }).catch(() => undefined);
  }
}

export type AnswerRecord =
  | { event: "UserPromptSubmit"; promptId: string; prompt: string }
  | { event: "Stop"; promptId: string; lastAssistantMessage: string };

/** Keep the records we use. Blank lines (the hook adds one), broken lines and other events are skipped. */
export function parseAnswerRecords(text: string): AnswerRecord[] {
  const records: AnswerRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const promptId = raw.prompt_id;
    if (typeof promptId !== "string" || promptId === "") continue;
    if (raw.hook_event_name === "UserPromptSubmit" && typeof raw.prompt === "string") {
      records.push({ event: "UserPromptSubmit", promptId, prompt: raw.prompt });
    } else if (raw.hook_event_name === "Stop" && typeof raw.last_assistant_message === "string") {
      records.push({ event: "Stop", promptId, lastAssistantMessage: raw.last_assistant_message });
    }
  }
  return records;
}

/** Current size of the answer file in bytes (0 when it does not exist). Taken right before a message is typed. */
export async function answerOffset(file: string): Promise<number> {
  try {
    return (await fs.promises.stat(file)).size;
  } catch {
    return 0;
  }
}

/** Records appended after `offset`. Only complete lines count; `size` is where the next read starts. */
export async function readAnswerRecords(file: string, offset: number): Promise<{ records: AnswerRecord[]; size: number }> {
  let buffer: Buffer;
  try {
    buffer = await fs.promises.readFile(file);
  } catch {
    return { records: [], size: offset };
  }
  const fresh = buffer.subarray(Math.min(offset, buffer.length));
  const end = fresh.lastIndexOf(0x0a) + 1;
  return { records: parseAnswerRecords(fresh.subarray(0, end).toString("utf8")), size: offset + end };
}

/** Whitespace and the wrapper that Claude Code puts around pasted text do not count when two texts are compared. */
function normalize(text: string): string {
  return text.replace(/<\/?pasted_content[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

export type FoundAnswer =
  | { status: "answered"; text: string; promptId: string }
  | { status: "pending"; promptId: string }
  | { status: "none" };

/**
 * The answer to the message we sent: the first prompt (after the offset) with exactly our text gives the `prompt_id`; the
 * `Stop` record with the same id is the answer. A prompt typed by someone else has another text, so its answer is never taken.
 */
export function findAnswer(records: readonly AnswerRecord[], sentText: string): FoundAnswer {
  const wanted = normalize(sentText);
  if (wanted === "") return { status: "none" };
  const prompt = records.find((r) => r.event === "UserPromptSubmit" && normalize(r.prompt) === wanted);
  if (!prompt) return { status: "none" };
  const done = records.find((r) => r.event === "Stop" && r.promptId === prompt.promptId);
  if (done && done.event === "Stop") return { status: "answered", text: done.lastAssistantMessage, promptId: prompt.promptId };
  return { status: "pending", promptId: prompt.promptId };
}
