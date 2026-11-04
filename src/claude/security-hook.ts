import type { Config } from "../core/types.js";
import * as path from "node:path";
import { bashSecurityHook } from "../security/bash-hook.js";
import { fileToolSecurityHook } from "../security/file-tool-hook.js";

export interface ClaudeHookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
}

export interface ClaudeHookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason: string;
  };
}

const PROTECTED_TOOLS = new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]);

function isProtectedControlPath(rawPath: string, workspace: string): boolean {
  const absolute = path.resolve(workspace, rawPath);
  const relative = path.relative(workspace, absolute).split(path.sep).join("/");
  return relative === ".mcp.json" || relative === ".mcp-stdio-fallback.json" || relative === ".claude/settings.json" || relative === ".claude/settings.local.json";
}

function commandTargetsProtectedControlFile(command: string, workspace: string): boolean {
  // The command validator intentionally does not execute or expand shell input.
  // Block any literal access to the control directories, including escaped
  // filenames, rather than attempting an incomplete filename parser here.
  return command.includes(".claude") || command.includes(".mcp") || command.includes(path.join(workspace, ".claude"));
}

function decision(decisionValue: "allow" | "deny", reason: string): ClaudeHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decisionValue,
      permissionDecisionReason: reason,
    },
  };
}

function isHookInput(value: unknown): value is ClaudeHookInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return typeof input.tool_name === "string" && !!input.tool_input && typeof input.tool_input === "object";
}

/**
 * Adapter from Claude Code's command-hook protocol to PA's existing, shared
 * Bash/file security policies. A malformed or rejected request fails closed.
 */
export async function evaluateClaudePreToolUse(input: unknown, config: Config): Promise<ClaudeHookOutput> {
  if (!isHookInput(input)) return decision("deny", "Invalid PA Claude security-hook input");
  if (!PROTECTED_TOOLS.has(input.tool_name)) return decision("deny", `Unsupported protected tool: ${input.tool_name}`);

  if (input.tool_name === "Bash" && typeof input.tool_input.command === "string" && commandTargetsProtectedControlFile(input.tool_input.command, config.security.workspace)) {
    return decision("deny", "PA Claude control files cannot be changed through Bash");
  }
  if ((input.tool_name === "Write" || input.tool_name === "Edit") && typeof input.tool_input.file_path === "string" && isProtectedControlPath(input.tool_input.file_path, config.security.workspace)) {
    return decision("deny", "PA Claude control files cannot be changed through file tools");
  }

  const context = { workspaceDir: config.security.workspace, config };
  const result = input.tool_name === "Bash"
    ? await bashSecurityHook(input, input.tool_use_id, context)
    : await fileToolSecurityHook(input, input.tool_use_id, context);

  if (result["decision"] === "block") {
    const reason = typeof result["reason"] === "string" ? result["reason"] : "Blocked by PA security policy";
    return decision("deny", reason);
  }
  return decision("allow", "Allowed by Personal Assistant security policy");
}
