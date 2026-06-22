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
});
