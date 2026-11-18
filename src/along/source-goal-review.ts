/** Bounded first-ready continuation for old goals. Metadata planning only; no account data or fake user event. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { ReminderPlan } from './reminder-plan.ts'
import type { AlongStore } from './store.ts'
import type { AlongCommitScope, AlongChangeSetInput, AlongIdentity } from './service.ts'
import type { HealthDispatch } from './health-store.ts'
import type { SourceCapability } from './source-state.ts'
import { TASK_TRIGGER_SCHEMA } from './task-trigger.ts'

export interface LegacySourceTask {taskId:string;revision:number;content:string;status:'open';scheduledAt?:string;reminderPlan?:ReminderPlan}
export interface SourceGoalReview {
  provider:'okx';sourceEventId:string;generation:number;revision:number;reference:string;deviceId:string;
  legacyTasks:LegacySourceTask[];originalTaskIds:string[];capabilities:SourceCapability[];retired:boolean;contextReadAt?:string
}
export interface SourceGoalReviewRequest extends Omit<SourceGoalReview,'retired'|'contextReadAt'> {userId:string;goalId:string;inputVersion:number}
export const SOURCE_GOAL_REVIEW_DDL=`
CREATE TABLE IF NOT EXISTS source_goal_review (
 event_id TEXT PRIMARY KEY REFERENCES health_dispatch(event_id),provider TEXT NOT NULL,source_event_id TEXT NOT NULL,
 generation INTEGER NOT NULL,revision INTEGER NOT NULL,reference TEXT NOT NULL,device_id TEXT NOT NULL,
 legacy_tasks TEXT NOT NULL,original_task_ids TEXT NOT NULL,context_read_at TEXT,retired INTEGER NOT NULL DEFAULT 0,
 capabilities TEXT NOT NULL DEFAULT '["trading_account_summary"]'
);
CREATE INDEX IF NOT EXISTS source_goal_review_generation ON source_goal_review(provider,generation,device_id,retired,event_id);
`
export const SOURCE_REVIEW_FINISH=z.object({outcome:z.enum(['keep','revise','need_data']),reason:z.string().trim().min(2).max(800),
  needs:z.array(z.string().trim().min(2).max(240)).max(8).optional()}).strict().superRefine((value,ctx)=>{
    if(value.outcome==='need_data'&&!value.needs?.length)ctx.addIssue({code:'custom',path:['needs'],message:'Name the real missing data/capability; source readiness is not strategy evidence.'})
  })
/** Stable refusals never contain private source data or transport credentials. */
export class SourceReviewError extends Error {constructor(readonly code:string){super(code)}}
const fail=(code:string):never=>{throw new SourceReviewError(code)}

/** Called inside the source-accept transaction, and again by restart reconciliation. */
export function ensureSourceGoalReview(store:AlongStore,identity:AlongIdentity,goalId:string) {
  if(!store.health.pairingMatches(identity.userId,identity.deviceId))return undefined
  const goal=store.getGoal(identity.userId,goalId)
  if(goal?.status!=='active'||!store.goalDataSources(identity.userId,goalId).some(s=>s.provider==='okx'))return undefined
  const fact=store.sources.queryCurrent(identity.userId,goalId,'okx')
  if(fact?.state!=='ready'||!fact.capabilities.includes('trading_account_summary'))return undefined
  const detail=store.goalDetail(identity.userId,goalId)
  const legacy=detail.tasks.filter(task=>task.status==='open'&&!store.triggers.get(identity.userId,task.id))
  const hasHistory=fact.capabilities.includes('trading_history')
  // A real history capability can unlock useful work even after the summary review already typed every human task.
  // Existing open history subscribers already receive the real fact through normal trigger evaluation.
  if(hasHistory&&detail.tasks.some(task=>task.status==='open'&&task.trigger?.actor==='agent'&&
    task.trigger.conditions?.some(condition=>(condition.kind==='source_ready'||condition.kind==='source_updated')&&condition.capability==='trading_history')))return undefined
  if(!legacy.length&&!hasHistory)return undefined
  return store.health.requestSourceReview({userId:identity.userId,deviceId:identity.deviceId,goalId,inputVersion:store.inputVersion(goalId),
    provider:'okx',sourceEventId:store.health.currentSourceEventId(identity.userId,goalId)!,generation:fact.generation,revision:fact.revision,reference:fact.reference,
    capabilities:hasHistory?['trading_history']:['trading_account_summary'],
    legacyTasks:legacy.map(task=>({taskId:task.id,revision:task.currentRevision,content:task.content,status:'open',...(task.scheduledAt===undefined?{}:{scheduledAt:task.scheduledAt}),...(task.reminderPlan===undefined?{}:{reminderPlan:task.reminderPlan})})),
    originalTaskIds:detail.tasks.map(task=>task.id)})
}
export function reconcileSourceGoalReviews(store:AlongStore):void {
  for(const source of store.health.legacyReadySources())ensureSourceGoalReview(store,{userId:source.userId,deviceId:source.deviceId},source.goalId)
}

/** A newer price in the same grant does not invalidate a metadata-only capability review. No values are consumed here. */
export function sourceReviewCurrent(store:AlongStore,d:HealthDispatch):boolean {
  const r=d.sourceReview
  if(!r||r.retired||store.getGoal(d.userId,d.goalId)?.status!=='active'||store.inputVersion(d.goalId)!==d.inputVersion||
    !store.health.pairingMatches(d.userId,r.deviceId)||!store.goalDataSources(d.userId,d.goalId).some(s=>s.provider===r.provider))return false
  const fact=store.sources.queryCurrent(d.userId,d.goalId,r.provider)
  if(fact?.state!=='ready'||fact.generation!==r.generation||fact.revision<r.revision||
    fact.revision===r.revision&&fact.reference!==r.reference||r.capabilities.some(capability=>!fact.capabilities.includes(capability)))return false
  return r.legacyTasks.every(original=>{
    const task=store.getTask(d.userId,original.taskId)
    return task?.goalId===d.goalId&&task.status===original.status&&task.content===original.content&&task.scheduledAt===original.scheduledAt&&isDeepStrictEqual(task.reminderPlan,original.reminderPlan)&&
      (task.currentRevision===original.revision||store.taskRevisionOrigin(task.id,task.currentRevision)===d.eventId)
  })
}

/** A queued bootstrap is obsolete once a different legitimate planner already persisted the history subscriber. */
export function sourceReviewHistoryAlreadyPlanned(store:AlongStore,d:HealthDispatch):boolean {
  if(!d.sourceReview?.capabilities.includes('trading_history'))return false
  return store.goalDetail(d.userId,d.goalId).tasks.some(task=>task.status==='open'&&task.trigger?.actor==='agent'&&
    task.trigger.conditions?.some(c=>(c.kind==='source_ready'||c.kind==='source_updated')&&c.capability==='trading_history')&&
    store.taskRevisionOrigin(task.id,task.currentRevision)!==d.eventId)
}

/** Keep the original human actions, their clocks/plans and unrelated typed tasks immutable in this planning scope. */
export function sourceReviewChangeRefusal(store:AlongStore,input:AlongChangeSetInput,scope:AlongCommitScope):string|undefined {
  const d=scope.triggerEventId?store.health.get(scope.triggerEventId):undefined
  if(!d?.sourceReview)return undefined
  if(d.userId!==scope.userId||d.goalId!==scope.allowedGoalId||d.result||!d.sourceReview.contextReadAt||!sourceReviewCurrent(store,d))return 'source_review_unavailable'
  for(const raw of input.ops) {
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return 'outside_source_review'
    const op=raw as {op?:unknown;task_id?:unknown;fields?:Record<string,unknown>;trigger?:unknown}
    if(op.op==='task.create') {
      if(sourceReviewHistoryAlreadyPlanned(store,d))return 'source_review_history_already_planned'
      const parsed=TASK_TRIGGER_SCHEMA.safeParse(op.trigger)
      if(!parsed.success||parsed.data.actor!=='agent')return 'source_review_new_task_requires_agent_trigger'
      continue
    }
    const original=d.sourceReview.legacyTasks.find(t=>t.taskId===op.task_id)
    if(op.op!=='task.update'||!original||!op.fields||typeof op.fields!=='object'||Array.isArray(op.fields)||
      Object.keys(op.fields).some(key=>key!=='trigger'))return 'outside_source_review'
    const trigger=op.fields.trigger
    if(trigger==='keep') {
      const current=store.triggers.get(d.userId,original.taskId)
      if(!current||current.definition.actor!=='user')return 'source_review_legacy_actor_preserved'
    }else {
      const parsed=TASK_TRIGGER_SCHEMA.safeParse(trigger)
      if(!parsed.success||parsed.data.actor!=='user'||(original.scheduledAt===undefined?parsed.data.kind!=='waiting':parsed.data.kind!=='time'))return 'source_review_legacy_actor_or_clock_preserved'
    }
  }
  return undefined
}
export function assertSourceReviewWrite(store:AlongStore,scope:AlongCommitScope):void {
  const d=scope.triggerEventId?store.health.get(scope.triggerEventId):undefined
  if(d?.sourceReview&&!sourceReviewCurrent(store,d))fail('source_review_original_fields_changed')
}

export function sourceReviewContext(store:AlongStore,d:HealthDispatch) {
  if(!sourceReviewCurrent(store,d)||d.result)fail('source_review_unavailable')
  const r=d.sourceReview!,detail=store.goalDetail(d.userId,d.goalId),fact=store.sources.queryCurrent(d.userId,d.goalId,r.provider)!
  const history=store.conversationContextPage(d.userId,d.goalId,undefined,100)
  store.health.readSourceReviewContext(d.eventId)
  return {review:{id:d.eventId,origin:'accepted_source_ready_bootstrap',input_version:d.inputVersion,
      original_source:{provider:r.provider,capabilities:r.capabilities,generation:r.generation,revision:r.revision,reference:r.reference,source_event_id:r.sourceEventId},
      legacy_task_ids:r.legacyTasks.map(t=>t.taskId),legacy_allowed_fields:['trigger'],preserve:['content','status','scheduled_at','reminder_plan','repeat'],
      legacy_completion:'Every open legacy task must have a durable user trigger: preserve an existing clock as time, otherwise waiting with a specific reason and resume condition.',
      new_tasks:'Only genuinely useful separate Agent tasks with registered triggers; never reinterpret the old human action. For newly available trading_history, create at most one useful history research task subscribed to that actual capability, read the private report during execution, and preserve missing user strategy mapping as a limitation.'},
    goal:detail.goal,revision:detail.revision,tasks:detail.tasks,
    source:{provider:r.provider,state:fact.state,generation:fact.generation,revision:fact.revision,reference:fact.reference,
      capabilities:fact.capabilities,private_data_read:false,
      available_fields:[{name:'tradingEquityUsd',unit:'USD'},{name:'assetCount',unit:'count'},{name:'positionCount',unit:'count'}],
      available_reports:fact.capabilities.includes('trading_history')?[{capability:'trading_history',meaning:'Fixed-window exact per-currency fill/bill costs and ordinary derivative PnL components with explicit coverage; must perform fresh bound read before any conclusion.'}]:[],
      unavailable_coverage:fact.capabilities.includes('trading_history')?['full_account_return','spot_opening_cost_basis','strategy_labels','strategy_performance_without_user_rules']:['orders','fills','trade_history','realized_returns','strategy_labels','strategy_performance']},
    conversation:history.items.map(m=>({event_id:m.eventId,role:m.role,text:m.text,audience:m.audience})),next_cursor:history.nextCursor,
    instruction:'Read every remaining original conversation/task page through the bound read tools before deciding; capability metadata is not a private read or analysis result.'}
}
export function finishSourceReview(store:AlongStore,d:HealthDispatch,body:unknown) {
  const input=SOURCE_REVIEW_FINISH.parse(body)
  const result={outcome:input.outcome,types:[] as string[],reason:input.reason,...(input.needs?{needs:input.needs}:{})}
  if(!sourceReviewCurrent(store,d))fail('source_review_unavailable')
  if(d.result) {if(!isDeepStrictEqual(d.result,result))fail('source_review_already_finished');return {status:'reviewed',outcome:input.outcome,reused:true}}
  if(!d.sourceReview?.contextReadAt)fail('read_source_review_context_first')
  const tasks=store.goalDetail(d.userId,d.goalId).tasks
  for(const original of d.sourceReview!.legacyTasks) {
    const task=store.getTask(d.userId,original.taskId),trigger=store.triggers.get(d.userId,original.taskId)
    if(task?.status==='open'&&(!trigger||trigger.taskRevision!==task.currentRevision||trigger.definition.actor!=='user'||
      (original.scheduledAt===undefined?trigger.definition.kind!=='waiting':trigger.definition.kind!=='time')))fail('source_review_legacy_trigger_not_persisted')
  }
  const changed=tasks.some(task=>store.taskRevisionOrigin(task.id,task.currentRevision)===d.eventId)
  if(input.outcome==='keep'&&changed||input.outcome==='revise'&&!changed)fail('source_review_outcome_must_match_applied_changes')
  for(const task of tasks.filter(t=>!d.sourceReview!.originalTaskIds.includes(t.id))) {
    if(store.taskRevisionOrigin(task.id,task.currentRevision)!==d.eventId)continue
    const trigger=store.triggers.get(d.userId,task.id)
    if(!trigger||trigger.taskRevision!==task.currentRevision||trigger.definition.actor!=='agent')fail('source_review_new_trigger_not_persisted')
  }
  store.health.finish(d,result)
  return {status:'reviewed',outcome:input.outcome,reused:false,task_completed:false,private_data_read:false}
}
