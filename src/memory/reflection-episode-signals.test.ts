import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigSchema, type Config } from "../core/types.js";
import type { EpisodeRecord } from "./episodes/types.js";
import {
  buildEpisodeSignalsSummary,
  buildReflectionWindowBounds,
  loadEpisodeSignalsSummary,
} from "./reflection-episode-signals.js";

function makeConfig(overrides: Partial<Config["reflection"]> = {}): Config {
  return ConfigSchema.parse({
    security: {
      allowedCommands: [],
      commandsNeedingExtraValidation: [],
      workspace: "/tmp/test-workspace",
      dataDir: "/tmp/test-data",
      additionalReadDirs: [],
      additionalWriteDirs: [],
    },
    adapters: {
      telegram: { enabled: false, botToken: "x", allowedUserIds: [] },
      slack: {
        enabled: false,
        botToken: "x",
        appToken: "x",
        allowedUserIds: [],
        socketMode: false,
      },
    },
    heartbeat: {
      enabled: false,
      intervalMinutes: 30,
      activeHours: "8-22",
      deliverTo: "last",
    },
    gateway: { maxQueueSize: 10 },
    agent: { model: null, maxTurns: 5 },
    session: {
      maxHistoryMessages: 50,
      compactionEnabled: false,
      summarizationEnabled: true,
    },
    memory: {
      search: {
        enabled: false,
        hybridWeights: { vector: 0.7, keyword: 0.3 },
        minScore: 0.1,
        maxResults: 10,
        chunkTokens: 200,
        chunkOverlap: 50,
      },
      extraPaths: [],
    },
    mcpServers: {},
    codex: {},
    reflection: {
      enabled: true,
      schedule: "0 7 * * *",
      maxDailyLogEntries: 500,
      episodeSignals: {
        enabled: true,
        maxRecentEpisodes: 5,
        maxTopItems: 2,
      },
      weeklyEnabled: true,
      weeklySchedule: "5 7 * * 1",
      ...overrides,
    },
  });
}

function makeEpisode(id: string, overrides: Partial<EpisodeRecord> = {}): EpisodeRecord {
  return {
    id,
    startedAt: "2026-06-18T10:00:00.000Z",
    endedAt: "2026-06-18T10:05:00.000Z",
    source: "github",
    sessionKey: `github--${id}`,
    sessionId: `github--${id}`,
    initiator: "user",
    action: "Implement reflection signals",
    normalizedAction: "implement reflection signals",
    summary: `Summary for ${id}`,
    why: null,
    projectName: "personal-assistant",
    jobName: "003-personal-assistant-episodic-memory",
    issueId: id,
    pullRequestId: null,
    detailedMemoryFile: null,
    category: "coding",
    skillsUsed: [],
    toolsUsed: ["functions.exec_command"],
    tags: [],
    outcome: "success",
    successScore: 1,
    blockers: [],
    errors: [],
    evidenceIncomplete: [],
    trajectory: [],
    semanticEmbeddingText: `signals ${id}`,
    ...overrides,
  };
}

describe("buildReflectionWindowBounds", () => {
  it("returns an overlap window covering the entire date range", () => {
    expect(buildReflectionWindowBounds("2026-06-15", "2026-06-21")).toEqual({
      startedAtTo: "2026-06-21T23:59:59.999Z",
      endedAtFrom: "2026-06-15T00:00:00.000Z",
    });
  });
});

describe("buildEpisodeSignalsSummary", () => {
  it("builds a compact aggregate summary", () => {
    const summary = buildEpisodeSignalsSummary({
      label: "2026-W25",
      episodes: [
        makeEpisode("1", { outcome: "failure", blockers: ["schema drift"] }),
        makeEpisode("2", { outcome: "success", errors: ["schema drift"] }),
      ],
      maxTopItems: 2,
    });

    expect(summary).toContain("Structured episodic signals for 2026-W25");
    expect(summary).toContain("- episodes: 2");
    expect(summary).toContain("- outcomes: failure (1), success (1)");
    expect(summary).toContain("- sources: github (2)");
    expect(summary).toContain("- categories: coding (2)");
    expect(summary).toContain("- projects: personal-assistant (2)");
    expect(summary).toContain("- jobs: 003-personal-assistant-episodic-memory (2)");
    expect(summary).toContain("- tools: functions.exec_command (2)");
    expect(summary).toContain("- blockers/errors: schema drift (2)");
    expect(summary).toContain("- promotion hints: repeated blocker/error: schema drift (2)");
    expect(summary).toContain("- promotion hints are advisory only; no automatic semantic/procedural promotion is applied");
  });

  it("includes repeated successful workflow hints when the same tool-backed pattern recurs", () => {
    const summary = buildEpisodeSignalsSummary({
      label: "2026-W25",
      episodes: [
        makeEpisode("1", { outcome: "success", toolsUsed: ["functions.exec_command", "functions.exec_command"] }),
        makeEpisode("2", { outcome: "success", toolsUsed: ["functions.exec_command"] }),
        makeEpisode("3", { outcome: "failure", toolsUsed: ["other.tool"], projectName: "other-project", jobName: "other-job" }),
      ],
      maxTopItems: 3,
    });

    expect(summary).toContain("repeated successful workflow: personal-assistant | 003-personal-assistant-episodic-memory | functions.exec_command (2)");
    expect(summary).not.toContain("other-project | other-job");
    expect(summary).toContain("promotion hints are advisory only");
  });

  it("returns empty string when there are no episodes", () => {
    expect(buildEpisodeSignalsSummary({
      label: "empty",
      episodes: [],
      maxTopItems: 2,
    })).toBe("");
  });

  it("surfaces top sources and categories for mixed episode windows", () => {
    const summary = buildEpisodeSignalsSummary({
      label: "mixed-window",
      episodes: [
        makeEpisode("1", { source: "github", category: "coding" }),
        makeEpisode("2", { source: "github", category: "coding" }),
        makeEpisode("3", { source: "heartbeat", category: "admin" }),
      ],
      maxTopItems: 2,
    });

    expect(summary).toContain("- sources: github (2), heartbeat (1)");
    expect(summary).toContain("- categories: coding (2), admin (1)");
  });
});

describe("loadEpisodeSignalsSummary", () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("returns empty string when episode signals are disabled", async () => {
    const createEpisodeStoreMock = vi.fn();
    const summary = await loadEpisodeSignalsSummary({
      config: makeConfig({ episodeSignals: { enabled: false, maxRecentEpisodes: 5, maxTopItems: 2 } }),
      label: "2026-06-18",
      startDate: "2026-06-18",
      endDate: "2026-06-18",
      deps: { createEpisodeStore: createEpisodeStoreMock as any },
    });

    expect(summary).toBe("");
    expect(createEpisodeStoreMock).not.toHaveBeenCalled();
  });

  it("returns empty string when episodes.db is missing", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "reflection-signals-test-"));
    const config = makeConfig();
    config.security.dataDir = tmpDir;
    const createEpisodeStoreMock = vi.fn();

    const summary = await loadEpisodeSignalsSummary({
      config,
      label: "2026-06-18",
      startDate: "2026-06-18",
      endDate: "2026-06-18",
      deps: { createEpisodeStore: createEpisodeStoreMock as any },
    });

    expect(summary).toBe("");
    expect(createEpisodeStoreMock).not.toHaveBeenCalled();
  });

  it("queries the bounded overlap window and closes the store", async () => {
    await fs.mkdir("/tmp/test-data", { recursive: true });
    await fs.writeFile("/tmp/test-data/episodes.db", "");

    const close = vi.fn();
    const listEpisodes = vi.fn(() => [
      makeEpisode("1", { blockers: ["schema drift"], outcome: "failure" }),
      makeEpisode("2", { errors: ["schema drift"] }),
    ]);
    const createEpisodeStoreMock = vi.fn(() => ({
      listEpisodes,
      close,
    }));

    const summary = await loadEpisodeSignalsSummary({
      config: makeConfig({ episodeSignals: { enabled: true, maxRecentEpisodes: 7, maxTopItems: 2 } }),
      label: "2026-W25",
      startDate: "2026-06-15",
      endDate: "2026-06-21",
      deps: { createEpisodeStore: createEpisodeStoreMock as any },
    });

    expect(createEpisodeStoreMock).toHaveBeenCalledWith("/tmp/test-data/episodes.db");
    expect(listEpisodes).toHaveBeenCalledWith({
      startedAtTo: "2026-06-21T23:59:59.999Z",
      endedAtFrom: "2026-06-15T00:00:00.000Z",
      limit: 7,
    });
    expect(close).toHaveBeenCalledOnce();
    expect(summary).toContain("Structured episodic signals for 2026-W25");
    expect(summary).toContain("schema drift (2)");
  });

  it("keeps the computed summary when store close fails after a successful load", async () => {
    await fs.mkdir("/tmp/test-data", { recursive: true });
    await fs.writeFile("/tmp/test-data/episodes.db", "");

    const summary = await loadEpisodeSignalsSummary({
      config: makeConfig({ episodeSignals: { enabled: true, maxRecentEpisodes: 7, maxTopItems: 2 } }),
      label: "2026-W25",
      startDate: "2026-06-15",
      endDate: "2026-06-21",
      deps: {
        createEpisodeStore: (() => ({
          listEpisodes: () => [
            makeEpisode("1", { blockers: ["schema drift"], outcome: "failure" }),
            makeEpisode("2", { errors: ["schema drift"] }),
          ],
          close: () => {
            throw new Error("close failed");
          },
        })) as any,
      },
    });

    expect(summary).toContain("Structured episodic signals for 2026-W25");
    expect(summary).toContain("schema drift (2)");
  });

  it("fails open when the episode store throws", async () => {
    await fs.mkdir("/tmp/test-data", { recursive: true });
    await fs.writeFile("/tmp/test-data/episodes.db", "");

    const summary = await loadEpisodeSignalsSummary({
      config: makeConfig(),
      label: "2026-W25",
      startDate: "2026-06-15",
      endDate: "2026-06-21",
      deps: {
        createEpisodeStore: (() => {
          throw new Error("episodes.db incompatible schema");
        }) as any,
      },
    });

    expect(summary).toBe("");
  });

  it("fails open and still closes the store when listing episodes throws", async () => {
    await fs.mkdir("/tmp/test-data", { recursive: true });
    await fs.writeFile("/tmp/test-data/episodes.db", "");

    const close = vi.fn();
    const summary = await loadEpisodeSignalsSummary({
      config: makeConfig(),
      label: "2026-W25",
      startDate: "2026-06-15",
      endDate: "2026-06-21",
      deps: {
        createEpisodeStore: (() => ({
          listEpisodes: () => {
            throw new Error("episodes.db read failure");
          },
          close,
        })) as any,
      },
    });

    expect(summary).toBe("");
    expect(close).toHaveBeenCalledOnce();
  });

  it("fails open when both listing episodes and close throw", async () => {
    await fs.mkdir("/tmp/test-data", { recursive: true });
    await fs.writeFile("/tmp/test-data/episodes.db", "");

    const close = vi.fn(() => {
      throw new Error("close failed");
    });
    const summary = await loadEpisodeSignalsSummary({
      config: makeConfig(),
      label: "2026-W25",
      startDate: "2026-06-15",
      endDate: "2026-06-21",
      deps: {
        createEpisodeStore: (() => ({
          listEpisodes: () => {
            throw new Error("episodes.db read failure");
          },
          close,
        })) as any,
      },
    });

    expect(summary).toBe("");
    expect(close).toHaveBeenCalledOnce();
  });
});
