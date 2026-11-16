/** AlongStore-owned schedule persistence; no second connection or transaction owner. */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

export interface MaintenanceBatch {
  id: string; userId: string; dueAt: string; throughSeq: number; status: 'pending' | 'done' | 'stopped'
  retryAt: string; attempts: number; processed: number; saved: number; createdAt: string
}
/** Persistent schedule and batch checkpoints sharing AlongStore's lifetime and savepoints. */
export class MaintenanceStore {
  constructor(private readonly db: DatabaseSync, private readonly atomic: <T>(work: () => T) => T) {}
  private batch(row: Record<string, SQLInputValue>): MaintenanceBatch {
    return { id: String(row.id), userId: String(row.user_id), dueAt: String(row.due_at), throughSeq: Number(row.through_seq),
      status: row.status as MaintenanceBatch['status'], retryAt: String(row.retry_at), attempts: Number(row.attempts),
      processed: Number(row.processed), saved: Number(row.saved), createdAt: String(row.created_at) }
  }
  users(): string[] { return this.db.prepare('SELECT id FROM user ORDER BY id').all().map(row => String(row.id)) }
  get(id: string): MaintenanceBatch | undefined {
    const row = this.db.prepare('SELECT * FROM maintenance_batch WHERE id=?').get(id)
    return row && this.batch(row)
  }
  outstanding(userId: string): MaintenanceBatch | undefined {
    const row = this.db.prepare("SELECT * FROM maintenance_batch WHERE user_id=? AND status='pending'").get(userId)
    return row && this.batch(row)
  }
  nextDue(userId: string, initial: string, config?: { time: string; now: string }): string {
    return this.atomic(() => {
      this.db.prepare('INSERT OR IGNORE INTO maintenance_schedule(user_id,next_due_at) VALUES(?,?)').run(userId, initial)
      if (config) {
        const key = `maintenance_time:${userId}`
        const previous = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value
        if ((previous ?? '03:00') !== config.time) {
          this.db.prepare('UPDATE maintenance_schedule SET next_due_at=? WHERE user_id=? AND next_due_at>?').run(initial, userId, config.now)
        }
        if (previous !== config.time) this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
          .run(key, config.time)
      }
      return String(this.db.prepare('SELECT next_due_at FROM maintenance_schedule WHERE user_id=?').get(userId)!.next_due_at)
    })
  }
  advance(userId: string, next: string, success?: string): void {
    this.atomic(() => { this.db.prepare('UPDATE maintenance_schedule SET next_due_at=?,last_success_at=COALESCE(?,last_success_at) WHERE user_id=?')
      .run(next, success ?? null, userId) })
  }
  create(userId: string, dueAt: string, now: string): MaintenanceBatch {
    return this.atomic(() => {
      const current = this.outstanding(userId)
      if (current) return current
      const through = Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM message WHERE user_id=?').get(userId)!.seq)
      const id = `mb_${randomUUID()}`
      this.db.prepare('INSERT INTO maintenance_batch(id,user_id,due_at,through_seq,retry_at,created_at) VALUES(?,?,?,?,?,?)')
        .run(id, userId, dueAt, through, now, now)
      return this.get(id)!
    })
  }
  attempt(id: string): void {
    this.atomic(() => { this.db.prepare("UPDATE maintenance_batch SET attempts=attempts+1 WHERE id=? AND status='pending'").run(id) })
  }
  checkpoint(id: string, processed: number, saved: number): void {
    this.atomic(() => { this.db.prepare("UPDATE maintenance_batch SET processed=processed+?,saved=saved+? WHERE id=? AND status='pending'")
      .run(processed, saved, id) })
  }
  defer(id: string, retryAt: string): void {
    this.atomic(() => { this.db.prepare("UPDATE maintenance_batch SET retry_at=? WHERE id=? AND status='pending'").run(retryAt, id) })
  }
  finish(id: string, now: string, stopped = false): void {
    this.atomic(() => { this.db.prepare("UPDATE maintenance_batch SET status=?,finished_at=? WHERE id=? AND status='pending'")
      .run(stopped ? 'stopped' : 'done', now, id) })
  }
}
