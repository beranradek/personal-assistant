/**
 * Bash Security Hook (PreToolUse)
 * ================================
 *
 * Validates Bash tool invocations before they execute. Combines three
 * layers of defense-in-depth:
 *
 * 1. **Command allowlist** -- every command name extracted from the shell
 *    string must appear in `config.security.allowedCommands`.
 *
 * 2. **Extra validation** -- commands listed in
 *    `config.security.commandsNeedingExtraValidation` (e.g. rm, kill) are
 *    run through additional safety checks (dangerous patterns, PID ranges).
 *
 * 3. **Path validation** -- file paths extracted from the command are
 *    validated against the workspace directory and any additional
 *    read/write directories.
 *
 * If everything passes the hook returns `{}` (allow). If any check fails
 * it returns `{ decision: "block", reason: "..." }`.
 *
 * Non-Bash tool calls are passed through unchanged (`{}`).
 */

import {
  containsSudo,
  extractCommands,
  validateCommand,
  validateRmCommand,
  validateKillCommand,
  extractFilePathsFromCommand,
} from "./allowed-commands.js";
import { validatePath } from "./path-validator.js";
import type { Config } from "../core/types.js";

// ---------------------------------------------------------------------------
// Types
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
// Extra-validation dispatch table
// ---------------------------------------------------------------------------

/**
 * Map of command names to their extra-validation functions.
 *
 * Each function receives the full command segment and returns
 * `{ allowed, reason? }`. The segment is the original command string
 * for single commands, or needs to be reconstructed for commands found
 * in pipes/chains.
 */
const EXTRA_VALIDATORS: Record<
  string,
  (segment: string) => { allowed: boolean; reason?: string }
> = {
  rm: validateRmCommand,
  kill: validateKillCommand,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract individual command segments from a full command string.
 *
 * Splits on `&&`, `||`, `;` to get chained segments, then splits on `|`
 * to get piped segments. Returns trimmed, non-empty segments.
 */
function extractSegments(commandString: string): string[] {
  const segments: string[] = [];

  // Split on ;, &&, ||
  const chainedParts = commandString.split(/\s*(?:&&|\|\|)\s*/);
  for (const part of chainedParts) {
    const semiParts = part.split(/\s*;\s*/);
    for (const semi of semiParts) {
      // Split on | for pipes
      const pipeParts = semi.split(/\s*\|\s*/);
      for (const pipe of pipeParts) {
        const trimmed = pipe.trim();
        if (trimmed) {
          segments.push(trimmed);
        }
      }
    }
  }

  return segments;
}

/**
 * Get the base command name from a segment string.
 *
 * Skips variable assignments and shell keywords to find the actual
 * command name token.
 */
function getBaseCommand(segment: string): string | null {
  const tokens = segment.split(/\s+/);
  for (const token of tokens) {
    // Skip variable assignments (VAR=value)
    if (token.includes("=") && !token.startsWith("=")) {
      const eqIndex = token.indexOf("=");
      const beforeEq = token.slice(0, eqIndex);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(beforeEq)) {
        continue;
      }
    }
    // Skip flags
    if (token.startsWith("-")) {
      continue;
    }
    // Return the basename (strip directory)
    const parts = token.split("/");
    return parts[parts.length - 1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Commands that read files -- their non-flag arguments are file paths
// ---------------------------------------------------------------------------

/**
 * Common commands whose positional arguments are file paths.
 *
 * These are NOT in `extractFilePathsFromCommand` (which targets cp, mv, rm,
 * mkdir, etc.) but they still take file path arguments that we must validate.
 */
const READ_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "sort",
  "uniq",
  "wc",
  "diff",
  "file",
  "stat",
  "grep",
  "awk",
  "sed",
]);

/**
 * Extract path-like arguments from a general command segment.
 *
 * For commands in READ_COMMANDS, extracts all non-flag positional
 * arguments that look like file paths (start with /, ./, ../, or ~,
 * or are bare filenames that could be relative paths).
 *
 * For other commands, extracts only arguments that are clearly
 * absolute paths (start with /).
 */
function extractPathArguments(segment: string): string[] {
  const tokens = segment.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return [];

  const baseCmd = getBaseCommand(segment);
  if (!baseCmd) return [];

  const paths: string[] = [];

  // For read commands, all non-flag arguments after the command are paths
  if (READ_COMMANDS.has(baseCmd)) {
    let foundCmd = false;
    for (const token of tokens) {
      if (!foundCmd) {
        // Skip variable assignments and find the command
        if (token.includes("=") && !token.startsWith("=")) {
          continue;
        }
        if (token.startsWith("-")) continue;
        foundCmd = true;
        continue; // skip the command name itself
      }

      // Skip flags
      if (token.startsWith("-")) continue;

      // Skip redirection operators
      if (
        token === ">" ||
        token === ">>" ||
        token === "2>" ||
        token === "&>"
      ) {
        continue;
      }

      // If the token looks like a path (absolute), validate it
      if (token.startsWith("/") || token.startsWith("~")) {
        paths.push(token);
      }
    }
  } else {
    // For non-read, non-file-operation commands, check only absolute paths
    let foundCmd = false;
    for (const token of tokens) {
      if (!foundCmd) {
        if (token.includes("=") && !token.startsWith("=")) continue;
        if (token.startsWith("-")) continue;
        foundCmd = true;
        continue;
      }
      if (token.startsWith("-")) continue;
      if (
        token === ">" ||
        token === ">>" ||
        token === "2>" ||
        token === "&>"
      ) {
        continue;
      }

      if (token.startsWith("/") || token.startsWith("~")) {
        paths.push(token);
      }
    }
  }

  return paths;
}

// ---------------------------------------------------------------------------
// Main hook function
// ---------------------------------------------------------------------------

/**
 * PreToolUse security hook for Bash commands.
 *
 * @param input - The tool invocation being requested
 * @param toolUseId - The tool use ID (unused but part of the hook signature)
 * @param context - The workspace directory and full config
 * @returns `{}` to allow, or `{ decision: "block", reason: "..." }` to block
 */
export async function bashSecurityHook(
  input: HookInput,
  toolUseId: string | undefined,
  context: HookContext,
): Promise<HookResult> {
  // Step 1: Non-Bash tool calls pass through unchanged
  if (input.tool_name !== "Bash") {
    return {};
  }

  // Step 2: Extract the command string from tool_input
  const command =
    typeof input.tool_input.command === "string"
      ? input.tool_input.command
      : "";

  // Empty command passes through
  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    return {};
  }

  // Step 3: Reject any command containing sudo (privilege escalation)
  const sudoCheck = containsSudo(trimmedCommand);
  if (sudoCheck.found) {
    return { decision: "block", reason: sudoCheck.reason };
  }

  const { config, workspaceDir } = context;
  const allowlist = new Set(config.security.allowedCommands);
  const extraValidationSet = new Set(
    config.security.commandsNeedingExtraValidation,
  );

  // Step 4: Extract all command names and validate against allowlist
  const commands = extractCommands(trimmedCommand);

  for (const cmd of commands) {
    const validation = validateCommand(cmd, allowlist);
    if (!validation.allowed) {
      return {
        decision: "block",
        reason: validation.reason ?? `Command '${cmd}' is not allowed`,
      };
    }
  }

  // Step 5: Run extra validation for commands that need it
  const segments = extractSegments(trimmedCommand);

  for (const segment of segments) {
    const baseCmd = getBaseCommand(segment);
    if (baseCmd && extraValidationSet.has(baseCmd)) {
      const validator = EXTRA_VALIDATORS[baseCmd];
      if (validator) {
        const extraResult = validator(segment);
        if (!extraResult.allowed) {
          return {
            decision: "block",
            reason:
              extraResult.reason ??
              `Command '${baseCmd}' failed extra validation`,
          };
        }
      }
    }
  }

  // Step 6: Extract file paths and validate each one
  for (const segment of segments) {
    // Paths from file-operation commands (cp, mv, rm, mkdir, etc.)
    // and output redirections
    const fileOpPaths = extractFilePathsFromCommand(segment);

    // Paths from general commands (absolute paths in arguments)
    const generalPaths = extractPathArguments(segment);

    // Combine and deduplicate
    const allPaths = [...new Set([...fileOpPaths, ...generalPaths])];

    for (const filePath of allPaths) {
      const pathResult = validatePath(filePath, {
        workspaceDir,
        additionalReadDirs: config.security.additionalReadDirs,
        additionalWriteDirs: config.security.additionalWriteDirs,
        operation: "write", // conservative: assume write by default
      });

      if (!pathResult.valid) {
        return {
          decision: "block",
          reason:
            pathResult.reason ??
            `Path '${filePath}' is outside allowed directories`,
        };
      }
    }
  }

  // All checks passed
  return {};
}
