/** Durable per-goal evaluation baselines and immutable host-bound dispatches (stage C). */
export const HEALTH_DDL = `
CREATE TABLE IF NOT EXISTS health_followup (
 goal_id TEXT PRIMARY KEY REFERENCES goal(id), user_id TEXT NOT NULL,
 input_version INTEGER NOT NULL, types TEXT NOT NULL, baseline TEXT NOT NULL,
 reason TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS health_dispatch (
 event_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, goal_id TEXT NOT NULL REFERENCES goal(id),
 input_version INTEGER NOT NULL, snapshot TEXT NOT NULL, read_snapshot TEXT,
 result TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS health_dispatch_goal ON health_dispatch(goal_id,created_at);
`

/** A review is an immutable occurrence. A task's daily mandate is independent of its next time. */
export const TASK_SCHEDULE_DDL = `
CREATE TABLE IF NOT EXISTS task_review (
 event_id TEXT PRIMARY KEY REFERENCES health_dispatch(event_id), task_id TEXT NOT NULL REFERENCES user_task(id),
 revision INTEGER NOT NULL, due_at TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0, renewed_revision INTEGER
);
CREATE INDEX IF NOT EXISTS task_review_occurrence ON task_review(task_id,due_at,revision);
CREATE TABLE IF NOT EXISTS due_notice (
 task_id TEXT NOT NULL REFERENCES user_task(id), due_at REAL NOT NULL, PRIMARY KEY(task_id,due_at)
);
CREATE TABLE IF NOT EXISTS task_once (
 task_id TEXT PRIMARY KEY REFERENCES user_task(id)
);
CREATE TABLE IF NOT EXISTS task_daily (
 task_id TEXT PRIMARY KEY REFERENCES user_task(id), evidence_event_id TEXT NOT NULL, timezone TEXT NOT NULL, wall_time TEXT NOT NULL
);
`
