/**
 * File Tool Security Hook (PreToolUse)
 * =====================================
 *
 * Validates file paths for SDK built-in file tools (Read, Write, Edit,
 * Glob, Grep) before they execute.
 *
 * Uses the same `validatePath()` infrastructure as the Bash security hook
 * to enforce workspace boundaries on all file access.
 *
 * If the path is within allowed directories the hook returns `{}` (allow).
 * If validation fails it returns `{ decision: "block", reason: "..." }`.
 */

import { validatePath } from "./path-validator.js";
import type { Config } from "../core/types.js";

// ---------------------------------------------------------------------------
// Types (matches bash-hook.ts conventions)
// ---------------------------------------------------------------------------

interface HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

interface HookContext {
  workspaceDir: string;
  config: Config;
}

type HookResult = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Tool → path field mapping
// ---------------------------------------------------------------------------

/** Tools that read files — their paths are validated with operation "read". */
const READ_TOOLS: Record<string, string> = {
  Read: "file_path",
  Glob: "path",
  Grep: "path",
};

/** Tools that write files — their paths are validated with operation "write". */
const WRITE_TOOLS: Record<string, string> = {
  Write: "file_path",
  Edit: "file_path",
};

// ---------------------------------------------------------------------------
// Main hook function
// ---------------------------------------------------------------------------

/**
 * PreToolUse security hook for SDK file tools.
 *
 * @param input - The tool invocation being requested
 * @param _toolUseId - The tool use ID (unused but part of the hook signature)
 * @param context - The workspace directory and full config
 * @returns `{}` to allow, or `{ decision: "block", reason: "..." }` to block
 */
export async function fileToolSecurityHook(
  input: HookInput,
  _toolUseId: string | undefined,
  context: HookContext,
): Promise<HookResult> {
  const { tool_name, tool_input } = input;
  const { config, workspaceDir } = context;

  // Determine operation and path field
  let operation: "read" | "write";
  let pathField: string | undefined;

  if (tool_name in READ_TOOLS) {
    operation = "read";
    pathField = READ_TOOLS[tool_name];
  } else if (tool_name in WRITE_TOOLS) {
    operation = "write";
    pathField = WRITE_TOOLS[tool_name];
  } else {
    // Unknown tool — pass through
    return {};
  }

  // Extract the path from tool_input
  const rawPath = tool_input[pathField!];

  // For Glob/Grep, `path` is optional — when omitted the SDK uses cwd
  // (which is the workspace), so allow.
  if (rawPath === undefined || rawPath === null) {
    return {};
  }

  if (typeof rawPath !== "string") {
    return {
      decision: "block",
      reason: `Invalid path type for ${tool_name}: expected string, got ${typeof rawPath}`,
    };
  }

  // Build additional read dirs — include dataDir for read operations
  const additionalReadDirs = [...config.security.additionalReadDirs];
  if (operation === "read") {
    additionalReadDirs.push(config.security.dataDir);
  }

  const result = validatePath(rawPath, {
    workspaceDir,
    additionalReadDirs,
    additionalWriteDirs: config.security.additionalWriteDirs,
    operation,
  });

  if (!result.valid) {
    return {
      decision: "block",
      reason:
        result.reason ??
        `Path '${rawPath}' is outside allowed directories for ${tool_name}`,
    };
  }

  return {};
}
