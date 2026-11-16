/**
 * Schema version check and single-transaction migration for `along.sqlite`.
 * A database newer than this build is refused; a database older than `ALONG_OLDEST_SCHEMA` is refused with a
 * backup-restore hint; anything in between migrates inside one transaction so a failure leaves the file unchanged.
 */
import type { DatabaseSync } from 'node:sqlite'
import { ALONG_DDL, ALONG_OLDEST_SCHEMA, ALONG_SCHEMA_VERSION } from './schema.ts'
import { RESEARCH_DDL } from './research-store.ts'
import { MEMORY_DDL } from './memory/schema.ts'
import { HEALTH_DDL, TASK_SCHEDULE_DDL } from './health-schema.ts'
import { MAINTENANCE_DDL } from './maintenance-schema.ts'

/** Raised when `along.sqlite` cannot be opened or migrated; the caller must abort startup. */
export class AlongSchemaError extends Error {}

/** Reads the stored schema version, or `undefined` for a fresh database without a `meta` table. */
export function alongSchemaVersion(db: DatabaseSync): number | undefined {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()
  if (table === undefined) return undefined
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
  if (row === undefined) return undefined
  const version = Number(row.value)
  return Number.isFinite(version) ? version : undefined
}

/**
 * Migration steps keyed by the version they upgrade **to**; the baseline DDL always runs first.
 * Phase A starts at version 1 with no steps; future versions add one entry each.
 */
const MIGRATIONS: Record<number, (db: DatabaseSync) => void> = {
  8: db => {
    const columns = new Set(db.prepare('PRAGMA table_info(message)').all().map(row => row.name))
    if (!columns.has('audience')) db.exec("ALTER TABLE message ADD COLUMN audience TEXT NOT NULL DEFAULT 'conversation' CHECK(audience IN ('conversation','background'))")
    db.exec(`CREATE TABLE IF NOT EXISTS message_audience_audit (
      message_id TEXT PRIMARY KEY REFERENCES message(id), user_id TEXT NOT NULL,
      source_event_id TEXT NOT NULL, evidence_ref TEXT NOT NULL, previous_audience TEXT NOT NULL, created_at TEXT NOT NULL
    );
    UPDATE message SET audience='background' WHERE id IN (
      SELECT message_id FROM sync_outbox WHERE kind='message' AND json_valid(payload) AND json_extract(payload,'$.presentation')='execution'
    ) OR EXISTS (SELECT 1 FROM health_dispatch d WHERE d.user_id=message.user_id
      AND message.event_id='followup_'||d.event_id AND (d.result IS NULL OR json_extract(d.result,'$.outcome')<>'ask'))
      OR EXISTS (SELECT 1 FROM event_inbox e WHERE e.user_id=message.user_id AND e.event_id=message.event_id
        AND e.status='accepted' AND e.event_type='along.message');`)
  },
  7: db => { db.exec(RESEARCH_DDL) },
  2: db => { db.exec(MEMORY_DDL) }, 3: db => { db.exec(MAINTENANCE_DDL) }, 4: db => { db.exec(HEALTH_DDL) },
  5: db => { db.exec(TASK_SCHEDULE_DDL) },
  6: db => {
    db.exec('CREATE TABLE IF NOT EXISTS task_reminder_plan (task_id TEXT PRIMARY KEY REFERENCES user_task(id), plan TEXT NOT NULL)')
    const existing = new Set(db.prepare('PRAGMA table_info(task_daily)').all().map(row => row.name))
    for (const [column,type] of [['weekday','INTEGER'],['evidence_quote','TEXT'],['task_action','TEXT']] as const) {
      if (!existing.has(column)) db.exec(`ALTER TABLE task_daily ADD COLUMN ${column} ${type}`)
    }
  },
}

/**
 * Verifies the schema version and brings the database to `ALONG_SCHEMA_VERSION` inside one transaction.
 * @throws `AlongSchemaError` when the version is unsupported, or when a migration fails (the transaction is
 * rolled back, so the database file is unchanged); the caller closes the handle.
 */
export function migrateAlongSchema(db: DatabaseSync): void {
  const version = alongSchemaVersion(db)
  if (version !== undefined && version > ALONG_SCHEMA_VERSION) {
    throw new AlongSchemaError(`Unsupported along.sqlite schema version ${version}: this build supports up to ${ALONG_SCHEMA_VERSION}`)
  }
  if (version !== undefined && version < ALONG_OLDEST_SCHEMA) {
    throw new AlongSchemaError(`along.sqlite schema ${version} predates schema ${ALONG_OLDEST_SCHEMA}, which this build cannot migrate; ` +
      'restore a backup taken with scripts/along-backup.mjs or start with a new data directory')
  }
  const migrating = version !== undefined && version < ALONG_SCHEMA_VERSION
  try {
    db.exec('BEGIN')
    try {
      db.exec(ALONG_DDL)
      for (let target = (version ?? 0) + 1; target <= ALONG_SCHEMA_VERSION; target++) MIGRATIONS[target]?.(db)
      if (version !== ALONG_SCHEMA_VERSION) {
        db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(String(ALONG_SCHEMA_VERSION))
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } catch (error) {
    if (!migrating) throw error instanceof AlongSchemaError ? error : new AlongSchemaError(error instanceof Error ? error.message : String(error), { cause: error })
    const reason = error instanceof Error ? error.message : String(error)
    throw new AlongSchemaError(`along.sqlite is unchanged at schema ${version}: its migration to schema ${ALONG_SCHEMA_VERSION} failed: ${reason}`, { cause: error })
  }
}
