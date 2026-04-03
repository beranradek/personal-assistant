import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock logger
vi.mock("../core/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

// Mock child_process
const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

// Mock util.promisify to return our mockExecFile directly
vi.mock("node:util", () => ({
  promisify: (fn: unknown) => {
    // If called with our mocked execFile, return a promisified version
    void fn;
    return (...args: unknown[]) => mockExecFile(...args);
  },
}));

import { pullWorkspace, pushWorkspace } from "./git-sync.js";

const WORKSPACE = "/home/user/workspace";
const REMOTE = "origin";

beforeEach(() => {
  mockExecFile.mockReset();
});

// ---------------------------------------------------------------------------
// pullWorkspace
// ---------------------------------------------------------------------------

describe("pullWorkspace", () => {
  it("given a clean workspace, runs pull --rebase and returns success", async () => {
    // status --porcelain returns empty (clean)
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" });
    // pull --rebase succeeds
    mockExecFile.mockResolvedValueOnce({ stdout: "Already up to date.", stderr: "" });

    const result = await pullWorkspace(WORKSPACE, REMOTE);

    expect(result).toEqual({ success: true, stashed: false });
    expect(mockExecFile).toHaveBeenNthCalledWith(
      1,
      "git",
      ["status", "--porcelain"],
      { cwd: WORKSPACE },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      "git",
      ["pull", "--rebase", REMOTE],
      { cwd: WORKSPACE },
    );
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it("given a dirty workspace, stashes, pulls, and pops stash", async () => {
    // status --porcelain returns dirty
    mockExecFile.mockResolvedValueOnce({ stdout: " M some-file.ts\n", stderr: "" });
    // stash push succeeds
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" });
    // pull --rebase succeeds
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" });
    // stash pop succeeds
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await pullWorkspace(WORKSPACE, REMOTE);

    expect(result).toEqual({ success: true, stashed: false });
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      "git",
      ["stash", "push", "-m", "heartbeat-auto-stash"],
      { cwd: WORKSPACE },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      3,
      "git",
      ["pull", "--rebase", REMOTE],
      { cwd: WORKSPACE },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(4, "git", ["stash", "pop"], {
      cwd: WORKSPACE,
    });
    expect(mockExecFile).toHaveBeenCalledTimes(4);
  });

  it("given a pull conflict, returns { success: false } without crashing", async () => {
    // status --porcelain returns clean
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" });
    // pull --rebase fails
    mockExecFile.mockRejectedValueOnce(new Error("CONFLICT (content): Merge conflict"));

    const result = await pullWorkspace(WORKSPACE, REMOTE);

    expect(result.success).toBe(false);
    expect(result.error).toContain("CONFLICT");
  });

  it("given stash push failure, returns { success: false } without crashing", async () => {
    // dirty workspace
    mockExecFile.mockResolvedValueOnce({ stdout: " M file.ts\n", stderr: "" });
    // stash push fails
    mockExecFile.mockRejectedValueOnce(new Error("stash push failed"));

    const result = await pullWorkspace(WORKSPACE, REMOTE);

    expect(result.success).toBe(false);
    expect(result.error).toContain("stash push failed");
  });
});

// ---------------------------------------------------------------------------
// pushWorkspace
// ---------------------------------------------------------------------------

describe("pushWorkspace", () => {
  it("given local commits ahead of remote, runs git push", async () => {
    // rev-list --count returns 2
    mockExecFile.mockResolvedValueOnce({ stdout: "2\n", stderr: "" });
    // push succeeds
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await pushWorkspace(WORKSPACE, REMOTE);

    expect(result).toEqual({ success: true });
    expect(mockExecFile).toHaveBeenNthCalledWith(
      1,
      "git",
      ["rev-list", "--count", "@{u}..HEAD"],
      { cwd: WORKSPACE },
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(2, "git", ["push", REMOTE], {
      cwd: WORKSPACE,
    });
  });

  it("given no local commits, skips push and returns success", async () => {
    // rev-list --count returns 0
    mockExecFile.mockResolvedValueOnce({ stdout: "0\n", stderr: "" });

    const result = await pushWorkspace(WORKSPACE, REMOTE);

    expect(result).toEqual({ success: true });
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("given no upstream configured, skips push and returns success", async () => {
    // rev-list fails with no upstream error
    mockExecFile.mockRejectedValueOnce(
      new Error("fatal: no upstream configured for branch 'main' @{u}"),
    );

    const result = await pushWorkspace(WORKSPACE, REMOTE);

    expect(result).toEqual({ success: true });
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("given a push failure, returns { success: false } with error message", async () => {
    // rev-list returns 1
    mockExecFile.mockResolvedValueOnce({ stdout: "1\n", stderr: "" });
    // push fails
    mockExecFile.mockRejectedValueOnce(new Error("error: failed to push some refs"));

    const result = await pushWorkspace(WORKSPACE, REMOTE);

    expect(result.success).toBe(false);
    expect(result.error).toContain("failed to push");
  });
});
