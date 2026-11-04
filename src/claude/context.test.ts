import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildClaudeContext, DEFAULT_CLAUDE_CONTEXT_MAX_BYTES, formatSessionStartHookOutput } from "./context.js";

const tempDirs: string[] = [];

async function workspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-context-test-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("Claude Code context", () => {
  it("injects SOUL.md and tells the agent to read the large files itself", async () => {
    const directory = await workspace();
    await fs.writeFile(path.join(directory, "AGENTS.md"), "agents rules");
    await fs.writeFile(path.join(directory, "SOUL.md"), "Jsi Amy");
    await fs.writeFile(path.join(directory, "MEMORY.md"), "memory");
    await fs.writeFile(path.join(directory, "HEARTBEAT.md"), "heartbeat");

    const result = await buildClaudeContext(directory);

    expect(result).toContain("Jsi Amy");
    expect(result).toContain(`- ${path.join(directory, "AGENTS.md")}`);
    expect(result).toContain(`- ${path.join(directory, "MEMORY.md")}`);
    expect(result).not.toContain("USER.md");
    expect(result).not.toContain("agents rules");
    expect(result).not.toContain("heartbeat");
  });

  it("keeps the persona visible when other context files are large", async () => {
    const directory = await workspace();
    for (const name of ["AGENTS.md", "USER.md", "MEMORY.md"]) await fs.writeFile(path.join(directory, name), "x".repeat(50_000));
    await fs.writeFile(path.join(directory, "SOUL.md"), "Jsi Amy");

    const result = await buildClaudeContext(directory);

    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(DEFAULT_CLAUDE_CONTEXT_MAX_BYTES);
    expect(result).toContain("Jsi Amy");
  });

  it("caps output and marks a truncated persona", async () => {
    const directory = await workspace();
    await fs.writeFile(path.join(directory, "SOUL.md"), "ž".repeat(5000));

    const result = await buildClaudeContext(directory, 400);

    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(400);
    expect(result).toContain("[SOUL.md truncated]");
    expect(result).not.toContain("\uFFFD");
  });

  it("works when workspace has no context files", async () => {
    const directory = await workspace();
    const result = await buildClaudeContext(directory);
    expect(result).toContain("Personal assistant session start.");
    expect(result).not.toContain("Read tool");
  });

  it("formats valid SessionStart hook JSON", () => {
    expect(JSON.parse(formatSessionStartHookOutput("trusted context"))).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "trusted context",
      },
    });
  });
});
