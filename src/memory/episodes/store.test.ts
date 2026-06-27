import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEpisodeStore, type EpisodeStore } from "./store.js";
import type { EpisodeRecord } from "./types.js";

function makeEpisode(id: string, overrides: Partial<EpisodeRecord> = {}): EpisodeRecord {
  return {
    id,
    startedAt: "2026-06-18T10:00:00.000Z",
    endedAt: "2026-06-18T10:05:00.000Z",
    source: "terminal",
    sessionKey: "session-1",
    sessionId: "session-1",
    initiator: "user",
    action: "Implement episodic store",
    normalizedAction: "implement episodic store",
    summary: `Summary for ${id}`,
    why: "Needed for episodic memory foundation",
    projectName: "personal-assistant",
    jobName: "003-personal-assistant-episodic-memory",
    issueId: "123",
    pullRequestId: "456",
    detailedMemoryFile: "memory/personal-assistant-episodic-memory.md",
    category: "coding",
    skillsUsed: ["tdd-workflow"],
    toolsUsed: ["functions.exec_command"],
    tags: ["episodic-memory", "sqlite"],
    outcome: "success",
    successScore: 0.9,
    blockers: [],
    errors: [],
    openQuestions: [],
    relatedEpisodeIds: [],
    model: null,
    inputTokens: null,
    outputTokens: null,
    location: null,
    trajectory: [
      {
        at: "2026-06-18T10:01:00.000Z",
        kind: "action",
        label: "Created store test",
      },
    ],
    semanticEmbeddingText: "implemented episodic store foundation",
    ...overrides,
  };
}

describe("EpisodeStore", () => {
  let store: EpisodeStore | undefined;
  let tmpDir: string | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("creates a SQLite database at the requested path", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "episode-store-"));
    const dbPath = path.join(tmpDir, "episodes.db");

    store = createEpisodeStore(dbPath);

    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it("works with :memory: databases", () => {
    store = createEpisodeStore(":memory:");
    store.insertEpisode(makeEpisode("ep-1"));

    expect(store.getEpisodeById("ep-1")?.id).toBe("ep-1");
  });

  it("round-trips a full episode record", () => {
    store = createEpisodeStore(":memory:");
    const episode = makeEpisode("ep-roundtrip", {
      blockers: ["needs follow-up"],
      errors: ["temporary timeout"],
      openQuestions: ["missing screenshot"],
      relatedEpisodeIds: [],
      trajectory: [
        { at: "2026-06-18T10:01:00.000Z", kind: "state", label: "started" },
        {
          at: "2026-06-18T10:02:00.000Z",
          kind: "tool_call",
          label: "rg",
          data: { pattern: "episode" },
        },
      ],
    });

    store.insertEpisode(episode);

    expect(store.getEpisodeById("ep-roundtrip")).toEqual(episode);
  });

  it("reopens a file-backed database and preserves normalized child rows", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "episode-store-reopen-"));
    const dbPath = path.join(tmpDir, "episodes.db");
    const episode = makeEpisode("ep-file", {
      source: "github",
      skillsUsed: ["tdd-workflow", "systematic-debugging"],
      tags: ["github", "episodic-memory"],
      blockers: ["await review"],
      errors: ["none yet"],
      openQuestions: ["need screenshot"],
      relatedEpisodeIds: [],
      trajectory: [
        { at: "2026-06-18T10:01:00.000Z", kind: "decision", label: "picked slice 2" },
      ],
    });

    store = createEpisodeStore(dbPath);
    store.insertEpisode(episode);
    store.close();

    store = createEpisodeStore(dbPath);

    expect(store.getEpisodeById("ep-file")).toEqual(episode);
  });

  it("lists episodes ordered by startedAt descending", () => {
    store = createEpisodeStore(":memory:");
    store.insertEpisode(makeEpisode("older", { startedAt: "2026-06-18T09:00:00.000Z" }));
    store.insertEpisode(makeEpisode("newer", { startedAt: "2026-06-18T11:00:00.000Z" }));

    const results = store.listEpisodes();

    expect(results.map((episode) => episode.id)).toEqual(["newer", "older"]);
  });

  it("supports exact filtering on source, outcome, sessionKey, and identity fields", () => {
    store = createEpisodeStore(":memory:");
    store.insertEpisode(makeEpisode("match-1", {
      source: "heartbeat",
      sessionKey: "hb-1",
      outcome: "failure",
      projectName: "personal-assistant",
      jobName: "job-alpha",
      issueId: "9001",
      pullRequestId: "77",
      detailedMemoryFile: "memory/a.md",
      category: "heartbeat",
      skillsUsed: ["heartbeat-runbook"],
    }));
    store.insertEpisode(makeEpisode("other", {
      source: "telegram",
      sessionKey: "tg-1",
      outcome: "success",
      projectName: "other-project",
      jobName: "job-beta",
      issueId: "42",
      pullRequestId: "88",
      detailedMemoryFile: "memory/b.md",
      category: "chat",
      skillsUsed: ["integrations"],
    }));

    expect(store.listEpisodes({ source: "heartbeat" }).map((episode) => episode.id)).toEqual(["match-1"]);
    expect(store.listEpisodes({ outcome: "failure" }).map((episode) => episode.id)).toEqual(["match-1"]);
    expect(store.listEpisodes({ sessionKey: "hb-1" }).map((episode) => episode.id)).toEqual(["match-1"]);
    expect(store.listEpisodes({ projectName: "personal-assistant" }).map((episode) => episode.id)).toEqual(["match-1"]);
    expect(store.listEpisodes({ jobName: "job-alpha" }).map((episode) => episode.id)).toEqual(["match-1"]);
    expect(store.listEpisodes({ issueId: "9001", pullRequestId: "77" }).map((episode) => episode.id)).toEqual(["match-1"]);
    expect(store.listEpisodes({ detailedMemoryFile: "memory/b.md" }).map((episode) => episode.id)).toEqual(["other"]);
    expect(store.listEpisodes({ category: "chat" }).map((episode) => episode.id)).toEqual(["other"]);
    expect(store.listEpisodes({ skillUsed: "heartbeat-runbook" }).map((episode) => episode.id)).toEqual(["match-1"]);
  });

  it("supports date-range filtering for startedAt and endedAt", () => {
    store = createEpisodeStore(":memory:");
    store.insertEpisode(makeEpisode("overnight", {
      startedAt: "2026-06-17T23:55:00.000Z",
      endedAt: "2026-06-18T00:05:00.000Z",
    }));
    store.insertEpisode(makeEpisode("same-day", {
      startedAt: "2026-06-18T12:00:00.000Z",
      endedAt: "2026-06-18T12:10:00.000Z",
    }));
    store.insertEpisode(makeEpisode("future", {
      startedAt: "2026-06-19T09:00:00.000Z",
      endedAt: "2026-06-19T09:05:00.000Z",
    }));

    const results = store.listEpisodes({
      startedAtTo: "2026-06-18T23:59:59.999Z",
      endedAtFrom: "2026-06-18T00:00:00.000Z",
    });

    expect(results.map((episode) => episode.id)).toEqual(["same-day", "overnight"]);
  });

  it("applies the limit parameter after sorting", () => {
    store = createEpisodeStore(":memory:");
    store.insertEpisode(makeEpisode("ep-1", { startedAt: "2026-06-18T09:00:00.000Z" }));
    store.insertEpisode(makeEpisode("ep-2", { startedAt: "2026-06-18T10:00:00.000Z" }));
    store.insertEpisode(makeEpisode("ep-3", { startedAt: "2026-06-18T11:00:00.000Z" }));

    const results = store.listEpisodes({ limit: 2 });

    expect(results.map((episode) => episode.id)).toEqual(["ep-3", "ep-2"]);
  });
});
