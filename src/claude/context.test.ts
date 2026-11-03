import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildClaudeContext, formatSessionStartHookOutput } from "./context.js";

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
  it("reads the fixed root context files without HEARTBEAT.md", async () => {
    const directory = await workspace();
    await fs.writeFile(path.join(directory, "AGENTS.md"), "agents");
    await fs.writeFile(path.join(directory, "MEMORY.md"), "memory");
    await fs.writeFile(path.join(directory, "HEARTBEAT.md"), "heartbeat");

    await expect(buildClaudeContext(directory)).resolves.toBe("agents\n\n---\n\nmemory");
  });

  it("caps aggregate output instead of loading unbounded context", async () => {
    const directory = await workspace();
    await fs.writeFile(path.join(directory, "AGENTS.md"), "a".repeat(100));
    await fs.writeFile(path.join(directory, "SOUL.md"), "b".repeat(100));

    const result = await buildClaudeContext(directory, 150);

    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(150);
    expect(result).toContain("a");
    expect(result).toContain("Context truncated");
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
