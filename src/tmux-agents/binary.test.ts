import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createBinaryResolver } from "./binary.js";
import { TmuxAgentError } from "./errors.js";

function errorOf(fn: () => unknown): TmuxAgentError {
  try {
    fn();
  } catch (err) {
    if (err instanceof TmuxAgentError) return err;
    throw err;
  }
  throw new Error("expected a TmuxAgentError");
}

describe("createBinaryResolver", () => {
  let tmp: string;
  let binDir: string;
  let otherDir: string;

  const makeExecutable = (dir: string, name: string, mode = 0o755) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "#!/bin/sh\n");
    fs.chmodSync(file, mode);
    return file;
  };

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "binary-test-")));
    binDir = path.join(tmp, "bin");
    otherDir = path.join(tmp, "other");
    fs.mkdirSync(binDir);
    fs.mkdirSync(otherDir);
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const resolver = (agentBinaries: Record<string, string>, PATH: string | undefined) =>
    createBinaryResolver({ agentBinaries }, { env: PATH === undefined ? {} : { PATH } });

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

  it("fails with AGENT_BINARY_NOT_FOUND naming the binary, the searched PATH and the setting", () => {
    const err = errorOf(() => resolver({}, `${binDir}:${otherDir}`)("claude", "claude"));
    expect(err.code).toBe("AGENT_BINARY_NOT_FOUND");
    expect(err.message).toContain("claude");
    expect(err.message).toContain(`${binDir}:${otherDir}`);
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
