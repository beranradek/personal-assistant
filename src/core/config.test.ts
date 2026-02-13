import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig, resolveUserPath, resolveConfigDir, DEFAULTS } from "./config.js";

describe("config", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("loadConfig", () => {
    it("loads settings.json from app directory and returns typed config", () => {
      const settings = {
        security: {
          allowedCommands: ["ls", "cat"],
          commandsNeedingExtraValidation: ["rm"],
          workspace: "~/.personal-assistant/workspace",
          dataDir: "~/.personal-assistant/data",
          additionalReadDirs: [],
          additionalWriteDirs: [],
        },
        adapters: {
          telegram: { enabled: false, botToken: "", allowedUserIds: [], mode: "polling" as const },
          slack: { enabled: false, botToken: "", appToken: "", socketMode: true },
        },
        heartbeat: { enabled: true, intervalMinutes: 30, activeHours: "8-21", deliverTo: "last" as const },
        gateway: { maxQueueSize: 20 },
        agent: { model: null, maxTurns: 200 },
        session: { maxHistoryMessages: 50, compactionEnabled: true },
        memory: {
          search: {
            enabled: true,
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
      fs.writeFileSync(path.join(tmpDir, "settings.json"), JSON.stringify(settings));

      const config = loadConfig(tmpDir);

      expect(config.security.allowedCommands).toEqual(["ls", "cat"]);
      expect(config.heartbeat.intervalMinutes).toBe(30);
      expect(config.agent.model).toBeNull();
      expect(config.adapters.telegram.enabled).toBe(false);
    });

    it("merges user settings over defaults (missing keys get defaults)", () => {
      // Only override heartbeat interval; everything else should come from defaults
      const partial = {
        heartbeat: {
          intervalMinutes: 15,
        },
      };
      fs.writeFileSync(path.join(tmpDir, "settings.json"), JSON.stringify(partial));

      const config = loadConfig(tmpDir);

      // User override applied
      expect(config.heartbeat.intervalMinutes).toBe(15);
      // Other heartbeat fields come from defaults
      expect(config.heartbeat.enabled).toBe(DEFAULTS.heartbeat.enabled);
      expect(config.heartbeat.activeHours).toBe(DEFAULTS.heartbeat.activeHours);
      expect(config.heartbeat.deliverTo).toBe(DEFAULTS.heartbeat.deliverTo);
      // Unrelated sections come from defaults
      expect(config.security.allowedCommands).toEqual(DEFAULTS.security.allowedCommands);
      expect(config.gateway.maxQueueSize).toBe(DEFAULTS.gateway.maxQueueSize);
      expect(config.adapters.telegram.enabled).toBe(false);
    });

    it("validates required fields (throws on invalid config)", () => {
      // intervalMinutes must be positive integer
      const invalid = {
        heartbeat: {
          intervalMinutes: -5,
        },
      };
      fs.writeFileSync(path.join(tmpDir, "settings.json"), JSON.stringify(invalid));

      expect(() => loadConfig(tmpDir)).toThrow();
    });

    it("resolves ~ in workspace and dataDir paths to absolute", () => {
      const partial = {
        security: {
          workspace: "~/my-workspace",
          dataDir: "~/my-data",
        },
      };
      fs.writeFileSync(path.join(tmpDir, "settings.json"), JSON.stringify(partial));

      const config = loadConfig(tmpDir);

      const home = os.homedir();
      expect(config.security.workspace).toBe(path.join(home, "my-workspace"));
      expect(config.security.dataDir).toBe(path.join(home, "my-data"));
      // Should not contain ~
      expect(config.security.workspace).not.toContain("~");
      expect(config.security.dataDir).not.toContain("~");
    });

    it("returns full defaults when settings.json has empty object {}", () => {
      fs.writeFileSync(path.join(tmpDir, "settings.json"), "{}");

      const config = loadConfig(tmpDir);

      // workspace and dataDir should be resolved (no ~)
      const home = os.homedir();
      expect(config.security.workspace).toBe(
        path.join(home, ".personal-assistant", "workspace"),
      );
      expect(config.security.dataDir).toBe(
        path.join(home, ".personal-assistant", "data"),
      );
      expect(config.security.allowedCommands).toEqual(DEFAULTS.security.allowedCommands);
      expect(config.adapters.telegram.enabled).toBe(false);
      expect(config.adapters.slack.enabled).toBe(false);
      expect(config.heartbeat.enabled).toBe(true);
      expect(config.heartbeat.intervalMinutes).toBe(30);
      expect(config.gateway.maxQueueSize).toBe(20);
      expect(config.agent.model).toBeNull();
      expect(config.agent.maxTurns).toBe(200);
      expect(config.session.maxHistoryMessages).toBe(50);
      expect(config.session.compactionEnabled).toBe(true);
      expect(config.memory.search.enabled).toBe(true);
      expect(config.memory.search.hybridWeights).toEqual({ vector: 0.7, keyword: 0.3 });
      expect(config.memory.extraPaths).toEqual([]);
      expect(config.mcpServers).toEqual({});
    });
  });

  describe("resolveUserPath", () => {
    it("expands ~ to os.homedir()", () => {
      const result = resolveUserPath("~/foo/bar");
      expect(result).toBe(path.join(os.homedir(), "foo", "bar"));
    });

    it("returns absolute paths unchanged", () => {
      const result = resolveUserPath("/absolute/path");
      expect(result).toBe("/absolute/path");
    });

    it("handles bare ~ (home directory itself)", () => {
      const result = resolveUserPath("~");
      expect(result).toBe(os.homedir());
    });
  });

  describe("resolveConfigDir", () => {
    let savedPaConfig: string | undefined;

    beforeEach(() => {
      savedPaConfig = process.env["PA_CONFIG"];
      delete process.env["PA_CONFIG"];
    });

    afterEach(() => {
      if (savedPaConfig !== undefined) {
        process.env["PA_CONFIG"] = savedPaConfig;
      } else {
        delete process.env["PA_CONFIG"];
      }
    });

    it("returns parent directory of --config path", () => {
      const result = resolveConfigDir(["node", "app.js", "--config", "/etc/myapp/settings.json"]);
      expect(result).toBe("/etc/myapp");
    });

    it("returns PA_CONFIG env var when set and no --config flag", () => {
      process.env["PA_CONFIG"] = "/custom/config/dir";
      const result = resolveConfigDir(["node", "app.js"]);
      expect(result).toBe("/custom/config/dir");
    });

    it("returns ~/.personal-assistant as default when no flag or env", () => {
      const result = resolveConfigDir(["node", "app.js"]);
      expect(result).toBe(path.join(os.homedir(), ".personal-assistant"));
    });

    it("--config flag takes precedence over PA_CONFIG env var", () => {
      process.env["PA_CONFIG"] = "/from/env";
      const result = resolveConfigDir(["node", "app.js", "--config", "/from/flag/settings.json"]);
      expect(result).toBe("/from/flag");
    });
  });
});
