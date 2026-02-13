import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { validatePath, type PathValidationOptions } from "./path-validator.js";

describe("path-validator", () => {
  let tmpDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "path-validator-test-"));
    workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Core: path within workspace returns valid
  // -------------------------------------------------------------------------

  describe("path within workspace", () => {
    it("returns valid for a file directly in workspace", () => {
      const filePath = path.join(workspaceDir, "file.txt");
      fs.writeFileSync(filePath, "hello");

      const result = validatePath(filePath, { workspaceDir });

      expect(result.valid).toBe(true);
      expect(result.resolvedPath).toBe(filePath);
      expect(result.reason).toBeUndefined();
    });

    it("returns valid for a file in a subdirectory of workspace", () => {
      const subDir = path.join(workspaceDir, "sub", "deep");
      fs.mkdirSync(subDir, { recursive: true });
      const filePath = path.join(subDir, "nested.ts");
      fs.writeFileSync(filePath, "content");

      const result = validatePath(filePath, { workspaceDir });

      expect(result.valid).toBe(true);
      expect(result.resolvedPath).toBe(filePath);
    });

    it("returns valid for the workspace directory itself", () => {
      const result = validatePath(workspaceDir, { workspaceDir });

      expect(result.valid).toBe(true);
      expect(result.resolvedPath).toBe(workspaceDir);
    });

    it("returns valid for a file that does not yet exist (within workspace)", () => {
      const filePath = path.join(workspaceDir, "not-yet-created.txt");

      const result = validatePath(filePath, { workspaceDir });

      expect(result.valid).toBe(true);
      expect(result.resolvedPath).toBe(filePath);
    });
  });

  // -------------------------------------------------------------------------
  // Core: path outside workspace returns invalid with reason
  // -------------------------------------------------------------------------

  describe("path outside workspace", () => {
    it("returns invalid for a path outside workspace", () => {
      const outsidePath = path.join(tmpDir, "outside.txt");

      const result = validatePath(outsidePath, { workspaceDir });

      expect(result.valid).toBe(false);
      expect(result.reason).toBeDefined();
      expect(result.reason).toContain("outside");
    });

    it("returns invalid for /etc/passwd", () => {
      const result = validatePath("/etc/passwd", { workspaceDir });

      expect(result.valid).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it("returns invalid with reason explaining why", () => {
      const result = validatePath("/tmp/evil", { workspaceDir });

      expect(result.valid).toBe(false);
      expect(typeof result.reason).toBe("string");
      expect(result.reason!.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Symlink escape prevention
  // -------------------------------------------------------------------------

  describe("symlink resolution", () => {
    it("resolves symlinks before checking (blocks symlink escape)", () => {
      // Create a directory outside workspace
      const outsideDir = path.join(tmpDir, "outside-secret");
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(path.join(outsideDir, "secret.txt"), "secret data");

      // Create a symlink inside workspace pointing outside
      const symlinkPath = path.join(workspaceDir, "escape-link");
      fs.symlinkSync(outsideDir, symlinkPath);

      // The symlink target resolves outside workspace -> should be invalid
      const result = validatePath(
        path.join(symlinkPath, "secret.txt"),
        { workspaceDir },
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it("allows symlinks that resolve within workspace", () => {
      // Create a real dir within workspace
      const realDir = path.join(workspaceDir, "real-dir");
      fs.mkdirSync(realDir);
      fs.writeFileSync(path.join(realDir, "ok.txt"), "ok");

      // Create a symlink within workspace pointing to realDir
      const symlinkPath = path.join(workspaceDir, "link-to-real");
      fs.symlinkSync(realDir, symlinkPath);

      const result = validatePath(
        path.join(symlinkPath, "ok.txt"),
        { workspaceDir },
      );

      expect(result.valid).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // ../ traversal blocked
  // -------------------------------------------------------------------------

  describe("path traversal with ../", () => {
    it("blocks ../ traversal that escapes workspace", () => {
      const maliciousPath = path.join(workspaceDir, "..", "outside.txt");

      const result = validatePath(maliciousPath, { workspaceDir });

      expect(result.valid).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it("blocks deeply nested ../ traversal", () => {
      // workspace/a/b/../../.. = workspace/.. = parent of workspace
      const deep = path.join(workspaceDir, "a", "b", "..", "..", "..", "escape.txt");

      const result = validatePath(deep, { workspaceDir });

      expect(result.valid).toBe(false);
    });

    it("allows ../ that stays within workspace", () => {
      // workspace/sub/../file.txt = workspace/file.txt (still inside)
      const subDir = path.join(workspaceDir, "sub");
      fs.mkdirSync(subDir);
      const stayInsidePath = path.join(workspaceDir, "sub", "..", "file.txt");

      const result = validatePath(stayInsidePath, { workspaceDir });

      expect(result.valid).toBe(true);
      expect(result.resolvedPath).toBe(path.join(workspaceDir, "file.txt"));
    });
  });

  // -------------------------------------------------------------------------
  // ~ expansion works correctly
  // -------------------------------------------------------------------------

  describe("tilde expansion", () => {
    it("expands ~ to os.homedir()", () => {
      const home = os.homedir();
      // Use workspace at homedir for this test
      const homeWorkspace = path.join(home, ".test-pa-workspace");

      // We check that tilde expansion works; path may be invalid
      // if home is not workspace, which is fine for the expansion test.
      const result = validatePath("~/some-file.txt", {
        workspaceDir: homeWorkspace,
      });

      // The path should be expanded (not contain ~)
      if (result.resolvedPath) {
        expect(result.resolvedPath).not.toContain("~");
        expect(result.resolvedPath).toContain(home);
      }
    });

    it("expands ~ and resolves against home directory, not workspace", () => {
      const home = os.homedir();
      // Set workspace to tmpDir
      // ~/some-file.txt -> /home/user/some-file.txt which is outside workspace
      const result = validatePath("~/some-file.txt", { workspaceDir });

      expect(result.valid).toBe(false);
      // The reason should mention the resolved path
      expect(result.reason).toBeDefined();
    });

    it("expands bare ~ to home directory", () => {
      const home = os.homedir();
      const result = validatePath("~", { workspaceDir: home });

      expect(result.valid).toBe(true);
      expect(result.resolvedPath).toBe(home);
    });
  });

  // -------------------------------------------------------------------------
  // additionalReadDirs respected
  // -------------------------------------------------------------------------

  describe("additionalReadDirs", () => {
    it("allows reading from additionalReadDirs", () => {
      const readableDir = path.join(tmpDir, "readable");
      fs.mkdirSync(readableDir);
      fs.writeFileSync(path.join(readableDir, "data.csv"), "a,b,c");

      const result = validatePath(path.join(readableDir, "data.csv"), {
        workspaceDir,
        additionalReadDirs: [readableDir],
        operation: "read",
      });

      expect(result.valid).toBe(true);
      expect(result.resolvedPath).toBe(path.join(readableDir, "data.csv"));
    });

    it("does NOT allow writing to additionalReadDirs", () => {
      const readableDir = path.join(tmpDir, "readable");
      fs.mkdirSync(readableDir);

      const result = validatePath(path.join(readableDir, "data.csv"), {
        workspaceDir,
        additionalReadDirs: [readableDir],
        operation: "write",
      });

      expect(result.valid).toBe(false);
    });

    it("allows reading from additionalReadDirs with default operation (write -> blocked)", () => {
      const readableDir = path.join(tmpDir, "readable");
      fs.mkdirSync(readableDir);

      // Default operation is "write", so readDirs should NOT match
      const result = validatePath(path.join(readableDir, "file.txt"), {
        workspaceDir,
        additionalReadDirs: [readableDir],
        // operation defaults to "write"
      });

      expect(result.valid).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // additionalWriteDirs respected
  // -------------------------------------------------------------------------

  describe("additionalWriteDirs", () => {
    it("allows writing to additionalWriteDirs", () => {
      const writableDir = path.join(tmpDir, "writable");
      fs.mkdirSync(writableDir);

      const result = validatePath(path.join(writableDir, "output.log"), {
        workspaceDir,
        additionalWriteDirs: [writableDir],
        operation: "write",
      });

      expect(result.valid).toBe(true);
    });

    it("allows reading from additionalWriteDirs", () => {
      const writableDir = path.join(tmpDir, "writable");
      fs.mkdirSync(writableDir);

      // Write dirs should also be readable
      const result = validatePath(path.join(writableDir, "output.log"), {
        workspaceDir,
        additionalWriteDirs: [writableDir],
        operation: "read",
      });

      expect(result.valid).toBe(true);
    });

    it("does NOT allow writing to unrelated dirs even with additionalWriteDirs set", () => {
      const writableDir = path.join(tmpDir, "writable");
      fs.mkdirSync(writableDir);
      const otherDir = path.join(tmpDir, "other");
      fs.mkdirSync(otherDir);

      const result = validatePath(path.join(otherDir, "sneaky.txt"), {
        workspaceDir,
        additionalWriteDirs: [writableDir],
        operation: "write",
      });

      expect(result.valid).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Absolute paths outside all allowed dirs blocked
  // -------------------------------------------------------------------------

  describe("absolute paths outside allowed dirs", () => {
    it("blocks absolute path outside workspace and additional dirs", () => {
      const result = validatePath("/usr/local/bin/something", {
        workspaceDir,
        additionalReadDirs: ["/opt/data"],
        additionalWriteDirs: ["/var/output"],
        operation: "read",
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it("blocks path that is a prefix match but not a real subdirectory", () => {
      // Prevent prefix attacks: /home/user/.personal-assistant-evil
      // should NOT be allowed when workspace is /home/user/.personal-assistant
      const evilDir = workspaceDir + "-evil";
      fs.mkdirSync(evilDir, { recursive: true });

      const result = validatePath(path.join(evilDir, "payload.sh"), {
        workspaceDir,
      });

      expect(result.valid).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Relative paths resolved against workspace
  // -------------------------------------------------------------------------

  describe("relative paths", () => {
    it("resolves relative paths against workspace", () => {
      const result = validatePath("src/index.ts", { workspaceDir });

      expect(result.valid).toBe(true);
      expect(result.resolvedPath).toBe(
        path.join(workspaceDir, "src", "index.ts"),
      );
    });

    it("resolves ./relative paths against workspace", () => {
      const result = validatePath("./config.json", { workspaceDir });

      expect(result.valid).toBe(true);
      expect(result.resolvedPath).toBe(
        path.join(workspaceDir, "config.json"),
      );
    });

    it("blocks relative paths that escape workspace via ../", () => {
      const result = validatePath("../../../etc/passwd", { workspaceDir });

      expect(result.valid).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Empty path returns invalid
  // -------------------------------------------------------------------------

  describe("empty path", () => {
    it("returns invalid for empty string", () => {
      const result = validatePath("", { workspaceDir });

      expect(result.valid).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it("returns invalid for whitespace-only string", () => {
      const result = validatePath("   ", { workspaceDir });

      expect(result.valid).toBe(false);
      expect(result.reason).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Security edge cases
  // -------------------------------------------------------------------------

  describe("security edge cases", () => {
    it("blocks null bytes in path", () => {
      const result = validatePath("file\0.txt", { workspaceDir });

      expect(result.valid).toBe(false);
    });

    it("handles workspace dir without trailing separator consistently", () => {
      // Ensure the check uses trailing separator to prevent prefix attacks
      const wsNoTrailing = workspaceDir; // typically no trailing /
      const result = validatePath(
        path.join(workspaceDir, "inside.txt"),
        { workspaceDir: wsNoTrailing },
      );

      expect(result.valid).toBe(true);
    });

    it("handles workspace dir with trailing separator consistently", () => {
      const wsWithTrailing = workspaceDir + path.sep;
      const result = validatePath(
        path.join(workspaceDir, "inside.txt"),
        { workspaceDir: wsWithTrailing },
      );

      expect(result.valid).toBe(true);
    });

    it("blocks paths with encoded traversal sequences after normalization", () => {
      // After path.resolve, these should be normalized
      const result = validatePath(
        workspaceDir + "/sub/./../../escape",
        { workspaceDir },
      );

      expect(result.valid).toBe(false);
    });

    it("workspace itself is valid even for write operations", () => {
      const result = validatePath(workspaceDir, {
        workspaceDir,
        operation: "write",
      });

      expect(result.valid).toBe(true);
    });

    it("handles multiple additionalReadDirs", () => {
      const dir1 = path.join(tmpDir, "read1");
      const dir2 = path.join(tmpDir, "read2");
      fs.mkdirSync(dir1);
      fs.mkdirSync(dir2);

      const result1 = validatePath(path.join(dir1, "a.txt"), {
        workspaceDir,
        additionalReadDirs: [dir1, dir2],
        operation: "read",
      });
      const result2 = validatePath(path.join(dir2, "b.txt"), {
        workspaceDir,
        additionalReadDirs: [dir1, dir2],
        operation: "read",
      });

      expect(result1.valid).toBe(true);
      expect(result2.valid).toBe(true);
    });

    it("additionalWriteDirs also valid for read operations", () => {
      const writeDir = path.join(tmpDir, "writedir");
      fs.mkdirSync(writeDir);

      const result = validatePath(path.join(writeDir, "log.txt"), {
        workspaceDir,
        additionalWriteDirs: [writeDir],
        operation: "read",
      });

      expect(result.valid).toBe(true);
    });

    it("symlink in additionalReadDirs target resolves correctly", () => {
      const realDir = path.join(tmpDir, "real-read-dir");
      fs.mkdirSync(realDir);
      fs.writeFileSync(path.join(realDir, "data.txt"), "data");

      const symlinkDir = path.join(tmpDir, "link-read-dir");
      fs.symlinkSync(realDir, symlinkDir);

      // Use the symlink as an additional read dir
      // The file under the symlink should resolve to the real path
      const result = validatePath(path.join(symlinkDir, "data.txt"), {
        workspaceDir,
        additionalReadDirs: [symlinkDir],
        operation: "read",
      });

      expect(result.valid).toBe(true);
    });
  });
});
