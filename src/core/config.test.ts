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
        gateway: { maxQueueSize: 20, processingUpdateIntervalMs: 5000 },
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
        gateway: {
          workloadLockFiles: ["~/locks/autoworker.lock"],
        },
      };
      fs.writeFileSync(path.join(tmpDir, "settings.json"), JSON.stringify(partial));

      const config = loadConfig(tmpDir);

      const home = os.homedir();
      expect(config.security.workspace).toBe(path.join(home, "my-workspace"));
      expect(config.security.dataDir).toBe(path.join(home, "my-data"));
      expect(config.gateway.workloadLockFiles).toEqual([
        path.join(home, "locks", "autoworker.lock"),
      ]);
      // Should not contain ~
      expect(config.security.workspace).not.toContain("~");
      expect(config.security.dataDir).not.toContain("~");
      expect(config.gateway.workloadLockFiles[0]).not.toContain("~");
    });

    it("resolves ~ in additionalReadDirs and additionalWriteDirs", () => {
      const partial = {
        security: {
          additionalReadDirs: ["~/read-me", "/tmp"],
          additionalWriteDirs: ["~/.android", "/tmp"],
        },
      };
      fs.writeFileSync(path.join(tmpDir, "settings.json"), JSON.stringify(partial));

      const config = loadConfig(tmpDir);

      const home = os.homedir();
      expect(config.security.additionalReadDirs).toEqual([path.join(home, "read-me"), "/tmp"]);
      expect(config.security.additionalWriteDirs).toEqual([path.join(home, ".android"), "/tmp"]);
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
      expect(config.gateway.processingUpdateIntervalMs).toBe(5000);
      expect(config.gateway.workloadLockFiles).toEqual([
        path.join(home, ".personal-assistant", "workspace", "tmp", "autoworker-heavy-tests.lock"),
      ]);
      expect(config.agent.model).toBeNull();
      expect(config.agent.maxTurns).toBe(200);
      expect(config.session.maxHistoryMessages).toBe(20);
      expect(config.session.compactionEnabled).toBe(true);
      expect(config.session.summarizationEnabled).toBe(true);
      expect(config.session.summarizationModel).toBe("claude-haiku-4-5-20251001");
      expect(config.memory.search.enabled).toBe(true);
      expect(config.memory.search.hybridWeights).toEqual({ vector: 0.7, keyword: 0.3 });
      expect(config.memory.extraPaths).toEqual([]);
      expect(config.reflection.episodeSignals.enabled).toBe(false);
      expect(config.reflection.episodeSignals.maxRecentEpisodes).toBe(200);
      expect(config.reflection.episodeSignals.maxTopItems).toBe(3);
      expect(config.mcpServers).toEqual({});
      expect(config.mcp.httpServer.enabled).toBe(false);
      // Codex backend defaults
      expect(config.agent.backend).toBe("claude");
      expect(config.codex.sandboxMode).toBe("workspace-write");
      expect(config.codex.approvalPolicy).toBe("never");
      expect(config.codex.networkAccess).toBe(true);
      expect(config.codex.skipGitRepoCheck).toBe(true);
      expect(config.codex.codexPath).toBeNull();
      expect(config.codex.apiKey).toBeNull();
      expect(config.codex.baseUrl).toBeNull();
      expect(config.codex.reasoningEffort).toBeNull();
      expect(config.codex.configOverrides).toEqual({});
      expect(config.codex.httpMcpPort).toBe(47392);
    });

    it("merges reflection episodeSignals overrides over defaults", () => {
      const partial = {
        reflection: {
          episodeSignals: {
            enabled: true,
            maxRecentEpisodes: 25,
          },
        },
      };
      fs.writeFileSync(path.join(tmpDir, "settings.json"), JSON.stringify(partial));

      const config = loadConfig(tmpDir);

      expect(config.reflection.enabled).toBe(DEFAULTS.reflection.enabled);
      expect(config.reflection.weeklyEnabled).toBe(DEFAULTS.reflection.weeklyEnabled);
      expect(config.reflection.episodeSignals.enabled).toBe(true);
      expect(config.reflection.episodeSignals.maxRecentEpisodes).toBe(25);
      expect(config.reflection.episodeSignals.maxTopItems).toBe(DEFAULTS.reflection.episodeSignals.maxTopItems);
    });

    it("defaults to a lazy isolated embedding model, 30 min background sync, sync before search and lazy integ-api", () => {
      fs.writeFileSync(path.join(tmpDir, "settings.json"), "{}");

      const config = loadConfig(tmpDir);

      expect(config.memory.embedding).toEqual({
        lazyLoad: true,
        isolate: true,
        idleUnloadMinutes: 10,
        dimensions: 768,
        model: "",
      });
      expect(config.memory.sync).toEqual({
        intervalMinutes: 30,
        watch: false,
        beforeSearchMinIntervalSeconds: 0,
      });
      expect(config.integApi.lazyStart).toEqual({ enabled: true, idleMinutes: 15 });
    });

    it("merges memory.sync, memory.embedding and integApi.lazyStart overrides over defaults", () => {
      const partial = {
        memory: { sync: { intervalMinutes: 0, watch: true }, embedding: { idleUnloadMinutes: 2 } },
        integApi: { lazyStart: { enabled: false } },
      };
      fs.writeFileSync(path.join(tmpDir, "settings.json"), JSON.stringify(partial));

      const config = loadConfig(tmpDir);

      expect(config.memory.sync.intervalMinutes).toBe(0);
      expect(config.memory.sync.watch).toBe(true);
      expect(config.memory.sync.beforeSearchMinIntervalSeconds).toBe(0);
      expect(config.memory.embedding.idleUnloadMinutes).toBe(2);
      expect(config.memory.embedding.lazyLoad).toBe(true);
      expect(config.integApi.lazyStart.enabled).toBe(false);
      expect(config.integApi.lazyStart.idleMinutes).toBe(15);
    });

    it("rejects invalid memory.sync values", () => {
      fs.writeFileSync(path.join(tmpDir, "settings.json"), JSON.stringify({ memory: { sync: { intervalMinutes: -5 } } }));
      expect(() => loadConfig(tmpDir)).toThrow();
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

    it("resolves relative --config path to absolute", () => {
      const result = resolveConfigDir(["node", "cli.js", "--config", "config/settings.json"]);
      expect(path.isAbsolute(result)).toBe(true);
    });

    it("ignores --config when it is the last argument with no value", () => {
      const original = process.env["PA_CONFIG"];
      delete process.env["PA_CONFIG"];
      try {
        const result = resolveConfigDir(["node", "cli.js", "--config"]);
        expect(result).toBe(path.join(os.homedir(), ".personal-assistant"));
      } finally {
        if (original !== undefined) process.env["PA_CONFIG"] = original;
      }
    });
  });

  describe("claudeCode.remote", () => {
    function load(settings: Record<string, unknown>) {
      fs.writeFileSync(path.join(tmpDir, "settings.json"), JSON.stringify(settings));
      return loadConfig(tmpDir);
    }

    it("is disabled with defaults when the section is absent", () => {
      expect(load({}).claudeCode.remote).toEqual({
        enabled: false,
        idleDetachMinutes: 60,
        deliveryTimeoutMs: 20000,
        progress: true,
        maxMessageChars: 4000,
        maxMessagesPerMinute: 20,
        reasoning: false,
        slack: { progress: false, reactions: true, format: "mrkdwn" },
      });
      expect(load({}).claudeCode.remote.defaultChannel).toBeUndefined();
    });

    it("parses an old remote section without the new keys", () => {
      const r = load({ claudeCode: { remote: { enabled: true, progress: false } } }).claudeCode.remote;
      expect(r.defaultChannel).toBeUndefined();
      expect(r.slack).toEqual({ progress: false, reactions: true, format: "mrkdwn" });
    });

    it("accepts defaultChannel and slack overrides", () => {
      const r = load({
        claudeCode: { remote: { defaultChannel: "slack", slack: { progress: true, format: "plain" } } },
      }).claudeCode.remote;
      expect(r.defaultChannel).toBe("slack");
      expect(r.slack).toEqual({ progress: true, reactions: true, format: "plain" });
    });

    it("rejects invalid slack format and defaultChannel", () => {
      expect(() => load({ claudeCode: { remote: { slack: { format: "html" } } } })).toThrow();
      expect(() => load({ claudeCode: { remote: { defaultChannel: "discord" } } })).toThrow();
    });

    it("merges user overrides over defaults", () => {
      const r = load({ claudeCode: { remote: { enabled: true, idleDetachMinutes: 5 } } }).claudeCode.remote;
      expect(r.enabled).toBe(true);
      expect(r.idleDetachMinutes).toBe(5);
      expect(r.maxMessagesPerMinute).toBe(20);
    });

    it("rejects invalid values", () => {
      expect(() => load({ claudeCode: { remote: { maxMessageChars: 0 } } })).toThrow();
    });
  });

  describe("tmuxAgents", () => {
    function load(tmuxAgents?: Record<string, unknown>, security?: Record<string, unknown>) {
      const settings: Record<string, unknown> = {};
      if (tmuxAgents) settings["tmuxAgents"] = tmuxAgents;
      if (security) settings["security"] = security;
      fs.writeFileSync(path.join(tmpDir, "settings.json"), JSON.stringify(settings));
      return loadConfig(tmpDir);
    }

    it("is disabled with safe defaults when the key is absent", () => {
      const config = load();
      expect(config.tmuxAgents.enabled).toBe(false);
      expect(config.tmuxAgents.maxSessions).toBe(3);
      expect(config.tmuxAgents.allowPermissionBypass).toBe(false);
      expect(config.tmuxAgents.allowAnswerPrompts).toBe(false);
      expect(config.tmuxAgents.trustedRoots).toEqual([]);
      expect(config.tmuxAgents.allowedRoots).toEqual([]);
    });

    it("derives the socket path from dataDir when empty", () => {
      const config = load(undefined, { dataDir: path.join(tmpDir, "data") });
      expect(config.tmuxAgents.socketPath).toBe(path.join(tmpDir, "data", "tmux-agents", "tmux.sock"));
    });

    it("resolves ~ in allowedRoots, trustedRoots and socketPath", () => {
      const config = load({
        allowedRoots: ["~/agents"],
        trustedRoots: ["~/agents"],
        socketPath: "~/s.sock",
      });
      expect(config.tmuxAgents.allowedRoots).toEqual([path.join(os.homedir(), "agents")]);
      expect(config.tmuxAgents.trustedRoots).toEqual([path.join(os.homedir(), "agents")]);
      expect(config.tmuxAgents.socketPath).toBe(path.join(os.homedir(), "s.sock"));
    });

    it("defaults agentBinaries to empty and resolves ~ in its paths", () => {
      expect(load().tmuxAgents.agentBinaries).toEqual({});
      const config = load({ agentBinaries: { claude: "~/.local/bin/claude" } });
      expect(config.tmuxAgents.agentBinaries).toEqual({ claude: path.join(os.homedir(), ".local/bin/claude") });
    });

    it("rejects a relative agentBinaries path", () => {
      expect(() => load({ agentBinaries: { claude: "bin/claude" } })).toThrow(/agentBinaries/);
    });

    it("rejects a relative socketPath", () => {
      expect(() => load({ socketPath: "rel/tmux.sock" })).toThrow(/socketPath/);
    });

    it("rejects a socketPath longer than 100 characters", () => {
      expect(() => load({ socketPath: `/${"a".repeat(100)}/tmux.sock` })).toThrow(/socketPath/);
    });

    it("rejects a trustedRoots entry that is not in allowedRoots", () => {
      expect(() => load({ allowedRoots: ["/srv/a"], trustedRoots: ["/srv/b"] })).toThrow(/trustedRoots/);
    });

    it("rejects a sessionPrefix other than pa-", () => {
      expect(() => load({ sessionPrefix: "x-" })).toThrow();
    });

    it("rejects relative allowedRoots entries", () => {
      expect(() => load({ allowedRoots: ["rel/dir"] })).toThrow(/allowedRoots/);
    });
  });
});
