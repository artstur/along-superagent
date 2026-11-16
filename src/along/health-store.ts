import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import type { HealthSummaryRow } from './store.ts'

export interface HealthDispatch {
  eventId: string
  userId: string
  goalId: string
  inputVersion: number
  snapshot: HealthSummaryRow[]
  readSnapshot?: HealthSummaryRow[]
  result?: { outcome: string; types: string[]; reason: string; text?: string }
  createdAt: string
}
/** AlongStore-owned persistence sharing the business transaction and database lifetime. */
export class HealthStore {
  constructor(private readonly db: DatabaseSync) {}
  state(
    goalId: string
  ): { inputVersion: number; types: string[]; baseline: HealthSummaryRow[]; seenTypes: string[] } | undefined {
    const row = this.db.prepare('SELECT * FROM health_followup WHERE goal_id=?').get(goalId)
    const dispatched =
      row &&
      this.db
        .prepare(
          'SELECT snapshot FROM health_dispatch WHERE goal_id=? AND input_version=? AND result IS NOT NULL ORDER BY created_at DESC,event_id DESC LIMIT 1'
        )
        .get(goalId, Number(row.input_version))
    return row
      ? {
          seenTypes: dispatched
            ? (JSON.parse(String(dispatched.snapshot)) as HealthSummaryRow[]).map((s) => s.type)
            : [],
          inputVersion: Number(row.input_version),
          types: JSON.parse(String(row.types)),
          baseline: JSON.parse(String(row.baseline))
        }
      : undefined
  }
  get(eventId: string): HealthDispatch | undefined {
    const r = this.db.prepare('SELECT * FROM health_dispatch WHERE event_id=?').get(eventId)
    return r
      ? {
          eventId: String(r.event_id),
          userId: String(r.user_id),
          goalId: String(r.goal_id),
          inputVersion: Number(r.input_version),
          snapshot: JSON.parse(String(r.snapshot)),
          readSnapshot: r.read_snapshot === null ? undefined : JSON.parse(String(r.read_snapshot)),
          result: r.result === null ? undefined : JSON.parse(String(r.result)),
          createdAt: String(r.created_at)
        }
      : undefined
  }
  dispatch(userId: string, goalId: string, inputVersion: number, snapshot: HealthSummaryRow[]): HealthDispatch {
    const eventId =
      'health_' +
      createHash('sha256')
        .update(JSON.stringify([userId, goalId, inputVersion, snapshot.map((s) => s.id)]))
        .digest('hex')
        .slice(0, 40)
    this.db
      .prepare(
        'INSERT INTO health_dispatch(event_id,user_id,goal_id,input_version,snapshot,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING'
      )
      .run(eventId, userId, goalId, inputVersion, JSON.stringify(snapshot), new Date().toISOString())
    return this.get(eventId)!
  }
  pending(): HealthDispatch[] {
    return this.db
      .prepare('SELECT event_id FROM health_dispatch WHERE result IS NULL ORDER BY created_at,event_id')
      .all()
      .map((r) => this.get(String(r.event_id))!)
  }
  read(eventId: string, snapshot: HealthSummaryRow[]): void {
    this.db
      .prepare('UPDATE health_dispatch SET read_snapshot=? WHERE event_id=? AND result IS NULL')
      .run(JSON.stringify(snapshot), eventId)
  }
  finish(d: HealthDispatch, result: NonNullable<HealthDispatch['result']>): void {
    this.db.prepare('UPDATE health_dispatch SET result=? WHERE event_id=?').run(JSON.stringify(result), d.eventId)
    this.db
      .prepare(
        `INSERT INTO health_followup(goal_id,user_id,input_version,types,baseline,reason,updated_at) VALUES(?,?,?,?,?,?,?)
   ON CONFLICT(goal_id) DO UPDATE SET input_version=excluded.input_version,types=excluded.types,baseline=excluded.baseline,reason=excluded.reason,updated_at=excluded.updated_at`
      )
      .run(
        d.goalId,
        d.userId,
        d.inputVersion,
        JSON.stringify(result.types),
        JSON.stringify(d.readSnapshot ?? d.snapshot),
        result.reason,
        new Date().toISOString()
      )
  }
  users(): string[] {
    return this.db
      .prepare('SELECT DISTINCT user_id FROM health_summary')
      .all()
      .map((r) => String(r.user_id))
  }
}
