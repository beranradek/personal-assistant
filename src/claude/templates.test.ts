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
    const config = await fs.mkdtemp(path.join(os.tmpdir(), "claude-config-test-"));
    tempDirs.push(workspace);
    tempDirs.push(config);
    await fs.writeFile(path.join(workspace, ".mcp.json"), "{\"existing\":true}\n");

    const result = await installClaudeCodeTemplates(workspace, config);

    expect(result.created).toEqual([".mcp-stdio-fallback.json", ".claude/settings.json", "claude-code/settings.json"]);
    expect(result.skipped).toEqual([".mcp.json"]);
    await expect(fs.readFile(path.join(workspace, ".mcp.json"), "utf8")).resolves.toContain("existing");
    const settings = await fs.readFile(path.join(workspace, ".claude", "settings.json"), "utf8");
    expect(settings).toContain("pa claude-context --hook-json");
    expect(settings).toContain("pa claude-security-hook");
    expect(settings).toContain("mcp__pa__memory_search");
    expect(settings).toContain("mcp__pa__cron_remove");
    expect(settings).toContain("mcp__pa__integ_calendar");
    expect(settings).not.toContain("mcp__pa__integ_calendar_rsvp");
    expect(settings).not.toContain('"ask"');
    await expect(fs.readFile(path.join(workspace, ".mcp-stdio-fallback.json"), "utf8")).resolves.toMatch(/"mcpServers"/);
    expect((await fs.stat(path.join(config, "claude-code", "settings.json"))).mode & 0o777).toBe(0o600);
  });
});
