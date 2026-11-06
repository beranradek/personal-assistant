import { spawn } from "node:child_process";
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
  sweepAnswerFiles,
  writeAnswerSettings,
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
      expect(hook!.command).toContain(`'/d/tmux-agents/answers/a b'\\''c.jsonl'`);
      expect(hook!.command.startsWith("umask 077;")).toBe(true);
    }
  });

  describe("the hook command run by a real shell", () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "answers-hook-"));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const commandFor = (file: string) =>
      (JSON.parse(buildAnswerSettings(file)) as { hooks: { Stop: { hooks: { command: string }[] }[] } }).hooks.Stop[0]!.hooks[0]!.command;

    const runHook = (command: string, payload: string) =>
      new Promise<number | null>((resolve) => {
        const child = spawn("sh", ["-c", command], { stdio: ["pipe", "ignore", "ignore"] });
        child.stdin.end(payload);
        child.on("close", resolve);
      });

    it("appends concurrent payloads as separate, complete lines (also big ones, in a path with a space and a quote)", async () => {
      const file = path.join(dir, "a b'c.jsonl");
      const command = commandFor(file);
      const payloads = Array.from({ length: 24 }, (_, i) =>
        JSON.stringify({ hook_event_name: "Stop", prompt_id: `p${i}`, last_assistant_message: `${i}:`.padEnd(200_000, "x") }),
      );
      const codes = await Promise.all(payloads.map((payload) => runHook(command, `${payload}\n`)));
      expect(codes.every((code) => code === 0)).toBe(true);
      const { records } = await readAnswerRecords(file, 0);
      expect(records).toHaveLength(24);
      expect(new Set(records.map((r) => r.promptId)).size).toBe(24);
      expect((fs.statSync(file).mode & 0o077)).toBe(0); // private: umask 077
    });
  });
});

describe("writeAnswerSettings and sweepAnswerFiles", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "answers-files-"));
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it("refuses a session name whose settings file exists and leaves its files alone", async () => {
    await writeAnswerSettings(dataDir, "pa-a-0001");
    fs.writeFileSync(answerFilePath(dataDir, "pa-a-0001"), "live records\n");
    await expect(writeAnswerSettings(dataDir, "pa-a-0001")).rejects.toMatchObject({ code: "EEXIST" });
    expect(fs.readFileSync(answerFilePath(dataDir, "pa-a-0001"), "utf8")).toBe("live records\n");
  });

  it("makes the answers directory private even when it existed with looser permissions", async () => {
    const dir = path.dirname(answerFilePath(dataDir, "x"));
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    await writeAnswerSettings(dataDir, "pa-a-0001");
    expect(fs.statSync(dir).mode & 0o077).toBe(0);
  });

  it("sweeps files of sessions that are not kept and old enough; keeps the others", async () => {
    for (const name of ["pa-keep-0001", "pa-gone-0002", "pa-new-0003"]) {
      await writeAnswerSettings(dataDir, name);
      fs.writeFileSync(answerFilePath(dataDir, name), "x\n");
      fs.writeFileSync(`${answerFilePath(dataDir, name)}.lock`, "");
    }
    const dir = path.dirname(answerFilePath(dataDir, "x"));
    const old = new Date(Date.now() - 600_000);
    for (const file of fs.readdirSync(dir).filter((f) => !f.startsWith("pa-new-"))) fs.utimesSync(path.join(dir, file), old, old);
    expect(await sweepAnswerFiles(dataDir, new Set(["pa-keep-0001"]), Date.now())).toBe(3);
    expect(fs.readdirSync(dir).sort()).toEqual(
      fs.readdirSync(dir).filter((f) => f.startsWith("pa-keep-") || f.startsWith("pa-new-")).sort(),
    );
    expect(fs.readdirSync(dir).some((f) => f.startsWith("pa-gone-"))).toBe(false);
    expect(fs.readdirSync(dir).some((f) => f.startsWith("pa-new-"))).toBe(true); // too young: a start may be in progress
  });

  it("returns 0 when the directory does not exist", async () => {
    expect(await sweepAnswerFiles(dataDir, new Set(), Date.now())).toBe(0);
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
