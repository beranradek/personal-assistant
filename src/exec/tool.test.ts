import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { handleExec } from "./tool.js";
import { clearAll, getSession } from "./process-registry.js";
import { clearSystemEvents, peekSystemEvents } from "../heartbeat/system-events.js";
import type { Config } from "../core/types.js";
import type { ExecOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Mock child_process.spawn
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock security modules
// ---------------------------------------------------------------------------

vi.mock("../security/allowed-commands.js", () => ({
  extractCommands: vi.fn(),
  validateCommand: vi.fn(),
  extractFilePathsFromCommand: vi.fn(),
}));

vi.mock("../security/path-validator.js", () => ({
  validatePath: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import mocked modules
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import {
  extractCommands,
  validateCommand,
  extractFilePathsFromCommand,
} from "../security/allowed-commands.js";
import { validatePath } from "../security/path-validator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Config["security"]> = {}): Config {
  return {
    security: {
      allowedCommands: ["ls", "echo", "node", "cat"],
      commandsNeedingExtraValidation: [],
      workspace: "/home/test/workspace",
      dataDir: "/home/test/.pa/data",
      additionalReadDirs: [],
      additionalWriteDirs: [],
      ...overrides,
    },
    adapters: {
      telegram: { enabled: false, botToken: "", allowedUserIds: [], mode: "polling" },
      slack: { enabled: false, botToken: "", appToken: "", socketMode: true },
    },
    heartbeat: { enabled: false, intervalMinutes: 30, activeHours: "8-21", deliverTo: "last" },
    gateway: { maxQueueSize: 20 },
    agent: { model: null, maxTurns: 200 },
    session: { maxHistoryMessages: 50, compactionEnabled: true },
    memory: {
      search: {
        enabled: false,
        hybridWeights: { vector: 0.7, keyword: 0.3 },
        minScore: 0.35,
        maxResults: 6,
        chunkTokens: 400,
        chunkOverlap: 80,
      },
      extraPaths: [],
    },
    mcpServers: {},
  };
}

/**
 * Create a mock ChildProcess that emits events.
 * Immediately emits data on stdout and exits with given code.
 */
function createMockProcess(
  output: string,
  exitCode: number,
  options?: { immediate?: boolean },
): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess;
  (proc as any).pid = Math.floor(Math.random() * 10000) + 1000;
  (proc as any).stdout = new EventEmitter();
  (proc as any).stderr = new EventEmitter();

  if (options?.immediate !== false) {
    // Schedule data + close events for the next tick
    process.nextTick(() => {
      (proc as any).stdout.emit("data", Buffer.from(output));
      proc.emit("close", exitCode);
    });
  }

  return proc;
}

/**
 * Create a mock ChildProcess that stays running (does not emit close).
 */
function createLongRunningProcess(initialOutput: string = ""): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess;
  (proc as any).pid = Math.floor(Math.random() * 10000) + 1000;
  (proc as any).stdout = new EventEmitter();
  (proc as any).stderr = new EventEmitter();

  if (initialOutput) {
    process.nextTick(() => {
      (proc as any).stdout.emit("data", Buffer.from(initialOutput));
    });
  }

  return proc;
}

/**
 * Set up mocks so security validation passes.
 */
function passAllSecurity() {
  (extractCommands as Mock).mockReturnValue(["ls"]);
  (validateCommand as Mock).mockReturnValue({ allowed: true });
  (extractFilePathsFromCommand as Mock).mockReturnValue([]);
  (validatePath as Mock).mockReturnValue({ valid: true, resolvedPath: "/home/test/workspace/file" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleExec", () => {
  const config = makeConfig();

  beforeEach(() => {
    clearAll();
    clearSystemEvents();
    vi.clearAllMocks();
    passAllSecurity();
  });

  // -------------------------------------------------------------------------
  // Basic execution
  // -------------------------------------------------------------------------
  describe("basic execution", () => {
    it("spawns a child process with the given command", async () => {
      const mockProc = createMockProcess("hello world\n", 0);
      (spawn as Mock).mockReturnValue(mockProc);

      const result = await handleExec({ command: "echo hello world" }, config);

      expect(spawn).toHaveBeenCalledWith(
        "echo hello world",
        expect.objectContaining({ shell: true }),
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain("hello world");
      expect(result.exitCode).toBe(0);
    });

    it("returns output from stdout", async () => {
      const mockProc = createMockProcess("file1.txt\nfile2.txt\n", 0);
      (spawn as Mock).mockReturnValue(mockProc);

      const result = await handleExec({ command: "ls" }, config);

      expect(result.success).toBe(true);
      expect(result.output).toContain("file1.txt");
      expect(result.output).toContain("file2.txt");
    });

    it("returns non-zero exit code on failure", async () => {
      const mockProc = createMockProcess("error occurred\n", 1);
      (spawn as Mock).mockReturnValue(mockProc);

      const result = await handleExec({ command: "ls nonexistent" }, config);

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Command validation
  // -------------------------------------------------------------------------
  describe("command validation", () => {
    it("validates commands against the allowlist", async () => {
      (extractCommands as Mock).mockReturnValue(["curl"]);
      (validateCommand as Mock).mockReturnValue({
        allowed: false,
        reason: "Command 'curl' is not in the allowed commands list",
      });

      const result = await handleExec({ command: "curl http://evil.com" }, config);

      expect(result.success).toBe(false);
      expect(result.message).toContain("curl");
      expect(spawn).not.toHaveBeenCalled();
    });

    it("blocks execution when any command in pipeline is not allowed", async () => {
      (extractCommands as Mock).mockReturnValue(["ls", "badcmd"]);
      (validateCommand as Mock)
        .mockReturnValueOnce({ allowed: true })
        .mockReturnValueOnce({
          allowed: false,
          reason: "Command 'badcmd' is not in the allowed commands list",
        });

      const result = await handleExec(
        { command: "ls | badcmd" },
        config,
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("badcmd");
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Path validation
  // -------------------------------------------------------------------------
  describe("path validation", () => {
    it("validates file paths against the workspace", async () => {
      (extractCommands as Mock).mockReturnValue(["cp"]);
      (validateCommand as Mock).mockReturnValue({ allowed: true });
      (extractFilePathsFromCommand as Mock).mockReturnValue([
        "file.txt",
        "/etc/passwd",
      ]);
      (validatePath as Mock)
        .mockReturnValueOnce({ valid: true, resolvedPath: "/home/test/workspace/file.txt" })
        .mockReturnValueOnce({
          valid: false,
          reason: "Path is outside allowed directories",
        });

      const result = await handleExec(
        { command: "cp file.txt /etc/passwd" },
        config,
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("outside");
      expect(spawn).not.toHaveBeenCalled();
    });

    it("allows commands when all paths are within workspace", async () => {
      (extractFilePathsFromCommand as Mock).mockReturnValue(["src/app.ts"]);
      (validatePath as Mock).mockReturnValue({
        valid: true,
        resolvedPath: "/home/test/workspace/src/app.ts",
      });
      const mockProc = createMockProcess("", 0);
      (spawn as Mock).mockReturnValue(mockProc);

      const result = await handleExec(
        { command: "cat src/app.ts" },
        config,
      );

      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Background execution
  // -------------------------------------------------------------------------
  describe("background execution", () => {
    it("returns immediately with session ID when background: true", async () => {
      const mockProc = createLongRunningProcess("starting server...\n");
      (spawn as Mock).mockReturnValue(mockProc);

      const result = await handleExec(
        { command: "node server.js", background: true },
        config,
      );

      expect(result.success).toBe(true);
      expect(result.sessionId).toBeDefined();
      expect(typeof result.sessionId).toBe("string");
    });

    it("registers the process in the process registry", async () => {
      const mockProc = createLongRunningProcess();
      (spawn as Mock).mockReturnValue(mockProc);

      const result = await handleExec(
        { command: "node server.js", background: true },
        config,
      );

      const session = getSession(result.sessionId!);
      expect(session).toBeDefined();
      expect(session!.command).toBe("node server.js");
      expect(session!.exitCode).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Process exit enqueues system event
  // -------------------------------------------------------------------------
  describe("process exit system event", () => {
    it("enqueues a system event when background process exits", async () => {
      const mockProc = createLongRunningProcess();
      (spawn as Mock).mockReturnValue(mockProc);

      const result = await handleExec(
        { command: "node build.js", background: true },
        config,
      );

      // Simulate the process exiting
      mockProc.emit("close", 0);

      // Allow microtasks to flush
      await new Promise((r) => setTimeout(r, 10));

      const events = peekSystemEvents();
      expect(events.length).toBeGreaterThan(0);
      const execEvent = events.find((e) => e.type === "exec");
      expect(execEvent).toBeDefined();
      expect(execEvent!.text).toContain("node build.js");
    });

    it("marks the session as exited when process closes", async () => {
      const mockProc = createLongRunningProcess();
      (spawn as Mock).mockReturnValue(mockProc);

      const result = await handleExec(
        { command: "npm test", background: true },
        config,
      );

      // Simulate exit
      mockProc.emit("close", 0);
      await new Promise((r) => setTimeout(r, 10));

      const session = getSession(result.sessionId!);
      expect(session!.exitCode).toBe(0);
      expect(session!.exitedAt).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // yieldMs
  // -------------------------------------------------------------------------
  describe("yieldMs", () => {
    it("waits yieldMs then returns output so far if still running", async () => {
      const mockProc = createLongRunningProcess("partial output\n");
      (spawn as Mock).mockReturnValue(mockProc);

      const result = await handleExec(
        { command: "node long-task.js", yieldMs: 50 },
        config,
      );

      // Process is still running, so we get a session ID
      expect(result.success).toBe(true);
      expect(result.sessionId).toBeDefined();
      expect(result.output).toContain("partial output");
    });

    it("returns completed result if process exits before yieldMs", async () => {
      const mockProc = createMockProcess("done\n", 0);
      (spawn as Mock).mockReturnValue(mockProc);

      const result = await handleExec(
        { command: "echo done", yieldMs: 1000 },
        config,
      );

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("done");
    });
  });

  // -------------------------------------------------------------------------
  // stderr handling
  // -------------------------------------------------------------------------
  describe("stderr handling", () => {
    it("captures stderr output alongside stdout", async () => {
      const proc = new EventEmitter() as unknown as ChildProcess;
      (proc as any).pid = 5555;
      (proc as any).stdout = new EventEmitter();
      (proc as any).stderr = new EventEmitter();

      process.nextTick(() => {
        (proc as any).stdout.emit("data", Buffer.from("stdout line\n"));
        (proc as any).stderr.emit("data", Buffer.from("stderr line\n"));
        proc.emit("close", 0);
      });

      (spawn as Mock).mockReturnValue(proc);

      const result = await handleExec({ command: "ls" }, config);

      expect(result.output).toContain("stdout line");
      expect(result.output).toContain("stderr line");
    });
  });
});
