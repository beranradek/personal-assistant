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
    evidenceIncomplete: [],
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
      evidenceIncomplete: ["missing screenshot"],
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
      issueId: "9001",
      pullRequestId: "77",
      category: "heartbeat",
    }));
    store.insertEpisode(makeEpisode("other", {
      source: "telegram",
      sessionKey: "tg-1",
      outcome: "success",
      issueId: "42",
      pullRequestId: "88",
      category: "chat",
    }));

    expect(store.listEpisodes({ source: "heartbeat" }).map((episode) => episode.id)).toEqual(["match-1"]);
    expect(store.listEpisodes({ outcome: "failure" }).map((episode) => episode.id)).toEqual(["match-1"]);
    expect(store.listEpisodes({ sessionKey: "hb-1" }).map((episode) => episode.id)).toEqual(["match-1"]);
    expect(store.listEpisodes({ issueId: "9001", pullRequestId: "77" }).map((episode) => episode.id)).toEqual(["match-1"]);
    expect(store.listEpisodes({ category: "chat" }).map((episode) => episode.id)).toEqual(["other"]);
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
