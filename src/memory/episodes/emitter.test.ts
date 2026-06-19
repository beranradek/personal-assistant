import { describe, expect, it, vi } from "vitest";
import type { Config, AuditEntry } from "../../core/types.js";
import { DEFAULTS } from "../../core/config.js";
import type { EpisodeStore } from "./store.js";
import { maybeAutoWriteEpisode } from "./emitter.js";

function makeConfig(): Config {
  return {
    ...DEFAULTS,
    security: {
      ...DEFAULTS.security,
      workspace: "/workspace",
      dataDir: "/data",
    },
    memory: {
      ...DEFAULTS.memory,
      episodicMemory: {
        autoWrite: {
          enabled: true,
          dryRun: false,
          sources: ["github", "terminal", "telegram", "slack"],
          requireTaskContext: true,
          maxWindowEntries: 50,
        },
      },
    },
  };
}

function makeEntry(
  overrides: Partial<AuditEntry> = {},
): AuditEntry {
  return {
    timestamp: "2026-06-19T18:00:00.000Z",
    source: "terminal",
    sessionKey: "terminal--default",
    type: "interaction",
    userMessage: "Ship slice 4A",
    assistantResponse: "Slice 4A shipped behind a flag.",
    taskContext: {
      projectName: "personal-assistant",
      jobName: "003-personal-assistant-episodic-memory",
      category: "coding",
    },
    ...overrides,
  };
}

function makeStore(overrides: Partial<EpisodeStore> = {}): EpisodeStore {
  return {
    insertEpisode: vi.fn(),
    getEpisodeById: vi.fn(() => null),
    listEpisodes: vi.fn(() => []),
    close: vi.fn(),
    ...overrides,
  };
}

describe("maybeAutoWriteEpisode", () => {
  it("returns disabled when auto-write is off", async () => {
    const config = makeConfig();
    config.memory.episodicMemory.autoWrite.enabled = false;

    const result = await maybeAutoWriteEpisode(config, makeEntry());

    expect(result).toEqual({
      status: "disabled",
      reason: "episodic auto-write disabled",
    });
  });

  it("skips sources outside the allowlist", async () => {
    const config = makeConfig();

    const result = await maybeAutoWriteEpisode(config, makeEntry({ source: "heartbeat" }));

    expect(result).toEqual({
      status: "skipped",
      reason: "source not enabled for episodic auto-write",
    });
  });

  it("skips when task context is required but missing", async () => {
    const config = makeConfig();

    const result = await maybeAutoWriteEpisode(config, makeEntry({ taskContext: undefined }));

    expect(result).toEqual({
      status: "skipped",
      reason: "taskContext required for episodic auto-write",
    });
  });

  it("supports dry-run without writing to the store", async () => {
    const config = makeConfig();
    config.memory.episodicMemory.autoWrite.dryRun = true;
    const store = makeStore();
    const readAuditEntries = vi.fn(async () => [
      makeEntry({
        timestamp: "2026-06-19T17:50:00.000Z",
        userMessage: "Old turn",
        assistantResponse: "Old response",
      }),
      makeEntry({
        timestamp: "2026-06-19T17:59:00.000Z",
        type: "tool_call",
        toolName: "functions.exec_command",
        toolInput: { cmd: "pnpm test" },
        toolResult: { exitCode: 0 },
        userMessage: undefined,
        assistantResponse: undefined,
      }),
      makeEntry(),
    ]);

    const result = await maybeAutoWriteEpisode(config, makeEntry(), {
      readAuditEntries,
      createEpisodeStore: () => store,
    });

    expect(result.status).toBe("dry_run");
    expect(result.reason).toBe("episode candidate built but dry-run enabled");
    expect(result.episode?.action).toBe("Ship slice 4A");
    expect(result.episode?.toolsUsed).toEqual(["functions.exec_command"]);
    expect(store.getEpisodeById).not.toHaveBeenCalled();
    expect(store.insertEpisode).not.toHaveBeenCalled();
    expect(store.close).not.toHaveBeenCalled();
  });

  it("writes one episode from the bounded current turn window", async () => {
    const config = makeConfig();
    const store = makeStore();
    const readAuditEntries = vi.fn(async () => [
      makeEntry({
        timestamp: "2026-06-19T17:40:00.000Z",
        userMessage: "Previous turn",
        assistantResponse: "Previous response",
      }),
      makeEntry({
        timestamp: "2026-06-19T17:59:00.000Z",
        type: "tool_call",
        toolName: "functions.exec_command",
        toolInput: { cmd: "pnpm test" },
        toolResult: { exitCode: 0 },
        userMessage: undefined,
        assistantResponse: undefined,
      }),
      makeEntry(),
    ]);

    const result = await maybeAutoWriteEpisode(config, makeEntry(), {
      readAuditEntries,
      createEpisodeStore: () => store,
    });

    expect(result.status).toBe("inserted");
    expect(result.reason).toBe("episode inserted");
    expect(store.getEpisodeById).toHaveBeenCalledOnce();
    expect(store.insertEpisode).toHaveBeenCalledOnce();
    const inserted = vi.mocked(store.insertEpisode).mock.calls[0][0];
    expect(inserted.action).toBe("Ship slice 4A");
    expect(inserted.summary).toBe("Slice 4A shipped behind a flag.");
    expect(inserted.toolsUsed).toEqual(["functions.exec_command"]);
  });

  it("skips duplicate episode ids", async () => {
    const config = makeConfig();
    const existingEpisode = { id: "episode-duplicate" } as ReturnType<typeof makeEntry> & { id: string };
    const store = makeStore({
      getEpisodeById: vi.fn(() => existingEpisode as any),
    });
    const readAuditEntries = vi.fn(async () => [makeEntry()]);

    const result = await maybeAutoWriteEpisode(config, makeEntry(), {
      readAuditEntries,
      createEpisodeStore: () => store,
      buildEpisode: () => ({
        id: "episode-duplicate",
        startedAt: "2026-06-19T18:00:00.000Z",
        endedAt: "2026-06-19T18:00:00.000Z",
        source: "terminal",
        sessionKey: "terminal--default",
        sessionId: "terminal--default",
        initiator: "user",
        action: "Ship slice 4A",
        normalizedAction: "ship slice 4a",
        summary: "Slice 4A shipped behind a flag.",
        why: null,
        projectName: "personal-assistant",
        jobName: "003-personal-assistant-episodic-memory",
        issueId: null,
        pullRequestId: null,
        detailedMemoryFile: null,
        category: "coding",
        skillsUsed: [],
        toolsUsed: [],
        tags: ["coding"],
        outcome: "success",
        successScore: 1,
        blockers: [],
        errors: [],
        evidenceIncomplete: [],
        trajectory: [],
        semanticEmbeddingText: "action: Ship slice 4A",
      }),
    });

    expect(result).toEqual({
      status: "duplicate",
      reason: "episode already exists",
      episodeId: "episode-duplicate",
    });
    expect(store.insertEpisode).not.toHaveBeenCalled();
    expect(store.close).toHaveBeenCalledOnce();
  });
});
