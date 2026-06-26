import { describe, expect, it } from "vitest";
import { evaluateEpisodeFixture } from "./eval.js";
import { inferEpisodeRetrievalMode, searchEpisodes } from "./retrieval.js";
import type { EpisodeRecord } from "./types.js";

const baseEpisodes: EpisodeRecord[] = [
  {
    id: "ep-github-12",
    startedAt: "2026-06-20T07:00:00.000Z",
    endedAt: "2026-06-20T07:05:00.000Z",
    source: "github",
    sessionKey: "github--owner/repo#12",
    sessionId: "github--owner/repo#12",
    initiator: "user",
    action: "Fix episodic emitter duplicate guard",
    normalizedAction: "fix episodic emitter duplicate guard",
    summary: "Fixed duplicate guard for issue 12 in personal-assistant.",
    why: "GitHub issue follow-up",
    projectName: "personal-assistant",
    jobName: "003-personal-assistant-episodic-memory",
    issueId: "owner/repo#12",
    pullRequestId: null,
    detailedMemoryFile: "memory/personal-assistant-episodic-memory.md",
    category: "coding",
    skillsUsed: ["tdd-workflow"],
    toolsUsed: ["functions.exec_command"],
    tags: ["github", "episodic", "duplicate-guard"],
    outcome: "success",
    successScore: 1,
    blockers: [],
    errors: [],
    evidenceIncomplete: [],
    trajectory: [],
    semanticEmbeddingText: "fix episodic emitter duplicate guard issue 12",
  },
  {
    id: "ep-github-21",
    startedAt: "2026-06-20T06:00:00.000Z",
    endedAt: "2026-06-20T06:05:00.000Z",
    source: "github",
    sessionKey: "github--owner/repo#21",
    sessionId: "github--owner/repo#21",
    initiator: "user",
    action: "Fix episodic emitter config defaults",
    normalizedAction: "fix episodic emitter config defaults",
    summary: "Fixed rollout defaults for issue 21 in personal-assistant.",
    why: "Similar GitHub issue",
    projectName: "personal-assistant",
    jobName: "003-personal-assistant-episodic-memory",
    issueId: "owner/repo#21",
    pullRequestId: null,
    detailedMemoryFile: "memory/personal-assistant-episodic-memory.md",
    category: "coding",
    skillsUsed: ["tdd-workflow"],
    toolsUsed: ["functions.exec_command"],
    tags: ["github", "episodic", "config"],
    outcome: "success",
    successScore: 1,
    blockers: [],
    errors: [],
    evidenceIncomplete: [],
    trajectory: [],
    semanticEmbeddingText: "fix episodic emitter defaults issue 21",
  },
  {
    id: "ep-deploy-failure",
    startedAt: "2026-06-20T05:00:00.000Z",
    endedAt: "2026-06-20T05:08:00.000Z",
    source: "terminal",
    sessionKey: "terminal--deploy-failure",
    sessionId: "terminal--deploy-failure",
    initiator: "user",
    action: "Investigate failed deploy",
    normalizedAction: "investigate failed deploy",
    summary: "Heroku deploy failed on missing app access and interactive prompt.",
    why: "Deploy failure recall",
    projectName: "artbeams",
    jobName: "deploy",
    issueId: null,
    pullRequestId: null,
    detailedMemoryFile: null,
    category: "ops",
    skillsUsed: ["artbeams-heroku-deploy"],
    toolsUsed: ["functions.exec_command"],
    tags: ["deploy", "failure", "heroku"],
    outcome: "failure",
    successScore: 0.1,
    blockers: ["missing app access"],
    errors: ["interactive prompt"],
    evidenceIncomplete: [],
    trajectory: [],
    semanticEmbeddingText: "deploy failure heroku app access interactive prompt",
  },
  {
    id: "ep-deploy-success",
    startedAt: "2026-06-20T04:00:00.000Z",
    endedAt: "2026-06-20T04:06:00.000Z",
    source: "terminal",
    sessionKey: "terminal--deploy-success",
    sessionId: "terminal--deploy-success",
    initiator: "user",
    action: "Deploy app to production",
    normalizedAction: "deploy app to production",
    summary: "Successful deploy after workflow_dispatch.",
    why: "Deploy success",
    projectName: "artbeams",
    jobName: "deploy",
    issueId: null,
    pullRequestId: null,
    detailedMemoryFile: null,
    category: "ops",
    skillsUsed: ["artbeams-heroku-deploy"],
    toolsUsed: ["functions.exec_command"],
    tags: ["deploy", "success", "heroku"],
    outcome: "success",
    successScore: 1,
    blockers: [],
    errors: [],
    evidenceIncomplete: [],
    trajectory: [],
    semanticEmbeddingText: "deploy success workflow dispatch",
  },
];

describe("episodic retrieval helpers", () => {
  it("infers exact retrieval mode when exact filters are present", () => {
    expect(
      inferEpisodeRetrievalMode({
        query: "duplicate guard",
        filters: { issueId: "owner/repo#12" },
      }),
    ).toBe("exact_episodic");
  });

  it("searchEpisodes combines exact filters with deterministic ranking", () => {
    const results = searchEpisodes(baseEpisodes, {
      query: "duplicate guard",
      filters: {
        projectName: "personal-assistant",
        issueId: "owner/repo#12",
      },
      maxResults: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0].episode.id).toBe("ep-github-12");
    expect(results[0].exactMatchedFilters).toEqual(["projectName", "issueId"]);
    expect(results[0].matchedFields).toContain("action");
  });

  it("treats broad scoping filters as semantic rather than exact routing", () => {
    expect(
      inferEpisodeRetrievalMode({
        query: "deploy failure",
        filters: { source: "terminal", outcome: "failure" },
      }),
    ).toBe("semantic_episodic");
  });

  it("keeps date-range-only filters on the semantic routing path", () => {
    expect(
      inferEpisodeRetrievalMode({
        query: "deploy failure",
        filters: {
          startedAtFrom: "2026-06-20T05:00:00.000Z",
          endedAtTo: "2026-06-20T05:08:00.000Z",
        },
      }),
    ).toBe("semantic_episodic");
  });

  it("searchEpisodes applies date-range filters before ranking", () => {
    const results = searchEpisodes(baseEpisodes, {
      query: "deploy",
      filters: {
        startedAtFrom: "2026-06-20T05:00:00.000Z",
        startedAtTo: "2026-06-20T05:59:59.999Z",
        endedAtFrom: "2026-06-20T05:00:00.000Z",
        endedAtTo: "2026-06-20T05:59:59.999Z",
      },
      maxResults: 5,
    });

    expect(results.map((result) => result.episode.id)).toEqual(["ep-deploy-failure"]);
    expect(results[0]?.exactMatchedFilters).toEqual([
      "startedAtFrom",
      "startedAtTo",
      "endedAtFrom",
      "endedAtTo",
    ]);
  });
});

describe("evaluateEpisodeFixture", () => {
  it("scores an exact-identity fixture as a clean pass", () => {
    const result = evaluateEpisodeFixture({
      id: "exact-github-follow-up",
      query: "duplicate guard",
      filters: {
        projectName: "personal-assistant",
        issueId: "owner/repo#12",
      },
      insertedEpisodes: baseEpisodes,
      expectedMode: "exact_episodic",
      mustHitIds: ["ep-github-12"],
      mustAvoidIds: ["ep-github-21"],
      expectedTop1Id: "ep-github-12",
      expectedTopKAtMost: 1,
    });

    expect(result.metrics.modeCorrect).toBe(true);
    expect(result.metrics.mustHitRecall).toBe(true);
    expect(result.metrics.mustAvoidPrecision).toBe(true);
    expect(result.metrics.top1Correct).toBe(true);
    expect(result.metrics.topKBounded).toBe(true);
    expect(result.metrics.explanationPresent).toBe(true);
    expect(result.failureClasses).toEqual([]);
  });

  it("scores a semantic episodic failure-recall fixture and excludes distractors", () => {
    const result = evaluateEpisodeFixture({
      id: "deploy-failure-recall",
      query: "deploy failure heroku prompt",
      maxResults: 1,
      insertedEpisodes: baseEpisodes,
      expectedMode: "semantic_episodic",
      mustHitIds: ["ep-deploy-failure"],
      mustAvoidIds: ["ep-deploy-success"],
      expectedTop1Id: "ep-deploy-failure",
      expectedTopKAtMost: 1,
    });

    expect(result.resultIds).toEqual(["ep-deploy-failure"]);
    expect(result.metrics.modeCorrect).toBe(true);
    expect(result.metrics.mustHitRecall).toBe(true);
    expect(result.metrics.mustAvoidPrecision).toBe(true);
    expect(result.metrics.top1Correct).toBe(true);
    expect(result.metrics.topKBounded).toBe(true);
    expect(result.failureClasses).toEqual([]);
  });

  it("can score a non-episodic route via explicit mode/result overrides", () => {
    const result = evaluateEpisodeFixture({
      id: "markdown-preference-pass",
      query: "dark mode preference",
      insertedEpisodes: [],
      expectedMode: "semantic_markdown",
      mustHitIds: ["memory-user-preference"],
      actualMode: "semantic_markdown",
      actualResults: [
        {
          id: "memory-user-preference",
          matchedFields: [],
          matchedFilters: [],
          explanation: "Matched curated markdown memory note for user preference",
        },
      ],
    });

    expect(result.metrics.modeCorrect).toBe(true);
    expect(result.metrics.mustHitRecall).toBe(true);
    expect(result.metrics.explanationPresent).toBe(true);
    expect(result.failureClasses).toEqual([]);
  });

  it("classifies routing and availability regressions when the wrong tier is chosen", () => {
    const result = evaluateEpisodeFixture({
      id: "markdown-preference-routing-failure",
      query: "dark mode preference",
      insertedEpisodes: [],
      expectedMode: "semantic_markdown",
      actualMode: "semantic_episodic",
      actualResults: [],
      availabilityExpected: true,
      availabilityActual: false,
    });

    expect(result.metrics.modeCorrect).toBe(false);
    expect(result.metrics.availabilityOk).toBe(false);
    expect(result.failureClasses).toEqual(["routing", "availability"]);
  });

  it("classifies ranking and noise regressions when distractors outrank or overflow results", () => {
    const result = evaluateEpisodeFixture({
      id: "noisy-deploy-query",
      query: "deploy",
      insertedEpisodes: baseEpisodes,
      expectedMode: "semantic_episodic",
      mustHitIds: ["ep-deploy-failure"],
      mustAvoidIds: ["ep-deploy-success"],
      expectedTop1Id: "ep-deploy-failure",
      expectedTopKAtMost: 1,
    });

    expect(result.metrics.modeCorrect).toBe(true);
    expect(result.metrics.mustHitRecall).toBe(true);
    expect(result.metrics.mustAvoidPrecision).toBe(false);
    expect(result.metrics.topKBounded).toBe(false);
    expect(result.failureClasses).toEqual(["noise"]);
  });

  it("classifies ranking regression when required hits are missing", () => {
    const result = evaluateEpisodeFixture({
      id: "missing-hit",
      query: "deploy failure",
      insertedEpisodes: baseEpisodes,
      expectedMode: "semantic_episodic",
      mustHitIds: ["does-not-exist"],
    });

    expect(result.metrics.mustHitRecall).toBe(false);
    expect(result.failureClasses).toEqual(["ranking"]);
  });

  it("classifies latency regression when a fixture threshold is exceeded", () => {
    const result = evaluateEpisodeFixture({
      id: "latency-threshold",
      query: "deploy failure",
      insertedEpisodes: baseEpisodes,
      expectedMode: "semantic_episodic",
      maxLatencyMs: Number.MIN_VALUE,
    });

    expect(result.failureClasses).toEqual(["latency"]);
  });
});
