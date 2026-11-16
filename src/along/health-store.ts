import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import type { HealthSummaryRow } from './store.ts'

export interface DueTask { taskId: string; revision: number; dueAt: string }
export interface HealthDispatch {
  due?: DueTask
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
          'SELECT snapshot FROM health_dispatch WHERE goal_id=? AND input_version=? AND result IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task_review r WHERE r.event_id=health_dispatch.event_id) ORDER BY created_at DESC,event_id DESC LIMIT 1'
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
    const due = r && this.db.prepare('SELECT * FROM task_review WHERE event_id=?').get(eventId)
    return r
      ? {
          ...(due ? { due: { taskId: String(due.task_id), revision: Number(due.revision), dueAt: String(due.due_at) } } : {}),
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
  recentUnnotifiedTasks(now: string): {userId:string; goalId:string; due:DueTask}[] {
    return this.db.prepare(`SELECT t.id,t.user_id,t.goal_id,t.current_revision,t.scheduled_at FROM user_task t
      JOIN goal g ON g.id=t.goal_id WHERE g.status='active' AND t.status='open'
      AND julianday(t.scheduled_at) BETWEEN julianday(?,'-10 minutes') AND julianday(?)
      AND NOT EXISTS (SELECT 1 FROM due_notice n WHERE n.task_id=t.id AND n.due_at=julianday(t.scheduled_at))`)
      .all(now,now).map(r=>({userId:String(r.user_id),goalId:String(r.goal_id),due:{
        taskId:String(r.id),revision:Number(r.current_revision),dueAt:String(r.scheduled_at)}}))
  }
  claimDueNotice(taskId: string, dueAt: string): boolean {
    return this.db.prepare('INSERT INTO due_notice(task_id,due_at) VALUES(?,julianday(?)) ON CONFLICT DO NOTHING')
      .run(taskId,dueAt).changes === 1
  }
  dueTasks(now: string): { userId: string; goalId: string; due: DueTask }[] {
    const rows = this.db.prepare(`SELECT t.user_id,t.goal_id,t.id,t.current_revision,t.scheduled_at
      FROM user_task t JOIN goal g ON g.id=t.goal_id
      WHERE g.status='active' AND t.status='open' AND julianday(t.scheduled_at)<=julianday(?)
      AND NOT EXISTS (SELECT 1 FROM task_review r JOIN health_dispatch d ON d.event_id=r.event_id
        WHERE r.task_id=t.id AND julianday(r.due_at)=julianday(t.scheduled_at)
        AND (d.result IS NOT NULL OR (r.retired=0 AND r.revision=t.current_revision AND d.input_version=(
          SELECT version FROM input_version WHERE goal_id=t.goal_id))))
      ORDER BY julianday(t.scheduled_at),t.id`).all(now)
    return rows.map(r => ({ userId: String(r.user_id), goalId: String(r.goal_id),
      due: { taskId: String(r.id), revision: Number(r.current_revision), dueAt: String(r.scheduled_at) } }))
  }
  dispatchDue(userId: string, goalId: string, inputVersion: number, due: DueTask, snapshot: HealthSummaryRow[]): HealthDispatch {
    const eventId = 'due_' + createHash('sha256').update(JSON.stringify([userId, goalId, due, inputVersion])).digest('hex').slice(0, 40)
    this.db.prepare('INSERT INTO health_dispatch(event_id,user_id,goal_id,input_version,snapshot,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(eventId, userId, goalId, inputVersion, JSON.stringify(snapshot), new Date().toISOString())
    this.db.prepare('INSERT INTO task_review(event_id,task_id,revision,due_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING')
      .run(eventId, due.taskId, due.revision, due.dueAt)
    return this.get(eventId)!
  }
  daily(taskId: string): { evidence: string; zone: string; wallTime: string } | undefined {
    const row = this.db.prepare('SELECT * FROM task_daily WHERE task_id=?').get(taskId)
    return row && { evidence: String(row.evidence_event_id), zone: String(row.timezone), wallTime: String(row.wall_time) }
  }
  soleTaskFromMandate(taskId: string, goalId: string, eventId: string): boolean {
    const tasks = this.db.prepare(`SELECT DISTINCT t.id FROM user_task t JOIN task_revision r ON r.task_id=t.id
      WHERE t.goal_id=? AND r.origin_event_id=? AND r.scheduled_at IS NOT NULL`).all(goalId, eventId)
    return tasks.length === 1 && tasks[0]!.id === taskId && !this.db.prepare('SELECT 1 FROM task_once WHERE task_id=?').get(taskId)
  }
  setDaily(taskId: string, evidence?: { eventId: string; zone: string; wallTime: string }): void {
    if (!evidence) {
      this.db.prepare('DELETE FROM task_daily WHERE task_id=?').run(taskId)
      this.db.prepare('INSERT INTO task_once(task_id) VALUES(?) ON CONFLICT DO NOTHING').run(taskId)
      return
    }
    this.db.prepare('DELETE FROM task_once WHERE task_id=?').run(taskId)
    this.db.prepare(`INSERT INTO task_daily(task_id,evidence_event_id,timezone,wall_time) VALUES(?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET evidence_event_id=excluded.evidence_event_id,timezone=excluded.timezone,wall_time=excluded.wall_time`)
      .run(taskId, evidence.eventId, evidence.zone, evidence.wallTime)
  }
  recordRenewal(eventId: string, revision: number): void {
    this.db.prepare('UPDATE task_review SET renewed_revision=? WHERE event_id=?').run(revision,eventId)
  }
  previousDailyOccurrence(taskId: string, revision: number): string | undefined {
    const row = this.db.prepare('SELECT due_at FROM task_review WHERE task_id=? AND renewed_revision=?').get(taskId,revision)
    return row && String(row.due_at)
  }
  retireDue(eventId: string): void {
    this.db.prepare('UPDATE task_review SET retired=1 WHERE event_id=?').run(eventId)
  }
  pending(): HealthDispatch[] {
    return this.db
      .prepare('SELECT d.event_id FROM health_dispatch d LEFT JOIN task_review r ON r.event_id=d.event_id WHERE d.result IS NULL AND COALESCE(r.retired,0)=0 ORDER BY d.created_at,d.event_id')
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
    if (d.due) return // A clock tick never advances the health-change baseline.
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
