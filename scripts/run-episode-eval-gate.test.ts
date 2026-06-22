import { describe, expect, it, vi } from "vitest";
import { resolveEpisodeEvalOutputPath, runEpisodeEvalGate } from "./run-episode-eval-gate.mjs";

describe("run-episode-eval-gate script", () => {
  it("uses the default artifact path when override is absent", () => {
    expect(resolveEpisodeEvalOutputPath({})).toBe("./tmp/episode-eval-report.json");
  });

  it("uses EPISODE_EVAL_OUTPUT_PATH override when provided", () => {
    expect(resolveEpisodeEvalOutputPath({
      EPISODE_EVAL_OUTPUT_PATH: "./tmp/custom-report.json",
    })).toBe("./tmp/custom-report.json");
  });

  it("runs build first and then episode-eval with JSON artifact output", () => {
    const exec = vi.fn();

    runEpisodeEvalGate({
      env: { EPISODE_EVAL_OUTPUT_PATH: "./tmp/custom-report.json" },
      exec,
    });

    expect(exec).toHaveBeenNthCalledWith(1, "pnpm", ["build"], {
      stdio: "inherit",
    });
    expect(exec).toHaveBeenNthCalledWith(
      2,
      "node",
      ["dist/cli.js", "episode-eval", "--json", "--output", "./tmp/custom-report.json"],
      {
        stdio: "inherit",
      },
    );
  });

  it("does not run episode-eval when the build step fails", () => {
    const exec = vi.fn().mockImplementationOnce(() => {
      throw new Error("build failed");
    });

    expect(() =>
      runEpisodeEvalGate({
        exec,
      }),
    ).toThrow("build failed");

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenNthCalledWith(1, "pnpm", ["build"], {
      stdio: "inherit",
    });
  });

  it("propagates episode-eval failures after a successful build", () => {
    const exec = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("eval failed");
      });

    expect(() =>
      runEpisodeEvalGate({
        exec,
      }),
    ).toThrow("eval failed");

    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenNthCalledWith(1, "pnpm", ["build"], {
      stdio: "inherit",
    });
    expect(exec).toHaveBeenNthCalledWith(
      2,
      "node",
      ["dist/cli.js", "episode-eval", "--json", "--output", "./tmp/episode-eval-report.json"],
      {
        stdio: "inherit",
      },
    );
  });
});
