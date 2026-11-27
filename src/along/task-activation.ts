/** Arms typed tasks through the existing durable due-task pipeline; it never runs a second scheduler. */
import { createHash } from 'node:crypto'
import type { AlongStore, TaskRow, HealthSummaryRow } from './store.ts'
import type { HealthDispatch } from './health-store.ts'
import type { TaskCapability, TaskCondition, TriggerOccurrence, TriggerRow } from './task-trigger.ts'

export interface SourceConditionFact {
  state:string;generation:number;revision:number;reference:string;capabilities:readonly string[]
}
export interface ActivationHost {
  readonly store:AlongStore
  readonly available?:(capability:TaskCapability)=>boolean
  readonly source?:(userId:string,goalId:string,provider:'okx')=>SourceConditionFact|undefined
  readonly allowed?:(userId:string)=>boolean
  readonly currentHealth?:(summary:HealthSummaryRow)=>boolean
}
interface ConditionResult {ready:boolean;token:string;reason?:string}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,32)

/** Reads trusted conditions, persists one logical occurrence and lets HealthFollowup dispatch it normally. */
export class TaskActivation {
  constructor(private readonly host:ActivationHost) {}
  private executorAvailable(row:TriggerRow):boolean {
    const d=row.definition
    const privateHistory=d.actor==='agent'&&d.capability==='research'&&d.conditions?.some(c=>
      (c.kind==='source_ready'||c.kind==='source_updated')&&c.capability==='trading_history')
    return !!privateHistory||!this.host.available||this.host.available(d.capability)
  }
  /** Configuration loss pauses the same occurrence; it is not a stale input or a new execution. */
  capabilityAvailable(dispatch:HealthDispatch):boolean {
    if(!dispatch.due)return true
    const row=this.host.store.triggers.get(dispatch.userId,dispatch.due.taskId)
    return !row||this.executorAvailable(row)
  }
  private conditions(row:TriggerRow):ConditionResult {
    const tokens:string[]=[]
    for(const condition of row.definition.conditions??[]) {
      const result=this.condition(row,condition)
      if(!result.ready)return result
      tokens.push(result.token)
    }
    return {ready:true,token:digest(tokens)}
  }
  private condition(row:TriggerRow,c:TaskCondition):ConditionResult {
    const store=this.host.store
    if(c.kind==='source_ready'||c.kind==='source_updated') {
      const fact=this.host.source?.(row.userId,row.goalId,c.provider)
      if(!fact||fact.state!=='ready'||!fact.capabilities.includes(c.capability))return {ready:false,token:'',reason:'等待数据源连接并授权读取'}
      return {ready:true,token:`source:${c.provider}:${fact.generation}:${fact.revision}:${fact.reference}`}
    }
    if(c.kind==='health_available') {
      const fact=store.latestHealthSummaries(row.userId).find(s=>s.type===c.type&&s.adapter==='known'&&s.availability==='ok'&&(!this.host.currentHealth||this.host.currentHealth(s)))
      return fact?{ready:true,token:`health:${fact.id}:${fact.metricVersion}`}:{ready:false,token:'',reason:'等待所需健康摘要'}
    }
    const task=store.getTask(row.userId,c.task_id)
    if(!task||task.goalId!==row.goalId||task.status==='cancelled')return {ready:false,token:'',reason:'等待前置任务完成'}
    const completed=store.triggers.dependencyFact(row.userId,task.id)
    const dependent=store.getTask(row.userId,row.taskId)
    if(completed&&store.health.daily(task.id)&&dependent&&Date.parse(completed.completedAt??completed.createdAt)<Date.parse(dependent.createdAt))
      return {ready:false,token:'',reason:'等待前置周期任务本次完成'}
    if(completed)return {ready:true,token:`completed:${completed.id}:${completed.completionEventId??completed.outcome}`}
    return task.status==='done'&&task.completedFeedbackEventId
      ?{ready:true,token:`completed:${task.id}:${task.completedFeedbackEventId}`}
      :{ready:false,token:'',reason:'等待前置任务完成'}
  }
  /** Evaluates current state as well as new events, so an already-ready source can unlock a newly created task. */
  prepare(now=new Date().toISOString()):void {
    const store=this.host.store
    for(const row of store.triggers.list()) {
      const task=store.getTask(row.userId,row.taskId),goal=store.getGoal(row.userId,row.goalId)
      if(task?.status==='done'&&goal?.status==='active') {store.triggers.setState(row,'settled');continue}
      if(!task||task.status!=='open'||goal?.status!=='active') {store.triggers.cancel(row.userId,row.taskId);continue}
      if(this.host.allowed&&!this.host.allowed(row.userId)) {store.triggers.setState(row,'waiting','等待授权恢复');continue}
      if(row.state==='cancelled'||row.state==='settled')continue
      if(task.currentRevision!==row.taskRevision)continue
      const d=row.definition
      if(d.actor==='user'&&task.reminderPlan?.state==='off'&&task.reminderPlan.reason==='opt_out') {
        store.triggers.setState(row,'waiting','等待你的完成反馈');continue
      }
      // Private history research uses the installed report interpreter, not the optional public web connector.
      // Its actual source condition, read freshness and finish proof remain independently checked.
      if(!this.executorAvailable(row)) {
        store.triggers.observeMissingCapability(row)
        store.triggers.setState(row,'waiting','等待执行能力恢复');continue
      }
      const condition=this.conditions(row)
      if(!condition.ready) {store.triggers.setState(row,'waiting',condition.reason);continue}
      if(d.kind==='waiting'&&d.actor==='user') {store.triggers.setState(row,'waiting',d.reason);continue}
      if(d.kind==='waiting'&&d.resume==='capability_available'&&!d.conditions?.length&&!row.capabilityMissing) {
        store.triggers.setState(row,'waiting',d.reason);continue
      }
      if(d.kind==='waiting'&&d.resume==='user_input'&&store.inputVersion(row.goalId)<=row.inputVersion) {
        store.triggers.setState(row,'waiting','等待补充信息');continue
      }
      if(d.kind==='time') {
        if(!task.scheduledAt) {store.triggers.setState(row,'waiting','等待安排执行时间');continue}
        if(Date.parse(task.scheduledAt)>Date.parse(now)) {store.triggers.setState(row,'scheduled');continue}
        const prior=store.triggers.forTime(row.userId,row.taskId,task.scheduledAt)
        if(prior&&prior.state!=='settled'&&(prior.conditionsToken!==condition.token||prior.inputVersion!==store.inputVersion(row.goalId))) {
          store.triggers.invalidate(prior)
          store.appendTaskRevision({taskId:task.id,userId:task.userId,scheduledAt:task.scheduledAt,
            originEventId:`activation_${digest([row.taskId,row.generation,condition.token,store.inputVersion(row.goalId)])}`})
        }
        const current=store.assertTaskOwner(row.userId,row.taskId)
        store.triggers.claim(current,'time:'+new Date(task.scheduledAt).toISOString(),task.scheduledAt,store.inputVersion(row.goalId),condition.token)
        continue
      }
      const key=d.kind==='immediate'?'immediate':d.kind==='waiting'
        ?d.resume==='user_input'?`input:${store.inputVersion(row.goalId)}`:`capability:${d.capability}`
        :`event:${condition.token}`
      // An active occurrence is kept while its conditions stay current. A changed source invalidates
      // only unfinished work; an old generation cannot execute after a disconnect/reconnect.
      const prior=row.lastKey&&store.triggers.forTime(row.userId,row.taskId,task.scheduledAt??'')
      if(prior&&prior.key===key&&prior.state!=='invalidated'&&prior.conditionsToken===condition.token&&prior.inputVersion===store.inputVersion(row.goalId)) {
        if(prior.state==='pending'||prior.state==='dispatched')store.triggers.setState(row,'running')
        continue
      }
      if(prior&&prior.state!=='settled')store.triggers.invalidate(prior)
      store.atomic(()=>{
        const current=store.assertTaskOwner(row.userId,row.taskId)
        if(current.status!=='open'||current.currentRevision!==row.taskRevision)return
        const at=now
        // scheduled_at is the actual activation instant for the common due pipeline. Its public
        // trigger remains immediate/event, so it is not mislabeled as a timed human reminder.
        store.appendTaskRevision({taskId:current.id,userId:current.userId,scheduledAt:at,originEventId:`activation_${digest([row.taskId,row.generation,key])}`})
        const armed=store.assertTaskOwner(row.userId,row.taskId)
        const item=store.triggers.claim(armed,key,at,store.inputVersion(row.goalId),condition.token)
        if(!item)return
        store.appendSync({userId:row.userId,goalId:row.goalId,taskId:row.taskId,kind:'task_updated',
          payload:{task_id:row.taskId,goal_id:row.goalId,revision:armed.currentRevision,status:armed.status}})
      })
    }
  }
  allowDue(task:TaskRow):boolean {
    const row=this.host.store.triggers.get(task.userId,task.id)
    if(!row)return true // Legacy clocks keep their existing behavior until explicitly migrated.
    if(row.state!=='running'||row.taskRevision!==task.currentRevision)return false
    const item=task.scheduledAt&&this.host.store.triggers.forTime(task.userId,task.id,task.scheduledAt)
    return !!item&&['pending','dispatched'].includes(item.state)&&this.currentOccurrence(item)
  }
  notifyBefore(task:TaskRow):boolean {
    const row=this.host.store.triggers.get(task.userId,task.id)
    return !row||row.definition.actor==='user'||row.definition.notify_before===true
  }
  bind(dispatch:HealthDispatch):void {
    if(!dispatch.due)return
    const item=this.host.store.triggers.forTime(dispatch.userId,dispatch.due.taskId,dispatch.due.dueAt)
    if(item)this.host.store.triggers.bindDispatch(item,dispatch.eventId)
  }
  current(dispatch:HealthDispatch):boolean {
    const item=this.host.store.triggers.forDispatch(dispatch.eventId)
    return !item||this.currentOccurrence(item)
  }
  private currentOccurrence(item:TriggerOccurrence):boolean {
    const store=this.host.store,row=store.triggers.get(item.userId,item.taskId),task=store.getTask(item.userId,item.taskId)
    if(!row||row.generation!==item.generation||row.state==='cancelled'||item.state==='invalidated'||!task||task.status!=='open')return false
    if(item.inputVersion!==store.inputVersion(item.goalId))return false
    const condition=this.conditions(row)
    return condition.ready&&condition.token===item.conditionsToken
  }
  definition(dispatch:HealthDispatch) {
    return dispatch.due?this.host.store.triggers.get(dispatch.userId,dispatch.due.taskId):undefined
  }
  occurrence(dispatch:HealthDispatch):TriggerOccurrence|undefined {return this.host.store.triggers.forDispatch(dispatch.eventId)}
  settle(dispatch:HealthDispatch,outcome:string):void {
    const item=this.occurrence(dispatch)
    if(item)this.host.store.triggers.settle(item,outcome)
  }
}
