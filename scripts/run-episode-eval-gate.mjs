import { execFileSync } from "node:child_process";

const outputPath = process.env.EPISODE_EVAL_OUTPUT_PATH || "./tmp/episode-eval-report.json";

execFileSync("pnpm", ["build"], {
  stdio: "inherit",
});

execFileSync("node", ["dist/cli.js", "episode-eval", "--json", "--output", outputPath], {
  stdio: "inherit",
});
