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
      "gh",
      "pa",
      "curl", "wget", "tar", "gzip", "gunzip", "zip", "unzip", "jq",
      "python", "python3", "pip", "pip3", "make",
      "mkdir", "rmdir", "touch", "cp", "mv", "rm", "chmod", "ln", "tee",
      "kill", "pkill",
    ],
    commandsNeedingExtraValidation: ["rm", "rmdir", "kill", "chmod", "curl"],
    allowSudo: false,
    workspace: "~/.personal-assistant/workspace",
    dataDir: "~/.personal-assistant/data",
    additionalReadDirs: [],
    additionalWriteDirs: [],
    scriptContentPolicy: {
      enabled: true,
      maxBytes: 200_000,
      denyStdinExecution: true,
      denyMissingScriptFile: true,
      scanInline: true,
    },
  },
  adapters: {
    telegram: {
      enabled: false,
      botToken: "",
      allowedUserIds: [],
      mode: "polling",
      audio: {
        enabled: true,
        sttModel: "whisper-1",
        sttLanguage: "cs",
        ttsModel: "gpt-4o-mini-tts",
        ttsVoice: "nova",
        ttsSpeed: 1.0,
        ttsFormat: "opus",
        maxInputSizeMb: 20,
        openaiBaseUrl: null,
        timeoutMs: 30_000,
      },
    },
    slack: { enabled: false, botToken: "", appToken: "", allowedUserIds: [], socketMode: true },
    githubWebhook: {
      enabled: false,
      bind: "127.0.0.1",
      port: 19210,
      path: "/personal-assistant/github/webhook",
      botLogin: "",
      secretEnvVar: "PA_GITHUB_WEBHOOK_SECRET",
    },
  },
  heartbeat: {
    enabled: true,
    intervalMinutes: 30,
    activeHours: "8-21",
    morningHour: 8,
    eveningHour: 20,
    deliverTo: "last",
    stateDiffing: true,
    gitSync: { enabled: true, remote: "origin" },
  },
  gateway: {
    maxQueueSize: 20,
    processingUpdateIntervalMs: 5000,
    rateLimiter: { enabled: true, windowMs: 60_000, maxRequests: 20 },
  },
  agent: { backend: "claude" as const, model: null, maxTurns: 200 },
  session: {
    maxHistoryMessages: 20,
    compactionEnabled: true,
    summarizationEnabled: true,
    summarizationModel: "claude-haiku-4-5-20251001",
    preCompactionFlush: true,
  },
  memory: {
    search: {
      enabled: true,
      hybridWeights: { vector: 0.7, keyword: 0.3 },
      minScore: 0.35,
      maxResults: 6,
      chunkTokens: 400,
      chunkOverlap: 80,
      recencyBoost: 0.1,
      recencyHalfLifeDays: 7,
    },
    extraPaths: [],
    indexDailyLogs: true,
    dailyLogRetentionDays: 90,
  },
  reflection: {
    enabled: true,
    schedule: "0 7 * * *",
    maxDailyLogEntries: 500,
    weeklyEnabled: true,
    weeklySchedule: "5 7 * * 1",
    dailyRetentionDays: 21,
  },
  integApi: {
    enabled: false,
    port: 19100,
    bind: "127.0.0.1",
    inboundRateLimit: 100,
    contentFilter: { redactPatterns: [], maxBodyLength: 50000 },
    services: {
      gmail: { enabled: false, scopes: [], userEmails: [] },
      calendar: { enabled: false, scopes: [] },
      slack: { enabled: false, scopes: [] },
    },
  },
  habits: {
    enabled: false,
    pillars: [],
  },
  drafts: {
    enabled: false,
    ttlHours: 24,
    autoScan: false,
  },
  mcpServers: {},
  codex: {
    codexPath: null,
    apiKey: null,
    baseUrl: null,
    sandboxMode: "workspace-write" as const,
    approvalPolicy: "never" as const,
    networkAccess: true,
    reasoningEffort: null,
    skipGitRepoCheck: true,
    configOverrides: {},
  },
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
