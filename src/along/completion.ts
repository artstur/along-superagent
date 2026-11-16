/** Along-only postconditions for an explicit task update; diagnostic work is not a persisted outcome. */
import { localWeekday,supportsRecurrence } from './reminder-plan.ts'
import type { AlongStore,MessageRow } from './store.ts'
import type { CommitScope } from './changeset.ts'
interface CompletionHost {
 readonly service:{readonly alongStore:AlongStore}
 readonly scopeFor:(ticketId:string)=>CommitScope|undefined
}
/** Deliberately narrow: a quoted add-weekly imperative, concrete clock, and exact action shared with this task. */
export function explicitWeeklyTaskRequest(message:Pick<MessageRow,'text'|'timezone'>,content:string) {
 for(const clause of message.text.split(/[，,。；;!?！？\n]/)) {
  const match=/(?:^|[:：])\s*((?:请)?补上每(?:个)?(?:周|星期|礼拜)([一二三四五六日天])\s*(北京时间)?\s*([01]?\d|2[0-3])[:：]([0-5]\d)\s*(.+))$/u.exec(clause.trim())
  if(!match)continue
  const quote=match[1]!.trim(),weekday='一二三四五六日'.indexOf(match[2]==='天'?'日':match[2]!)+1
  const action=match[6]!.trim().replace(/^(?:提醒我|通知我|叫我)/u,'')
  const zone:string=match[3]?'Asia/Shanghai':(message.timezone??'')
  if(action.length<2||action.length>100)continue
  let validTimezone=!!zone&&zone===message.timezone
  try {new Intl.DateTimeFormat('en',{timeZone:zone})}catch {validTimezone=false}
  if(supportsRecurrence(message.text,quote,action,content,'weekly',weekday))
   return {quote,action,weekday,zone,validTimezone,clock:`${match[4]!.padStart(2,'0')}:${match[5]}`}
 }
}
const clockAt=(instant:string,zone:string)=>new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(instant))
function weeklyCompletion(host:CompletionHost,ticketId:string) {
 const bound=host.scopeFor(ticketId),store=host.service.alongStore
 if(!bound?.allowedGoalId||!bound.triggerEventId)return
 const inbox=store.findInboxEvent(bound.userId,bound.triggerEventId)
 if(inbox?.eventType!=='along.user_message')return
 const source=store.getMessage(bound.userId,`msg:${bound.userId}:${bound.triggerEventId}`)
 const link=store.getWorkLink(ticketId)
 if(!source||source.role!=='user'||source.direction!=='inbound'||!link?.taskId||link.goalId!==bound.allowedGoalId)return
 if(!store.isCurrentChatInput(bound.userId,source.eventId,bound.allowedGoalId))return
 const task=store.getTask(bound.userId,link.taskId)
 if(!task||task.goalId!==bound.allowedGoalId)return
 const prior=store.taskBeforeMessage(bound.userId,task.id,source)
 if(!prior)return
 const expected=explicitWeeklyTaskRequest(source,prior.content)
 if(!expected)return
 const keepNext=source.text.split(/[。；;!?！？\n]/).some(clause=>!/(?:不要|不必|不用|无需|如果|假设|不保持|不保留)/u.test(clause)
  &&/(?:^|[，,：:])(?:请)?(?:保持|保留).{0,80}(?:下一次|下次).{0,40}(?:时刻|时间).{0,40}不变/u.test(clause))
 const preservedAt=keepNext&&prior.scheduledAt&&Date.parse(prior.scheduledAt)>Date.parse(source.receivedAt)?prior.scheduledAt:undefined
 const plan=task.reminderPlan,mandate=store.health.daily(task.id),at=task.scheduledAt
 const original=mandate&&store.getMessage(bound.userId,`msg:${bound.userId}:${mandate.evidence}`)
 const valid=expected.validTimezone&&task.status==='open'&&plan?.state==='scheduled'&&plan.repeat==='weekly'&&plan.weekday===expected.weekday
  &&plan.timezone===expected.zone&&mandate?.weekday===expected.weekday&&mandate.zone===expected.zone
  &&!!original&&original.role==='user'&&original.direction==='inbound'&&!!mandate.quote&&!!mandate.action
  &&supportsRecurrence(original.text,mandate.quote,mandate.action,task.content,'weekly',expected.weekday)
  &&!!at&&Number.isFinite(Date.parse(at))&&Date.parse(at)>Date.now()
  &&(!preservedAt||Date.parse(at)===Date.parse(preservedAt))
  &&localWeekday(at,expected.zone)===expected.weekday&&clockAt(at,expected.zone)===expected.clock
  &&Number.isFinite(Date.parse(mandate.wallTime))&&clockAt(mandate.wallTime,expected.zone)===expected.clock
 return {valid,task,expected,preservedAt}
}
export function weeklyCompletionNotice(host:CompletionHost,ticketId:string):string|undefined {
 const result=weeklyCompletion(host,ticketId)
 return result&&!result.valid?'该结果生成时，原任务的每周安排尚未落实；请以任务当前安排为准。':undefined
}
/** Only ready is a business-completion claim. This reads state and never commits or changes authority. */
export function assertAlongReport(host:CompletionHost,ticketId:string,state:string):void {
 if(state!=='ready')return
 const result=weeklyCompletion(host,ticketId)
 if(!result||result.valid)return
 const {task,expected,preservedAt}=result,plan=task.reminderPlan,at=task.scheduledAt
 throw new Error('requested_weekly_plan_incomplete: '+JSON.stringify({task_id:task.id,
  expected:{status:'open',repeat:'weekly',weekday:expected.weekday,timezone:expected.zone,clock:expected.clock,future_next_occurrence:true,...(preservedAt?{scheduled_at:preservedAt}:{})},
  actual:{status:task.status,revision:task.currentRevision,reminder_plan:plan,scheduled_at:at},
  guidance:'The explicit weekly task update is not complete. Read the live goal/task revisions and original user instruction; use the CURRENT REGISTERED along_changes_commit to update this SAME task with repeat:weekly and its exact authorized evidence/action. Preserve the existing valid next occurrence when unchanged by omitting scheduled_at. Read back the persisted plan before ready. Temporary packages, local database simulations and a subagent report are not an applied live operation. A partial recommendation may be delivered separately, but does not complete this task-update request. If genuinely blocked report blocked/failed truthfully; never claim ready.'}))
}
