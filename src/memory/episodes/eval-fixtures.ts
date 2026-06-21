import type { EpisodeEvalFixture } from "./eval.js";
import type { EpisodeRecord } from "./types.js";
import { initializeStartupMemoryServices } from "../startup-services.js";
import type { Config } from "../../core/types.js";
import { DEFAULTS } from "../../core/config.js";
import { runDegradedTerminalSessionProbe } from "../../terminal/session.js";
import { runDegradedDaemonStartupProbe } from "../../daemon.js";

const personalAssistantIssueSuccess: EpisodeRecord = {
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
};

const personalAssistantIssueNearMatch: EpisodeRecord = {
  ...personalAssistantIssueSuccess,
  id: "ep-github-21",
  sessionKey: "github--owner/repo#21",
  sessionId: "github--owner/repo#21",
  action: "Fix episodic emitter config defaults",
  normalizedAction: "fix episodic emitter config defaults",
  summary: "Fixed rollout defaults for issue 21 in personal-assistant.",
  why: "Similar GitHub issue",
  issueId: "owner/repo#21",
  tags: ["github", "episodic", "config"],
  semanticEmbeddingText: "fix episodic emitter defaults issue 21",
};

const deployFailure: EpisodeRecord = {
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
};

const deploySuccess: EpisodeRecord = {
  ...deployFailure,
  id: "ep-deploy-success",
  sessionKey: "terminal--deploy-success",
  sessionId: "terminal--deploy-success",
  action: "Deploy app to production",
  normalizedAction: "deploy app to production",
  summary: "Successful deploy after workflow_dispatch.",
  why: "Deploy success",
  tags: ["deploy", "success", "heroku"],
  outcome: "success",
  successScore: 1,
  blockers: [],
  errors: [],
  semanticEmbeddingText: "deploy success workflow dispatch",
};

const heartbeatProgress: EpisodeRecord = {
  id: "ep-heartbeat-progress",
  startedAt: "2026-06-20T08:00:00.000Z",
  endedAt: "2026-06-20T08:04:00.000Z",
  source: "heartbeat",
  sessionKey: "heartbeat--2026-06-20-08",
  sessionId: "heartbeat--2026-06-20-08",
  initiator: "heartbeat",
  action: "Continue active episodic memory implementation",
  normalizedAction: "continue active episodic memory implementation",
  summary: "Added Slice 6 evaluation harness to personal-assistant.",
  why: "Hourly progress heartbeat",
  projectName: "personal-assistant",
  jobName: "003-personal-assistant-episodic-memory",
  issueId: null,
  pullRequestId: null,
  detailedMemoryFile: "memory/personal-assistant-episodic-memory.md",
  category: "heartbeat",
  skillsUsed: ["heartbeat-runbook"],
  toolsUsed: ["functions.exec_command"],
  tags: ["heartbeat", "episodic", "progress"],
  outcome: "success",
  successScore: 0.95,
  blockers: [],
  errors: [],
  evidenceIncomplete: [],
  trajectory: [],
  semanticEmbeddingText: "heartbeat progress added slice 6 episodic evaluation harness",
};

const adminWorkflow: EpisodeRecord = {
  id: "ep-chat-admin",
  startedAt: "2026-06-20T06:30:00.000Z",
  endedAt: "2026-06-20T06:37:00.000Z",
  source: "telegram",
  sessionKey: "telegram--admin-1",
  sessionId: "telegram--admin-1",
  initiator: "user",
  action: "Prepare admin follow-up summary for user",
  normalizedAction: "prepare admin follow up summary for user",
  summary: "Summarized status, reminders, and next actions for the user.",
  why: "Assistant admin workflow",
  projectName: null,
  jobName: null,
  issueId: null,
  pullRequestId: null,
  detailedMemoryFile: null,
  category: "admin",
  skillsUsed: ["response-hygiene-gate"],
  toolsUsed: ["functions.exec_command"],
  tags: ["admin", "telegram", "summary"],
  outcome: "success",
  successScore: 0.9,
  blockers: [],
  errors: [],
  evidenceIncomplete: [],
  trajectory: [],
  semanticEmbeddingText: "admin telegram summary reminders next actions",
};

function createEvalConfig(): Config {
  return {
    ...DEFAULTS,
    security: {
      ...DEFAULTS.security,
      workspace: "/tmp/workspace",
      dataDir: "/tmp/data",
    },
  };
}

const EXPECTED_DEGRADED_PROBE_STATE = {
  fallbackTriggered: true,
  warningTriggered: true,
  episodicSurfaceExposed: false,
} as const;

function createDegradedEntrypointFixture(args: {
  id: string;
  fixtureKind: "terminal_startup_entrypoint" | "daemon_startup_entrypoint";
  probe: {
    actualMode: "raw_audit_fallback";
    actualResults: Array<{
      id: string;
      matchedFields: string[];
      matchedFilters: string[];
      explanation: string;
    }>;
    assistantAvailable: boolean;
    fallbackTriggered: boolean;
    warningTriggered: boolean;
    episodicSurfaceExposed: boolean;
  };
  expectedTop1Id: string;
}): EpisodeEvalFixture {
  return {
    id: args.id,
    fixtureKind: args.fixtureKind,
    insertedEpisodes: [],
    expectedMode: "raw_audit_fallback",
    actualMode: args.probe.actualMode,
    actualResults: args.probe.actualResults,
    mustHitIds: [args.expectedTop1Id],
    mustAvoidIds: [],
    expectedTop1Id: args.expectedTop1Id,
    expectedTopKAtMost: 1,
    availabilityExpected: true,
    availabilityActual: args.probe.assistantAvailable,
    probeStateExpected: EXPECTED_DEGRADED_PROBE_STATE,
    probeStateActual: {
      fallbackTriggered: args.probe.fallbackTriggered,
      warningTriggered: args.probe.warningTriggered,
      episodicSurfaceExposed: args.probe.episodicSurfaceExposed,
    },
    maxLatencyMs: 50,
  };
}

function createEvalStartupDeps() {
  return {
    createEmbeddingProvider: async () => ({
      dimensions: 768,
      embed: async () => [],
      embedBatch: async () => [],
      close: async () => {},
    }),
    createVectorStore: () => ({
      upsertChunk: () => {},
      searchVector: () => [],
      searchKeyword: () => [],
      deleteChunksForFile: () => {},
      getFileHash: () => null,
      setFileHash: () => {},
      getTrackedFilePaths: () => [],
      deleteFileHash: () => {},
      close: () => {},
    }),
    createIndexer: () => ({
      syncFiles: async () => {},
      markDirty: () => {},
      isDirty: () => false,
      syncIfDirty: async () => {},
      abort: () => {},
      close: () => {},
    }),
    createRobustMemorySearch: () => async () => [],
    createRedactor: () => (text: string) => text,
    initializeEpisodeMemoryServer: ({ onWarn }: { onWarn?: (err: unknown) => void }) => {
      onWarn?.(new Error("episodes.db incompatible schema"));
      return {
        episodeStore: undefined,
        memoryServer: { name: "memory" },
        assistantAvailable: true as const,
        fallbackTriggered: true,
        warningTriggered: true,
        episodicSurfaceExposed: false,
      };
    },
  };
}

function createEvalBackendStub() {
  return {
    name: "test",
    async *runTurn() {},
    runTurnSync: async () => ({
      response: "",
      messages: [],
      partial: false,
    }),
    clearSession: () => {},
    close: async () => {},
  };
}

function createProbeBaseDeps(startupDeps: ReturnType<typeof createEvalStartupDeps>) {
  return {
    initializeStartupMemoryServices: (args: { config: Config; onEpisodeWarn?: (err: unknown) => void }) =>
      initializeStartupMemoryServices({
        ...args,
        deps: startupDeps,
      }),
    collectMemoryFiles: () => [],
    createMemoryWatcher: () => ({ close: () => {} }),
    readMemoryFiles: async () => "",
    createCronToolManager: (() => ({
      handleAction: async () => ({ success: true, message: "ok" }),
      rearmTimer: async () => {},
      stop: () => {},
    })) as any,
    createAssistantServer: (() => ({ name: "assistant" } as any)) as any,
    buildAgentOptions: () => ({} as any),
    createBackend: async () => createEvalBackendStub(),
  };
}

function createDaemonProbeDeps(startupDeps: ReturnType<typeof createEvalStartupDeps>) {
  return {
    ...createProbeBaseDeps(startupDeps),
    createMessageQueue: (() => ({
      enqueue: () => ({ accepted: true }),
      processNext: async () => {},
      size: () => 0,
      processLoop: () => {},
      stop: () => {},
    })) as any,
    createRouter: (() => ({
      register: () => {},
      unregister: () => {},
      route: () => undefined,
    })) as any,
  };
}

export async function createDefaultEpisodeEvalFixtures(): Promise<EpisodeEvalFixture[]> {
  const startupDeps = createEvalStartupDeps();
  const degradedStartupProbe = await runDegradedTerminalSessionProbe({
    config: createEvalConfig(),
    deps: createProbeBaseDeps(startupDeps),
  });
  const degradedDaemonProbe = await runDegradedDaemonStartupProbe({
    config: createEvalConfig(),
    deps: createDaemonProbeDeps(startupDeps),
  });
  return [
    {
      id: "github-issue-success",
      query: "duplicate guard",
      filters: {
        projectName: "personal-assistant",
        issueId: "owner/repo#12",
      },
      insertedEpisodes: [personalAssistantIssueSuccess, personalAssistantIssueNearMatch],
      expectedMode: "exact_episodic",
      mustHitIds: ["ep-github-12"],
      mustAvoidIds: ["ep-github-21"],
      expectedTop1Id: "ep-github-12",
      expectedTopKAtMost: 1,
      maxLatencyMs: 50,
    },
    {
      id: "github-issue-failure",
      query: "deploy failure heroku prompt",
      maxResults: 1,
      insertedEpisodes: [deployFailure, deploySuccess],
      expectedMode: "semantic_episodic",
      mustHitIds: ["ep-deploy-failure"],
      mustAvoidIds: ["ep-deploy-success"],
      expectedTop1Id: "ep-deploy-failure",
      expectedTopKAtMost: 1,
      maxLatencyMs: 50,
    },
    {
      id: "heartbeat-project-progress",
      query: "slice 6 evaluation harness",
      filters: {
        projectName: "personal-assistant",
        jobName: "003-personal-assistant-episodic-memory",
      },
      insertedEpisodes: [heartbeatProgress, personalAssistantIssueSuccess],
      expectedMode: "exact_episodic",
      mustHitIds: ["ep-heartbeat-progress"],
      mustAvoidIds: [],
      expectedTop1Id: "ep-heartbeat-progress",
      expectedTopKAtMost: 1,
      maxLatencyMs: 50,
    },
    {
      id: "chat-admin-workflow",
      query: "admin summary reminders next actions",
      maxResults: 1,
      insertedEpisodes: [adminWorkflow, heartbeatProgress],
      expectedMode: "semantic_episodic",
      mustHitIds: ["ep-chat-admin"],
      mustAvoidIds: ["ep-heartbeat-progress"],
      expectedTop1Id: "ep-chat-admin",
      expectedTopKAtMost: 1,
      maxLatencyMs: 50,
    },
    {
      ...createDegradedEntrypointFixture({
        id: "degraded-store-startup",
        fixtureKind: "terminal_startup_entrypoint",
        probe: degradedStartupProbe,
        expectedTop1Id: "startup-log-terminal-fallback",
      }),
    },
    {
      id: "near-match-retrieval",
      query: "fix episodic emitter issue 12",
      filters: {
        projectName: "personal-assistant",
      },
      maxResults: 1,
      insertedEpisodes: [personalAssistantIssueSuccess, personalAssistantIssueNearMatch],
      expectedMode: "semantic_episodic",
      mustHitIds: ["ep-github-12"],
      mustAvoidIds: ["ep-github-21"],
      expectedTop1Id: "ep-github-12",
      expectedTopKAtMost: 1,
      maxLatencyMs: 50,
    },
    {
      ...createDegradedEntrypointFixture({
        id: "degraded-daemon-startup",
        fixtureKind: "daemon_startup_entrypoint",
        probe: degradedDaemonProbe,
        expectedTop1Id: "startup-log-daemon-entrypoint-fallback",
      }),
    },
  ];
}
