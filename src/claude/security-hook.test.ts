import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULTS } from "../core/config.js";
import type { Config } from "../core/types.js";
import { evaluateClaudePreToolUse } from "./security-hook.js";

const tempDirs: string[] = [];

function makeConfig(workspace: string): Config {
  const config = structuredClone(DEFAULTS);
  const parent = path.dirname(workspace);
  config.security.workspace = workspace;
  config.security.dataDir = path.join(workspace, ".data");
  config.security.allowedCommands = ["echo", "cat"];
  config.security.additionalReadDirs = [path.join(parent, "readable")];
  config.security.additionalWriteDirs = [path.join(parent, "writable")];
  return config;
}

function hookInput(toolName: string, toolInput: Record<string, unknown>) {
  return { tool_name: toolName, tool_input: toolInput };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Claude Code PreToolUse PA security hook", () => {
  it("allows an allowlisted Bash command without a Claude permission dialog", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pa-hook-"));
    tempDirs.push(workspace);

    const result = await evaluateClaudePreToolUse(hookInput("Bash", { command: "echo hello" }), makeConfig(workspace));

    expect(result.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    });
  });

  it("denies a Bash command outside PA's configured allowlist", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pa-hook-"));
    tempDirs.push(workspace);

    const result = await evaluateClaudePreToolUse(hookInput("Bash", { command: "curl https://example.test" }), makeConfig(workspace));

    expect(result.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    });
  });

  it("applies PA's separate read/write directory policy to Claude file tools", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pa-hook-"));
    tempDirs.push(workspace);
    const config = makeConfig(workspace);
    const readableFile = path.join(config.security.additionalReadDirs[0]!, "input.txt");
    const writableFile = path.join(config.security.additionalWriteDirs[0]!, "output.txt");
    fs.mkdirSync(path.dirname(readableFile), { recursive: true });
    fs.mkdirSync(path.dirname(writableFile), { recursive: true });
    fs.writeFileSync(readableFile, "input");

    await expect(evaluateClaudePreToolUse(hookInput("Read", { file_path: readableFile }), config))
      .resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
    await expect(evaluateClaudePreToolUse(hookInput("Write", { file_path: readableFile, content: "no" }), config))
      .resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    await expect(evaluateClaudePreToolUse(hookInput("Write", { file_path: writableFile, content: "yes" }), config))
      .resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
  });

  it("fails closed for malformed hook input", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pa-hook-"));
    tempDirs.push(workspace);

    const result = await evaluateClaudePreToolUse({ tool_name: "Bash", tool_input: null } as never, makeConfig(workspace));

    expect(result.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
  });

  it("blocks direct control-file mutations before they can remove the PA hook", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pa-hook-"));
    tempDirs.push(workspace);
    const config = makeConfig(workspace);

    await expect(evaluateClaudePreToolUse(hookInput("Edit", { file_path: path.join(workspace, ".claude", "settings.json"), old_string: "x", new_string: "y" }), config))
      .resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    await expect(evaluateClaudePreToolUse(hookInput("Bash", { command: "echo '{}' > .claude/settings.json" }), config))
      .resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    await expect(evaluateClaudePreToolUse(hookInput("Bash", { command: "mv .claude/settings\\.json backup.json" }), config))
      .resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });
});
