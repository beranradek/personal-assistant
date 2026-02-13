import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileToolSecurityHook } from "./file-tool-hook.js";
import type { Config } from "../core/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTestConfig(workspaceDir: string): Config {
  return {
    security: {
      allowedCommands: [],
      commandsNeedingExtraValidation: [],
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
        allowedUserIds: [],
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

function toolInput(toolName: string, input: Record<string, unknown>) {
  return { tool_name: toolName, tool_input: input };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fileToolSecurityHook", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let config: Config;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-hook-test-"));
    workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, ".data"), { recursive: true });
    // Create a test file so realpathSync works
    fs.writeFileSync(path.join(workspaceDir, "test.txt"), "hello");
    config = makeTestConfig(workspaceDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Read tool
  // -----------------------------------------------------------------------

  describe("Read tool", () => {
    it("allows reading a file inside workspace", async () => {
      const input = toolInput("Read", {
        file_path: path.join(workspaceDir, "test.txt"),
      });
      const result = await fileToolSecurityHook(input, "tool-1", {
        workspaceDir,
        config,
      });
      expect(result).toEqual({});
    });

    it("blocks reading a file outside workspace", async () => {
      const input = toolInput("Read", { file_path: "/etc/passwd" });
      const result = await fileToolSecurityHook(input, "tool-2", {
        workspaceDir,
        config,
      });
      expect(result).toHaveProperty("decision", "block");
    });

    it("blocks reading from home directory", async () => {
      const input = toolInput("Read", {
        file_path: path.join(os.homedir(), ".tmux.conf"),
      });
      const result = await fileToolSecurityHook(input, "tool-3", {
        workspaceDir,
        config,
      });
      expect(result).toHaveProperty("decision", "block");
    });

    it("allows reading from dataDir", async () => {
      const dataFile = path.join(workspaceDir, ".data", "sessions.jsonl");
      fs.writeFileSync(dataFile, "{}");
      const input = toolInput("Read", { file_path: dataFile });
      const result = await fileToolSecurityHook(input, "tool-4", {
        workspaceDir,
        config,
      });
      expect(result).toEqual({});
    });

    it("allows reading from additionalReadDirs", async () => {
      const extraDir = path.join(tmpDir, "extra-read");
      fs.mkdirSync(extraDir, { recursive: true });
      const extraFile = path.join(extraDir, "notes.txt");
      fs.writeFileSync(extraFile, "notes");
      config.security.additionalReadDirs = [extraDir];

      const input = toolInput("Read", { file_path: extraFile });
      const result = await fileToolSecurityHook(input, "tool-5", {
        workspaceDir,
        config,
      });
      expect(result).toEqual({});
    });
  });

  // -----------------------------------------------------------------------
  // Write tool
  // -----------------------------------------------------------------------

  describe("Write tool", () => {
    it("allows writing a file inside workspace", async () => {
      const input = toolInput("Write", {
        file_path: path.join(workspaceDir, "new.txt"),
        content: "hello",
      });
      const result = await fileToolSecurityHook(input, "tool-10", {
        workspaceDir,
        config,
      });
      expect(result).toEqual({});
    });

    it("blocks writing a file outside workspace", async () => {
      const input = toolInput("Write", {
        file_path: "/home/radek/pozdrav.md",
        content: "Ahoj",
      });
      const result = await fileToolSecurityHook(input, "tool-11", {
        workspaceDir,
        config,
      });
      expect(result).toHaveProperty("decision", "block");
    });

    it("blocks writing to /tmp", async () => {
      const input = toolInput("Write", {
        file_path: "/tmp/evil.sh",
        content: "#!/bin/bash",
      });
      const result = await fileToolSecurityHook(input, "tool-12", {
        workspaceDir,
        config,
      });
      expect(result).toHaveProperty("decision", "block");
    });

    it("allows writing to additionalWriteDirs", async () => {
      const extraDir = path.join(tmpDir, "extra-write");
      fs.mkdirSync(extraDir, { recursive: true });
      config.security.additionalWriteDirs = [extraDir];

      const input = toolInput("Write", {
        file_path: path.join(extraDir, "output.txt"),
        content: "data",
      });
      const result = await fileToolSecurityHook(input, "tool-13", {
        workspaceDir,
        config,
      });
      expect(result).toEqual({});
    });

    it("blocks writing to additionalReadDirs (read-only)", async () => {
      const readDir = path.join(tmpDir, "read-only");
      fs.mkdirSync(readDir, { recursive: true });
      config.security.additionalReadDirs = [readDir];

      const input = toolInput("Write", {
        file_path: path.join(readDir, "file.txt"),
        content: "data",
      });
      const result = await fileToolSecurityHook(input, "tool-14", {
        workspaceDir,
        config,
      });
      expect(result).toHaveProperty("decision", "block");
    });
  });

  // -----------------------------------------------------------------------
  // Edit tool
  // -----------------------------------------------------------------------

  describe("Edit tool", () => {
    it("allows editing a file inside workspace", async () => {
      const input = toolInput("Edit", {
        file_path: path.join(workspaceDir, "test.txt"),
        old_string: "hello",
        new_string: "world",
      });
      const result = await fileToolSecurityHook(input, "tool-20", {
        workspaceDir,
        config,
      });
      expect(result).toEqual({});
    });

    it("blocks editing a file outside workspace", async () => {
      const input = toolInput("Edit", {
        file_path: "/etc/hosts",
        old_string: "localhost",
        new_string: "evil",
      });
      const result = await fileToolSecurityHook(input, "tool-21", {
        workspaceDir,
        config,
      });
      expect(result).toHaveProperty("decision", "block");
    });
  });

  // -----------------------------------------------------------------------
  // Glob tool
  // -----------------------------------------------------------------------

  describe("Glob tool", () => {
    it("allows glob with path inside workspace", async () => {
      const input = toolInput("Glob", {
        pattern: "*.txt",
        path: workspaceDir,
      });
      const result = await fileToolSecurityHook(input, "tool-30", {
        workspaceDir,
        config,
      });
      expect(result).toEqual({});
    });

    it("blocks glob with path outside workspace", async () => {
      const input = toolInput("Glob", {
        pattern: "*.conf",
        path: "/etc",
      });
      const result = await fileToolSecurityHook(input, "tool-31", {
        workspaceDir,
        config,
      });
      expect(result).toHaveProperty("decision", "block");
    });

    it("allows glob when no path is provided (defaults to cwd)", async () => {
      const input = toolInput("Glob", { pattern: "**/*.ts" });
      const result = await fileToolSecurityHook(input, "tool-32", {
        workspaceDir,
        config,
      });
      expect(result).toEqual({});
    });
  });

  // -----------------------------------------------------------------------
  // Grep tool
  // -----------------------------------------------------------------------

  describe("Grep tool", () => {
    it("allows grep with path inside workspace", async () => {
      const input = toolInput("Grep", {
        pattern: "password",
        path: workspaceDir,
      });
      const result = await fileToolSecurityHook(input, "tool-40", {
        workspaceDir,
        config,
      });
      expect(result).toEqual({});
    });

    it("blocks grep with path outside workspace", async () => {
      const input = toolInput("Grep", {
        pattern: "password",
        path: os.homedir(),
      });
      const result = await fileToolSecurityHook(input, "tool-41", {
        workspaceDir,
        config,
      });
      expect(result).toHaveProperty("decision", "block");
    });

    it("allows grep when no path is provided", async () => {
      const input = toolInput("Grep", { pattern: "TODO" });
      const result = await fileToolSecurityHook(input, "tool-42", {
        workspaceDir,
        config,
      });
      expect(result).toEqual({});
    });
  });

  // -----------------------------------------------------------------------
  // Unknown tools
  // -----------------------------------------------------------------------

  describe("unknown tools", () => {
    it("passes through unknown tool names", async () => {
      const input = toolInput("WebFetch", { url: "https://example.com" });
      const result = await fileToolSecurityHook(input, "tool-50", {
        workspaceDir,
        config,
      });
      expect(result).toEqual({});
    });

    it("passes through Bash tool (handled by bashSecurityHook)", async () => {
      const input = toolInput("Bash", { command: "ls" });
      const result = await fileToolSecurityHook(input, "tool-51", {
        workspaceDir,
        config,
      });
      expect(result).toEqual({});
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    it("blocks non-string path values", async () => {
      const input = toolInput("Read", { file_path: 12345 });
      const result = await fileToolSecurityHook(input, "tool-60", {
        workspaceDir,
        config,
      });
      expect(result).toHaveProperty("decision", "block");
    });

    it("blocks path traversal via ../", async () => {
      const input = toolInput("Read", {
        file_path: path.join(workspaceDir, "..", "..", "etc", "passwd"),
      });
      const result = await fileToolSecurityHook(input, "tool-61", {
        workspaceDir,
        config,
      });
      expect(result).toHaveProperty("decision", "block");
    });

    it("blocks tilde expansion to home directory", async () => {
      const input = toolInput("Read", { file_path: "~/.bashrc" });
      const result = await fileToolSecurityHook(input, "tool-62", {
        workspaceDir,
        config,
      });
      expect(result).toHaveProperty("decision", "block");
    });
  });
});
