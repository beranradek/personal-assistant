import { z } from "zod";

// ---------------------------------------------------------------------------
// Config – Zod schema for runtime validation + inferred TypeScript type
// ---------------------------------------------------------------------------

export const SecurityConfigSchema = z.object({
  allowedCommands: z.array(z.string()),
  commandsNeedingExtraValidation: z.array(z.string()),
  workspace: z.string(),
  dataDir: z.string(),
  additionalReadDirs: z.array(z.string()),
  additionalWriteDirs: z.array(z.string()),
});

export const TelegramConfigSchema = z.object({
  enabled: z.boolean(),
  botToken: z.string(),
  allowedUserIds: z.array(z.number()),
});

export const SlackConfigSchema = z.object({
  enabled: z.boolean(),
  botToken: z.string(),
  appToken: z.string(),
  allowedUserIds: z.array(z.string()),
  socketMode: z.boolean(),
});

export const AdaptersConfigSchema = z.object({
  telegram: TelegramConfigSchema,
  slack: SlackConfigSchema,
});

export const HeartbeatConfigSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().positive(),
  activeHours: z.string(),
  deliverTo: z.enum(["last", "telegram", "slack"]),
});

export const GatewayConfigSchema = z.object({
  maxQueueSize: z.number().int().positive(),
  processingUpdateIntervalMs: z.number().int().positive().default(5000),
});

export const AgentConfigSchema = z.object({
  model: z.string().nullable(),
  maxTurns: z.number().int().positive(),
});

export const SessionConfigSchema = z.object({
  maxHistoryMessages: z.number().int().positive(),
  compactionEnabled: z.boolean(),
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
});

export const MemoryConfigSchema = z.object({
  search: SearchConfigSchema,
  extraPaths: z.array(z.string()),
});

export const McpServerConfigSchema = z.record(z.string(), z.unknown());

export const ConfigSchema = z.object({
  security: SecurityConfigSchema,
  adapters: AdaptersConfigSchema,
  heartbeat: HeartbeatConfigSchema,
  gateway: GatewayConfigSchema,
  agent: AgentConfigSchema,
  session: SessionConfigSchema,
  memory: MemoryConfigSchema,
  mcpServers: McpServerConfigSchema,
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
  role: z.enum(["user", "assistant", "tool_use", "tool_result"]),
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
