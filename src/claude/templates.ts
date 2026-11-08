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
  /** Files that did not exist. They were created from the base template and merged. */
  created: string[];
  /** Files where missing remote hooks or flags were added. */
  updated: string[];
  /** Files that already had all remote hooks and allow entries. */
  unchanged: string[];
  /** Per file: the `permissions.allow` entries that were added (only files that were merged). */
  allowAdded: Record<string, string[]>;
}

type JsonRecord = Record<string, unknown>;
type HookEntry = [event: string, hook: JsonRecord];

/** Allow entries of the remote MCP tools. The Claude Code agent must use them without a prompt. */
const REMOTE_ALLOW_PREFIX = "mcp__pa__remote_session_";
const REMOTE_COMMAND_RE = /(^|[\s/])(pa-remote-hook|pa claude-remote-hook)\s+(\S+)/;
/** Older plain modes that the newer listen modes replace (same event, same posted payload). */
const LEGACY_MODES: Record<string, string> = { "listen-fail": "StopFailure", "listen-prompt": "UserPromptSubmit" };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The mode (first argument) of a remote hook command, or undefined when it is not a remote hook command. */
function remoteModeOf(command: string): string | undefined {
  return REMOTE_COMMAND_RE.exec(command)?.[3];
}

/** Regex of a remote hook command (new or older form) for one mode. Edited paths and flags are accepted. */
function modeRegExp(mode: string): RegExp {
  return new RegExp(`(^|[\\s/])(pa-remote-hook|pa claude-remote-hook)\\s+${escapeRegExp(mode)}(?![\\w-])`);
}

/** Remote hook entries of a template: hook objects whose command is a remote hook command. */
function templateRemoteHooks(template: unknown): HookEntry[] {
  const result: HookEntry[] = [];
  const hooks = isRecord(template) && isRecord(template["hooks"]) ? template["hooks"] : {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group["hooks"])) continue;
      for (const hook of group["hooks"]) {
        if (isRecord(hook) && typeof hook["command"] === "string" && remoteModeOf(hook["command"])) result.push([event, hook]);
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

/** All hook objects of one event (all groups) that have a string command. */
function hookObjectsOf(groups: unknown[]): JsonRecord[] {
  const result: JsonRecord[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group["hooks"])) continue;
    for (const hook of group["hooks"]) {
      if (isRecord(hook) && typeof hook["command"] === "string") result.push(hook);
    }
  }
  return result;
}

/** Set `async` and `asyncRewake` where the template has them and the existing hook does not. Returns true on a change. */
function upgradeFlags(existing: JsonRecord, template: JsonRecord): boolean {
  let changed = false;
  for (const flag of ["async", "asyncRewake"]) {
    if (template[flag] === true && existing[flag] !== true) {
      existing[flag] = true;
      changed = true;
    }
  }
  return changed;
}

/**
 * Add missing remote hooks to a parsed settings object. An existing hook of the same mode is upgraded in place (flags),
 * never duplicated. Returns true when something changed.
 */
function mergeRemoteHooks(settings: JsonRecord, remoteHooks: HookEntry[]): boolean {
  let changed = false;
  if (settings["hooks"] === undefined) settings["hooks"] = {};
  const hooks = settings["hooks"];
  if (!isRecord(hooks)) throw new Error("Claude settings: \"hooks\" is not an object");
  for (const [event, hook] of remoteHooks) {
    if (hooks[event] === undefined) hooks[event] = [];
    const groups = hooks[event];
    if (!Array.isArray(groups)) throw new Error(`Claude settings: hooks.${event} is not an array`);
    const command = hook["command"] as string;
    const mode = remoteModeOf(command) as string;
    const legacyMode = LEGACY_MODES[mode];
    const existing = hookObjectsOf(groups);
    const exact = existing.filter((h) => modeRegExp(mode).test(h["command"] as string));
    if (exact.length > 0) {
      for (const h of exact) {
        // Rewrite the older command form only when it is byte-identical to the old template command.
        if (h["command"] === `pa claude-remote-hook ${mode}`) {
          h["command"] = command;
          changed = true;
        }
        if (upgradeFlags(h, hook)) changed = true;
      }
      continue;
    }
    const legacy = legacyMode ? existing.filter((h) => modeRegExp(legacyMode).test(h["command"] as string)) : [];
    if (legacy.length > 0) {
      // An old plain hook (for example `StopFailure`) is replaced by the listen mode, when it was not edited.
      // An edited old hook stays as it is. No duplicate is added.
      for (const h of legacy) {
        if (h["command"] === `pa claude-remote-hook ${legacyMode}` || h["command"] === `pa-remote-hook ${legacyMode}`) {
          h["command"] = command;
          upgradeFlags(h, hook);
          changed = true;
        }
      }
      continue;
    }
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

interface PlannedWrite {
  label: string;
  /** File to write (the real path when the target is a symlink). */
  file: string;
  content: string;
  mode: number;
  /** True when the file did not exist. */
  isNew: boolean;
  allowAdded: string[];
}

/**
 * Add the remote session hooks (`pa-remote-hook ...`) and the `mcp__pa__remote_session_*` allow entries to the workspace
 * Claude settings and to the launcher settings under `<configDir>/claude-code/`. The entries come from the opt-in template
 * `remote-settings.json`. Additive and idempotent: other keys and hooks stay as they are, an existing remote hook is never
 * duplicated (it is upgraded in place), a missing file is first created from the base template, then merged.
 * All target files are parsed and validated before any write: on an error nothing is written.
 * Writes are atomic and keep the file mode.
 */
export async function installClaudeRemoteConfig(workspaceDir: string, configDir?: string): Promise<ClaudeRemoteInstallResult> {
  const baseText = await fs.readFile(new URL("../templates/claude-code/settings.json", import.meta.url), "utf8");
  const remoteUrl = new URL("../templates/claude-code/remote-settings.json", import.meta.url);
  const remoteTemplate = JSON.parse(await fs.readFile(remoteUrl, "utf8")) as unknown;
  const remoteHooks = templateRemoteHooks(remoteTemplate);
  const remoteAllow = templateRemoteAllow(remoteTemplate);
  const targets = [
    { label: ".claude/settings.json", file: path.join(workspaceDir, ".claude", "settings.json"), createMode: 0o644 },
    ...(configDir ? [{ label: COMPANION_SETTINGS_FILE, file: path.join(configDir, COMPANION_SETTINGS_FILE), createMode: 0o600 }] : []),
  ];
  const result: ClaudeRemoteInstallResult = { created: [], updated: [], unchanged: [], allowAdded: {} };
  const plan: PlannedWrite[] = [];

  // Phase 1: read, parse, validate and merge in memory. Nothing is written here.
  for (const target of targets) {
    let existing: string | undefined;
    try {
      // Follow a symlink so the link itself is kept.
      existing = await fs.readFile(target.file, "utf8");
    } catch (error: unknown) {
      if (!isMissingFileError(error)) throw error;
    }
    let settings: unknown;
    try {
      settings = JSON.parse(existing ?? baseText);
    } catch {
      throw new Error(`Claude settings file is not valid JSON, not changed: ${target.file}`);
    }
    if (!isRecord(settings)) throw new Error(`Claude settings file is not a JSON object, not changed: ${target.file}`);
    const hooksChanged = mergeRemoteHooks(settings, remoteHooks);
    const allowAdded = mergeRemoteAllow(settings, remoteAllow);
    if (existing !== undefined && !hooksChanged && allowAdded.length === 0) {
      result.unchanged.push(target.label);
      continue;
    }
    const content = `${JSON.stringify(settings, null, 2)}\n`;
    if (existing === undefined) {
      plan.push({ label: target.label, file: target.file, content, mode: target.createMode, isNew: true, allowAdded });
    } else {
      const realPath = await fs.realpath(target.file);
      const mode = (await fs.stat(realPath)).mode & 0o777;
      plan.push({ label: target.label, file: realPath, content, mode, isNew: false, allowAdded });
    }
  }

  // Phase 2: write.
  for (const item of plan) {
    if (item.isNew) await fs.mkdir(path.dirname(item.file), { recursive: true, mode: 0o700 });
    await writeFileAtomic(item.file, item.content, item.mode);
    if (item.isNew) {
      result.created.push(item.label);
    } else {
      result.allowAdded[item.label] = item.allowAdded;
      result.updated.push(item.label);
    }
  }
  return result;
}

export function claudeCompanionSettingsPath(configDir: string): string {
  return path.join(configDir, COMPANION_SETTINGS_FILE);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
