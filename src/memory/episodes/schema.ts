export const EPISODE_SCHEMA_VERSION = 1;

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
    outcome TEXT NOT NULL,
    success_score REAL,
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

export const CREATE_EPISODE_SKILLS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS episode_skills (
    episode_id TEXT NOT NULL,
    skill TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (episode_id, position),
    FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_episode_skills_skill ON episode_skills(skill);
`;

export const CREATE_EPISODE_TOOLS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS episode_tools (
    episode_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (episode_id, position),
    FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
  );
`;

export const CREATE_EPISODE_TAGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS episode_tags (
    episode_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (episode_id, position),
    FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
  );
`;

export const CREATE_EPISODE_BLOCKERS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS episode_blockers (
    episode_id TEXT NOT NULL,
    blocker TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (episode_id, position),
    FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
  );
`;

export const CREATE_EPISODE_ERRORS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS episode_errors (
    episode_id TEXT NOT NULL,
    error TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (episode_id, position),
    FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
  );
`;

export const CREATE_EPISODE_EVIDENCE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS episode_evidence_incomplete (
    episode_id TEXT NOT NULL,
    evidence TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (episode_id, position),
    FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
  );
`;

export const CREATE_EPISODE_STEPS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS episode_steps (
    episode_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    data_json TEXT,
    PRIMARY KEY (episode_id, position),
    FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_episode_steps_episode_id ON episode_steps(episode_id);
`;
