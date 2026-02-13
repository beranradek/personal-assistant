import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { readMemoryFiles, readMemoryFile } from "./files.js";

describe("memory file reader", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-files-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("readMemoryFiles", () => {
    it("returns concatenated content of AGENTS.md + SOUL.md + USER.md + MEMORY.md", async () => {
      await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "agents content");
      await fs.writeFile(path.join(tmpDir, "SOUL.md"), "soul content");
      await fs.writeFile(path.join(tmpDir, "USER.md"), "user content");
      await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "memory content");

      const result = await readMemoryFiles(tmpDir);

      expect(result).toBe(
        "agents content\n\n---\n\nsoul content\n\n---\n\nuser content\n\n---\n\nmemory content",
      );
    });

    it("includes HEARTBEAT.md when includeHeartbeat is true", async () => {
      await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "agents");
      await fs.writeFile(path.join(tmpDir, "SOUL.md"), "soul");
      await fs.writeFile(path.join(tmpDir, "USER.md"), "user");
      await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "memory");
      await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "heartbeat");

      const result = await readMemoryFiles(tmpDir, { includeHeartbeat: true });

      expect(result).toBe(
        "agents\n\n---\n\nsoul\n\n---\n\nuser\n\n---\n\nmemory\n\n---\n\nheartbeat",
      );
    });

    it("does NOT include HEARTBEAT.md by default", async () => {
      await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "agents");
      await fs.writeFile(path.join(tmpDir, "SOUL.md"), "soul");
      await fs.writeFile(path.join(tmpDir, "USER.md"), "user");
      await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "memory");
      await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "heartbeat");

      const result = await readMemoryFiles(tmpDir);

      expect(result).not.toContain("heartbeat");
      expect(result).toBe(
        "agents\n\n---\n\nsoul\n\n---\n\nuser\n\n---\n\nmemory",
      );
    });

    it("skips missing files gracefully (no error)", async () => {
      // Only AGENTS.md and MEMORY.md exist
      await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "agents");
      await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "memory");

      const result = await readMemoryFiles(tmpDir);

      expect(result).toBe("agents\n\n---\n\nmemory");
    });

    it("separates files by \\n\\n---\\n\\n", async () => {
      await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "A");
      await fs.writeFile(path.join(tmpDir, "SOUL.md"), "B");

      const result = await readMemoryFiles(tmpDir);

      expect(result).toBe("A\n\n---\n\nB");
    });

    it("returns empty string for empty workspace", async () => {
      const result = await readMemoryFiles(tmpDir);

      expect(result).toBe("");
    });

    it("returns empty string when workspace directory does not exist", async () => {
      const nonExistent = path.join(tmpDir, "does-not-exist");

      const result = await readMemoryFiles(nonExistent);

      expect(result).toBe("");
    });

    it("reads files in correct order: AGENTS, SOUL, USER, MEMORY, HEARTBEAT", async () => {
      // Create files in reverse order to ensure implementation uses defined order, not fs order
      await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "5");
      await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "4");
      await fs.writeFile(path.join(tmpDir, "USER.md"), "3");
      await fs.writeFile(path.join(tmpDir, "SOUL.md"), "2");
      await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "1");

      const result = await readMemoryFiles(tmpDir, { includeHeartbeat: true });

      expect(result).toBe("1\n\n---\n\n2\n\n---\n\n3\n\n---\n\n4\n\n---\n\n5");
    });
  });

  describe("readMemoryFile", () => {
    it("reads a single memory file by name", async () => {
      await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "agents content");

      const result = await readMemoryFile(tmpDir, "AGENTS.md");

      expect(result).toBe("agents content");
    });

    it("returns null for a missing file", async () => {
      const result = await readMemoryFile(tmpDir, "AGENTS.md");

      expect(result).toBeNull();
    });

    it("reads HEARTBEAT.md when requested", async () => {
      await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "heartbeat data");

      const result = await readMemoryFile(tmpDir, "HEARTBEAT.md");

      expect(result).toBe("heartbeat data");
    });
  });
});
