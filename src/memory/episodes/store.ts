import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import {
  EpisodeListFiltersSchema,
  EpisodeStepSchema,
  EpisodeRecordSchema,
  type EpisodeListFilters,
  type EpisodeRecord,
} from "./types.js";
import {
  CREATE_EPISODE_BLOCKERS_TABLE_SQL,
  CREATE_EPISODE_ERRORS_TABLE_SQL,
  CREATE_EPISODE_EVIDENCE_TABLE_SQL,
  CREATE_EPISODE_SKILLS_TABLE_SQL,
  CREATE_EPISODE_STEPS_TABLE_SQL,
  CREATE_EPISODE_TAGS_TABLE_SQL,
  CREATE_EPISODE_TOOLS_TABLE_SQL,
  CREATE_EPISODES_INDEXES_SQL,
  CREATE_EPISODES_TABLE_SQL,
  EPISODE_SCHEMA_VERSION,
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
  outcome: string;
  success_score: number | null;
  semantic_embedding_text: string;
};

type EpisodeStepRow = {
  at: string;
  kind: string;
  label: string;
  data_json: string | null;
};

function migrateSchema(db: Database.Database): void {
  const currentVersion = Number(db.pragma("user_version", { simple: true }) ?? 0);
  if (currentVersion > EPISODE_SCHEMA_VERSION) {
    throw new Error(
      `episodes.db schema version ${currentVersion} is newer than supported ${EPISODE_SCHEMA_VERSION}`,
    );
  }
  if (currentVersion === EPISODE_SCHEMA_VERSION) return;

  db.transaction(() => {
    db.exec(CREATE_EPISODES_TABLE_SQL);
    db.exec(CREATE_EPISODES_INDEXES_SQL);
    db.exec(CREATE_EPISODE_SKILLS_TABLE_SQL);
    db.exec(CREATE_EPISODE_TOOLS_TABLE_SQL);
    db.exec(CREATE_EPISODE_TAGS_TABLE_SQL);
    db.exec(CREATE_EPISODE_BLOCKERS_TABLE_SQL);
    db.exec(CREATE_EPISODE_ERRORS_TABLE_SQL);
    db.exec(CREATE_EPISODE_EVIDENCE_TABLE_SQL);
    db.exec(CREATE_EPISODE_STEPS_TABLE_SQL);
    db.pragma(`user_version = ${EPISODE_SCHEMA_VERSION}`);
  })();
}

function loadStringValues(
  stmt: Database.Statement<[string], { value: string }>,
  episodeId: string,
): string[] {
  return stmt.all(episodeId).map((row) => row.value);
}

function loadSteps(
  stmt: Database.Statement<[string], EpisodeStepRow>,
  episodeId: string,
) {
  return stmt.all(episodeId).map((row) => EpisodeStepSchema.parse({
    at: row.at,
    kind: row.kind,
    label: row.label,
    data: row.data_json ? JSON.parse(row.data_json) : undefined,
  }));
}

function rowToEpisode(
  row: EpisodeRow,
  loaders: {
    skills: Database.Statement<[string], { value: string }>;
    tools: Database.Statement<[string], { value: string }>;
    tags: Database.Statement<[string], { value: string }>;
    blockers: Database.Statement<[string], { value: string }>;
    errors: Database.Statement<[string], { value: string }>;
    evidence: Database.Statement<[string], { value: string }>;
    steps: Database.Statement<[string], EpisodeStepRow>;
  },
): EpisodeRecord {
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
    skillsUsed: loadStringValues(loaders.skills, row.id),
    toolsUsed: loadStringValues(loaders.tools, row.id),
    tags: loadStringValues(loaders.tags, row.id),
    outcome: row.outcome,
    successScore: row.success_score,
    blockers: loadStringValues(loaders.blockers, row.id),
    errors: loadStringValues(loaders.errors, row.id),
    evidenceIncomplete: loadStringValues(loaders.evidence, row.id),
    trajectory: loadSteps(loaders.steps, row.id),
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
    outcome: parsed.outcome,
    success_score: parsed.successScore ?? null,
    semantic_embedding_text: parsed.semanticEmbeddingText,
  };
}

function insertOrderedStringValues(
  stmt: Database.Statement,
  episodeId: string,
  values: string[],
): void {
  for (const [position, value] of values.entries()) {
    stmt.run(episodeId, value, position);
  }
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
  db.pragma("foreign_keys = ON");
  migrateSchema(db);

  const insertEpisodeStmt = db.prepare(`
    INSERT INTO episodes (
      id, started_at, ended_at, source, session_key, session_id, initiator,
      action, normalized_action, summary, why, project_name, job_name,
      issue_id, pull_request_id, detailed_memory_file, category,
      outcome, success_score, semantic_embedding_text
    ) VALUES (
      @id, @started_at, @ended_at, @source, @session_key, @session_id, @initiator,
      @action, @normalized_action, @summary, @why, @project_name, @job_name,
      @issue_id, @pull_request_id, @detailed_memory_file, @category,
      @outcome, @success_score, @semantic_embedding_text
    )
  `);
  const insertSkillStmt = db.prepare(`
    INSERT INTO episode_skills (episode_id, skill, position) VALUES (?, ?, ?)
  `);
  const insertToolStmt = db.prepare(`
    INSERT INTO episode_tools (episode_id, tool, position) VALUES (?, ?, ?)
  `);
  const insertTagStmt = db.prepare(`
    INSERT INTO episode_tags (episode_id, tag, position) VALUES (?, ?, ?)
  `);
  const insertBlockerStmt = db.prepare(`
    INSERT INTO episode_blockers (episode_id, blocker, position) VALUES (?, ?, ?)
  `);
  const insertErrorStmt = db.prepare(`
    INSERT INTO episode_errors (episode_id, error, position) VALUES (?, ?, ?)
  `);
  const insertEvidenceStmt = db.prepare(`
    INSERT INTO episode_evidence_incomplete (episode_id, evidence, position) VALUES (?, ?, ?)
  `);
  const insertStepStmt = db.prepare(`
    INSERT INTO episode_steps (episode_id, position, at, kind, label, data_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const getEpisodeByIdStmt = db.prepare(`
    SELECT * FROM episodes WHERE id = ?
  `);
  const loadSkillsStmt = db.prepare<[string], { value: string }>(`
    SELECT skill AS value FROM episode_skills WHERE episode_id = ? ORDER BY position ASC
  `);
  const loadToolsStmt = db.prepare<[string], { value: string }>(`
    SELECT tool AS value FROM episode_tools WHERE episode_id = ? ORDER BY position ASC
  `);
  const loadTagsStmt = db.prepare<[string], { value: string }>(`
    SELECT tag AS value FROM episode_tags WHERE episode_id = ? ORDER BY position ASC
  `);
  const loadBlockersStmt = db.prepare<[string], { value: string }>(`
    SELECT blocker AS value FROM episode_blockers WHERE episode_id = ? ORDER BY position ASC
  `);
  const loadErrorsStmt = db.prepare<[string], { value: string }>(`
    SELECT error AS value FROM episode_errors WHERE episode_id = ? ORDER BY position ASC
  `);
  const loadEvidenceStmt = db.prepare<[string], { value: string }>(`
    SELECT evidence AS value FROM episode_evidence_incomplete WHERE episode_id = ? ORDER BY position ASC
  `);
  const loadStepsStmt = db.prepare<[string], EpisodeStepRow>(`
    SELECT at, kind, label, data_json
    FROM episode_steps
    WHERE episode_id = ?
    ORDER BY position ASC
  `);

  const insertEpisodeTx = db.transaction((episode: EpisodeRecord) => {
    const parsed = EpisodeRecordSchema.parse(episode);
    insertEpisodeStmt.run(episodeToParams(parsed));
    insertOrderedStringValues(insertSkillStmt, parsed.id, parsed.skillsUsed);
    insertOrderedStringValues(insertToolStmt, parsed.id, parsed.toolsUsed);
    insertOrderedStringValues(insertTagStmt, parsed.id, parsed.tags);
    insertOrderedStringValues(insertBlockerStmt, parsed.id, parsed.blockers);
    insertOrderedStringValues(insertErrorStmt, parsed.id, parsed.errors);
    insertOrderedStringValues(insertEvidenceStmt, parsed.id, parsed.evidenceIncomplete);
    for (const [position, step] of parsed.trajectory.entries()) {
      insertStepStmt.run(
        parsed.id,
        position,
        step.at,
        step.kind,
        step.label,
        step.data === undefined ? null : JSON.stringify(step.data),
      );
    }
  });

  const rowLoaders = {
    skills: loadSkillsStmt,
    tools: loadToolsStmt,
    tags: loadTagsStmt,
    blockers: loadBlockersStmt,
    errors: loadErrorsStmt,
    evidence: loadEvidenceStmt,
    steps: loadStepsStmt,
  };

  return {
    insertEpisode(episode) {
      insertEpisodeTx(episode);
    },

    getEpisodeById(id) {
      const row = getEpisodeByIdStmt.get(id) as EpisodeRow | undefined;
      return row ? rowToEpisode(row, rowLoaders) : null;
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
      if (parsed.startedAtFrom !== undefined) {
        clauses.push("started_at >= ?");
        values.push(parsed.startedAtFrom);
      }
      if (parsed.startedAtTo !== undefined) {
        clauses.push("started_at <= ?");
        values.push(parsed.startedAtTo);
      }
      if (parsed.endedAtFrom !== undefined) {
        clauses.push("ended_at >= ?");
        values.push(parsed.endedAtFrom);
      }
      if (parsed.endedAtTo !== undefined) {
        clauses.push("ended_at <= ?");
        values.push(parsed.endedAtTo);
      }
      if (parsed.skillUsed !== undefined) {
        clauses.push(
          "EXISTS (SELECT 1 FROM episode_skills s WHERE s.episode_id = episodes.id AND s.skill = ?)",
        );
        values.push(parsed.skillUsed);
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

      return (stmt.all(...values) as EpisodeRow[]).map((row) => rowToEpisode(row, rowLoaders));
    },

    close() {
      db.close();
    },
  };
}
