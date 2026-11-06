import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TmuxAgentError } from "./errors.js";
import { checkTrust, isWithinDir, resolveAllowedDirectory, resolveStartDirectory } from "./roots.js";

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof TmuxAgentError ? err.code : "OTHER";
  }
  return undefined;
}

describe("roots", () => {
  let tmp: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roots-test-")));
    root = path.join(tmp, "root");
    outside = path.join(tmp, "outside");
    fs.mkdirSync(path.join(root, "proj"), { recursive: true });
    fs.mkdirSync(outside);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("isWithinDir", () => {
    it("mirrors the cases of path-validator", () => {
      expect(isWithinDir("/a/root", "/a/root")).toBe(true);
      expect(isWithinDir("/a/root/x/y", "/a/root")).toBe(true);
      expect(isWithinDir("/a/root-evil", "/a/root")).toBe(false);
      expect(isWithinDir("/a", "/a/root")).toBe(false);
      expect(isWithinDir("/anything", "/")).toBe(true);
    });
  });

  describe("resolveAllowedDirectory", () => {
    it("accepts a directory inside a root and returns its real path", () => {
      const result = resolveAllowedDirectory(path.join(root, "proj"), [root]);
      expect(result).toEqual({ cwd: path.join(root, "proj"), root });
    });

    it("lists the allowed roots in the error when the directory is outside them", () => {
      const outside = path.join(tmp, "outside");
      fs.mkdirSync(outside, { recursive: true });
      const message = (() => {
        try {
          resolveAllowedDirectory(outside, [root, "/another/root"]);
        } catch (err) {
          return err instanceof Error ? err.message : "";
        }
        return "";
      })();
      expect(message).toContain("not inside tmuxAgents.allowedRoots");
      expect(message).toContain(root);
      expect(message).toContain("/another/root");
    });

    it("keeps the other ROOT_NOT_ALLOWED messages free of the roots list", () => {
      expect(() => resolveAllowedDirectory("relative/dir", [root])).toThrow(/absolute path \(no ~ expansion\)$/);
    });

    it("accepts the root itself", () => {
      expect(resolveAllowedDirectory(root, [root]).cwd).toBe(root);
    });

    it("rejects traversal out of the root", () => {
      expect(code(() => resolveAllowedDirectory(path.join(root, "..", "outside"), [root]))).toBe("ROOT_NOT_ALLOWED");
    });

    it("rejects a symlink inside the root that points outside", () => {
      fs.symlinkSync(outside, path.join(root, "link"));
      expect(code(() => resolveAllowedDirectory(path.join(root, "link"), [root]))).toBe("ROOT_NOT_ALLOWED");
    });

    it("rejects a sibling that shares the prefix", () => {
      const evil = `${root}-evil`;
      fs.mkdirSync(evil);
      expect(code(() => resolveAllowedDirectory(evil, [root]))).toBe("ROOT_NOT_ALLOWED");
    });

    it.each(["relative/path", "~/x", "~", "/tmp/a\0b", ""])("rejects %j", (dir) => {
      expect(code(() => resolveAllowedDirectory(dir, [root]))).toBe("ROOT_NOT_ALLOWED");
    });

    it("rejects a missing directory and a file", () => {
      expect(code(() => resolveAllowedDirectory(path.join(root, "missing"), [root]))).toBe("ROOT_NOT_ALLOWED");
      const file = path.join(root, "file.txt");
      fs.writeFileSync(file, "x");
      expect(code(() => resolveAllowedDirectory(file, [root]))).toBe("ROOT_NOT_ALLOWED");
    });

    it("rejects everything when allowedRoots is empty or has a missing entry", () => {
      expect(code(() => resolveAllowedDirectory(root, []))).toBe("ROOT_NOT_ALLOWED");
      expect(code(() => resolveAllowedDirectory(root, [path.join(tmp, "nope")]))).toBe("ROOT_NOT_ALLOWED");
    });

    it("rejects a directory with # in its name (tmux format expansion)", () => {
      const evil = path.join(root, "a#(touch x)");
      fs.mkdirSync(evil);
      expect(code(() => resolveAllowedDirectory(evil, [root]))).toBe("ROOT_NOT_ALLOWED");
      fs.mkdirSync(path.join(root, "h#sh"));
      expect(code(() => resolveAllowedDirectory(path.join(root, "h#sh"), [root]))).toBe("ROOT_NOT_ALLOWED");
    });

    it("rejects a symlink whose real path contains #", () => {
      fs.mkdirSync(path.join(root, "real#dir"));
      fs.symlinkSync(path.join(root, "real#dir"), path.join(root, "clean"));
      expect(code(() => resolveAllowedDirectory(path.join(root, "clean"), [root]))).toBe("ROOT_NOT_ALLOWED");
    });
  });

  describe("checkTrust (D20)", () => {
    it("refuses a cwd under a writable dir unless its root is trusted", () => {
      const cwd = path.join(root, "proj");
      expect(code(() => checkTrust(cwd, root, { trustedRoots: [], writableDirs: [root] }))).toBe("ROOT_NOT_TRUSTED");
      expect(code(() => checkTrust(cwd, root, { trustedRoots: [root], writableDirs: [root] }))).toBeUndefined();
    });

    it("passes a cwd outside every writable dir without trustedRoots", () => {
      expect(code(() => checkTrust(path.join(root, "proj"), root, { trustedRoots: [], writableDirs: [outside] })))
        .toBeUndefined();
    });

    it("compares real paths: a symlink into the writable dir is refused", () => {
      const ws = path.join(tmp, "ws");
      fs.mkdirSync(ws);
      const linkRoot = path.join(tmp, "linkroot");
      fs.mkdirSync(linkRoot);
      fs.symlinkSync(ws, path.join(linkRoot, "w"));
      const policy = { allowedRoots: [tmp], trustedRoots: [], writableDirs: [ws] };
      expect(code(() => resolveStartDirectory(path.join(linkRoot, "w"), policy))).toBe("ROOT_NOT_TRUSTED");
      expect(code(() => resolveStartDirectory(ws, policy))).toBe("ROOT_NOT_TRUSTED");
    });

    it("trust applies to the matching root only", () => {
      const other = path.join(tmp, "other");
      fs.mkdirSync(other);
      const policy = { allowedRoots: [root, other], trustedRoots: [other], writableDirs: [tmp] };
      expect(code(() => resolveStartDirectory(path.join(root, "proj"), policy))).toBe("ROOT_NOT_TRUSTED");
      expect(code(() => resolveStartDirectory(other, policy))).toBeUndefined();
    });
  });

  describe("resolveStartDirectory", () => {
    it("returns the real path when all checks pass", () => {
      const policy = { allowedRoots: [root], trustedRoots: [], writableDirs: [outside] };
      expect(resolveStartDirectory(path.join(root, "proj"), policy)).toBe(path.join(root, "proj"));
    });
  });
});
