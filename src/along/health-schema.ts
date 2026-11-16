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
