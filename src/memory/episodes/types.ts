import { z } from "zod";

export const EpisodeSourceSchema = z.enum([
  "telegram",
  "slack",
  "terminal",
  "github",
  "heartbeat",
  "system",
]);

export type EpisodeSource = z.infer<typeof EpisodeSourceSchema>;

export const EpisodeInitiatorSchema = z.enum(["user", "heartbeat", "system"]);

export type EpisodeInitiator = z.infer<typeof EpisodeInitiatorSchema>;

export const EpisodeOutcomeSchema = z.enum([
  "success",
  "partial_success",
  "failure",
  "aborted",
]);

export type EpisodeOutcome = z.infer<typeof EpisodeOutcomeSchema>;

export const EpisodeStepKindSchema = z.enum([
  "state",
  "action",
  "observation",
  "tool_call",
  "tool_result",
  "decision",
]);

export type EpisodeStepKind = z.infer<typeof EpisodeStepKindSchema>;

export const EpisodeStepSchema = z.object({
  at: z.string(),
  kind: EpisodeStepKindSchema,
  label: z.string(),
  data: z.unknown().optional(),
});

export type EpisodeStep = z.infer<typeof EpisodeStepSchema>;

export const EpisodeRecordSchema = z.object({
  id: z.string().min(1),
  startedAt: z.string(),
  endedAt: z.string(),
  source: EpisodeSourceSchema,
  sessionKey: z.string().min(1),
  sessionId: z.string().nullable().optional(),
  initiator: EpisodeInitiatorSchema,
  action: z.string().min(1),
  normalizedAction: z.string().min(1),
  summary: z.string().min(1),
  why: z.string().nullable().optional(),
  projectName: z.string().nullable().optional(),
  jobName: z.string().nullable().optional(),
  issueId: z.string().nullable().optional(),
  pullRequestId: z.string().nullable().optional(),
  detailedMemoryFile: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  skillsUsed: z.array(z.string()),
  toolsUsed: z.array(z.string()),
  tags: z.array(z.string()),
  outcome: EpisodeOutcomeSchema,
  successScore: z.number().nullable().optional(),
  blockers: z.array(z.string()),
  errors: z.array(z.string()),
  openQuestions: z.array(z.string()),
  relatedEpisodeIds: z.array(z.string()).default([]),
  model: z.string().nullable().optional(),
  inputTokens: z.number().int().nullable().optional(),
  outputTokens: z.number().int().nullable().optional(),
  location: z.string().nullable().optional(),
  trajectory: z.array(EpisodeStepSchema),
  semanticEmbeddingText: z.string().min(1),
});

export type EpisodeRecord = z.infer<typeof EpisodeRecordSchema>;

export const EpisodeListFiltersSchema = z.object({
  sessionKey: z.string().optional(),
  source: EpisodeSourceSchema.optional(),
  outcome: EpisodeOutcomeSchema.optional(),
  startedAtFrom: z.string().optional(),
  startedAtTo: z.string().optional(),
  endedAtFrom: z.string().optional(),
  endedAtTo: z.string().optional(),
  projectName: z.string().optional(),
  jobName: z.string().optional(),
  issueId: z.string().optional(),
  pullRequestId: z.string().optional(),
  detailedMemoryFile: z.string().optional(),
  category: z.string().optional(),
  skillUsed: z.string().optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

export type EpisodeListFilters = z.infer<typeof EpisodeListFiltersSchema>;
