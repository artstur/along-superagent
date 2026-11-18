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
 result TEXT, created_at TEXT NOT NULL, reassessment_of TEXT, reassessment_reason TEXT
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

/** Private maintenance review of one existing task. Distinct from clock and observation occurrences. */
export const TASK_TRIGGER_REVIEW_DDL = `
CREATE TABLE IF NOT EXISTS task_trigger_review (
 event_id TEXT PRIMARY KEY REFERENCES health_dispatch(event_id), task_id TEXT NOT NULL REFERENCES user_task(id),
 task_revision INTEGER NOT NULL, input_version INTEGER NOT NULL, evidence_event_id TEXT NOT NULL, device_id TEXT NOT NULL,
 original_scheduled_at TEXT, original_content TEXT NOT NULL, reason TEXT NOT NULL,
 context_read_at TEXT, retired INTEGER NOT NULL DEFAULT 0,
 UNIQUE(task_id,task_revision,input_version,evidence_event_id,device_id)
);
CREATE INDEX IF NOT EXISTS task_trigger_review_task ON task_trigger_review(task_id,event_id);
`
