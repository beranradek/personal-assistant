import { spawn } from "node:child_process";
import {
  extractCommands,
  validateCommand,
  extractFilePathsFromCommand,
} from "../security/allowed-commands.js";
import { validatePath } from "../security/path-validator.js";
import { enqueueSystemEvent } from "../heartbeat/system-events.js";
import { addSession, getSession, markExited } from "./process-registry.js";
import type { Config } from "../core/types.js";
import type { ExecOptions, ExecResult } from "./types.js";

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

  // ---- Step 1 & 2: Extract and validate commands ----

  const allowlist = new Set(config.security.allowedCommands);
  const commands = extractCommands(command);

  for (const cmd of commands) {
    const validation = validateCommand(cmd, allowlist);
    if (!validation.allowed) {
      return {
        success: false,
        message: validation.reason ?? `Command '${cmd}' is not allowed`,
      };
    }
  }

  // ---- Step 3: Extract and validate file paths ----

  const filePaths = extractFilePathsFromCommand(command);
  for (const filePath of filePaths) {
    const pathResult = validatePath(filePath, {
      workspaceDir: config.security.workspace,
      additionalReadDirs: config.security.additionalReadDirs,
      additionalWriteDirs: config.security.additionalWriteDirs,
      operation: "write",
    });
    if (!pathResult.valid) {
      return {
        success: false,
        message: pathResult.reason ?? `Path '${filePath}' is outside allowed directories`,
      };
    }
  }

  // ---- Step 5: Spawn child process ----

  const child = spawn(command, { shell: true });
  const pid = child.pid ?? 0;

  let output = "";

  child.stdout?.on("data", (data: Buffer) => {
    output += data.toString();
    // Also update process registry if session exists
    const sessionId = (child as any).__sessionId as string | undefined;
    if (sessionId) {
      const session = getSession(sessionId);
      if (session) {
        session.output = output;
      }
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    output += data.toString();
    const sessionId = (child as any).__sessionId as string | undefined;
    if (sessionId) {
      const session = getSession(sessionId);
      if (session) {
        session.output = output;
      }
    }
  });

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
