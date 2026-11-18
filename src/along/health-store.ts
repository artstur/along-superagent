import type { SourceGoalReview,SourceGoalReviewRequest } from './source-goal-review.ts'
import type { ReminderPlan } from './reminder-plan.ts'
import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import type { HealthSummaryRow } from './store.ts'

export interface DueTask { taskId: string; revision: number; dueAt: string }
export interface TaskRepairReview {
  taskId:string;revision:number;evidenceEventId:string;deviceId:string;originalScheduledAt?:string;originalContent:string;reason:string;retired:boolean;contextReadAt?:string
}
export interface HealthDispatch {
  sourceReview?:SourceGoalReview
  repair?:TaskRepairReview
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
  private sourceReviewSchema():boolean {return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_goal_review'").get()}
  currentSourceEventId(userId:string,goalId:string):string|undefined {const row=this.db.prepare("SELECT event_id FROM source_state_current WHERE user_id=? AND goal_id=? AND provider='okx'").get(userId,goalId);return row?String(row.event_id):undefined}
  /** Only metadata is scanned; private source read data never enters the dispatch outbox. */
  legacyReadySources():{userId:string;deviceId:string;goalId:string}[] {
    if(!this.sourceReviewSchema())return []
    return this.db.prepare(`SELECT s.user_id,s.goal_id,u.device_id FROM source_state_current s
      JOIN goal g ON g.id=s.goal_id AND g.user_id=s.user_id JOIN user u ON u.id=s.user_id
      WHERE s.provider='okx' AND s.state='ready' AND g.status='active' AND (json_valid(s.capabilities) AND EXISTS(SELECT 1 FROM json_each(s.capabilities) WHERE value='trading_history') OR EXISTS (
        SELECT 1 FROM user_task t WHERE t.user_id=s.user_id AND t.goal_id=s.goal_id AND t.status='open'
        AND NOT EXISTS (SELECT 1 FROM task_trigger x WHERE x.task_id=t.id)))`).all()
      .map(row=>({userId:String(row.user_id),deviceId:String(row.device_id),goalId:String(row.goal_id)}))
  }
  /** One completed review per capability generation, not one Worker for every price revision. */
  requestSourceReview(input:SourceGoalReviewRequest):{dispatch:HealthDispatch;reused:boolean} {
    if(!this.sourceReviewSchema())throw new Error('source goal review not installed')
    const prior=this.db.prepare(`SELECT d.event_id FROM health_dispatch d JOIN source_goal_review r ON r.event_id=d.event_id
      WHERE d.user_id=? AND d.goal_id=? AND r.provider=? AND r.generation=? AND r.device_id=? AND r.capabilities=? AND r.retired=0
      AND (d.result IS NOT NULL OR d.input_version=?) ORDER BY (d.result IS NOT NULL) DESC,d.created_at LIMIT 1`)
      .get(input.userId,input.goalId,input.provider,input.generation,input.deviceId,JSON.stringify(input.capabilities),input.inputVersion)
    if(prior)return {dispatch:this.get(String(prior.event_id))!,reused:true}
    const eventId='source_review_'+createHash('sha256').update(JSON.stringify([input.userId,input.deviceId,input.goalId,input.provider,
      input.generation,input.capabilities,input.revision,input.reference,input.sourceEventId,input.inputVersion,input.legacyTasks.map(t=>[t.taskId,t.revision])])).digest('hex').slice(0,40)
    const existing=this.get(eventId)
    if(existing)return {dispatch:existing,reused:true}
    this.db.prepare('INSERT INTO health_dispatch(event_id,user_id,goal_id,input_version,snapshot,created_at) VALUES(?,?,?,?,?,?)')
      .run(eventId,input.userId,input.goalId,input.inputVersion,'[]',new Date().toISOString())
    this.db.prepare(`INSERT INTO source_goal_review(event_id,provider,source_event_id,generation,revision,reference,device_id,legacy_tasks,original_task_ids,capabilities)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(eventId,input.provider,input.sourceEventId,input.generation,input.revision,input.reference,input.deviceId,
        JSON.stringify(input.legacyTasks),JSON.stringify(input.originalTaskIds),JSON.stringify(input.capabilities))
    return {dispatch:this.get(eventId)!,reused:false}
  }
  readSourceReviewContext(eventId:string):void {this.read(eventId,[]);this.db.prepare('UPDATE source_goal_review SET context_read_at=? WHERE event_id=? AND retired=0').run(new Date().toISOString(),eventId)}
  retireSourceReview(eventId:string):void {if(this.sourceReviewSchema())this.db.prepare('UPDATE source_goal_review SET retired=1 WHERE event_id=?').run(eventId)}
  private repairSchema():boolean {return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_trigger_review'").get()}
  pairingMatches(userId:string,deviceId:string):boolean {return this.db.prepare('SELECT device_id FROM user WHERE id=?').get(userId)?.device_id===deviceId}
  requestTaskReview(input:{userId:string;deviceId:string;goalId:string;taskId:string;revision:number;inputVersion:number;evidenceEventId:string;scheduledAt?:string;content:string;reason:string}):{dispatch:HealthDispatch;reused:boolean} {
    if(!this.repairSchema())throw new Error('task trigger review not installed')
    const prior=this.db.prepare(`SELECT d.event_id,r.task_revision FROM health_dispatch d JOIN task_trigger_review r ON r.event_id=d.event_id
      WHERE d.user_id=? AND r.task_id=? AND d.input_version=? AND r.evidence_event_id=? AND r.device_id=? ORDER BY d.created_at DESC LIMIT 1`)
      .get(input.userId,input.taskId,input.inputVersion,input.evidenceEventId,input.deviceId)
    const origin=this.db.prepare('SELECT origin_event_id FROM task_revision WHERE task_id=? AND revision=?').get(input.taskId,input.revision)?.origin_event_id
    if(prior&&(Number(prior.task_revision)===input.revision||origin===prior.event_id))return {dispatch:this.get(String(prior.event_id))!,reused:true}
    const eventId='repair_'+createHash('sha256').update(JSON.stringify([input.userId,input.deviceId,input.goalId,input.taskId,input.revision,input.inputVersion,input.evidenceEventId])).digest('hex').slice(0,40)
    const existing=this.get(eventId)
    if(existing)return {dispatch:existing,reused:true}
    this.db.prepare('INSERT INTO health_dispatch(event_id,user_id,goal_id,input_version,snapshot,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(eventId,input.userId,input.goalId,input.inputVersion,'[]',new Date().toISOString())
    this.db.prepare(`INSERT INTO task_trigger_review(event_id,task_id,task_revision,input_version,evidence_event_id,device_id,original_scheduled_at,original_content,reason)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).run(eventId,input.taskId,input.revision,input.inputVersion,input.evidenceEventId,input.deviceId,input.scheduledAt??null,input.content,input.reason)
    return {dispatch:this.get(eventId)!,reused:false}
  }
  readRepairContext(eventId:string):void {this.read(eventId,[]);this.db.prepare('UPDATE task_trigger_review SET context_read_at=? WHERE event_id=? AND retired=0').run(new Date().toISOString(),eventId)}
  retireRepair(eventId:string):void {if(this.repairSchema())this.db.prepare('UPDATE task_trigger_review SET retired=1 WHERE event_id=?').run(eventId)}
  state(
    goalId: string
  ): { userId: string; updatedAt: string; inputVersion: number; types: string[]; baseline: HealthSummaryRow[]; seenTypes: string[] } | undefined {
    const row = this.db.prepare('SELECT * FROM health_followup WHERE goal_id=?').get(goalId)
    const dispatched =
      row &&
      this.db
        .prepare(
          `SELECT snapshot FROM health_dispatch WHERE goal_id=? AND input_version=? AND result IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task_review r WHERE r.event_id=health_dispatch.event_id) ${this.repairSchema()?'AND NOT EXISTS (SELECT 1 FROM task_trigger_review r WHERE r.event_id=health_dispatch.event_id)':''} ${this.sourceReviewSchema()?'AND NOT EXISTS (SELECT 1 FROM source_goal_review r WHERE r.event_id=health_dispatch.event_id)':''} ORDER BY created_at DESC,event_id DESC LIMIT 1`
        )
        .get(goalId, Number(row.input_version))
    return row
      ? {
          userId: String(row.user_id),
          updatedAt: String(row.updated_at),
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
    const source=r&&this.sourceReviewSchema()?this.db.prepare('SELECT * FROM source_goal_review WHERE event_id=?').get(eventId):undefined
    const repair=r&&this.repairSchema()?this.db.prepare('SELECT * FROM task_trigger_review WHERE event_id=?').get(eventId):undefined
    return r
      ? {
          ...(source?{sourceReview:{provider:'okx' as const,sourceEventId:String(source.source_event_id),generation:Number(source.generation),revision:Number(source.revision),reference:String(source.reference),deviceId:String(source.device_id),
            capabilities:JSON.parse(String(source.capabilities)),legacyTasks:JSON.parse(String(source.legacy_tasks)),originalTaskIds:JSON.parse(String(source.original_task_ids)),retired:source.retired===1,...(source.context_read_at==null?{}:{contextReadAt:String(source.context_read_at)})}}:{}),
          ...(repair?{repair:{taskId:String(repair.task_id),revision:Number(repair.task_revision),evidenceEventId:String(repair.evidence_event_id),deviceId:String(repair.device_id),
            ...(repair.original_scheduled_at==null?{}:{originalScheduledAt:String(repair.original_scheduled_at)}),originalContent:String(repair.original_content),reason:String(repair.reason),retired:repair.retired===1,...(repair.context_read_at==null?{}:{contextReadAt:String(repair.context_read_at)})}}:{}),
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
  reminderPlan(taskId:string): ReminderPlan | undefined {
    const row = this.db.prepare(`SELECT p.plan, d.timezone, d.wall_time, d.weekday FROM task_reminder_plan p
      LEFT JOIN task_daily d ON d.task_id=p.task_id WHERE p.task_id=?`).get(taskId)
    if (!row) return undefined
    const plan = JSON.parse(String(row.plan)) as ReminderPlan
    if (plan.state !== 'scheduled' || plan.repeat === 'once') return plan
    if (row.timezone == null || row.wall_time == null || (plan.weekday ?? null) !== row.weekday) {
      return { state:'scheduled', source:plan.source, explanation:plan.explanation, repeat:'once' }
    }
    return { ...plan, timezone:String(row.timezone), wallTime:String(row.wall_time) }
  }
  savePlan(taskId:string,plan:ReminderPlan | undefined):void {
    if (!plan) { this.db.prepare('DELETE FROM task_reminder_plan WHERE task_id=?').run(taskId); return }
    this.db.prepare('INSERT INTO task_reminder_plan(task_id,plan) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET plan=excluded.plan').run(taskId,JSON.stringify(plan))
  }
  daily(taskId: string): { evidence: string; zone: string; wallTime: string; weekday?:number; quote?:string; action?:string } | undefined {
    const row = this.db.prepare('SELECT * FROM task_daily WHERE task_id=?').get(taskId)
    return row && { evidence: String(row.evidence_event_id), zone: String(row.timezone), wallTime: String(row.wall_time),
      ...(row.weekday == null ? {} : { weekday:Number(row.weekday) }),
      ...(row.evidence_quote == null ? {} : { quote:String(row.evidence_quote),action:String(row.task_action) }) }
  }
  soleTaskFromMandate(taskId: string, goalId: string, eventId: string): boolean {
    const tasks = this.db.prepare(`SELECT DISTINCT t.id FROM user_task t JOIN task_revision r ON r.task_id=t.id
      WHERE t.goal_id=? AND r.origin_event_id=? AND r.scheduled_at IS NOT NULL`).all(goalId, eventId)
    return tasks.length === 1 && tasks[0]!.id === taskId && !this.db.prepare('SELECT 1 FROM task_once WHERE task_id=?').get(taskId)
  }
  setDaily(taskId: string, evidence?: { eventId: string; zone: string; wallTime: string; weekday?:number; quote?:string; action?:string }): void {
    if (!evidence) {
      this.db.prepare('DELETE FROM task_daily WHERE task_id=?').run(taskId)
      this.db.prepare('INSERT INTO task_once(task_id) VALUES(?) ON CONFLICT DO NOTHING').run(taskId)
      return
    }
    this.db.prepare('DELETE FROM task_once WHERE task_id=?').run(taskId)
    this.db.prepare(`INSERT INTO task_daily(task_id,evidence_event_id,timezone,wall_time,weekday,evidence_quote,task_action) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET evidence_event_id=excluded.evidence_event_id,timezone=excluded.timezone,wall_time=excluded.wall_time,weekday=excluded.weekday,evidence_quote=excluded.evidence_quote,task_action=excluded.task_action`)
      .run(taskId, evidence.eventId, evidence.zone, evidence.wallTime,evidence.weekday??null,evidence.quote??null,evidence.action??null)
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
      .prepare(`SELECT d.event_id FROM health_dispatch d LEFT JOIN task_review r ON r.event_id=d.event_id WHERE d.result IS NULL AND COALESCE(r.retired,0)=0 ${this.repairSchema()?'AND NOT EXISTS (SELECT 1 FROM task_trigger_review x WHERE x.event_id=d.event_id AND x.retired=1)':''} ${this.sourceReviewSchema()?'AND NOT EXISTS (SELECT 1 FROM source_goal_review x WHERE x.event_id=d.event_id AND x.retired=1)':''} ORDER BY d.created_at,d.event_id`)
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
    if (d.due||d.repair||d.sourceReview) return // Neither clocks nor maintenance reviews advance the observation baseline.
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
