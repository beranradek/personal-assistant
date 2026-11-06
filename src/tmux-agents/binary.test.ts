import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentEnvPath, createBinaryResolver } from "./binary.js";
import { TmuxAgentError } from "./errors.js";
import type { AgentKind, KindTable } from "./kinds.js";

function errorOf(fn: () => unknown): TmuxAgentError {
  try {
    fn();
  } catch (err) {
    if (err instanceof TmuxAgentError) return err;
    throw err;
  }
  throw new Error("expected a TmuxAgentError");
}

function kindTable(knownLocations?: readonly string[]): KindTable {
  const kind: AgentKind = {
    id: "claude",
    command: ["claude"],
    modes: { default: [], acceptEdits: [], plan: [], bypass: [] },
    exitInput: "/exit",
    interruptKey: "C-c",
    detector: "claude@1",
    allowedSlash: [],
    multilinePaste: "bracketed",
    ...(knownLocations ? { knownLocations } : {}),
  };
  return { claude: kind };
}

describe("createBinaryResolver", () => {
  let tmp: string;
  let binDir: string;
  let otherDir: string;
  let home: string;

  const makeExecutable = (dir: string, name: string, mode = 0o755) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, "#!/bin/sh\n");
    fs.chmodSync(file, mode);
    return file;
  };

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "binary-test-")));
    binDir = path.join(tmp, "bin");
    otherDir = path.join(tmp, "other");
    home = path.join(tmp, "home");
    fs.mkdirSync(binDir);
    fs.mkdirSync(otherDir);
    fs.mkdirSync(home);
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const resolver = (
    agentBinaries: Record<string, string>,
    PATH: string | undefined,
    knownLocations?: readonly string[],
    extra: { onResolved?: (kindId: string, file: string, via: string) => void } = {},
  ) =>
    createBinaryResolver(
      { agentBinaries },
      { env: PATH === undefined ? {} : { PATH }, kinds: kindTable(knownLocations), home, ...extra },
    );

  it("finds a bare command on the PATH of the env (first match wins)", () => {
    const first = makeExecutable(binDir, "agent");
    makeExecutable(otherDir, "agent");
    expect(resolver({}, `${binDir}:${otherDir}`)("claude", "agent")).toBe(first);
  });

  it("skips non-executable files, directories and relative PATH entries", () => {
    makeExecutable(binDir, "agent", 0o644);
    fs.mkdirSync(path.join(otherDir, "agent"));
    const real = makeExecutable(tmp, "agent");
    fs.mkdirSync(path.join(tmp, "rel"));
    expect(resolver({}, `${binDir}:${otherDir}:rel:${tmp}`)("claude", "agent")).toBe(real);
  });

  it("prefers the configured absolute path over the PATH", () => {
    makeExecutable(binDir, "claude");
    const configured = makeExecutable(otherDir, "my-agent");
    expect(resolver({ claude: configured }, binDir)("claude", "claude")).toBe(configured);
  });

  it("accepts an absolute command without searching the PATH", () => {
    const file = makeExecutable(binDir, "agent");
    expect(resolver({}, undefined)("fake", file)).toBe(file);
  });

  describe("well-known install locations", () => {
    it("finds the program there when it is not on the PATH, expanding ~ with the home directory", () => {
      const file = makeExecutable(path.join(home, ".local", "bin"), "claude");
      expect(resolver({}, binDir, ["~/.local/bin/claude"])("claude", "claude")).toBe(file);
    });

    it("uses the PATH before the well-known locations", () => {
      makeExecutable(path.join(home, ".local", "bin"), "claude");
      const onPath = makeExecutable(binDir, "claude");
      expect(resolver({}, binDir, ["~/.local/bin/claude"])("claude", "claude")).toBe(onPath);
    });

    it("takes the first executable regular file in table order and skips directories and non-executables", () => {
      fs.mkdirSync(path.join(home, "a"));
      makeExecutable(path.join(home, "b"), "claude", 0o644);
      const wanted = makeExecutable(path.join(home, "c"), "claude");
      makeExecutable(path.join(home, "d"), "claude");
      const locations = ["~/a", "~/b/claude", "~/missing/claude", "~/c/claude", "~/d/claude"];
      expect(resolver({}, undefined, locations)("claude", "claude")).toBe(wanted);
    });

    it("follows a symlink to an executable file and returns the symlink path", () => {
      const target = makeExecutable(path.join(home, "versions", "1.2.3"), "claude");
      const link = path.join(home, ".local", "bin", "claude");
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(target, link);
      expect(resolver({}, undefined, ["~/.local/bin/claude"])("claude", "claude")).toBe(link);
    });

    it("ignores a dangling symlink", () => {
      const link = path.join(home, "claude");
      fs.symlinkSync(path.join(home, "gone"), link);
      const err = errorOf(() => resolver({}, undefined, ["~/claude"])("claude", "claude"));
      expect(err.code).toBe("AGENT_BINARY_NOT_FOUND");
    });

    it("does not use well-known locations when the setting is invalid (no fallback)", () => {
      makeExecutable(path.join(home, ".local", "bin"), "claude");
      const missing = path.join(otherDir, "nope");
      const err = errorOf(() => resolver({ claude: missing }, binDir, ["~/.local/bin/claude"])("claude", "claude"));
      expect(err.message).toContain(missing);
    });

    it("keeps an absolute entry as it is", () => {
      const file = makeExecutable(otherDir, "claude");
      expect(resolver({}, undefined, [file])("claude", "claude")).toBe(file);
    });
  });

  describe("caching", () => {
    it("caches the result and does not search again while the file is still executable", () => {
      const first = makeExecutable(binDir, "agent");
      const seen: string[] = [];
      const resolve = resolver({}, `${binDir}:${otherDir}`, undefined, { onResolved: (_k, file) => seen.push(file) });
      expect(resolve("claude", "agent")).toBe(first);
      expect(resolve("claude", "agent")).toBe(first);
      expect(seen).toEqual([first]);
    });

    it("resolves again when the cached file is gone", () => {
      const first = makeExecutable(binDir, "agent");
      const second = makeExecutable(otherDir, "agent");
      const resolve = resolver({}, `${binDir}:${otherDir}`);
      expect(resolve("claude", "agent")).toBe(first);
      fs.rmSync(first);
      expect(resolve("claude", "agent")).toBe(second);
    });

    it("does not cache a failure: a program installed later is found", () => {
      const resolve = resolver({}, binDir, ["~/.local/bin/claude"]);
      expect(errorOf(() => resolve("claude", "claude")).code).toBe("AGENT_BINARY_NOT_FOUND");
      const file = makeExecutable(path.join(home, ".local", "bin"), "claude");
      expect(resolve("claude", "claude")).toBe(file);
    });

    it("reports how the program was found, once per resolution", () => {
      const found: Array<[string, string, string]> = [];
      const onPath = makeExecutable(binDir, "claude");
      const resolve = resolver({}, binDir, undefined, { onResolved: (k, f, via) => found.push([k, f, via]) });
      resolve("claude", "claude");
      resolve("claude", "claude");
      expect(found).toEqual([["claude", onPath, "PATH"]]);
    });
  });

  it("fails with AGENT_BINARY_NOT_FOUND listing the PATH, the known locations and the optional setting", () => {
    const err = errorOf(() => resolver({}, `${binDir}:${otherDir}`, ["~/.local/bin/claude", "/opt/x/claude"])("claude", "claude"));
    expect(err.code).toBe("AGENT_BINARY_NOT_FOUND");
    expect(err.message).toContain("claude");
    expect(err.message).toContain(`${binDir}:${otherDir}`);
    expect(err.message).toContain(path.join(home, ".local", "bin", "claude"));
    expect(err.message).toContain("/opt/x/claude");
    expect(err.message).toContain("tmuxAgents.agentBinaries.claude");
  });

  it("fails when the configured path is not executable and does not fall back to the PATH", () => {
    makeExecutable(binDir, "claude");
    const missing = path.join(otherDir, "nope");
    const err = errorOf(() => resolver({ claude: missing }, binDir)("claude", "claude"));
    expect(err.code).toBe("AGENT_BINARY_NOT_FOUND");
    expect(err.message).toContain(missing);
  });

  it("reports an empty PATH", () => {
    const err = errorOf(() => resolver({}, undefined)("claude", "claude"));
    expect(err.code).toBe("AGENT_BINARY_NOT_FOUND");
    expect(err.message).toContain("PATH is empty");
  });
});

describe("agentEnvPath", () => {
  it("prepends the directory of the binary when it is not on the PATH yet", () => {
    expect(agentEnvPath("/home/u/.local/bin/claude", "/usr/bin:/bin")).toBe("/home/u/.local/bin:/usr/bin:/bin");
  });

  it("returns undefined when the directory is already on the PATH", () => {
    expect(agentEnvPath("/usr/bin/claude", "/usr/local/bin:/usr/bin")).toBeUndefined();
  });

  it("returns undefined for a relative program (nothing to prepend)", () => {
    expect(agentEnvPath("claude", "/usr/bin")).toBeUndefined();
  });

  it("works with an empty or missing PATH", () => {
    expect(agentEnvPath("/opt/a/claude", "")).toBe("/opt/a");
    expect(agentEnvPath("/opt/a/claude", undefined)).toBe("/opt/a");
  });
});
