import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
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

  it("migrates a v1 database to v2 without data loss", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "episode-store-migrate-"));
    const dbPath = path.join(tmpDir, "episodes.db");

    // Build a v1 database manually
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE episodes (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
        source TEXT NOT NULL, session_key TEXT NOT NULL, session_id TEXT,
        initiator TEXT NOT NULL, action TEXT NOT NULL, normalized_action TEXT NOT NULL,
        summary TEXT NOT NULL, why TEXT, project_name TEXT, job_name TEXT,
        issue_id TEXT, pull_request_id TEXT, detailed_memory_file TEXT, category TEXT,
        outcome TEXT NOT NULL, success_score REAL, semantic_embedding_text TEXT NOT NULL
      );
      CREATE TABLE episode_skills (episode_id TEXT NOT NULL, skill TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (episode_id, position), FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE);
      CREATE TABLE episode_tools (episode_id TEXT NOT NULL, tool TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (episode_id, position), FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE);
      CREATE TABLE episode_tags (episode_id TEXT NOT NULL, tag TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (episode_id, position), FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE);
      CREATE TABLE episode_blockers (episode_id TEXT NOT NULL, blocker TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (episode_id, position), FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE);
      CREATE TABLE episode_errors (episode_id TEXT NOT NULL, error TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (episode_id, position), FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE);
      CREATE TABLE episode_evidence_incomplete (episode_id TEXT NOT NULL, evidence TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (episode_id, position), FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE);
      CREATE TABLE episode_steps (episode_id TEXT NOT NULL, position INTEGER NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, data_json TEXT, PRIMARY KEY (episode_id, position), FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE);
    `);
    db.exec(`INSERT INTO episodes (id, started_at, ended_at, source, session_key, initiator, action, normalized_action, summary, outcome, semantic_embedding_text) VALUES ('v1-ep', '2026-06-01T10:00:00.000Z', '2026-06-01T10:05:00.000Z', 'terminal', 'terminal--default', 'user', 'v1 action', 'v1 action', 'v1 summary', 'success', 'v1 action v1 summary')`);
    db.exec(`INSERT INTO episode_evidence_incomplete (episode_id, evidence, position) VALUES ('v1-ep', 'open question from v1', 0)`);
    db.pragma("user_version = 1");
    db.close();

    // Open with current createEpisodeStore — should auto-migrate
    store = createEpisodeStore(dbPath);

    const ep = store.getEpisodeById("v1-ep");
    expect(ep).not.toBeNull();
    expect(ep?.action).toBe("v1 action");
    expect(ep?.openQuestions).toEqual(["open question from v1"]);
    expect(ep?.relatedEpisodeIds).toEqual([]);
    expect(ep?.model).toBeNull();
    expect(ep?.location).toBeNull();

    // Can insert a new v2 episode after migration
    store.insertEpisode(makeEpisode("v2-ep"));
    expect(store.getEpisodeById("v2-ep")?.id).toBe("v2-ep");

    expect(store.listEpisodes().map((e) => e.id)).toContain("v1-ep");
  });
});
