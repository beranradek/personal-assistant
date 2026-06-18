export const CREATE_EPISODES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS episodes (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    source TEXT NOT NULL,
    session_key TEXT NOT NULL,
    session_id TEXT,
    initiator TEXT NOT NULL,
    action TEXT NOT NULL,
    normalized_action TEXT NOT NULL,
    summary TEXT NOT NULL,
    why TEXT,
    project_name TEXT,
    job_name TEXT,
    issue_id TEXT,
    pull_request_id TEXT,
    detailed_memory_file TEXT,
    category TEXT,
    skills_used_json TEXT NOT NULL,
    tools_used_json TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    outcome TEXT NOT NULL,
    success_score REAL,
    blockers_json TEXT NOT NULL,
    errors_json TEXT NOT NULL,
    evidence_incomplete_json TEXT NOT NULL,
    trajectory_json TEXT NOT NULL,
    semantic_embedding_text TEXT NOT NULL
  )
`;

export const CREATE_EPISODES_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_episodes_started_at ON episodes(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_episodes_session_key ON episodes(session_key);
  CREATE INDEX IF NOT EXISTS idx_episodes_source ON episodes(source);
  CREATE INDEX IF NOT EXISTS idx_episodes_outcome ON episodes(outcome);
  CREATE INDEX IF NOT EXISTS idx_episodes_project_name ON episodes(project_name);
  CREATE INDEX IF NOT EXISTS idx_episodes_job_name ON episodes(job_name);
  CREATE INDEX IF NOT EXISTS idx_episodes_issue_id ON episodes(issue_id);
  CREATE INDEX IF NOT EXISTS idx_episodes_pull_request_id ON episodes(pull_request_id);
  CREATE INDEX IF NOT EXISTS idx_episodes_detailed_memory_file ON episodes(detailed_memory_file);
  CREATE INDEX IF NOT EXISTS idx_episodes_category ON episodes(category);
`;
