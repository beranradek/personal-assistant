import * as fs from "node:fs/promises";
import * as path from "node:path";

const TEMPLATES = [
  { source: "claude-code/.mcp.json", target: ".mcp.json" },
  { source: "claude-code/.mcp-stdio-fallback.json", target: ".mcp-stdio-fallback.json" },
  { source: "claude-code/settings.json", target: ".claude/settings.json" },
] as const;

export interface ClaudeCodeTemplateInstallResult {
  created: string[];
  skipped: string[];
}

/** Copy opt-in Claude Code companion templates without altering user configuration. */
export async function installClaudeCodeTemplates(workspaceDir: string): Promise<ClaudeCodeTemplateInstallResult> {
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

  return { created, skipped };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
