PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  natural_language_request TEXT NOT NULL,
  deleted_at DATETIME
);

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  html_url TEXT NOT NULL,
  description TEXT,
  stars INTEGER,
  language TEXT,
  topics TEXT,
  updated_at DATETIME,
  etag TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_repos_fullname ON repos(full_name);

CREATE TABLE IF NOT EXISTS search_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  result_group INTEGER NOT NULL,
  search_query TEXT NOT NULL,
  query_hash TEXT,
  judge_model TEXT,
  judge_model_version TEXT,
  search_strategy_version TEXT,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_attempts_session_group ON search_attempts(session_id, result_group);
CREATE INDEX IF NOT EXISTS idx_attempts_session_time ON search_attempts(session_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_query_hash ON search_attempts(query_hash);

CREATE TABLE IF NOT EXISTS judge_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  search_attempt_id INTEGER NOT NULL,
  overall_judge_findings TEXT NOT NULL,
  judge_recommendations TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  FOREIGN KEY(search_attempt_id) REFERENCES search_attempts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_judge_attempt ON judge_reviews(search_attempt_id);

CREATE TABLE IF NOT EXISTS search_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  search_attempt_id INTEGER NOT NULL,
  repo_id TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  readme_content TEXT,
  judge_finding TEXT,
  judge_relevance_score REAL,
  batch_id INTEGER,
  inserted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (session_id, search_attempt_id, repo_id),
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  FOREIGN KEY(search_attempt_id) REFERENCES search_attempts(id) ON DELETE CASCADE,
  FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_results_session_repo ON search_results(session_id, repo_id);
CREATE INDEX IF NOT EXISTS idx_results_score ON search_results(session_id, judge_relevance_score DESC);

CREATE TABLE IF NOT EXISTS scaffolds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scaffold_id TEXT UNIQUE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  session_id TEXT NOT NULL,
  attempt_id INTEGER,
  title TEXT NOT NULL,
  user_prompt TEXT NOT NULL,
  selected_repo_ids TEXT NOT NULL,
  mcp_doc_queries TEXT NOT NULL,
  mcp_doc_evidence TEXT,
  artifact_key TEXT NOT NULL,
  cf_bindings TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_scaffolds_session ON scaffolds(session_id, created_at DESC);
