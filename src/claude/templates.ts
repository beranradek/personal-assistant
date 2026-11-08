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

export interface ClaudeRemoteInstallResult {
  /** Files created from the template (they did not exist). */
  created: string[];
  /** Files where missing remote hooks were added. */
  updated: string[];
  /** Files that already had all remote hooks and allow entries. */
  unchanged: string[];
  /** Per file: the `permissions.allow` entries that were added (only files that were merged). */
  allowAdded: Record<string, string[]>;
}

type JsonRecord = Record<string, unknown>;

const REMOTE_HOOK_PREFIX = "pa claude-remote-hook";
/** Allow entries of the remote MCP tools. The Claude Code agent must use them without a prompt. */
const REMOTE_ALLOW_PREFIX = "mcp__pa__remote_session_";

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collect the hook commands of one event (all groups). */
function commandsOf(groups: unknown[]): Set<string> {
  const commands = new Set<string>();
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group["hooks"])) continue;
    for (const hook of group["hooks"]) {
      if (isRecord(hook) && typeof hook["command"] === "string") commands.add(hook["command"]);
    }
  }
  return commands;
}

/** Remote hook entries of the template: event -> hook objects whose command starts with `pa claude-remote-hook`. */
function templateRemoteHooks(template: unknown): Array<[string, JsonRecord]> {
  const result: Array<[string, JsonRecord]> = [];
  const hooks = isRecord(template) && isRecord(template["hooks"]) ? template["hooks"] : {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group["hooks"])) continue;
      for (const hook of group["hooks"]) {
        if (isRecord(hook) && typeof hook["command"] === "string" && hook["command"].startsWith(REMOTE_HOOK_PREFIX)) {
          result.push([event, hook]);
        }
      }
    }
  }
  return result;
}

/** Remote allow entries of the template (`mcp__pa__remote_session_*`). */
function templateRemoteAllow(template: unknown): string[] {
  const allow = isRecord(template) && isRecord(template["permissions"]) ? template["permissions"]["allow"] : undefined;
  return Array.isArray(allow)
    ? allow.filter((entry): entry is string => typeof entry === "string" && entry.startsWith(REMOTE_ALLOW_PREFIX))
    : [];
}

/** Add missing allow entries to `permissions.allow` (arrays are created when missing). Returns the added entries. */
function mergeRemoteAllow(settings: JsonRecord, entries: string[]): string[] {
  if (settings["permissions"] === undefined) settings["permissions"] = {};
  const permissions = settings["permissions"];
  if (!isRecord(permissions)) throw new Error("Claude settings: \"permissions\" is not an object");
  if (permissions["allow"] === undefined) permissions["allow"] = [];
  const allow = permissions["allow"];
  if (!Array.isArray(allow)) throw new Error("Claude settings: permissions.allow is not an array");
  const added = entries.filter((entry) => !allow.includes(entry));
  allow.push(...added);
  return added;
}

/** Add missing remote hooks to a parsed settings object. Returns true when something was added. */
function mergeRemoteHooks(settings: JsonRecord, remoteHooks: Array<[string, JsonRecord]>): boolean {
  let changed = false;
  if (settings["hooks"] === undefined) settings["hooks"] = {};
  const hooks = settings["hooks"];
  if (!isRecord(hooks)) throw new Error("Claude settings: \"hooks\" is not an object");
  for (const [event, hook] of remoteHooks) {
    if (hooks[event] === undefined) hooks[event] = [];
    const groups = hooks[event];
    if (!Array.isArray(groups)) throw new Error(`Claude settings: hooks.${event} is not an array`);
    if (commandsOf(groups).has(hook["command"] as string)) continue;
    // A new group: existing groups (for example the security hook) stay untouched.
    groups.push({ hooks: [structuredClone(hook)] });
    changed = true;
  }
  return changed;
}

async function writeFileAtomic(filePath: string, content: string, mode: number): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmpPath, content, { mode });
    await fs.chmod(tmpPath, mode);
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Add the remote session hooks (`pa claude-remote-hook ...`) and the `mcp__pa__remote_session_*` allow entries to the workspace Claude settings and to the launcher
 * settings under `<configDir>/claude-code/`. Additive and idempotent: other keys and hooks stay as they are, an existing
 * remote hook is never duplicated, a missing file is created from the template. Writes are atomic and keep the file mode.
 * A file that is not valid JSON is not touched (an error is thrown).
 */
export async function installClaudeRemoteConfig(workspaceDir: string, configDir?: string): Promise<ClaudeRemoteInstallResult> {
  const templateUrl = new URL("../templates/claude-code/settings.json", import.meta.url);
  const templateText = await fs.readFile(templateUrl, "utf8");
  const template = JSON.parse(templateText) as unknown;
  const remoteHooks = templateRemoteHooks(template);
  const remoteAllow = templateRemoteAllow(template);
  const targets = [
    { label: ".claude/settings.json", file: path.join(workspaceDir, ".claude", "settings.json"), createMode: 0o644 },
    ...(configDir ? [{ label: COMPANION_SETTINGS_FILE, file: path.join(configDir, COMPANION_SETTINGS_FILE), createMode: 0o600 }] : []),
  ];
  const result: ClaudeRemoteInstallResult = { created: [], updated: [], unchanged: [], allowAdded: {} };

  for (const target of targets) {
    let existing: string;
    try {
      // Follow a symlink so the link itself is kept.
      existing = await fs.readFile(target.file, "utf8");
    } catch (error: unknown) {
      if (!isMissingFileError(error)) throw error;
      await fs.mkdir(path.dirname(target.file), { recursive: true, mode: 0o700 });
      await writeFileAtomic(target.file, templateText, target.createMode);
      result.created.push(target.label);
      continue;
    }

    let settings: unknown;
    try {
      settings = JSON.parse(existing);
    } catch {
      throw new Error(`Claude settings file is not valid JSON, not changed: ${target.file}`);
    }
    if (!isRecord(settings)) throw new Error(`Claude settings file is not a JSON object, not changed: ${target.file}`);
    const hooksChanged = mergeRemoteHooks(settings, remoteHooks);
    const allowAdded = mergeRemoteAllow(settings, remoteAllow);
    if (!hooksChanged && allowAdded.length === 0) {
      result.unchanged.push(target.label);
      continue;
    }
    result.allowAdded[target.label] = allowAdded;
    const realPath = await fs.realpath(target.file);
    const mode = (await fs.stat(realPath)).mode & 0o777;
    await writeFileAtomic(realPath, `${JSON.stringify(settings, null, 2)}\n`, mode);
    result.updated.push(target.label);
  }
  return result;
}

export function claudeCompanionSettingsPath(configDir: string): string {
  return path.join(configDir, COMPANION_SETTINGS_FILE);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
