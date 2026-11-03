import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { installClaudeCodeTemplates } from "./templates.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("installClaudeCodeTemplates", () => {
  it("creates companion configuration without overwriting user-managed files", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "claude-template-test-"));
    tempDirs.push(workspace);
    await fs.writeFile(path.join(workspace, ".mcp.json"), "{\"existing\":true}\n");

    const result = await installClaudeCodeTemplates(workspace);

    expect(result.created).toEqual([".mcp-stdio-fallback.json", ".claude/settings.json"]);
    expect(result.skipped).toEqual([".mcp.json"]);
    await expect(fs.readFile(path.join(workspace, ".mcp.json"), "utf8")).resolves.toContain("existing");
    const settings = await fs.readFile(path.join(workspace, ".claude", "settings.json"), "utf8");
    expect(settings).toContain("pa claude-context --hook-json");
    expect(settings).toContain("mcp__pa__memory_search");
    expect(settings).toContain("mcp__pa__cron_remove");
    await expect(fs.readFile(path.join(workspace, ".mcp-stdio-fallback.json"), "utf8")).resolves.toMatch(/"mcpServers"/);
  });
});
