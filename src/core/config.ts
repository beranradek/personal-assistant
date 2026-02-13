import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ConfigSchema, type Config } from "./types.js";

// ---------------------------------------------------------------------------
// Default configuration values
// ---------------------------------------------------------------------------

export const DEFAULTS: Config = {
  security: {
    allowedCommands: [
      "ls", "cat", "grep", "head", "tail", "wc", "sort", "uniq", "find",
      "echo", "pwd", "date", "whoami", "env", "which", "file", "stat",
      "du", "df", "diff", "tr", "cut", "sed", "awk", "xargs",
      "node", "npm", "npx", "git",
      "curl", "wget", "tar", "gzip", "gunzip", "zip", "unzip", "jq",
      "python", "python3", "pip", "pip3", "make",
      "mkdir", "rmdir", "touch", "cp", "mv", "rm", "chmod", "ln", "tee",
      "kill", "pkill",
    ],
    commandsNeedingExtraValidation: ["rm", "rmdir", "kill", "chmod", "curl"],
    workspace: "~/.personal-assistant/workspace",
    dataDir: "~/.personal-assistant/data",
    additionalReadDirs: [],
    additionalWriteDirs: [],
  },
  adapters: {
    telegram: { enabled: false, botToken: "", allowedUserIds: [], mode: "polling" },
    slack: { enabled: false, botToken: "", appToken: "", socketMode: true },
  },
  heartbeat: {
    enabled: true,
    intervalMinutes: 30,
    activeHours: "8-21",
    deliverTo: "last",
  },
  gateway: { maxQueueSize: 20 },
  agent: { model: null, maxTurns: 200 },
  session: { maxHistoryMessages: 50, compactionEnabled: true },
  memory: {
    search: {
      enabled: true,
      hybridWeights: { vector: 0.7, keyword: 0.3 },
      minScore: 0.35,
      maxResults: 6,
      chunkTokens: 400,
      chunkOverlap: 80,
    },
    extraPaths: [],
  },
  mcpServers: {},
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Expand a leading `~` to the current user's home directory.
 * Returns absolute paths unchanged.
 */
export function resolveUserPath(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Resolve the configuration directory from CLI args, env var, or default.
 *
 * Priority:
 * 1. `--config <path>` flag → parent directory of the specified file
 * 2. `PA_CONFIG` env var → that directory
 * 3. Default → `~/.personal-assistant/`
 */
export function resolveConfigDir(argv: string[]): string {
  const configIdx = argv.indexOf("--config");
  if (configIdx !== -1 && configIdx + 1 < argv.length) {
    return path.resolve(path.dirname(argv[configIdx + 1]));
  }

  const envConfig = process.env["PA_CONFIG"];
  if (envConfig) {
    return path.resolve(resolveUserPath(envConfig));
  }

  return path.join(os.homedir(), ".personal-assistant");
}

// ---------------------------------------------------------------------------
// Deep merge utility
// ---------------------------------------------------------------------------

/**
 * Recursively merge `source` into `target`. Values in `source` take precedence.
 * Arrays are replaced, not concatenated.
 */
function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>,
): T {
  const result = { ...target } as Record<string, unknown>;

  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];

    if (
      srcVal !== null &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else {
      result[key] = srcVal;
    }
  }

  return result as T;
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

/**
 * Load configuration from `settings.json` in the given directory.
 *
 * 1. Read the JSON file (or use `{}` if absent)
 * 2. Deep-merge user values over DEFAULTS
 * 3. Validate with Zod schema (throws on invalid)
 * 4. Resolve `~` in workspace and dataDir paths
 */
export function loadConfig(configDir: string): Config {
  const settingsPath = path.join(configDir, "settings.json");

  let userSettings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    userSettings = JSON.parse(raw) as Record<string, unknown>;
  }

  const merged = deepMerge(
    DEFAULTS as unknown as Record<string, unknown>,
    userSettings,
  );

  // Validate with Zod — throws ZodError on invalid config
  const config = ConfigSchema.parse(merged);

  // Resolve ~ in path fields
  config.security.workspace = resolveUserPath(config.security.workspace);
  config.security.dataDir = resolveUserPath(config.security.dataDir);

  return config;
}
