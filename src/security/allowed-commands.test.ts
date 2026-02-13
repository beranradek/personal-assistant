import { describe, it, expect } from "vitest";
import {
  extractCommands,
  validateCommand,
  validateRmCommand,
  validateKillCommand,
  extractFilePathsFromCommand,
} from "./allowed-commands.js";

// ---------------------------------------------------------------------------
// extractCommands
// ---------------------------------------------------------------------------

describe("extractCommands", () => {
  it("extracts a single command", () => {
    expect(extractCommands("ls -la")).toEqual(["ls"]);
  });

  it("extracts commands from a pipeline", () => {
    expect(extractCommands("ls | grep foo")).toEqual(["ls", "grep"]);
  });

  it("extracts commands chained with &&", () => {
    expect(extractCommands("echo hello && cat file")).toEqual(["echo", "cat"]);
  });

  it("extracts commands chained with ||", () => {
    expect(extractCommands("echo hello || cat file")).toEqual(["echo", "cat"]);
  });

  it("extracts commands separated by ;", () => {
    expect(extractCommands("echo hello; ls")).toEqual(["echo", "ls"]);
  });

  it("extracts commands from $() substitutions", () => {
    expect(extractCommands("$(whoami)")).toEqual(["whoami"]);
  });

  it("extracts commands from backtick substitutions", () => {
    expect(extractCommands("`whoami`")).toEqual(["whoami"]);
  });

  it("skips shell keywords (for/do/done)", () => {
    const result = extractCommands("for x in a b; do echo $x; done");
    // Should contain 'echo' but not 'for', 'do', 'done', 'in', or the loop variable
    expect(result).toContain("echo");
    expect(result).not.toContain("for");
    expect(result).not.toContain("do");
    expect(result).not.toContain("done");
    expect(result).not.toContain("in");
  });

  it("skips shell keywords (if/then/else/fi)", () => {
    const result = extractCommands("if true; then echo yes; else echo no; fi");
    expect(result).toContain("true");
    expect(result).toContain("echo");
    expect(result).not.toContain("if");
    expect(result).not.toContain("then");
    expect(result).not.toContain("else");
    expect(result).not.toContain("fi");
  });

  it("skips variable assignments and returns the command", () => {
    expect(extractCommands("VAR=val node app.js")).toEqual(["node"]);
  });

  it("handles multiple variable assignments before command", () => {
    expect(extractCommands("A=1 B=2 node app.js")).toEqual(["node"]);
  });

  it("extracts basename from absolute command paths", () => {
    expect(extractCommands("/usr/bin/python script.py")).toEqual(["python"]);
  });

  it("handles empty string", () => {
    expect(extractCommands("")).toEqual([]);
  });

  it("handles whitespace-only string", () => {
    expect(extractCommands("   ")).toEqual([]);
  });

  it("handles complex pipeline with multiple operators", () => {
    expect(extractCommands("find . -name '*.ts' | grep test | wc -l")).toEqual([
      "find",
      "grep",
      "wc",
    ]);
  });

  it("handles mixed chaining operators", () => {
    expect(extractCommands("mkdir -p dir && cd dir; ls")).toEqual([
      "mkdir",
      "cd",
      "ls",
    ]);
  });

  it("skips while/case/esac keywords", () => {
    const result = extractCommands(
      "while true; do echo loop; done",
    );
    expect(result).toContain("true");
    expect(result).toContain("echo");
    expect(result).not.toContain("while");
    expect(result).not.toContain("done");
  });

  it("skips the 'function' keyword", () => {
    // function keyword followed by a name isn't a command
    const result = extractCommands("function foo { echo bar; }");
    expect(result).toContain("echo");
    expect(result).not.toContain("function");
  });
});

// ---------------------------------------------------------------------------
// validateCommand
// ---------------------------------------------------------------------------

describe("validateCommand", () => {
  const allowlist = new Set(["ls", "cat", "echo", "grep", "node"]);

  it("returns allowed for a command in the allowlist", () => {
    const result = validateCommand("ls", allowlist);
    expect(result.allowed).toBe(true);
  });

  it("returns allowed without a reason", () => {
    const result = validateCommand("cat", allowlist);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("returns blocked for a command not in the allowlist", () => {
    const result = validateCommand("wget", allowlist);
    expect(result.allowed).toBe(false);
  });

  it("returns blocked with a reason", () => {
    const result = validateCommand("wget", allowlist);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain("wget");
  });

  it("returns blocked for curl when not in allowlist", () => {
    const result = validateCommand("curl", allowlist);
    expect(result.allowed).toBe(false);
  });

  it("returns allowed for each command in the allowlist", () => {
    for (const cmd of allowlist) {
      const result = validateCommand(cmd, allowlist);
      expect(result.allowed).toBe(true);
    }
  });

  it("is case-sensitive", () => {
    const result = validateCommand("LS", allowlist);
    expect(result.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateRmCommand
// ---------------------------------------------------------------------------

describe("validateRmCommand", () => {
  it("blocks rm -rf /", () => {
    const result = validateRmCommand("rm -rf /");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("blocks rm -rf /*", () => {
    const result = validateRmCommand("rm -rf /*");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("blocks rm -rf / with different flag ordering", () => {
    const result = validateRmCommand("rm -r -f /");
    expect(result.allowed).toBe(false);
  });

  it("blocks rm on sensitive system directories", () => {
    const result = validateRmCommand("rm -rf /etc");
    expect(result.allowed).toBe(false);
  });

  it("blocks rm -rf /home", () => {
    const result = validateRmCommand("rm -rf /home");
    expect(result.allowed).toBe(false);
  });

  it("allows normal rm usage on a single file", () => {
    const result = validateRmCommand("rm file.txt");
    expect(result.allowed).toBe(true);
  });

  it("allows rm -f on a specific file", () => {
    const result = validateRmCommand("rm -f dist/output.js");
    expect(result.allowed).toBe(true);
  });

  it("allows rm -rf on a project subdirectory", () => {
    const result = validateRmCommand("rm -rf dist");
    expect(result.allowed).toBe(true);
  });

  it("allows rm -rf on node_modules", () => {
    const result = validateRmCommand("rm -rf node_modules");
    expect(result.allowed).toBe(true);
  });

  it("blocks rm with no target", () => {
    const result = validateRmCommand("rm");
    expect(result.allowed).toBe(false);
  });

  it("blocks rm -rf with wildcard patterns", () => {
    const result = validateRmCommand("rm -rf ../*");
    expect(result.allowed).toBe(false);
  });

  it("blocks rm -rf on hidden files pattern", () => {
    const result = validateRmCommand("rm -rf .*");
    expect(result.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateKillCommand
// ---------------------------------------------------------------------------

describe("validateKillCommand", () => {
  it("blocks kill of PID 1", () => {
    const result = validateKillCommand("kill 1");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain("PID 1");
  });

  it("blocks kill -9 of PID 1", () => {
    const result = validateKillCommand("kill -9 1");
    expect(result.allowed).toBe(false);
  });

  it("blocks kill -SIGKILL of PID 1", () => {
    const result = validateKillCommand("kill -SIGKILL 1");
    expect(result.allowed).toBe(false);
  });

  it("allows kill of a normal PID", () => {
    const result = validateKillCommand("kill 12345");
    expect(result.allowed).toBe(true);
  });

  it("allows kill -9 of a normal PID", () => {
    const result = validateKillCommand("kill -9 12345");
    expect(result.allowed).toBe(true);
  });

  it("allows kill -TERM of a normal PID", () => {
    const result = validateKillCommand("kill -TERM 12345");
    expect(result.allowed).toBe(true);
  });

  it("blocks kill with no PID", () => {
    const result = validateKillCommand("kill");
    expect(result.allowed).toBe(false);
  });

  it("blocks kill of negative PIDs (process groups)", () => {
    const result = validateKillCommand("kill -9 -1");
    expect(result.allowed).toBe(false);
  });

  it("blocks kill of very low system PIDs", () => {
    const result = validateKillCommand("kill 2");
    expect(result.allowed).toBe(false);
  });

  it("allows kill -l (list signals)", () => {
    const result = validateKillCommand("kill -l");
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractFilePathsFromCommand
// ---------------------------------------------------------------------------

describe("extractFilePathsFromCommand", () => {
  it("extracts both paths from cp command", () => {
    const paths = extractFilePathsFromCommand("cp a.txt /etc/shadow");
    expect(paths).toContain("a.txt");
    expect(paths).toContain("/etc/shadow");
  });

  it("extracts both paths from mv command", () => {
    const paths = extractFilePathsFromCommand("mv src dest");
    expect(paths).toContain("src");
    expect(paths).toContain("dest");
  });

  it("extracts the directory path from mkdir -p", () => {
    const paths = extractFilePathsFromCommand("mkdir -p /some/dir");
    expect(paths).toContain("/some/dir");
  });

  it("extracts redirect target from echo with >", () => {
    const paths = extractFilePathsFromCommand("echo x > /tmp/out");
    expect(paths).toContain("/tmp/out");
  });

  it("extracts output path from curl -o", () => {
    const paths = extractFilePathsFromCommand("curl -o /path/file http://example.com");
    expect(paths).toContain("/path/file");
  });

  it("extracts paths from rm command", () => {
    const paths = extractFilePathsFromCommand("rm -f old-file.txt");
    expect(paths).toContain("old-file.txt");
  });

  it("extracts path from touch command", () => {
    const paths = extractFilePathsFromCommand("touch new-file.txt");
    expect(paths).toContain("new-file.txt");
  });

  it("extracts both source and dest from ln command", () => {
    const paths = extractFilePathsFromCommand("ln -s /usr/bin/node ./node-link");
    expect(paths).toContain("/usr/bin/node");
    expect(paths).toContain("./node-link");
  });

  it("extracts path from tee command", () => {
    const paths = extractFilePathsFromCommand("tee /tmp/output.log");
    expect(paths).toContain("/tmp/output.log");
  });

  it("extracts path from chmod command", () => {
    const paths = extractFilePathsFromCommand("chmod +x script.sh");
    expect(paths).toContain("script.sh");
  });

  it("extracts path from rmdir command", () => {
    const paths = extractFilePathsFromCommand("rmdir empty-dir");
    expect(paths).toContain("empty-dir");
  });

  it("extracts directory from unzip -d", () => {
    const paths = extractFilePathsFromCommand("unzip archive.zip -d /some/dir");
    expect(paths).toContain("/some/dir");
  });

  it("extracts redirect target from >> append", () => {
    const paths = extractFilePathsFromCommand("echo data >> /tmp/log");
    expect(paths).toContain("/tmp/log");
  });

  it("extracts redirect target from 2> stderr redirect", () => {
    const paths = extractFilePathsFromCommand("node app.js 2> /tmp/err.log");
    expect(paths).toContain("/tmp/err.log");
  });

  it("skips flags (args starting with -)", () => {
    const paths = extractFilePathsFromCommand("mkdir -p -v /some/dir");
    expect(paths).not.toContain("-p");
    expect(paths).not.toContain("-v");
    expect(paths).toContain("/some/dir");
  });

  it("returns empty array for empty string", () => {
    expect(extractFilePathsFromCommand("")).toEqual([]);
  });

  it("returns empty for non-file commands", () => {
    const paths = extractFilePathsFromCommand("echo hello world");
    // echo is not a file-manipulating command, so no paths unless there's redirection
    expect(paths).toEqual([]);
  });
});
