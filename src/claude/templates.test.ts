import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { installClaudeCodeTemplates, installClaudeRemoteConfig } from "./templates.js";

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

  it("does not ship remote hooks or remote allow entries in the base template", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "claude-template-test-"));
    tempDirs.push(workspace);
    await installClaudeCodeTemplates(workspace);
    const text = await fs.readFile(path.join(workspace, ".claude", "settings.json"), "utf8");
    expect(text).not.toContain("remote-hook");
    expect(text).not.toContain("remote_session");
  });

  it("ships all remote hooks in the opt-in remote template", async () => {
    const text = await fs.readFile(new URL("../templates/claude-code/remote-settings.json", import.meta.url), "utf8");
    const { hooks, permissions } = JSON.parse(text);
    const find = (event: string, command: string) =>
      hooks[event].flatMap((g: { hooks: unknown[] }) => g.hooks).find((h: { command: string }) => h.command === command);
    expect(find("SessionStart", "pa-remote-hook listen-start")).toMatchObject({ async: true, asyncRewake: true });
    expect(find("Stop", "pa-remote-hook listen-stop")).toMatchObject({ async: true, asyncRewake: true });
    expect(find("StopFailure", "pa-remote-hook listen-fail")).toMatchObject({ async: true, asyncRewake: true });
    expect(find("UserPromptSubmit", "pa-remote-hook listen-prompt")).toMatchObject({ async: true, asyncRewake: true });
    for (const event of ["PreToolUse", "MessageDisplay", "Notification", "SessionEnd"]) {
      const hook = find(event, `pa-remote-hook ${event}`);
      expect(hook).toMatchObject({ async: true });
      expect(hook.asyncRewake).toBeUndefined();
    }
    expect(permissions.allow).toEqual([
      "mcp__pa__remote_session_status",
      "mcp__pa__remote_session_attach",
      "mcp__pa__remote_session_detach",
    ]);
  });
});

describe("installClaudeRemoteConfig", () => {
  async function setup() {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "claude-remote-ws-"));
    const config = await fs.mkdtemp(path.join(os.tmpdir(), "claude-remote-cfg-"));
    tempDirs.push(workspace, config);
    return {
      workspace,
      config,
      wsFile: path.join(workspace, ".claude", "settings.json"),
      cfgFile: path.join(config, "claude-code", "settings.json"),
    };
  }

  it("creates both files from the base template, then merges the remote template", async () => {
    const { workspace, config, wsFile, cfgFile } = await setup();
    const result = await installClaudeRemoteConfig(workspace, config);
    expect(result).toEqual({
      created: [".claude/settings.json", "claude-code/settings.json"],
      updated: [],
      unchanged: [],
      allowAdded: {},
    });
    const created = JSON.parse(await fs.readFile(wsFile, "utf8"));
    expect(created.hooks.PreToolUse[0].hooks[0].command).toBe("pa claude-security-hook");
    expect(created.hooks.SessionStart[0].hooks[0].command).toBe("pa claude-context --hook-json");
    expect(created.permissions.allow).toContain("mcp__pa__memory_search");
    const text = await fs.readFile(wsFile, "utf8");
    expect(text).toContain("pa-remote-hook listen-fail");
    expect(text).toContain("pa-remote-hook listen-start");
    expect((await fs.stat(cfgFile)).mode & 0o777).toBe(0o600);
  });

  it("merges into existing files without touching other keys, keeps the mode, and runs idempotently", async () => {
    const { workspace, config, wsFile, cfgFile } = await setup();
    const original = {
      model: "opus",
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "my-start" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-guard" }] }],
        PostToolUse: [{ hooks: [{ type: "command", command: "my-post" }] }],
      },
      permissions: { allow: ["Read"], deny: ["Bash(rm *)"] },
    };
    await fs.mkdir(path.dirname(wsFile), { recursive: true });
    await fs.mkdir(path.dirname(cfgFile), { recursive: true });
    await fs.writeFile(wsFile, JSON.stringify(original), { mode: 0o640 });
    await fs.writeFile(cfgFile, JSON.stringify(original), { mode: 0o600 });
    await fs.chmod(wsFile, 0o640);

    const first = await installClaudeRemoteConfig(workspace, config);
    expect(first.updated).toEqual([".claude/settings.json", "claude-code/settings.json"]);
    const merged = JSON.parse(await fs.readFile(wsFile, "utf8"));
    const commands = (event: string) =>
      merged.hooks[event].flatMap((g: { hooks: Array<{ command: string }> }) => g.hooks.map((h) => h.command));
    expect(merged.model).toBe("opus");
    expect(merged.permissions.deny).toEqual(original.permissions.deny);
    expect(merged.permissions.allow).toEqual([
      "Read",
      "mcp__pa__remote_session_status",
      "mcp__pa__remote_session_attach",
      "mcp__pa__remote_session_detach",
    ]);
    expect(first.allowAdded[".claude/settings.json"]).toHaveLength(3);
    expect(commands("StopFailure")).toEqual(["pa-remote-hook listen-fail"]);
    expect(commands("UserPromptSubmit")).toEqual(["pa-remote-hook listen-prompt"]);
    expect(merged.hooks.PostToolUse).toEqual(original.hooks.PostToolUse);
    expect(merged.hooks.SessionStart[0]).toEqual(original.hooks.SessionStart[0]);
    expect(merged.hooks.PreToolUse[0]).toEqual(original.hooks.PreToolUse[0]);
    expect(commands("SessionStart")).toEqual(["my-start", "pa-remote-hook listen-start"]);
    expect(commands("Stop")).toEqual(["pa-remote-hook listen-stop"]);
    expect(commands("PreToolUse")).toEqual(["my-guard", "pa-remote-hook PreToolUse"]);
    expect((await fs.stat(wsFile)).mode & 0o777).toBe(0o640);
    expect((await fs.stat(cfgFile)).mode & 0o777).toBe(0o600);

    const before = await fs.readFile(wsFile, "utf8");
    const second = await installClaudeRemoteConfig(workspace, config);
    expect(second).toEqual({
      created: [],
      updated: [],
      unchanged: [".claude/settings.json", "claude-code/settings.json"],
      allowAdded: {},
    });
    expect(await fs.readFile(wsFile, "utf8")).toBe(before);
  });

  it("does not duplicate hooks of a file created from the template", async () => {
    const { workspace, config, wsFile } = await setup();
    await installClaudeRemoteConfig(workspace, config);
    const before = await fs.readFile(wsFile, "utf8");
    const result = await installClaudeRemoteConfig(workspace, config);
    expect(result.unchanged).toHaveLength(2);
    expect(await fs.readFile(wsFile, "utf8")).toBe(before);
  });

  it("adds only the missing allow entries to a launcher file without them (no duplicates)", async () => {
    const { workspace, config, cfgFile } = await setup();
    await installClaudeRemoteConfig(workspace, config);
    const full = JSON.parse(await fs.readFile(cfgFile, "utf8"));
    full.permissions.allow = full.permissions.allow.filter((e: string) => e !== "mcp__pa__remote_session_detach");
    await fs.writeFile(cfgFile, JSON.stringify(full));

    const result = await installClaudeRemoteConfig(workspace, config);
    expect(result.updated).toEqual(["claude-code/settings.json"]);
    expect(result.allowAdded).toEqual({ "claude-code/settings.json": ["mcp__pa__remote_session_detach"] });
    const merged = JSON.parse(await fs.readFile(cfgFile, "utf8"));
    expect(merged.permissions.allow.filter((e: string) => e.startsWith("mcp__pa__remote_session_"))).toHaveLength(3);
  });

  it("creates permissions.allow when the file has none", async () => {
    const { workspace, wsFile } = await setup();
    await fs.mkdir(path.dirname(wsFile), { recursive: true });
    await fs.writeFile(wsFile, JSON.stringify({ model: "opus" }));
    await installClaudeRemoteConfig(workspace);
    const merged = JSON.parse(await fs.readFile(wsFile, "utf8"));
    expect(merged.model).toBe("opus");
    expect(merged.permissions.allow).toHaveLength(3);
  });

  it("merges into a symlinked settings file and keeps the link", async () => {
    const { workspace, wsFile } = await setup();
    const real = path.join(workspace, "shared-settings.json");
    await fs.mkdir(path.dirname(wsFile), { recursive: true });
    await fs.writeFile(real, JSON.stringify({ permissions: { allow: ["Read"] } }));
    await fs.symlink(real, wsFile);

    await installClaudeRemoteConfig(workspace);

    expect((await fs.lstat(wsFile)).isSymbolicLink()).toBe(true);
    const merged = JSON.parse(await fs.readFile(real, "utf8"));
    expect(merged.permissions.allow).toContain("mcp__pa__remote_session_attach");
    expect(merged.hooks.StopFailure).toBeDefined();
  });

  it("refuses to change a file that is not valid JSON", async () => {
    const { workspace, wsFile } = await setup();
    await fs.mkdir(path.dirname(wsFile), { recursive: true });
    await fs.writeFile(wsFile, "{ broken");
    await expect(installClaudeRemoteConfig(workspace)).rejects.toThrow(/not valid JSON/);
    expect(await fs.readFile(wsFile, "utf8")).toBe("{ broken");
  });

  it("recognises edited commands and the older form, upgrades flags in place, rewrites only the identical old command", async () => {
    const { workspace, wsFile } = await setup();
    await fs.mkdir(path.dirname(wsFile), { recursive: true });
    const existing = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "/opt/bin/pa-remote-hook listen-start --x", async: true }] }],
        Stop: [{ hooks: [{ type: "command", command: "pa claude-remote-hook listen-stop", async: true, asyncRewake: true }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: "pa claude-remote-hook PreToolUse --edited", async: true }] }],
        StopFailure: [{ hooks: [{ type: "command", command: "pa claude-remote-hook StopFailure", async: true }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "my-wrapper pa-remote-hook UserPromptSubmit --keep" }] }],
      },
    };
    await fs.writeFile(wsFile, JSON.stringify(existing));
    await installClaudeRemoteConfig(workspace);
    const merged = JSON.parse(await fs.readFile(wsFile, "utf8"));
    const all = (event: string) => merged.hooks[event].flatMap((g: { hooks: unknown[] }) => g.hooks);
    // Edited command kept, flag added in place, no second hook.
    expect(all("SessionStart")).toEqual([
      { type: "command", command: "/opt/bin/pa-remote-hook listen-start --x", async: true, asyncRewake: true },
    ]);
    // Identical old command is rewritten to the new bin.
    expect(all("Stop")).toEqual([{ type: "command", command: "pa-remote-hook listen-stop", async: true, asyncRewake: true }]);
    // Edited old command is kept as it is.
    expect(all("PreToolUse")).toEqual([{ type: "command", command: "pa claude-remote-hook PreToolUse --edited", async: true }]);
    // The old plain StopFailure hook becomes listen-fail (no duplicate post).
    expect(all("StopFailure")).toEqual([{ type: "command", command: "pa-remote-hook listen-fail", async: true, asyncRewake: true }]);
    // An edited old plain hook is kept and no listen-prompt is added next to it.
    expect(all("UserPromptSubmit")).toEqual([{ type: "command", command: "my-wrapper pa-remote-hook UserPromptSubmit --keep" }]);
    const again = await installClaudeRemoteConfig(workspace);
    expect(again.unchanged).toEqual([".claude/settings.json"]);
  });

  it("writes nothing when one of the files is invalid (atomic install)", async () => {
    const { workspace, config, wsFile, cfgFile } = await setup();
    await fs.mkdir(path.dirname(wsFile), { recursive: true });
    await fs.mkdir(path.dirname(cfgFile), { recursive: true });
    await fs.writeFile(wsFile, JSON.stringify({ model: "opus" }));
    await fs.writeFile(cfgFile, JSON.stringify({ permissions: { allow: "nope" } }));
    await expect(installClaudeRemoteConfig(workspace, config)).rejects.toThrow(/permissions.allow is not an array/);
    expect(await fs.readFile(wsFile, "utf8")).toBe(JSON.stringify({ model: "opus" }));
    await fs.writeFile(cfgFile, "{ broken");
    await expect(installClaudeRemoteConfig(workspace, config)).rejects.toThrow(/not valid JSON/);
    expect(await fs.readFile(wsFile, "utf8")).toBe(JSON.stringify({ model: "opus" }));
  });

  it("creates no missing file when another file is invalid", async () => {
    const { workspace, config, wsFile, cfgFile } = await setup();
    await fs.mkdir(path.dirname(wsFile), { recursive: true });
    await fs.writeFile(wsFile, JSON.stringify({ hooks: [] }));
    await expect(installClaudeRemoteConfig(workspace, config)).rejects.toThrow(/"hooks" is not an object/);
    await expect(fs.stat(cfgFile)).rejects.toThrow();
  });

  it("only handles the workspace file when no config dir is given", async () => {
    const { workspace } = await setup();
    const result = await installClaudeRemoteConfig(workspace);
    expect(result.created).toEqual([".claude/settings.json"]);
  });
});
