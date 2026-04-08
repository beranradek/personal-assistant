import { z } from "zod";

// ---------------------------------------------------------------------------
// Config – Zod schema for runtime validation + inferred TypeScript type
// ---------------------------------------------------------------------------

export const SecurityConfigSchema = z.object({
  allowedCommands: z.array(z.string()),
  commandsNeedingExtraValidation: z.array(z.string()),
  allowSudo: z.boolean().default(false),
  workspace: z.string(),
  dataDir: z.string(),
  additionalReadDirs: z.array(z.string()),
  additionalWriteDirs: z.array(z.string()),
});

export const TelegramAudioConfigSchema = z.object({
  /** Enable speech-to-text for inbound audio and voice replies. */
  enabled: z.boolean().default(true),
  /** OpenAI model for speech-to-text (e.g. whisper-1, gpt-4o-mini-transcribe). */
  sttModel: z.string().default("whisper-1"),
  /** Language code for transcription (default: Czech). */
  sttLanguage: z.string().default("cs"),
  /** OpenAI model for text-to-speech (e.g. tts-1, gpt-4o-mini-tts). */
  ttsModel: z.string().default("gpt-4o-mini-tts"),
  /** OpenAI voice name (e.g. alloy, ash, echo, fable, onyx, nova, shimmer). */
  ttsVoice: z.string().default("nova"),
  /** Speech speed (0.25 to 4.0). */
  ttsSpeed: z.number().min(0.25).max(4).default(1.0),
  /** Output format for TTS (recommended: opus for Telegram voice). */
  ttsFormat: z.enum(["mp3", "opus", "aac", "flac", "wav", "pcm"]).default("opus"),
  /** Max Telegram audio size to download/transcribe. */
  maxInputSizeMb: z.number().int().positive().default(20),
  /** Optional OpenAI base URL override (host only, without /v1). */
  openaiBaseUrl: z.string().nullable().default(null),
  /** Timeout for OpenAI audio calls (ms). */
  timeoutMs: z.number().int().positive().default(30_000),
});

export const TelegramConfigSchema = z.object({
  enabled: z.boolean(),
  botToken: z.string(),
  allowedUserIds: z.array(z.number()),
  /** Transport mode (currently polling only). */
  mode: z.enum(["polling"]).default("polling"),
  audio: TelegramAudioConfigSchema.default(() => TelegramAudioConfigSchema.parse({})),
});

export const SlackConfigSchema = z.object({
  enabled: z.boolean(),
  botToken: z.string(),
  appToken: z.string(),
  allowedUserIds: z.array(z.string()),
  socketMode: z.boolean(),
});

export const GithubWebhookConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Bind address for the webhook HTTP server. */
  bind: z.string().default("127.0.0.1"),
  /** Port for the webhook HTTP server. */
  port: z.number().int().positive().default(19210),
  /** URL path to receive GitHub webhooks on. */
  path: z.string().default("/personal-assistant/github/webhook"),
  /** GitHub login of the bot user (used for mention parsing and loop prevention). */
  botLogin: z.string().default(""),
  /** Env var name holding the GitHub webhook secret used for signature verification. */
  secretEnvVar: z.string().default("PA_GITHUB_WEBHOOK_SECRET"),
});

export const AdaptersConfigSchema = z.object({
  telegram: TelegramConfigSchema,
  slack: SlackConfigSchema,
  githubWebhook: GithubWebhookConfigSchema.default(() => GithubWebhookConfigSchema.parse({})),
});

export const HeartbeatGitSyncConfigSchema = z.object({
  enabled: z.boolean().default(true),
  remote: z.string().default("origin"),
});

export const HeartbeatConfigSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().positive(),
  activeHours: z.string(),
  morningHour: z.number().int().min(0).max(23).default(8),
  eveningHour: z.number().int().min(0).max(23).default(20),
  deliverTo: z.enum(["last", "telegram", "slack"]),
  stateDiffing: z.boolean().default(true),
  gitSync: HeartbeatGitSyncConfigSchema.default(() => HeartbeatGitSyncConfigSchema.parse({})),
});

export const RateLimiterConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Duration of the sliding window in milliseconds. */
  windowMs: z.number().int().positive().default(60_000),
  /** Maximum number of requests allowed per user within the window. */
  maxRequests: z.number().int().positive().default(20),
});

export const GatewayConfigSchema = z.object({
  maxQueueSize: z.number().int().positive(),
  processingUpdateIntervalMs: z.number().int().positive().default(5000),
  rateLimiter: RateLimiterConfigSchema.default(() => RateLimiterConfigSchema.parse({})),
});

export const AgentConfigSchema = z.object({
  backend: z.enum(["claude", "codex"]).default("claude"),
  model: z.string().nullable(),
  maxTurns: z.number().int().positive(),
});

export const CodexConfigSchema = z.object({
  codexPath: z.string().nullable().default(null),
  apiKey: z.string().nullable().default(null),
  baseUrl: z.string().nullable().default(null),
  sandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
  approvalPolicy: z.enum(["never", "on-request", "on-failure", "untrusted"]).default("never"),
  networkAccess: z.boolean().default(true),
  reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).nullable().default(null),
  skipGitRepoCheck: z.boolean().default(true),
  configOverrides: z.record(z.string(), z.unknown()).default({}),
});

export const SessionConfigSchema = z.object({
  maxHistoryMessages: z.number().int().positive(),
  compactionEnabled: z.boolean(),
  summarizationEnabled: z.boolean().default(true),
  summarizationModel: z.string().default("claude-haiku-4-5-20251001"),
  preCompactionFlush: z.boolean().default(true),
});

export const HybridWeightsSchema = z.object({
  vector: z.number().min(0).max(1),
  keyword: z.number().min(0).max(1),
});

export const SearchConfigSchema = z.object({
  enabled: z.boolean(),
  hybridWeights: HybridWeightsSchema,
  minScore: z.number().min(0).max(1),
  maxResults: z.number().int().positive(),
  chunkTokens: z.number().int().positive(),
  chunkOverlap: z.number().int().nonnegative(),
  /** Maximum score boost added to results from recent files. Default: 0.1 */
  recencyBoost: z.number().min(0).max(1).default(0.1),
  /** Days for the recency boost to halve (exponential decay). Default: 7 */
  recencyHalfLifeDays: z.number().int().positive().default(7),
});

export const MemoryConfigSchema = z.object({
  search: SearchConfigSchema,
  extraPaths: z.array(z.string()),
  indexDailyLogs: z.boolean().default(true),
  dailyLogRetentionDays: z.number().int().positive().default(90),
});

export const McpServerConfigSchema = z.record(z.string(), z.unknown());

export const ReflectionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  schedule: z.string().default("0 7 * * *"),
  maxDailyLogEntries: z.number().int().positive().default(500),
  weeklyEnabled: z.boolean().default(true),
  /** Cron expression for weekly synthesis. Default: Monday 7:05 AM (after daily reflection). */
  weeklySchedule: z.string().default("5 7 * * 1"),
  /**
   * Days after which daily reflection files are automatically deleted.
   * Daily files are cleaned up during the weekly synthesis run once they
   * exceed this age. Set to 0 to disable cleanup. Default: 21 days.
   */
  dailyRetentionDays: z.number().int().nonnegative().default(21),
});

export const IntegApiContentFilterConfigSchema = z.object({
  redactPatterns: z.array(z.string()).default([]),
  maxBodyLength: z.number().int().positive().default(50000),
});

export const IntegApiServiceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  scopes: z.array(z.string()).default([]),
});

export const IntegApiGmailServiceConfigSchema = IntegApiServiceConfigSchema.extend({
  /** User's email addresses for TO/CC detection across Gmail accounts. */
  userEmails: z.array(z.string().email()).default([]),
});

export const IntegApiServicesConfigSchema = z.object({
  gmail: IntegApiGmailServiceConfigSchema.default(() => IntegApiGmailServiceConfigSchema.parse({})),
  calendar: IntegApiServiceConfigSchema.default(() => IntegApiServiceConfigSchema.parse({})),
  slack: IntegApiServiceConfigSchema.default(() => IntegApiServiceConfigSchema.parse({})),
});

export const IntegApiConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().positive().default(19100),
  bind: z.string().default("127.0.0.1"),
  inboundRateLimit: z.number().int().positive().default(100),
  contentFilter: IntegApiContentFilterConfigSchema.default(() =>
    IntegApiContentFilterConfigSchema.parse({}),
  ),
  services: IntegApiServicesConfigSchema.default(() => IntegApiServicesConfigSchema.parse({})),
});

export type IntegApiConfig = z.infer<typeof IntegApiConfigSchema>;

export const HabitPillarSchema = z.object({
  id: z.string(),
  label: z.string(),
  autoDetect: z.boolean().default(false),
  detectionCommand: z.string().optional(),
});

export const HabitsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  pillars: z.array(HabitPillarSchema).default([]),
});

export const DraftsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  ttlHours: z.number().int().positive().default(24),
  autoScan: z.boolean().default(false),
});

export const ConfigSchema = z.object({
  security: SecurityConfigSchema,
  adapters: AdaptersConfigSchema,
  heartbeat: HeartbeatConfigSchema,
  gateway: GatewayConfigSchema,
  agent: AgentConfigSchema,
  session: SessionConfigSchema,
  memory: MemoryConfigSchema,
  mcpServers: McpServerConfigSchema,
  codex: CodexConfigSchema,
  reflection: ReflectionConfigSchema.default(() => ReflectionConfigSchema.parse({})),
  integApi: IntegApiConfigSchema.default(() => IntegApiConfigSchema.parse({})),
  habits: HabitsConfigSchema.default(() => HabitsConfigSchema.parse({})),
  drafts: DraftsConfigSchema.default(() => DraftsConfigSchema.parse({})),
});

export type Config = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Adapter types
// ---------------------------------------------------------------------------

/** Message flowing through the gateway between adapters and the agent. */
export interface AdapterMessage {
  /** Which adapter produced this message (e.g. "telegram", "slack", "terminal"). */
  source: string;
  /** Adapter-specific identifier for routing the response back. */
  sourceId: string;
  /** The user's text content. */
  text: string;
  /** Arbitrary adapter-specific metadata. */
  metadata?: Record<string, unknown>;
}

/** Adapter contract – every chat adapter must implement this. */
export interface Adapter {
  /** Human-readable adapter name (e.g. "telegram"). */
  name: string;
  /** Start listening for incoming messages. */
  start(): Promise<void>;
  /** Gracefully stop the adapter. */
  stop(): Promise<void>;
  /** Deliver a response back to the user via this adapter. */
  sendResponse(message: AdapterMessage): Promise<void>;

  /**
   * Create a processing message in the user's chat/thread.
   * Returns a platform-specific message ID for later updates.
   * Optional — only adapters that support streaming implement this.
   */
  createProcessingMessage?(
    sourceId: string,
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<string>;

  /**
   * Update an existing processing message with new content.
   * Optional — only adapters that support streaming implement this.
   */
  updateProcessingMessage?(
    sourceId: string,
    messageId: string,
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Memory / search types
// ---------------------------------------------------------------------------

/** A single result from hybrid (vector + keyword) search. */
export interface SearchResult {
  /** File path relative to workspace root. */
  path: string;
  /** The matching text snippet. */
  snippet: string;
  /** First line of the chunk in the source file. */
  startLine: number;
  /** Last line of the chunk in the source file. */
  endLine: number;
  /** Combined relevance score (0..1). */
  score: number;
}

// ---------------------------------------------------------------------------
// Heartbeat / system event types
// ---------------------------------------------------------------------------

/** An event produced by cron jobs or background exec completions. */
export interface SystemEvent {
  /** Discriminator for the event source. */
  type: "cron" | "exec" | "system";
  /** Human-readable description of the event. */
  text: string;
  /** ISO-8601 timestamp when the event was created. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Cron types
// ---------------------------------------------------------------------------

/** Zod schema for cron schedule types. */
export const CronScheduleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cron"), expression: z.string().min(1) }),
  z.object({ type: z.literal("oneshot"), iso: z.string().min(1) }),
  z.object({ type: z.literal("interval"), everyMs: z.number().int().positive() }),
]);

/** Supported schedule types for a cron job. */
export type CronSchedule = z.infer<typeof CronScheduleSchema>;

/** Zod schema for cron payload. */
export const CronPayloadSchema = z.object({
  text: z.string().min(1),
});

/** Payload delivered when a cron job fires. */
export type CronPayload = z.infer<typeof CronPayloadSchema>;

/** Zod schema for a persisted cron job. */
export const CronJobSchema = z.object({
  id: z.string(),
  label: z.string(),
  schedule: CronScheduleSchema,
  payload: CronPayloadSchema,
  createdAt: z.string(),
  lastFiredAt: z.string().nullable(),
  enabled: z.boolean(),
});

/** A persisted cron job (stored in cron-jobs.json). */
export type CronJob = z.infer<typeof CronJobSchema>;

// ---------------------------------------------------------------------------
// Exec / process types
// ---------------------------------------------------------------------------

/** Tracks a background process spawned by the exec tool. */
export interface ProcessSession {
  /** Process ID. */
  pid: number;
  /** The command that was executed. */
  command: string;
  /** Captured stdout + stderr (combined). */
  output: string;
  /** Exit code, or null if still running. */
  exitCode: number | null;
  /** ISO-8601 timestamp when the process was started. */
  startedAt: string;
  /** ISO-8601 timestamp when the process exited, or null. */
  exitedAt: string | null;
}

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

/** Zod schema for a session message. */
export const SessionMessageSchema = z.object({
  role: z.enum(["user", "assistant", "tool_use", "tool_result", "compaction"]),
  content: z.string(),
  timestamp: z.string(),
  toolName: z.string().optional(),
  error: z.string().optional(),
});

/** A single message in a session transcript (JSONL). */
export type SessionMessage = z.infer<typeof SessionMessageSchema>;

// ---------------------------------------------------------------------------
// Audit log types
// ---------------------------------------------------------------------------

/** Zod schema for an audit log entry. */
export const AuditEntrySchema = z.object({
  timestamp: z.string(),
  source: z.string(),
  sessionKey: z.string(),
  type: z.enum(["interaction", "tool_call", "error"]),
  userMessage: z.string().optional(),
  assistantResponse: z.string().optional(),
  toolName: z.string().optional(),
  toolInput: z.unknown().optional(),
  toolResult: z.unknown().optional(),
  durationMs: z.number().optional(),
  errorMessage: z.string().optional(),
  stack: z.string().optional(),
  context: z.string().optional(),
});

/** A single entry in the daily audit log (JSONL). */
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
