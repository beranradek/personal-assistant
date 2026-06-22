import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function resolveEpisodeEvalOutputPath(env = process.env) {
  return env.EPISODE_EVAL_OUTPUT_PATH || "./tmp/episode-eval-report.json";
}

export function runEpisodeEvalGate({
  env = process.env,
  exec = execFileSync,
} = {}) {
  const outputPath = resolveEpisodeEvalOutputPath(env);

  exec("pnpm", ["build"], {
    stdio: "inherit",
  });

  exec("node", ["dist/cli.js", "episode-eval", "--json", "--output", outputPath], {
    stdio: "inherit",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runEpisodeEvalGate();
}
