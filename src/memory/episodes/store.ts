import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import {
  EpisodeListFiltersSchema,
  EpisodeRecordSchema,
  type EpisodeListFilters,
  type EpisodeRecord,
} from "./types.js";
import {
  CREATE_EPISODES_INDEXES_SQL,
  CREATE_EPISODES_TABLE_SQL,
} from "./schema.js";

export interface EpisodeStore {
  insertEpisode(episode: EpisodeRecord): void;
  getEpisodeById(id: string): EpisodeRecord | null;
  listEpisodes(filters?: EpisodeListFilters): EpisodeRecord[];
  close(): void;
}

type EpisodeRow = {
  id: string;
  started_at: string;
  ended_at: string;
  source: string;
  session_key: string;
  session_id: string | null;
  initiator: string;
  action: string;
  normalized_action: string;
  summary: string;
  why: string | null;
  project_name: string | null;
  job_name: string | null;
  issue_id: string | null;
  pull_request_id: string | null;
  detailed_memory_file: string | null;
  category: string | null;
  skills_used_json: string;
  tools_used_json: string;
  tags_json: string;
  outcome: string;
  success_score: number | null;
  blockers_json: string;
  errors_json: string;
  evidence_incomplete_json: string;
  trajectory_json: string;
  semantic_embedding_text: string;
};

function deserializeJsonArray(value: string): string[] {
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function rowToEpisode(row: EpisodeRow): EpisodeRecord {
  return EpisodeRecordSchema.parse({
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    source: row.source,
    sessionKey: row.session_key,
    sessionId: row.session_id,
    initiator: row.initiator,
    action: row.action,
    normalizedAction: row.normalized_action,
    summary: row.summary,
    why: row.why,
    projectName: row.project_name,
    jobName: row.job_name,
    issueId: row.issue_id,
    pullRequestId: row.pull_request_id,
    detailedMemoryFile: row.detailed_memory_file,
    category: row.category,
    skillsUsed: deserializeJsonArray(row.skills_used_json),
    toolsUsed: deserializeJsonArray(row.tools_used_json),
    tags: deserializeJsonArray(row.tags_json),
    outcome: row.outcome,
    successScore: row.success_score,
    blockers: deserializeJsonArray(row.blockers_json),
    errors: deserializeJsonArray(row.errors_json),
    evidenceIncomplete: deserializeJsonArray(row.evidence_incomplete_json),
    trajectory: JSON.parse(row.trajectory_json),
    semanticEmbeddingText: row.semantic_embedding_text,
  });
}

function episodeToParams(episode: EpisodeRecord) {
  const parsed = EpisodeRecordSchema.parse(episode);
  return {
    id: parsed.id,
    started_at: parsed.startedAt,
    ended_at: parsed.endedAt,
    source: parsed.source,
    session_key: parsed.sessionKey,
    session_id: parsed.sessionId ?? null,
    initiator: parsed.initiator,
    action: parsed.action,
    normalized_action: parsed.normalizedAction,
    summary: parsed.summary,
    why: parsed.why ?? null,
    project_name: parsed.projectName ?? null,
    job_name: parsed.jobName ?? null,
    issue_id: parsed.issueId ?? null,
    pull_request_id: parsed.pullRequestId ?? null,
    detailed_memory_file: parsed.detailedMemoryFile ?? null,
    category: parsed.category ?? null,
    skills_used_json: JSON.stringify(parsed.skillsUsed),
    tools_used_json: JSON.stringify(parsed.toolsUsed),
    tags_json: JSON.stringify(parsed.tags),
    outcome: parsed.outcome,
    success_score: parsed.successScore ?? null,
    blockers_json: JSON.stringify(parsed.blockers),
    errors_json: JSON.stringify(parsed.errors),
    evidence_incomplete_json: JSON.stringify(parsed.evidenceIncomplete),
    trajectory_json: JSON.stringify(parsed.trajectory),
    semantic_embedding_text: parsed.semanticEmbeddingText,
  };
}

export function createEpisodeStore(dbPath: string): EpisodeStore {
  if (dbPath !== ":memory:") {
    mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  }

  const db = new Database(dbPath);

  if (dbPath !== ":memory:") {
    chmodSync(dbPath, 0o600);
  }

  db.pragma("journal_mode = WAL");
  db.exec(CREATE_EPISODES_TABLE_SQL);
  db.exec(CREATE_EPISODES_INDEXES_SQL);

  const insertEpisodeStmt = db.prepare(`
    INSERT INTO episodes (
      id, started_at, ended_at, source, session_key, session_id, initiator,
      action, normalized_action, summary, why, project_name, job_name,
      issue_id, pull_request_id, detailed_memory_file, category,
      skills_used_json, tools_used_json, tags_json, outcome, success_score,
      blockers_json, errors_json, evidence_incomplete_json, trajectory_json,
      semantic_embedding_text
    ) VALUES (
      @id, @started_at, @ended_at, @source, @session_key, @session_id, @initiator,
      @action, @normalized_action, @summary, @why, @project_name, @job_name,
      @issue_id, @pull_request_id, @detailed_memory_file, @category,
      @skills_used_json, @tools_used_json, @tags_json, @outcome, @success_score,
      @blockers_json, @errors_json, @evidence_incomplete_json, @trajectory_json,
      @semantic_embedding_text
    )
  `);

  const getEpisodeByIdStmt = db.prepare(`
    SELECT * FROM episodes WHERE id = ?
  `);

  return {
    insertEpisode(episode) {
      insertEpisodeStmt.run(episodeToParams(episode));
    },

    getEpisodeById(id) {
      const row = getEpisodeByIdStmt.get(id) as EpisodeRow | undefined;
      return row ? rowToEpisode(row) : null;
    },

    listEpisodes(filters = {}) {
      const parsed = EpisodeListFiltersSchema.parse(filters);
      const clauses: string[] = [];
      const values: unknown[] = [];

      const exactFilters: Array<[keyof EpisodeListFilters, string]> = [
        ["sessionKey", "session_key"],
        ["source", "source"],
        ["outcome", "outcome"],
        ["projectName", "project_name"],
        ["jobName", "job_name"],
        ["issueId", "issue_id"],
        ["pullRequestId", "pull_request_id"],
        ["detailedMemoryFile", "detailed_memory_file"],
        ["category", "category"],
      ];

      for (const [filterKey, column] of exactFilters) {
        const value = parsed[filterKey];
        if (value !== undefined) {
          clauses.push(`${column} = ?`);
          values.push(value);
        }
      }

      const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const limitClause = parsed.limit !== undefined ? "LIMIT ?" : "";
      if (parsed.limit !== undefined) {
        values.push(parsed.limit);
      }

      const stmt = db.prepare(`
        SELECT *
        FROM episodes
        ${whereClause}
        ORDER BY started_at DESC, id DESC
        ${limitClause}
      `);

      return (stmt.all(...values) as EpisodeRow[]).map(rowToEpisode);
    },

    close() {
      db.close();
    },
  };
}
