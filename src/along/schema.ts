/**
 * DDL of the Along business database (`along.sqlite`), copied from the Stage A design §3.
 * Single database, single writer (the process holds the directory lock); snake_case names; all times are
 * ISO-8601 UTC strings; JSON columns are stored as `TEXT` and parsed by the service layer's consumers.
 * ★ idempotency keys from the design are realized as the primary keys and unique indexes below.
 */

/** Current schema version of `along.sqlite`; raised with every future migration step. */
export const ALONG_SCHEMA_VERSION = 10
/** The oldest schema version this build can open and migrate directly; older databases need a backup restore. */
export const ALONG_OLDEST_SCHEMA = 1

/**
 * The full baseline schema (version 1). Every statement is idempotent (`IF NOT EXISTS`) so opening an
 * existing database re-runs it safely inside the single migration transaction.
 */
export const ALONG_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  device_id  TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS goal (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES user(id),
  domain           TEXT NOT NULL,
  status           TEXT NOT NULL,
  current_revision INTEGER NOT NULL DEFAULT 0,
  origin_event_id  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS goal_user_status ON goal(user_id, status, updated_at DESC);
CREATE TABLE IF NOT EXISTS goal_revision (
  goal_id     TEXT NOT NULL REFERENCES goal(id),
  revision    INTEGER NOT NULL,
  user_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  metric      TEXT,
  context     TEXT,
  status      TEXT NOT NULL,
  basis_changeset TEXT,
  origin_event_id TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (goal_id, revision)
);
CREATE TABLE IF NOT EXISTS user_task (
  id               TEXT PRIMARY KEY,
  goal_id          TEXT NOT NULL REFERENCES goal(id),
  user_id          TEXT NOT NULL,
  status           TEXT NOT NULL,
  content          TEXT NOT NULL,
  scheduled_at     TEXT,
  completed_feedback_event_id TEXT,
  current_revision INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_goal ON user_task(goal_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS task_user_open ON user_task(user_id, scheduled_at) WHERE status = 'open';
CREATE TABLE IF NOT EXISTS task_revision (
  task_id     TEXT NOT NULL REFERENCES user_task(id),
  revision    INTEGER NOT NULL,
  user_id     TEXT NOT NULL,
  goal_id     TEXT NOT NULL,
  content     TEXT NOT NULL,
  status      TEXT NOT NULL,
  scheduled_at TEXT,
  basis_changeset TEXT,
  origin_event_id TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (task_id, revision)
);
CREATE TABLE IF NOT EXISTS message (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  role         TEXT NOT NULL,
  direction    TEXT NOT NULL,
  text         TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  occurred_at  TEXT,
  received_at  TEXT NOT NULL,
  timezone     TEXT,
  message_id   TEXT,
  causation_id TEXT,
  reply_to_message_id TEXT,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS message_user_seq ON message(user_id, seq);
CREATE INDEX IF NOT EXISTS message_user_client ON message(user_id, message_id) WHERE message_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS message_goal_link (
  message_id TEXT NOT NULL REFERENCES message(id),
  goal_id    TEXT NOT NULL REFERENCES goal(id),
  user_id    TEXT NOT NULL,
  relation   TEXT NOT NULL,
  PRIMARY KEY (message_id, goal_id)
);
CREATE INDEX IF NOT EXISTS mgl_goal ON message_goal_link(goal_id, message_id);
CREATE TABLE IF NOT EXISTS changeset (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  goal_id        TEXT,
  status         TEXT NOT NULL,
  base_revision  INTEGER NOT NULL,
  input_version  INTEGER NOT NULL,
  applied_revision INTEGER,
  idempotency_key TEXT NOT NULL,
  trigger_event_id TEXT,
  work_id TEXT, ticket_id TEXT, assignment_id TEXT,
  reason         TEXT NOT NULL,
  ops            TEXT NOT NULL,
  derived_from_changeset TEXT,
  created_at     TEXT NOT NULL,
  result         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS changeset_idem ON changeset(user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS changeset_goal ON changeset(goal_id, created_at);
CREATE TABLE IF NOT EXISTS health_summary (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  type               TEXT NOT NULL,
  metric_version     TEXT NOT NULL,
  window_start       TEXT, window_end TEXT,
  timezone           TEXT,
  unit               TEXT, statistic TEXT,
  value              TEXT,
  availability       TEXT NOT NULL,
  summarizer_version TEXT NOT NULL,
  adapter            TEXT NOT NULL,
  event_id           TEXT NOT NULL,
  received_at        TEXT NOT NULL,
  superseded         INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS health_event_type ON health_summary(user_id, event_id, type);
CREATE INDEX IF NOT EXISTS health_current ON health_summary(user_id, type, superseded, received_at DESC);
CREATE TABLE IF NOT EXISTS memory (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  status           TEXT NOT NULL,
  scope            TEXT,
  evidence_message_id TEXT,
  expires_at       TEXT,
  current_revision INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_user_status ON memory(user_id, status);
CREATE TABLE IF NOT EXISTS memory_revision (
  memory_id  TEXT NOT NULL REFERENCES memory(id),
  revision   INTEGER NOT NULL,
  content    TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, revision)
);
CREATE TABLE IF NOT EXISTS event_inbox (
  user_id        TEXT NOT NULL,
  event_id       TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  kind           TEXT,
  device_id      TEXT NOT NULL,
  goal_id        TEXT, task_id TEXT,
  occurred_at    TEXT, received_at TEXT NOT NULL, timezone TEXT,
  message_id     TEXT, causation_id TEXT, base_revision INTEGER,
  payload        TEXT NOT NULL,
  payload_hash   TEXT NOT NULL,
  status         TEXT NOT NULL,
  reject_reason  TEXT,
  trigger_id     TEXT,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX IF NOT EXISTS inbox_type_time ON event_inbox(user_id, event_type, received_at DESC);
CREATE TABLE IF NOT EXISTS delivery (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  trigger_id  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_attempt_at TEXT,
  last_error  TEXT,
  delivered_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_trigger ON delivery(trigger_id);
CREATE INDEX IF NOT EXISTS delivery_due ON delivery(status, next_attempt_at, seq);
CREATE TABLE IF NOT EXISTS work_link (
  ticket_id     TEXT PRIMARY KEY,
  assignment_id TEXT,
  work_id       TEXT NOT NULL,
  goal_id       TEXT,
  task_id       TEXT,
  event_id      TEXT,
  trigger_id    TEXT,
  thread_key    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  ended_at      TEXT,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS worklink_work ON work_link(work_id);
CREATE UNIQUE INDEX IF NOT EXISTS worklink_thread ON work_link(thread_key);
CREATE INDEX IF NOT EXISTS worklink_goal ON work_link(goal_id) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS run_record (
  id            TEXT PRIMARY KEY,
  ticket_id     TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  user_id       TEXT, work_id TEXT, goal_id TEXT, task_id TEXT,
  trigger_event_id TEXT,
  prompt_revisions TEXT,
  tool_trace_ref TEXT,
  report_state  TEXT, report_summary TEXT,
  changeset_id  TEXT,
  ended_at      TEXT,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS run_record_assignment ON run_record(ticket_id, assignment_id);
CREATE TABLE IF NOT EXISTS input_version (
  goal_id    TEXT PRIMARY KEY REFERENCES goal(id),
  user_id    TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  raised_by  TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_outbox (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  goal_id TEXT, task_id TEXT, message_id TEXT, changeset_id TEXT,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS sync_pending ON sync_outbox(user_id, seq) WHERE delivered_at IS NULL;
`
