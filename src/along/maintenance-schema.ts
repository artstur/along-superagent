/** Schema-3 persistent schedule and one outstanding memory-maintenance batch per user. */
export const MAINTENANCE_DDL = `
CREATE TABLE IF NOT EXISTS maintenance_schedule (
  user_id TEXT PRIMARY KEY REFERENCES user(id),
  next_due_at TEXT NOT NULL,
  last_success_at TEXT
);
CREATE TABLE IF NOT EXISTS maintenance_batch (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id),
  due_at TEXT NOT NULL,
  through_seq INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','stopped')),
  retry_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  saved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_outstanding ON maintenance_batch(user_id) WHERE status='pending';
`
