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
  mode: z.enum(["polling", "webhook"]),
});

export const SlackConfigSchema = z.object({
  enabled: z.boolean(),
  botToken: z.string(),
  appToken: z.string(),
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

/** Supported schedule types for a cron job. */
export type CronSchedule =
  | { type: "cron"; expression: string }
  | { type: "oneshot"; iso: string }
  | { type: "interval"; everyMs: number };

/** Payload delivered when a cron job fires. */
export interface CronPayload {
  /** The text/instruction the agent associated with this job. */
  text: string;
}

/** A persisted cron job (stored in cron-jobs.json). */
export interface CronJob {
  /** Unique job identifier. */
  id: string;
  /** Human-readable label for the job. */
  label: string;
  /** When to fire. */
  schedule: CronSchedule;
  /** What to deliver on fire. */
  payload: CronPayload;
  /** ISO-8601 timestamp of creation. */
  createdAt: string;
  /** ISO-8601 timestamp of last fire, or null. */
  lastFiredAt: string | null;
  /** Whether the job is active. */
  enabled: boolean;
}

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

/** A single message in a session transcript (JSONL). */
export interface SessionMessage {
  /** Message role in the conversation. */
  role: "user" | "assistant" | "tool_use" | "tool_result";
  /** Text content of the message. */
  content: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Tool name (for tool_use / tool_result roles). */
  toolName?: string;
  /** Error information if the tool call failed. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Audit log types
// ---------------------------------------------------------------------------

/** A single entry in the daily audit log (JSONL). */
export interface AuditEntry {
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Which adapter produced the interaction. */
  source: string;
  /** Session key (e.g. "telegram--123456"). */
  sessionKey: string;
  /** Entry type discriminator. */
  type: "interaction" | "tool_call" | "error";
  /** User message text (for interaction type). */
  userMessage?: string;
  /** Assistant response text (for interaction type). */
  assistantResponse?: string;
  /** Tool name (for tool_call type). */
  toolName?: string;
  /** Tool input (for tool_call type). */
  toolInput?: unknown;
  /** Tool result (for tool_call type). */
  toolResult?: unknown;
  /** Tool call duration in ms (for tool_call type). */
  durationMs?: number;
  /** Error message (for error type). */
  errorMessage?: string;
  /** Error stack trace (for error type). */
  stack?: string;
  /** Additional error context (for error type). */
  context?: string;
}
