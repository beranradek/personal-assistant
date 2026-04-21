import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendPromptLog } from "./prompt-log.js";

async function readJsonl(filePath: string): Promise<any[]> {
  const raw = await fs.readFile(filePath, "utf-8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("appendPromptLog", () => {
  it("writes a claude entry with trigger derived from sessionKey", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pa-prompt-log-"));
    const timestamp = "2026-04-21T12:34:56.000Z";

    await appendPromptLog(dataDir, {
      timestamp,
      kind: "turn_start",
      backend: "claude",
      sessionKey: "heartbeat--test",
      systemPrompt: { type: "preset", preset: "default", append: "APPEND" },
      userMessage: "hello",
    });

    const filePath = path.join(dataDir, "prompt-log", "2026-04-21.jsonl");
    const entries = await readJsonl(filePath);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      timestamp,
      kind: "turn_start",
      backend: "claude",
      sessionKey: "heartbeat--test",
      trigger: "heartbeat",
      systemPrompt: { type: "preset", preset: "default", append: "APPEND" },
      userMessage: "hello",
    });
  });

  it("writes a codex entry and applies redaction", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pa-prompt-log-"));
    const timestamp = "2026-04-21T01:02:03.000Z";

    await appendPromptLog(
      dataDir,
      {
        timestamp,
        kind: "turn_start",
        backend: "codex",
        sessionKey: "cli--test",
        developerInstructions: "SECRET abc",
        userMessage: "SECRET def",
      },
      (text) => text.replaceAll("SECRET", "REDACTED"),
    );

    const filePath = path.join(dataDir, "prompt-log", "2026-04-21.jsonl");
    const entries = await readJsonl(filePath);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      timestamp,
      kind: "turn_start",
      backend: "codex",
      sessionKey: "cli--test",
      trigger: "user",
      developerInstructions: "REDACTED abc",
      userMessage: "REDACTED def",
    });
  });
});

