import { z } from "zod";
import { searchEpisodes, inferEpisodeRetrievalMode } from "./retrieval.js";
import { EpisodeListFiltersSchema, EpisodeRecordSchema, type EpisodeListFilters } from "./types.js";

export const EpisodeEvalExpectedModeSchema = z.enum([
  "exact_episodic",
  "semantic_episodic",
  "semantic_markdown",
  "raw_audit_fallback",
]);

export type EpisodeEvalExpectedMode = z.infer<typeof EpisodeEvalExpectedModeSchema>;

export const EpisodeEvalFixtureKindSchema = z.enum([
  "runtime",
  "synthetic",
  "shared_startup_wiring",
  "shared_memory_startup",
  "terminal_startup_entrypoint",
  "daemon_startup_entrypoint",
]);

export type EpisodeEvalFixtureKind = z.infer<typeof EpisodeEvalFixtureKindSchema>;

export const EpisodeEvalFixtureSchema = z.object({
  id: z.string().min(1),
  synthetic: z.boolean().optional(),
  fixtureKind: EpisodeEvalFixtureKindSchema.optional(),
  query: z.string().optional(),
  filters: EpisodeListFiltersSchema.omit({ limit: true }).optional(),
  maxResults: z.number().int().positive().max(1000).optional(),
  maxLatencyMs: z.number().positive().optional(),
  insertedEpisodes: z.array(EpisodeRecordSchema),
  expectedMode: EpisodeEvalExpectedModeSchema,
  mustHitIds: z.array(z.string()).default([]),
  mustAvoidIds: z.array(z.string()).default([]),
  expectedTop1Id: z.string().optional(),
  expectedTopKAtMost: z.number().int().positive().max(1000).optional(),
  availabilityExpected: z.boolean().optional(),
  availabilityActual: z.boolean().optional(),
  probeStateExpected: z.object({
    fallbackTriggered: z.boolean().optional(),
    warningTriggered: z.boolean().optional(),
    episodicSurfaceExposed: z.boolean().optional(),
  }).optional(),
  probeStateActual: z.object({
    fallbackTriggered: z.boolean().optional(),
    warningTriggered: z.boolean().optional(),
    episodicSurfaceExposed: z.boolean().optional(),
  }).optional(),
  actualMode: EpisodeEvalExpectedModeSchema.optional(),
  actualResults: z.array(z.object({
    id: z.string().min(1),
    matchedFields: z.array(z.string()).default([]),
    matchedFilters: z.array(z.string()).default([]),
    explanation: z.string().nullable().optional(),
  })).optional(),
}).superRefine((fixture, ctx) => {
  if (
    fixture.synthetic !== undefined &&
    fixture.fixtureKind !== undefined &&
    (fixture.synthetic ? "synthetic" : "runtime") !== fixture.fixtureKind
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "synthetic and fixtureKind must not conflict",
      path: ["fixtureKind"],
    });
  }
});

export type EpisodeEvalFixture = z.infer<typeof EpisodeEvalFixtureSchema>;

export type EpisodeEvalRegressionClass =
  | "routing"
  | "ranking"
  | "noise"
  | "availability"
  | "latency";

export type EpisodeEvalResult = {
  fixtureId: string;
  expectedMode: EpisodeEvalExpectedMode;
  actualMode: string;
  metrics: {
    modeCorrect: boolean;
    mustHitRecall: boolean;
    mustAvoidPrecision: boolean;
    top1Correct: boolean;
    topKBounded: boolean;
    latencyMs: number;
    explanationPresent: boolean;
    availabilityOk: boolean | null;
    probeStateOk: boolean | null;
  };
  resultIds: string[];
  matchedFieldsById: Record<string, string[]>;
  exactMatchedFilters: string[];
  failureClasses: EpisodeEvalRegressionClass[];
};

function idsSet(values: string[]) {
  return new Set(values);
}

function listFailureClasses(args: {
  modeCorrect: boolean;
  mustHitRecall: boolean;
  top1Correct: boolean;
  mustAvoidPrecision: boolean;
  topKBounded: boolean;
  availabilityOk: boolean | null;
  probeStateOk: boolean | null;
  latencyOk: boolean;
}): EpisodeEvalRegressionClass[] {
  const failures = new Set<EpisodeEvalRegressionClass>();
  if (!args.modeCorrect) failures.add("routing");
  if (!args.mustHitRecall || !args.top1Correct) failures.add("ranking");
  if (!args.mustAvoidPrecision || !args.topKBounded) failures.add("noise");
  if (args.availabilityOk === false || args.probeStateOk === false) failures.add("availability");
  if (!args.latencyOk) failures.add("latency");
  return [...failures];
}

export function evaluateEpisodeFixture(input: EpisodeEvalFixture): EpisodeEvalResult {
  const fixture = EpisodeEvalFixtureSchema.parse(input);
  const startedAt = performance.now();
  const actualMode = fixture.actualMode ?? inferEpisodeRetrievalMode({
    query: fixture.query,
    filters: fixture.filters as EpisodeListFilters | undefined,
  });
  const results = fixture.actualResults ?? searchEpisodes(fixture.insertedEpisodes, {
    query: fixture.query,
    filters: fixture.filters as EpisodeListFilters | undefined,
    maxResults: fixture.maxResults,
  }).map((result) => ({
    id: result.episode.id,
    matchedFields: result.matchedFields,
    matchedFilters: result.exactMatchedFilters,
    explanation: undefined,
  }));
  const latencyMs = performance.now() - startedAt;
  const latencyOk = fixture.maxLatencyMs ? latencyMs <= fixture.maxLatencyMs : true;
  const resultIds = results.map((result) => result.id);
  const resultIdSet = idsSet(resultIds);
  const mustHitRecall = fixture.mustHitIds.every((id) => resultIdSet.has(id));
  const mustAvoidPrecision = fixture.mustAvoidIds.every((id) => !resultIdSet.has(id));
  const top1Correct = fixture.expectedTop1Id ? resultIds[0] === fixture.expectedTop1Id : true;
  const topKBounded = fixture.expectedTopKAtMost ? resultIds.length <= fixture.expectedTopKAtMost : true;
  const explanationPresent =
    results.length === 0 ||
    results.every(
      (result) =>
        result.matchedFields.length > 0 ||
        result.matchedFilters.length > 0 ||
        Boolean(result.explanation),
    );
  const availabilityOk =
    fixture.availabilityExpected === undefined && fixture.availabilityActual === undefined
      ? null
      : fixture.availabilityExpected === fixture.availabilityActual;
  const probeStateOk =
    fixture.probeStateExpected === undefined && fixture.probeStateActual === undefined
      ? null
      : fixture.probeStateExpected !== undefined &&
          fixture.probeStateActual !== undefined &&
          Object.entries(fixture.probeStateExpected).every(([key, expected]) =>
            expected === undefined ||
            fixture.probeStateActual?.[key as keyof typeof fixture.probeStateActual] === expected,
          );
  const modeCorrect = actualMode === fixture.expectedMode;

  return {
    fixtureId: fixture.id,
    expectedMode: fixture.expectedMode,
    actualMode,
    metrics: {
      modeCorrect,
      mustHitRecall,
      mustAvoidPrecision,
      top1Correct,
      topKBounded,
      latencyMs,
      explanationPresent,
      availabilityOk,
      probeStateOk,
    },
    resultIds,
    matchedFieldsById: Object.fromEntries(
      results.map((result) => [result.id, result.matchedFields]),
    ),
    exactMatchedFilters: results[0]?.matchedFilters ?? [],
    failureClasses: listFailureClasses({
      modeCorrect,
      mustHitRecall,
      top1Correct,
      mustAvoidPrecision,
      topKBounded,
      availabilityOk,
      probeStateOk,
      latencyOk,
    }),
  };
}
