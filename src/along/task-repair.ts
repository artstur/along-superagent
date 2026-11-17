/** Private background maintenance capability. Neither a user message, a clock nor a health fact. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { AlongStore } from './store.ts'
import type { HealthDispatch } from './health-store.ts'
import type { AlongChangeSetInput, AlongCommitScope, AlongIdentity } from './service.ts'
import { TASK_TRIGGER_SCHEMA } from './task-trigger.ts'
import { localWeekday, supportsRecurrence } from './reminder-plan.ts'

const Id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/)
export const TASK_REVIEW_REQUEST=z.object({task_id:Id,evidence_event_id:Id,reason:z.string().trim().min(2).max(500)}).strict()
export const TASK_REVIEW_FINISH=z.object({outcome:z.enum(['repaired','already_valid','waiting']),reason:z.string().trim().min(2).max(800),
  expected_trigger:TASK_TRIGGER_SCHEMA.optional(),expected_repeat:z.enum(['once','daily','weekly']).optional()}).strict()
/** Stable maintenance refusal codes without private evidence, transport details or credentials. */
export class TaskReviewError extends Error {constructor(readonly code:string){super(code)}}
const fail=(code:string):never=>{throw new TaskReviewError(code)}

export function taskReviewEvidence(store:AlongStore,d:HealthDispatch) {
 const r=d.repair;if(!r)return undefined
 const source=store.getMessage(d.userId,`msg:${d.userId}:${r.evidenceEventId}`),inbox=store.findInboxEvent(d.userId,r.evidenceEventId)
 return source?.role==='user'&&source.direction==='inbound'&&source.audience==='conversation'&&inbox?.status==='accepted'
  &&inbox.eventType==='along.user_message'&&store.messageLinkedToGoal(source.id,d.goalId)?source:undefined
}
export function taskReviewCurrent(store:AlongStore,d:HealthDispatch):boolean {
 const r=d.repair;if(!r||r.retired||!store.health.pairingMatches(d.userId,r.deviceId)||d.inputVersion!==store.inputVersion(d.goalId)
  ||store.getGoal(d.userId,d.goalId)?.status!=='active'||!taskReviewEvidence(store,d))return false
 const task=store.getTask(d.userId,r.taskId)
 return !!task&&task.goalId===d.goalId&&task.status==='open'&&task.content===r.originalContent
  &&(r.originalScheduledAt===undefined||task.scheduledAt===r.originalScheduledAt)
  &&(task.currentRevision===r.revision||store.taskRevisionOrigin(task.id,task.currentRevision)===d.eventId)
}
export function requestTaskReview(store:AlongStore,identity:AlongIdentity,body:unknown):{review_id:string;status:'pending'|'done'|'waiting'|'invalidated';reused:boolean} {
 const input=TASK_REVIEW_REQUEST.parse(body)
 return store.atomic(()=>{
  if(!store.health.pairingMatches(identity.userId,identity.deviceId))return fail('task_review_identity_mismatch')
  const task=store.assertTaskOwner(identity.userId,input.task_id),goal=store.assertGoalOwner(identity.userId,task.goalId)
  if(goal.status!=='active'||task.status!=='open')return fail('task_review_unavailable')
  const source=store.getMessage(identity.userId,`msg:${identity.userId}:${input.evidence_event_id}`),inbox=store.findInboxEvent(identity.userId,input.evidence_event_id)
  if(!source||source.role!=='user'||source.direction!=='inbound'||source.audience!=='conversation'||inbox?.status!=='accepted'
   ||inbox.eventType!=='along.user_message'||!store.messageLinkedToGoal(source.id,goal.id))return fail('task_review_evidence_mismatch')
  const {dispatch:d,reused}=store.health.requestTaskReview({userId:identity.userId,deviceId:identity.deviceId,goalId:goal.id,taskId:task.id,revision:task.currentRevision,
   inputVersion:store.inputVersion(goal.id),evidenceEventId:input.evidence_event_id,scheduledAt:task.scheduledAt,content:task.content,reason:input.reason})
  return {review_id:d.eventId,status:d.repair?.retired?'invalidated':d.result?(d.result.outcome==='ask'?'waiting':'done'):'pending',
   reused}
 })
}
/** Applied inside the same AlongStore transaction as the existing ChangeSet writer. */
export function taskReviewChangeRefusal(store:AlongStore,input:AlongChangeSetInput,scope:AlongCommitScope):string|undefined {
 const d=scope.triggerEventId?store.health.get(scope.triggerEventId):undefined
 if(!d?.repair)return undefined
 if(d.userId!==scope.userId||d.goalId!==scope.allowedGoalId||d.result||!d.repair.contextReadAt||!taskReviewCurrent(store,d))return 'task_review_unavailable'
 for(const raw of input.ops) {
  const op=raw as {op?:unknown;task_id?:unknown;fields?:Record<string,unknown>}
  if(op?.op!=='task.update'||op.task_id!==d.repair.taskId||!op.fields||typeof op.fields!=='object'||Array.isArray(op.fields))return 'outside_task_review'
  if(Object.keys(op.fields).some(k=>!['trigger','repeat','reminder_plan','scheduled_at'].includes(k)))return 'outside_task_review'
  if(d.repair.originalScheduledAt!==undefined&&op.fields.scheduled_at!==undefined&&op.fields.scheduled_at!==d.repair.originalScheduledAt)return 'task_review_clock_preserved'
  const nextTrigger=op.fields.trigger as {kind?:unknown}|undefined
  const nextPlan=op.fields.reminder_plan as {state?:unknown}|undefined
  if(d.repair.originalScheduledAt!==undefined&&(nextTrigger&&typeof nextTrigger==='object'&&nextTrigger.kind!=='time'||nextPlan&&typeof nextPlan==='object'&&nextPlan.state!=='scheduled'))return 'task_review_clock_preserved'
  const plan=op.fields.reminder_plan as {state?:unknown;evidence_event_id?:unknown}|undefined
  if(plan&&typeof plan==='object'&&plan.state==='scheduled'&&plan.evidence_event_id!==d.repair.evidenceEventId)return 'task_review_evidence_mismatch'
 }
 return undefined
}
export function taskReviewContext(store:AlongStore,d:HealthDispatch) {
 if(!taskReviewCurrent(store,d)||d.result)return fail('task_review_unavailable')
 const evidence=taskReviewEvidence(store,d)!,detail=store.goalDetail(d.userId,d.goalId),task=store.assertTaskOwner(d.userId,d.repair!.taskId)
 store.health.readRepairContext(d.eventId)
 const history=store.conversationContextPage(d.userId,d.goalId,undefined,100)
 return {review:{id:d.eventId,reason:d.repair!.reason,origin:'host_task_trigger_maintenance',input_version:d.inputVersion,
  task_revision:d.repair!.revision,evidence_event_id:d.repair!.evidenceEventId,preserve_scheduled_at:d.repair!.originalScheduledAt,
  allowed_fields:['trigger','repeat','reminder_plan',...(d.repair!.originalScheduledAt===undefined?['scheduled_at']:[])]},
  goal:detail.goal,revision:detail.revision,task,trigger:store.triggers.get(d.userId,task.id)?.definition,
  evidence:{event_id:evidence.eventId,text:evidence.text,timezone:evidence.timezone},
  conversation:history.items.map(m=>({event_id:m.eventId,role:m.role,text:m.text,audience:m.audience})),next_cursor:history.nextCursor}
}
export function finishTaskReview(store:AlongStore,d:HealthDispatch,body:unknown) {
 const input=TASK_REVIEW_FINISH.parse(body)
 const result={outcome:input.outcome==='waiting'?'ask':input.outcome==='repaired'?'update':'keep',types:[] as string[],reason:input.reason,
  ...(input.expected_trigger?{expected_trigger:input.expected_trigger}:{}),...(input.expected_repeat?{expected_repeat:input.expected_repeat}:{})}
 if(!taskReviewCurrent(store,d))return fail('task_review_unavailable')
 if(d.result) {if(!isDeepStrictEqual(d.result,result))return fail('task_review_already_finished');return {status:d.result.outcome==='ask'?'waiting':'done',reused:true}}
 if(!d.repair?.contextReadAt)return fail('task_review_unavailable')
 if(input.outcome!=='waiting') {
  const task=store.assertTaskOwner(d.userId,d.repair!.taskId),trigger=store.triggers.get(d.userId,task.id),plan=task.reminderPlan
  if(!input.expected_trigger||!trigger||trigger.taskRevision!==task.currentRevision||!isDeepStrictEqual(trigger.definition,input.expected_trigger))return fail('task_review_trigger_not_persisted')
  if(input.outcome==='repaired'&&(task.currentRevision<=d.repair!.revision||store.taskRevisionOrigin(task.id,task.currentRevision)!==d.eventId))return fail('task_review_changes_not_applied')
  if(trigger.definition.kind==='time') {
   if(!task.scheduledAt||!Number.isFinite(Date.parse(task.scheduledAt))||Date.parse(task.scheduledAt)<=Date.now()||plan?.state!=='scheduled'||!input.expected_repeat||plan.repeat!==input.expected_repeat)return fail('task_review_time_plan_not_persisted')
   const daily=store.health.daily(task.id)
   if(plan.repeat==='once'&&daily)return fail('task_review_cadence_not_persisted')
   if(plan.repeat!=='once') {
    const source=taskReviewEvidence(store,d)
    if(!daily||!daily.zone||!daily.wallTime||daily.evidence!==d.repair!.evidenceEventId||!daily.quote||!daily.action||!source
     ||!supportsRecurrence(source.text,daily.quote,daily.action,task.content,plan.repeat,daily.weekday??1,plan.recurrenceSource)
     ||plan.timezone!==daily.zone||plan.wallTime!==daily.wallTime
     ||plan.repeat==='weekly'&&(plan.weekday!==daily.weekday||localWeekday(task.scheduledAt,daily.zone)!==daily.weekday))return fail('task_review_cadence_not_persisted')
   }
  }else if(input.expected_repeat!==undefined)return fail('task_review_non_time_repeat')
 }
 store.health.finish(d,result)
 return {status:input.outcome==='waiting'?'waiting':'done',reused:false}
}

/** Backstop against implicit writer effects: a successful repair cannot commit forbidden task-field changes. */
export function assertTaskReviewWrite(store:AlongStore,scope:AlongCommitScope):void {
 const d=scope.triggerEventId?store.health.get(scope.triggerEventId):undefined
 if(d?.repair&&!taskReviewCurrent(store,d))return fail('task_review_fields_changed')
}
