/** Typed, durable task activation. The host supplies identities and evaluates registered conditions. */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/)
export const TASK_CAPABILITIES = ['reminder', 'research', 'calculation'] as const
export type TaskCapability = typeof TASK_CAPABILITIES[number]
export const TASK_CONDITION_SCHEMA = z.discriminatedUnion('kind', [
  z.object({ kind:z.literal('source_ready'), provider:z.literal('okx'), capability:z.literal('trading_account_summary') }).strict(),
  z.object({ kind:z.literal('source_updated'), provider:z.literal('okx'), capability:z.literal('trading_account_summary') }).strict(),
  z.object({ kind:z.literal('task_completed'), task_id:id }).strict(),
  z.object({ kind:z.literal('health_available'), type:z.enum(['steps','workout','active_energy','weight','resting_heart_rate','wrist_temperature','sleep']) }).strict(),
])
export type TaskCondition = z.infer<typeof TASK_CONDITION_SCHEMA>
const common = {
  actor:z.enum(['user','agent']), capability:z.enum(TASK_CAPABILITIES),
  conditions:z.array(TASK_CONDITION_SCHEMA).max(4).optional(),
  notify_before:z.boolean().optional().describe('Preserve an existing legitimate reminder, or an explicitly requested advance notification. Agent results normally notify when produced.'),
}
export const TASK_TRIGGER_SCHEMA = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('immediate'),...common}).strict(),
  z.object({kind:z.literal('time'),...common}).strict().describe('Uses the task scheduled_at, timezone and persisted once/daily/weekly plan; a clock in prose is not a schedule.'),
  z.object({kind:z.literal('event'),...common,conditions:z.array(TASK_CONDITION_SCHEMA).min(1).max(4),
    repeat:z.enum(['once','on_change']).optional()}).strict(),
  z.object({kind:z.literal('waiting'),...common,
    resume:z.enum(['user_input','capability_available']),reason:z.string().trim().min(2).max(240)}).strict(),
]).superRefine((value,ctx)=>{
  if(value.actor==='user'&&value.capability!=='reminder')ctx.addIssue({code:'custom',message:'A human action can be reminded, not automatically researched or calculated',path:['capability']})
})
export type TaskTriggerInput = z.infer<typeof TASK_TRIGGER_SCHEMA>
export type TriggerState = 'pending'|'scheduled'|'waiting'|'running'|'settled'|'cancelled'
export interface TriggerTask { id:string;userId:string;goalId:string;currentRevision:number;status:string;content:string;scheduledAt?:string;createdAt:string }
export interface TriggerRow {
  taskId:string;userId:string;goalId:string;taskRevision:number;generation:number;inputVersion:number;
  definition:TaskTriggerInput;state:TriggerState;reason?:string;lastKey?:string;updatedAt:string;capabilityMissing:boolean
}
export interface TriggerOccurrence {
  id:string;userId:string;goalId:string;taskId:string;generation:number;taskRevision:number;inputVersion:number;
  key:string;dueAt:string;conditionsToken:string;state:'pending'|'dispatched'|'settled'|'invalidated';
  eventId?:string;outcome?:string;completionEventId?:string;completedAt?:string;createdAt:string
}
export interface TaskTriggerView {
  version:1;kind:TaskTriggerInput['kind'];actor:'user'|'agent';capability:TaskCapability;state:TriggerState;
  label:string;conditions:TaskCondition[];notifyBefore:boolean
}
export const TASK_TRIGGER_DDL = `
CREATE TABLE IF NOT EXISTS task_trigger (
 task_id TEXT PRIMARY KEY REFERENCES user_task(id),user_id TEXT NOT NULL,goal_id TEXT NOT NULL,
 task_revision INTEGER NOT NULL,generation INTEGER NOT NULL,input_version INTEGER NOT NULL,
 definition TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,last_key TEXT,updated_at TEXT NOT NULL,capability_missing INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS task_trigger_goal ON task_trigger(user_id,goal_id,state);
CREATE TABLE IF NOT EXISTS task_trigger_occurrence (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL,goal_id TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES user_task(id),
 generation INTEGER NOT NULL,task_revision INTEGER NOT NULL,input_version INTEGER NOT NULL,
 occurrence_key TEXT NOT NULL,due_at TEXT NOT NULL,conditions_token TEXT NOT NULL,state TEXT NOT NULL,
 dispatch_event_id TEXT,outcome TEXT,completion_event_id TEXT,completed_at TEXT,created_at TEXT NOT NULL,
 UNIQUE(task_id,generation,occurrence_key)
);
CREATE INDEX IF NOT EXISTS trigger_occurrence_task ON task_trigger_occurrence(user_id,task_id,created_at DESC);
`
const hash = (parts:unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0,40)
const parse = (row:Record<string,unknown>):TriggerRow => ({taskId:String(row.task_id),userId:String(row.user_id),goalId:String(row.goal_id),
  taskRevision:Number(row.task_revision),generation:Number(row.generation),inputVersion:Number(row.input_version),
  definition:JSON.parse(String(row.definition)) as TaskTriggerInput,state:row.state as TriggerState,capabilityMissing:row.capability_missing===1,
  ...(row.reason==null?{}:{reason:String(row.reason)}),...(row.last_key==null?{}:{lastKey:String(row.last_key)}),updatedAt:String(row.updated_at)})
const occurrence = (r:Record<string,unknown>):TriggerOccurrence => ({id:String(r.id),userId:String(r.user_id),goalId:String(r.goal_id),taskId:String(r.task_id),
  generation:Number(r.generation),taskRevision:Number(r.task_revision),inputVersion:Number(r.input_version),key:String(r.occurrence_key),
  dueAt:String(r.due_at),conditionsToken:String(r.conditions_token),state:r.state as TriggerOccurrence['state'],
  ...(r.dispatch_event_id==null?{}:{eventId:String(r.dispatch_event_id)}),...(r.outcome==null?{}:{outcome:String(r.outcome)}),
  ...(r.completion_event_id==null?{}:{completionEventId:String(r.completion_event_id)}),...(r.completed_at==null?{}:{completedAt:String(r.completed_at)}),createdAt:String(r.created_at)})

/** Persistence only: the ChangeSet/API/runtime enforce current mandate and registered-condition ownership before writing. */
export class TaskTriggerStore {
  constructor(private readonly db:DatabaseSync,private readonly now:()=>string=()=>new Date().toISOString()) {}
  get(userId:string,taskId:string):TriggerRow|undefined {
    const r=this.db.prepare('SELECT * FROM task_trigger WHERE user_id=? AND task_id=?').get(userId,taskId)
    return r&&parse(r)
  }
  /** A new definition is a new generation; a cancelled or revised definition cannot revive old work. */
  put(task:TriggerTask,input:TaskTriggerInput,inputVersion:number):TriggerRow {
    const definition=TASK_TRIGGER_SCHEMA.parse(input),prior=this.get(task.userId,task.id)
    const stored=this.db.prepare('SELECT user_id,goal_id,current_revision,status FROM user_task WHERE id=?').get(task.id)
    if(!stored||stored.user_id!==task.userId||stored.goal_id!==task.goalId||stored.current_revision!==task.currentRevision)throw new Error('task trigger scope changed')
    this.db.prepare("UPDATE task_trigger_occurrence SET state='invalidated' WHERE task_id=? AND state IN ('pending','dispatched')").run(task.id)
    const state:TriggerState=task.status!=='open'?'cancelled':definition.kind==='time'?'scheduled':definition.kind==='immediate'?'pending':'waiting'
    this.db.prepare(`INSERT INTO task_trigger(task_id,user_id,goal_id,task_revision,generation,input_version,definition,state,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET task_revision=excluded.task_revision,generation=excluded.generation,
      input_version=excluded.input_version,definition=excluded.definition,state=excluded.state,reason=NULL,last_key=NULL,capability_missing=0,updated_at=excluded.updated_at`)
      .run(task.id,task.userId,task.goalId,task.currentRevision,(prior?.generation??0)+1,inputVersion,JSON.stringify(definition),state,this.now())
    return this.get(task.userId,task.id)!
  }
  /** A host-generated clock renewal carries the same definition; it is not a fresh user mandate. */
  carry(task:TriggerTask):void {
    this.db.prepare('UPDATE task_trigger SET task_revision=?,updated_at=? WHERE task_id=? AND user_id=?')
      .run(task.currentRevision,this.now(),task.id,task.userId)
    if(task.status==='cancelled')this.cancel(task.userId,task.id)
    else if(task.status==='done') {
      this.db.prepare("UPDATE task_trigger SET state='settled',updated_at=? WHERE user_id=? AND task_id=?").run(this.now(),task.userId,task.id)
      this.db.prepare("UPDATE task_trigger_occurrence SET state='invalidated' WHERE user_id=? AND task_id=? AND state IN ('pending','dispatched')").run(task.userId,task.id)
    }
  }
  list():TriggerRow[] { return this.db.prepare('SELECT * FROM task_trigger ORDER BY updated_at,task_id').all().map(parse) }
  setState(row:TriggerRow,state:TriggerState,reason?:string):void {
    this.db.prepare('UPDATE task_trigger SET state=?,reason=?,updated_at=? WHERE task_id=? AND user_id=? AND generation=?')
      .run(state,reason??null,this.now(),row.taskId,row.userId,row.generation)
  }
  observeMissingCapability(row:TriggerRow):void {
    this.db.prepare('UPDATE task_trigger SET capability_missing=1 WHERE task_id=? AND user_id=? AND generation=?')
      .run(row.taskId,row.userId,row.generation)
  }
  cancel(userId:string,taskId:string):void {
    this.db.prepare("UPDATE task_trigger SET state='cancelled',updated_at=? WHERE user_id=? AND task_id=?").run(this.now(),userId,taskId)
    this.db.prepare("UPDATE task_trigger_occurrence SET state='invalidated' WHERE user_id=? AND task_id=? AND state IN ('pending','dispatched')").run(userId,taskId)
  }
  /** One logical occurrence is stable across model/engine retries and process restarts. */
  claim(task:TriggerTask,key:string,dueAt:string,inputVersion:number,conditionsToken:string):TriggerOccurrence|undefined {
    const row=this.get(task.userId,task.id)
    if(!row||row.state==='cancelled'||task.status!=='open'||row.taskRevision!==task.currentRevision)throw new Error('task trigger unavailable')
    const oid='occ_'+hash([task.userId,task.goalId,task.id,row.generation,key])
    const prior=this.byId(task.userId,oid)
    if(prior?.state==='settled')return undefined
    if(prior&&prior.state!=='invalidated') {
      this.db.prepare("UPDATE task_trigger SET state='running',reason=NULL,updated_at=? WHERE task_id=? AND generation=?").run(this.now(),task.id,row.generation)
      return prior
    }
    this.db.prepare(`INSERT INTO task_trigger_occurrence(id,user_id,goal_id,task_id,generation,task_revision,input_version,occurrence_key,due_at,conditions_token,state,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?) ON CONFLICT(id) DO UPDATE SET task_revision=excluded.task_revision,input_version=excluded.input_version,
      conditions_token=excluded.conditions_token,due_at=excluded.due_at,state='pending',dispatch_event_id=NULL,outcome=NULL`)
      .run(oid,task.userId,task.goalId,task.id,row.generation,task.currentRevision,inputVersion,key,dueAt,conditionsToken,this.now())
    this.db.prepare("UPDATE task_trigger SET state='running',last_key=?,reason=NULL,updated_at=? WHERE task_id=? AND generation=?")
      .run(key,this.now(),task.id,row.generation)
    return this.byId(task.userId,oid)!
  }
  byId(userId:string,oid:string):TriggerOccurrence|undefined {
    const r=this.db.prepare('SELECT * FROM task_trigger_occurrence WHERE user_id=? AND id=?').get(userId,oid)
    return r&&occurrence(r)
  }
  forDispatch(eventId:string):TriggerOccurrence|undefined {
    const r=this.db.prepare('SELECT * FROM task_trigger_occurrence WHERE dispatch_event_id=?').get(eventId)
    return r&&occurrence(r)
  }
  forTime(userId:string,taskId:string,dueAt:string):TriggerOccurrence|undefined {
    const r=this.db.prepare("SELECT * FROM task_trigger_occurrence WHERE user_id=? AND task_id=? AND due_at=? AND state!='invalidated' ORDER BY created_at DESC LIMIT 1")
      .get(userId,taskId,dueAt)
    return r&&occurrence(r)
  }
  bindDispatch(item:TriggerOccurrence,eventId:string):void {
    this.db.prepare("UPDATE task_trigger_occurrence SET dispatch_event_id=?,state='dispatched' WHERE id=? AND state='pending'").run(eventId,item.id)
  }
  invalidate(item:TriggerOccurrence):void {
    this.db.prepare("UPDATE task_trigger_occurrence SET state='invalidated' WHERE id=? AND state IN ('pending','dispatched')").run(item.id)
  }
  settle(item:TriggerOccurrence,outcome:string):void {
    this.db.prepare("UPDATE task_trigger_occurrence SET state='settled',outcome=? WHERE id=? AND state IN ('pending','dispatched')").run(outcome,item.id)
    const row=this.get(item.userId,item.taskId)
    if(!row||row.generation!==item.generation)return
    const d=row.definition
    const next:TriggerState=d.kind==='time'?'scheduled':d.kind==='event'&&d.repeat==='on_change'||d.kind==='waiting'?'waiting':'settled'
    this.setState(row,next)
  }
  /** Real completion is separate from a reminder firing or a model's status edit. */
  completeUserOccurrence(task:TriggerTask,eventId:string,completedAt:string,inputVersion:number):TriggerOccurrence {
    const row=this.get(task.userId,task.id)
    if(!row||row.definition.actor!=='user'||row.state==='cancelled')throw new Error('human occurrence unavailable')
    const existing=this.db.prepare('SELECT * FROM task_trigger_occurrence WHERE user_id=? AND task_id=? AND completion_event_id=?')
      .get(task.userId,task.id,eventId)
    if(existing)return occurrence(existing)
    const recent=this.db.prepare(`SELECT * FROM task_trigger_occurrence WHERE user_id=? AND task_id=? AND generation=?
      AND julianday(due_at)<=julianday(?) AND state!='invalidated' AND completion_event_id IS NULL ORDER BY julianday(due_at) DESC LIMIT 1`)
      .get(task.userId,task.id,row.generation,completedAt)
    let item=recent?occurrence(recent):undefined
    if(!item) {
      const last=this.db.prepare(`SELECT * FROM task_trigger_occurrence WHERE user_id=? AND task_id=? AND generation=?
        AND completion_event_id IS NOT NULL ORDER BY completed_at DESC LIMIT 1`).get(task.userId,task.id,row.generation)
      const zone=this.db.prepare('SELECT timezone FROM task_daily WHERE task_id=?').get(task.id)?.timezone
      if(last&&task.scheduledAt&&Date.parse(task.scheduledAt)>Date.parse(completedAt)&&typeof zone==='string') {
        const civil=(at:string)=>new Intl.DateTimeFormat('sv-SE',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at))
        // A repeated completion tap between cycles is not evidence that next week's action happened.
        if(civil(task.scheduledAt)!==civil(completedAt)||String(last.due_at)===task.scheduledAt)return occurrence(last)
      }
      const at=task.scheduledAt??completedAt,key=row.definition.kind==='time'?'time:'+new Date(at).toISOString():'completion:'+eventId
      item=this.claim(task,key,at,inputVersion,'')
    }
    if(!item)throw new Error('this occurrence is already completed')
    this.db.prepare("UPDATE task_trigger_occurrence SET state='settled',outcome='completed',completion_event_id=?,completed_at=? WHERE id=? AND completion_event_id IS NULL")
      .run(eventId,completedAt,item.id)
    this.setState(row,row.definition.kind==='time'?'scheduled':'settled')
    return this.byId(task.userId,item.id)!
  }
  completionFacts(userId:string,taskId:string):TriggerOccurrence[] {
    return this.db.prepare("SELECT * FROM task_trigger_occurrence WHERE user_id=? AND task_id=? AND completion_event_id IS NOT NULL ORDER BY completed_at DESC").all(userId,taskId).map(occurrence)
  }
  dependencyFact(userId:string,taskId:string):TriggerOccurrence|undefined {
    const r=this.db.prepare(`SELECT x.* FROM task_trigger_occurrence x JOIN task_trigger t ON t.user_id=x.user_id AND t.task_id=x.task_id AND t.generation=x.generation
      WHERE x.user_id=? AND x.task_id=? AND x.state='settled' AND t.state<>'cancelled'
      AND (x.completion_event_id IS NOT NULL OR x.outcome IN ('calculated','researched','agent_researched')) ORDER BY x.created_at DESC LIMIT 1`).get(userId,taskId)
    return r&&occurrence(r)
  }
  view(userId:string,taskId:string):TaskTriggerView|undefined {
    const row=this.get(userId,taskId)
    if(!row)return
    const d=row.definition,conditions=d.conditions??[]
    const conditionLabel=conditions.map(c=>c.kind==='source_ready'?'数据源连接并可读取后执行':c.kind==='source_updated'?'数据更新后执行':c.kind==='task_completed'?'前置任务完成后执行':'健康摘要就绪后执行').join('，')
    const label=row.reason??(d.kind==='immediate'?'立即执行':d.kind==='time'?'按计划时间执行':d.kind==='waiting'?d.reason:conditionLabel)
    return {version:1,kind:d.kind,actor:d.actor,capability:d.capability,state:row.state,label,conditions,notifyBefore:d.actor==='user'||d.notify_before===true}
  }
}
