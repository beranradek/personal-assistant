import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigSchema, type Config } from "../core/types.js";
import type { EpisodeRecord } from "./episodes/types.js";

const loggerInfo = vi.fn();
const loggerWarn = vi.fn();

vi.mock("../core/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: loggerInfo,
    warn: loggerWarn,
  })),
}));

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
    openQuestions: [],
    relatedEpisodeIds: [],
    trajectory: [],
    semanticEmbeddingText: `signals ${id}`,
    ...overrides,
  };
}

describe("reflection-episode-signals observability", () => {
  let tmpDir: string | undefined;

  beforeEach(() => {
    loggerInfo.mockReset();
    loggerWarn.mockReset();
  });

  afterEach(async () => {
    vi.resetModules();
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("logs an info skip when episode signals are disabled", async () => {
    const { loadEpisodeSignalsSummary } = await import("./reflection-episode-signals.js");

    await loadEpisodeSignalsSummary({
      config: makeConfig({ episodeSignals: { enabled: false, maxRecentEpisodes: 5, maxTopItems: 2 } }),
      label: "disabled-case",
      startDate: "2026-06-18",
      endDate: "2026-06-18",
    });

    expect(loggerInfo).toHaveBeenCalledWith(
      { label: "disabled-case", reason: "disabled" },
      "Skipping episode-derived reflection signals",
    );
  });

  it("logs an info skip when episodes.db is missing", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "reflection-observability-"));
    const config = makeConfig();
    config.security.dataDir = tmpDir;
    const { loadEpisodeSignalsSummary } = await import("./reflection-episode-signals.js");

    await loadEpisodeSignalsSummary({
      config,
      label: "missing-db-case",
      startDate: "2026-06-18",
      endDate: "2026-06-18",
    });

    expect(loggerInfo).toHaveBeenCalledWith(
      { label: "missing-db-case", dbPath: path.join(tmpDir, "episodes.db"), reason: "missing_db" },
      "Skipping episode-derived reflection signals",
    );
  });

  it("logs an info load event with episode count on success", async () => {
    await fs.mkdir("/tmp/test-data", { recursive: true });
    await fs.writeFile("/tmp/test-data/episodes.db", "");
    const { loadEpisodeSignalsSummary } = await import("./reflection-episode-signals.js");

    await loadEpisodeSignalsSummary({
      config: makeConfig({ episodeSignals: { enabled: true, maxRecentEpisodes: 7, maxTopItems: 2 } }),
      label: "loaded-case",
      startDate: "2026-06-15",
      endDate: "2026-06-21",
      deps: {
        createEpisodeStore: (() => ({
          listEpisodes: () => [makeEpisode("1"), makeEpisode("2")],
          close: vi.fn(),
        })) as any,
      },
    });

    expect(loggerInfo).toHaveBeenCalledWith(
      {
        label: "loaded-case",
        dbPath: "/tmp/test-data/episodes.db",
        episodeCount: 2,
        maxRecentEpisodes: 7,
      },
      "Loaded episode-derived reflection signals",
    );
  });

  it("logs a warning with date bounds when episode loading fails after store creation", async () => {
    await fs.mkdir("/tmp/test-data", { recursive: true });
    await fs.writeFile("/tmp/test-data/episodes.db", "");
    const close = vi.fn();
    const { loadEpisodeSignalsSummary } = await import("./reflection-episode-signals.js");

    await loadEpisodeSignalsSummary({
      config: makeConfig(),
      label: "warn-case",
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

    expect(close).toHaveBeenCalledOnce();
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn.mock.calls[0]?.[0]).toMatchObject({
      label: "warn-case",
      startDate: "2026-06-15",
      endDate: "2026-06-21",
    });
    expect(loggerWarn.mock.calls[0]?.[0]?.err).toBeInstanceOf(Error);
    expect(loggerWarn.mock.calls[0]?.[0]?.err?.message).toBe("episodes.db read failure");
    expect(loggerWarn.mock.calls[0]?.[1]).toBe(
      "Failed to load episode-derived reflection signals — continuing",
    );
  });

  it("logs a warning but keeps the success path when store close fails", async () => {
    await fs.mkdir("/tmp/test-data", { recursive: true });
    await fs.writeFile("/tmp/test-data/episodes.db", "");
    const { loadEpisodeSignalsSummary } = await import("./reflection-episode-signals.js");

    const summary = await loadEpisodeSignalsSummary({
      config: makeConfig(),
      label: "close-warn-case",
      startDate: "2026-06-15",
      endDate: "2026-06-21",
      deps: {
        createEpisodeStore: (() => ({
          listEpisodes: () => [makeEpisode("1")],
          close: () => {
            throw new Error("close failed");
          },
        })) as any,
      },
    });

    expect(summary).toContain("Structured episodic signals for close-warn-case");
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn.mock.calls[0]?.[0]).toMatchObject({
      label: "close-warn-case",
      dbPath: "/tmp/test-data/episodes.db",
    });
    expect(loggerWarn.mock.calls[0]?.[0]?.err).toBeInstanceOf(Error);
    expect(loggerWarn.mock.calls[0]?.[0]?.err?.message).toBe("close failed");
    expect(loggerWarn.mock.calls[0]?.[1]).toBe(
      "Failed to close episode-derived reflection store after loading",
    );
  });

  it("preserves the primary read warning when both listing and close fail", async () => {
    await fs.mkdir("/tmp/test-data", { recursive: true });
    await fs.writeFile("/tmp/test-data/episodes.db", "");
    const { loadEpisodeSignalsSummary } = await import("./reflection-episode-signals.js");

    await loadEpisodeSignalsSummary({
      config: makeConfig(),
      label: "double-failure-case",
      startDate: "2026-06-15",
      endDate: "2026-06-21",
      deps: {
        createEpisodeStore: (() => ({
          listEpisodes: () => {
            throw new Error("episodes.db read failure");
          },
          close: () => {
            throw new Error("close failed");
          },
        })) as any,
      },
    });

    expect(loggerWarn).toHaveBeenCalledTimes(2);
    expect(loggerWarn.mock.calls[0]?.[0]).toMatchObject({
      label: "double-failure-case",
      dbPath: "/tmp/test-data/episodes.db",
    });
    expect(loggerWarn.mock.calls[0]?.[0]?.err?.message).toBe("close failed");
    expect(loggerWarn.mock.calls[0]?.[1]).toBe(
      "Failed to close episode-derived reflection store after loading",
    );
    expect(loggerWarn.mock.calls[1]?.[0]).toMatchObject({
      label: "double-failure-case",
      startDate: "2026-06-15",
      endDate: "2026-06-21",
    });
    expect(loggerWarn.mock.calls[1]?.[0]?.err?.message).toBe("episodes.db read failure");
    expect(loggerWarn.mock.calls[1]?.[1]).toBe(
      "Failed to load episode-derived reflection signals — continuing",
    );
  });
});
