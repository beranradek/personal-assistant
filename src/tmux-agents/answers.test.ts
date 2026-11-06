import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  answerFilePath,
  answerSettingsPath,
  buildAnswerSettings,
  findAnswer,
  parseAnswerRecords,
  readAnswerRecords,
  type AnswerRecord,
} from "./answers.js";

const prompt = (promptId: string, text: string): AnswerRecord => ({ event: "UserPromptSubmit", promptId, prompt: text });
const stop = (promptId: string, text: string): AnswerRecord => ({ event: "Stop", promptId, lastAssistantMessage: text });

describe("answer hook settings", () => {
  it("puts the answers of one tmux session next to its settings file", () => {
    expect(answerFilePath("/d", "pa-hit-1234")).toBe("/d/tmux-agents/answers/pa-hit-1234.jsonl");
    expect(answerSettingsPath("/d", "pa-hit-1234")).toBe("/d/tmux-agents/answers/pa-hit-1234.settings.json");
  });

  it("builds Stop and UserPromptSubmit hooks that append the payload to the answer file", () => {
    const settings = JSON.parse(buildAnswerSettings("/d/tmux-agents/answers/a b'c.jsonl")) as {
      hooks: Record<string, { hooks: { type: string; command: string }[] }[]>;
    };
    expect(Object.keys(settings.hooks).sort()).toEqual(["Stop", "UserPromptSubmit"]);
    for (const event of ["Stop", "UserPromptSubmit"]) {
      const [hook] = settings.hooks[event]![0]!.hooks;
      expect(hook!.type).toBe("command");
      // the path is quoted for the shell: one quoted word, the single quote escaped
      expect(hook!.command).toBe(`cat >> '/d/tmux-agents/answers/a b'\\''c.jsonl'; echo >> '/d/tmux-agents/answers/a b'\\''c.jsonl'`);
    }
  });
});

describe("parseAnswerRecords", () => {
  it("keeps only the fields it needs and skips blank, broken and foreign lines", () => {
    const lines = [
      JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt_id: "p1", prompt: "hello", session_id: "s" }),
      "",
      "{broken",
      JSON.stringify({ hook_event_name: "Notification", prompt_id: "p1" }),
      JSON.stringify({ hook_event_name: "Stop", prompt_id: "p1", last_assistant_message: "hi there" }),
      JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "no prompt id" }),
    ].join("\n");
    expect(parseAnswerRecords(lines)).toEqual([prompt("p1", "hello"), stop("p1", "hi there")]);
  });
});

describe("findAnswer", () => {
  it("pairs the answer with the prompt that holds our text, by prompt_id", () => {
    const records = [prompt("a", "other question"), prompt("b", "Question 1"), stop("a", "answer to other"), stop("b", "answer 1")];
    expect(findAnswer(records, "Question 1")).toEqual({ status: "answered", text: "answer 1", promptId: "b" });
  });

  it("is pending while the prompt has no Stop record yet", () => {
    expect(findAnswer([prompt("b", "Question 1")], "Question 1")).toEqual({ status: "pending", promptId: "b" });
  });

  it("finds nothing when no prompt holds our text (the answer of another message is never used)", () => {
    expect(findAnswer([prompt("a", "typed by the user"), stop("a", "its answer")], "Question 1")).toEqual({ status: "none" });
    expect(findAnswer([], "Question 1")).toEqual({ status: "none" });
  });

  it("ignores whitespace differences and a wrapper around pasted text", () => {
    const pasted = prompt("b", "<pasted_content>\nline one\n  line two\n</pasted_content>");
    expect(findAnswer([pasted, stop("b", "done")], "line one\nline two")).toEqual({ status: "answered", text: "done", promptId: "b" });
  });

  it("uses the first matching prompt when the same text was sent twice", () => {
    const records = [prompt("a", "same"), stop("a", "first"), prompt("b", "same"), stop("b", "second")];
    expect(findAnswer(records, "same")).toEqual({ status: "answered", text: "first", promptId: "a" });
  });
});

describe("readAnswerRecords", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "answers-test-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reads only what was appended after the offset; a missing file is empty", async () => {
    const file = path.join(dir, "x.jsonl");
    expect(await readAnswerRecords(file, 0)).toEqual({ records: [], size: 0 });
    const first = `${JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt_id: "a", prompt: "old" })}\n\n`;
    fs.writeFileSync(file, first);
    const { size } = await readAnswerRecords(file, 0);
    expect(size).toBe(Buffer.byteLength(first));
    fs.appendFileSync(file, `${JSON.stringify({ hook_event_name: "Stop", prompt_id: "a", last_assistant_message: "ž" })}\n\n`);
    expect((await readAnswerRecords(file, size)).records).toEqual([stop("a", "ž")]);
  });
});
