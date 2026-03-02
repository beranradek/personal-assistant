import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ensureWorkspace, ensureCodexSkills, writeFileIfMissing } from "./workspace.js";
import type { Config } from "./types.js";
import { DEFAULTS } from "./config.js";

/**
 * Build a Config object with workspace and dataDir pointing at the given paths.
 * All other fields use DEFAULTS.
 */
function makeConfig(workspace: string, dataDir: string): Config {
  return {
    ...DEFAULTS,
    security: {
      ...DEFAULTS.security,
      workspace,
      dataDir,
    },
  };
}

describe("workspace", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let dataDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-test-"));
    workspaceDir = path.join(tmpDir, "workspace");
    dataDir = path.join(tmpDir, "data");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("writeFileIfMissing", () => {
    it("creates a file when it does not exist", async () => {
      const filePath = path.join(tmpDir, "new-file.md");
      await writeFileIfMissing(filePath, "hello world");

      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("hello world");
    });

    it("does NOT overwrite an existing file", async () => {
      const filePath = path.join(tmpDir, "existing.md");
      await fs.writeFile(filePath, "original content");

      await writeFileIfMissing(filePath, "new content");

      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("original content");
    });

    it("does not throw when the file already exists", async () => {
      const filePath = path.join(tmpDir, "existing2.md");
      await fs.writeFile(filePath, "original");

      await expect(writeFileIfMissing(filePath, "new")).resolves.toBeUndefined();
    });
  });

  describe("ensureWorkspace", () => {
    it("creates workspace directory if missing", async () => {
      const config = makeConfig(workspaceDir, dataDir);

      await ensureWorkspace(config);

      const stat = await fs.stat(workspaceDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it("creates all template files on first run", async () => {
      const config = makeConfig(workspaceDir, dataDir);

      await ensureWorkspace(config);

      const templateNames = [
        "AGENTS.md",
        "SOUL.md",
        "USER.md",
        "MEMORY.md",
        "HEARTBEAT.md",
      ];

      for (const name of templateNames) {
        const filePath = path.join(workspaceDir, name);
        const stat = await fs.stat(filePath);
        expect(stat.isFile(), `${name} should exist as a file`).toBe(true);

        const content = await fs.readFile(filePath, "utf-8");
        expect(content.length, `${name} should have content`).toBeGreaterThan(0);
      }
    });

    it("does NOT overwrite existing files on subsequent runs", async () => {
      const config = makeConfig(workspaceDir, dataDir);

      // First run: create everything
      await ensureWorkspace(config);

      // Write custom content to one template
      const agentsPath = path.join(workspaceDir, "AGENTS.md");
      await fs.writeFile(agentsPath, "my custom agents config");

      // Second run: should not overwrite
      await ensureWorkspace(config);

      const content = await fs.readFile(agentsPath, "utf-8");
      expect(content).toBe("my custom agents config");
    });

    it("creates daily/ subdirectory", async () => {
      const config = makeConfig(workspaceDir, dataDir);

      await ensureWorkspace(config);

      const dailyDir = path.join(workspaceDir, "daily");
      const stat = await fs.stat(dailyDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it("creates .claude/skills/ subdirectory", async () => {
      const config = makeConfig(workspaceDir, dataDir);

      await ensureWorkspace(config);

      const skillsDir = path.join(workspaceDir, ".claude", "skills");
      const stat = await fs.stat(skillsDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it("creates data directory if missing", async () => {
      const config = makeConfig(workspaceDir, dataDir);

      await ensureWorkspace(config);

      const stat = await fs.stat(dataDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it("creates data/sessions/ subdirectory", async () => {
      const config = makeConfig(workspaceDir, dataDir);

      await ensureWorkspace(config);

      const sessionsDir = path.join(dataDir, "sessions");
      const stat = await fs.stat(sessionsDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it("is idempotent (can run multiple times without error)", async () => {
      const config = makeConfig(workspaceDir, dataDir);

      await ensureWorkspace(config);
      await ensureWorkspace(config);
      await ensureWorkspace(config);

      // No errors thrown, dirs and files still exist
      const stat = await fs.stat(workspaceDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe("ensureCodexSkills", () => {
    const skillPath = path.join(os.homedir(), ".codex", "skills", "personal-assistant.md");
    let savedContent: string | null = null;

    beforeEach(async () => {
      // Back up existing skill file if present
      try {
        savedContent = await fs.readFile(skillPath, "utf-8");
        await fs.unlink(skillPath);
      } catch {
        savedContent = null;
      }
    });

    afterEach(async () => {
      // Restore original skill file (or remove test artifact)
      if (savedContent !== null) {
        await fs.mkdir(path.dirname(skillPath), { recursive: true });
        await fs.writeFile(skillPath, savedContent);
      } else {
        try {
          await fs.unlink(skillPath);
        } catch {
          // ignore if already gone
        }
      }
    });

    it("creates .agents/skills/ directory in workspace", async () => {
      const config = makeConfig(workspaceDir, dataDir);
      await fs.mkdir(workspaceDir, { recursive: true });

      await ensureCodexSkills(config);

      const skillsDir = path.join(workspaceDir, ".agents", "skills");
      const stat = await fs.stat(skillsDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it("copies core skill template to ~/.codex/skills/", async () => {
      const config = makeConfig(workspaceDir, dataDir);
      await fs.mkdir(workspaceDir, { recursive: true });

      await ensureCodexSkills(config);

      const stat = await fs.stat(skillPath);
      expect(stat.isFile()).toBe(true);

      const content = await fs.readFile(skillPath, "utf-8");
      expect(content).toContain("personal-assistant");
    });

    it("does not overwrite existing skill files", async () => {
      const config = makeConfig(workspaceDir, dataDir);
      await fs.mkdir(workspaceDir, { recursive: true });

      // First run: create skills
      await ensureCodexSkills(config);

      // Overwrite with custom content
      await fs.writeFile(skillPath, "custom skill content");

      // Second run: should not overwrite
      await ensureCodexSkills(config);

      const content = await fs.readFile(skillPath, "utf-8");
      expect(content).toBe("custom skill content");
    });
  });
});
