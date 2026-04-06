import { spawn } from "node:child_process";
import {
  containsSudo,
  extractCommands,
  validateCommand,
  extractFilePathsFromCommand,
  validateRmCommand,
  validateKillCommand,
} from "../security/allowed-commands.js";
import { validatePath } from "../security/path-validator.js";
import { enqueueSystemEvent } from "../heartbeat/system-events.js";
import { addSession, getSession, markExited } from "./process-registry.js";
import { createLogger } from "../core/logger.js";
import type { Config } from "../core/types.js";
import type { ExecOptions, ExecResult } from "./types.js";

const log = createLogger("exec");

// ---------------------------------------------------------------------------
// Helpers (mirrors src/security/bash-hook.ts logic)
// ---------------------------------------------------------------------------

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
    // Skip shell keywords
    if (
      token === "if" ||
      token === "then" ||
      token === "else" ||
      token === "elif" ||
      token === "fi" ||
      token === "for" ||
      token === "select" ||
      token === "do" ||
      token === "done" ||
      token === "while" ||
      token === "until" ||
      token === "case" ||
      token === "esac" ||
      token === "in" ||
      token === "function" ||
      token === "!" ||
      token === "{" ||
      token === "}"
    ) {
      continue;
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

function extractPathArguments(segment: string): string[] {
  const tokens = segment.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return [];

  const baseCmd = getBaseCommand(segment);
  if (!baseCmd) return [];

  const paths: string[] = [];

  if (READ_COMMANDS.has(baseCmd)) {
    let foundCmd = false;
    for (const token of tokens) {
      if (!foundCmd) {
        if (token.includes("=") && !token.startsWith("=")) {
          continue;
        }
        if (token.startsWith("-")) continue;
        foundCmd = true;
        continue;
      }

      if (token.startsWith("-")) continue;
      if (token === ">" || token === ">>" || token === "2>" || token === "&>") {
        continue;
      }

      if (token.startsWith("/") || token.startsWith("~")) {
        paths.push(token);
      }
    }
  } else {
    let foundCmd = false;
    for (const token of tokens) {
      if (!foundCmd) {
        if (token.includes("=") && !token.startsWith("=")) continue;
        if (token.startsWith("-")) continue;
        foundCmd = true;
        continue;
      }
      if (token.startsWith("-")) continue;
      if (token === ">" || token === ">>" || token === "2>" || token === "&>") {
        continue;
      }

      if (token.startsWith("/") || token.startsWith("~")) {
        paths.push(token);
      }
    }
  }

  return paths;
}

const EXTRA_VALIDATORS: Record<
  string,
  (segment: string) => { allowed: boolean; reason?: string }
> = {
  rm: validateRmCommand,
  kill: validateKillCommand,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum combined stdout+stderr buffer size (1 MB). */
const MAX_OUTPUT_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// handleExec
// ---------------------------------------------------------------------------

/**
 * Execute a shell command with security validation.
 *
 * 1. Extract commands from the command string
 * 2. Validate each against config.security.allowedCommands
 * 3. Extract file paths and validate against workspace
 * 4. If validation fails, return error
 * 5. Spawn child process with `shell: true`
 * 6. If `background: true`, register in process registry, return session ID
 * 7. If `yieldMs` specified, wait that long, return output so far + session ID
 * 8. Otherwise wait for completion, return output + exit code
 */
export async function handleExec(
  options: ExecOptions,
  config: Config,
): Promise<ExecResult> {
  const { command, background = false, yieldMs } = options;

  // ---- Step 1: Check for sudo privilege escalation ----

  if (!config.security.allowSudo) {
    const sudoCheck = containsSudo(command);
    if (sudoCheck.found) {
      return {
        success: false,
        message: sudoCheck.reason ?? "Use of 'sudo' is not allowed.",
      };
    }
  }

  // ---- Step 2: Extract and validate commands against allowlist ----

  const allowlist = new Set(config.security.allowedCommands);
  const extraValidationSet = new Set(config.security.commandsNeedingExtraValidation);
  const commands = extractCommands(command);

  for (const cmd of commands) {
    if (cmd === "sudo" && config.security.allowSudo) {
      continue;
    }
    const validation = validateCommand(cmd, allowlist);
    if (!validation.allowed) {
      return {
        success: false,
        message: validation.reason ?? `Command '${cmd}' is not allowed`,
      };
    }
  }

  // ---- Step 3: Extra validation for risky commands (rm, kill, ...) ----

  const segments = extractSegments(command);
  for (const segment of segments) {
    const baseCmd = getBaseCommand(segment);
    if (baseCmd && extraValidationSet.has(baseCmd)) {
      const validator = EXTRA_VALIDATORS[baseCmd];
      if (validator) {
        const extraResult = validator(segment);
        if (!extraResult.allowed) {
          return {
            success: false,
            message:
              extraResult.reason ??
              `Command '${baseCmd}' failed extra validation`,
          };
        }
      }
    }
  }

  // ---- Step 4: Extract and validate file paths ----

  for (const segment of segments) {
    const fileOpPaths = extractFilePathsFromCommand(segment);
    const generalPaths = extractPathArguments(segment);
    const allPaths = [...new Set([...fileOpPaths, ...generalPaths])];

    for (const filePath of allPaths) {
      const pathResult = validatePath(filePath, {
        workspaceDir: config.security.workspace,
        additionalReadDirs: config.security.additionalReadDirs,
        additionalWriteDirs: config.security.additionalWriteDirs,
        operation: "write", // conservative
      });
      if (!pathResult.valid) {
        return {
          success: false,
          message:
            pathResult.reason ??
            `Path '${filePath}' is outside allowed directories`,
        };
      }
    }
  }

  // ---- Step 5: Spawn child process ----

  const child = spawn(command, { shell: true });
  const pid = child.pid ?? 0;

  let output = "";
  let outputCapped = false;

  const appendOutput = (data: Buffer) => {
    if (outputCapped) return;
    const chunk = data.toString();
    if (output.length + chunk.length > MAX_OUTPUT_BYTES) {
      output += chunk.slice(0, MAX_OUTPUT_BYTES - output.length);
      output += "\n... [output truncated at 1 MB]";
      outputCapped = true;
      log.warn({ command, pid }, "Output exceeded 1 MB, truncating");
    } else {
      output += chunk;
    }
    const sessionId = (child as any).__sessionId as string | undefined;
    if (sessionId) {
      const session = getSession(sessionId);
      if (session) {
        session.output = output;
      }
    }
  };

  child.stdout?.on("data", appendOutput);
  child.stderr?.on("data", appendOutput);

  // ---- Step 6: Background mode ----

  if (background) {
    const sessionId = addSession(command, pid);
    (child as any).__sessionId = sessionId;

    // Listen for process exit to enqueue system event
    child.on("close", (exitCode: number | null) => {
      const code = exitCode ?? 1;
      markExited(sessionId, code);
      const session = getSession(sessionId);
      if (session) {
        session.output = output;
      }
      enqueueSystemEvent(
        `Background process exited: "${command}" (exit code ${code})`,
        "exec",
      );
    });

    return {
      success: true,
      sessionId,
      message: `Process started in background (PID ${pid})`,
    };
  }

  // ---- Step 7: yieldMs mode ----

  if (yieldMs !== undefined) {
    const sessionId = addSession(command, pid);
    (child as any).__sessionId = sessionId;

    // Listen for process exit
    child.on("close", (exitCode: number | null) => {
      const code = exitCode ?? 1;
      markExited(sessionId, code);
      const session = getSession(sessionId);
      if (session) {
        session.output = output;
      }
      enqueueSystemEvent(
        `Background process exited: "${command}" (exit code ${code})`,
        "exec",
      );
    });

    return new Promise<ExecResult>((resolve) => {
      let resolved = false;

      child.on("close", (exitCode: number | null) => {
        if (!resolved) {
          resolved = true;
          const code = exitCode ?? 1;
          resolve({
            success: code === 0,
            output,
            exitCode: code,
          });
        }
      });

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          const session = getSession(sessionId);
          if (session) {
            session.output = output;
          }
          resolve({
            success: true,
            sessionId,
            output,
          });
        }
      }, yieldMs);
    });
  }

  // ---- Step 8: Wait for completion ----

  return new Promise<ExecResult>((resolve) => {
    child.on("close", (exitCode: number | null) => {
      const code = exitCode ?? 1;
      resolve({
        success: code === 0,
        output,
        exitCode: code,
      });
    });
  });
}
