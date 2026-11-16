/** Additive schema-2 tables, owned by AlongStore and migrated in its existing transaction. */
export const MEMORY_DDL = `
CREATE TABLE IF NOT EXISTS memory_detail (
  memory_id TEXT PRIMARY KEY REFERENCES memory(id),
  topic TEXT NOT NULL,
  goal_id TEXT,
  category TEXT NOT NULL,
  assertion TEXT NOT NULL,
  source_ids TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  backend_ids TEXT NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_operation (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_ids TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS memory_operation_pending ON memory_operation(user_id, status);
CREATE TABLE IF NOT EXISTS memory_attempt (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES memory_operation(id),
  status TEXT NOT NULL,
  request_id TEXT,
  backend_ids TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS memory_processed (
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  operation_id TEXT NOT NULL REFERENCES memory_operation(id),
  PRIMARY KEY(user_id, message_id)
);
CREATE TABLE IF NOT EXISTS memory_suppression (
  user_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  scope TEXT NOT NULL,
  through_seq INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY(user_id, memory_id)
);
CREATE TABLE IF NOT EXISTS memory_blocked_source (
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  PRIMARY KEY(user_id, message_id)
);
CREATE TABLE IF NOT EXISTS memory_cleanup (
  user_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
`
