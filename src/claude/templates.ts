import * as fs from "node:fs/promises";
import * as path from "node:path";

const TEMPLATES = [
  { source: "claude-code/.mcp.json", target: ".mcp.json" },
  { source: "claude-code/.mcp-stdio-fallback.json", target: ".mcp-stdio-fallback.json" },
  { source: "claude-code/settings.json", target: ".claude/settings.json" },
] as const;
const COMPANION_SETTINGS_FILE = path.join("claude-code", "settings.json");

export interface ClaudeCodeTemplateInstallResult {
  created: string[];
  skipped: string[];
}

/** Copy opt-in Claude Code companion templates without altering user configuration. */
export async function installClaudeCodeTemplates(workspaceDir: string, configDir?: string): Promise<ClaudeCodeTemplateInstallResult> {
  const created: string[] = [];
  const skipped: string[] = [];

  for (const template of TEMPLATES) {
    const destination = path.join(workspaceDir, template.target);
    try {
      await fs.lstat(destination);
      skipped.push(template.target);
      continue;
    } catch (error: unknown) {
      if (!isMissingFileError(error)) throw error;
    }

    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.copyFile(new URL(`../templates/${template.source}`, import.meta.url), destination);
    created.push(template.target);
  }

  // Keep the launcher-owned policy outside the project tree. The workspace
  // copy supports direct Claude Code usage, while `pa claude` prefers this
  // separate file as a tamper-deterrent layer.
  if (configDir) {
    const destination = path.join(configDir, COMPANION_SETTINGS_FILE);
    try {
      await fs.lstat(destination);
      skipped.push(COMPANION_SETTINGS_FILE);
    } catch (error: unknown) {
      if (!isMissingFileError(error)) throw error;
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.copyFile(new URL("../templates/claude-code/settings.json", import.meta.url), destination);
      await fs.chmod(destination, 0o600);
      created.push(COMPANION_SETTINGS_FILE);
    }
  }

  return { created, skipped };
}

export function claudeCompanionSettingsPath(configDir: string): string {
  return path.join(configDir, COMPANION_SETTINGS_FILE);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
