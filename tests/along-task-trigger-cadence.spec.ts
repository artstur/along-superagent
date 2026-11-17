import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AlongStore } from '../src/along/store.ts'
import { AlongService } from '../src/along/service.ts'
import { createInbox } from '../src/along/inbox.ts'
import { createChangeSetModule } from '../src/along/changeset.ts'
import { alongTools } from '../src/along/tools.ts'
import { supportsRecurrence } from '../src/along/reminder-plan.ts'
const userId='u_cadence',deviceId='d_cadence',dirs:string[]=[],stores:AlongStore[]=[]
afterEach(()=>{vi.useRealTimers();for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true})})
function setup(){
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2027-01-03T00:00:00Z'))
 const dir=mkdtempSync(join(tmpdir(),'along-cadence-'));dirs.push(dir)
 const store=new AlongStore(join(dir,'along.sqlite'));stores.push(store);store.assertUser(userId,deviceId)
 const service=new AlongService(store,{inbox:createInbox(store),changeset:createChangeSetModule(store)})
 const goal=store.insertGoal({userId,domain:'custom'});store.appendGoalRevision({userId,goalId:goal.id,title:'保持健康生活方式',status:'active'});store.ensureInputVersion(userId,goal.id)
 const text='想保持健康的生活方式，周二和周五尽量去做瑜伽（前一天需要预约）。'
 service.acceptEvent({event_id:'routine',schema_version:'1',event_type:'along.user_message',goal_id:goal.id,occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text}},{userId,deviceId})
 let eventId:string|undefined='routine',seq=0
 const tool=alongTools({service,scopeFor:()=>({userId,allowedGoalId:goal.id,triggerEventId:eventId})},'cadence').find(t=>t.name==='along_changes_commit')!
 const commit=(ops:unknown[])=>tool.execute(tool.schema.parse({idempotency_key:'cadence_'+ ++seq,base_revision:store.getGoal(userId,goal.id)!.currentRevision,input_version:store.inputVersion(goal.id),reason:'保留原任务，落实持续目标的预约安排',ops}),new AbortController().signal)
 const plan={state:'scheduled',source:'agent',explanation:'在上课前一天上午提醒预约，09:00由Agent选择',evidence:'周二和周五尽量去做瑜伽（前一天需要预约）',action:'瑜伽'}
 const trigger={kind:'time',actor:'user',capability:'reminder'}
 return {store,service,goal,text,plan,trigger,commit,background:()=>{eventId=undefined}}
}
it('persists both booking weekdays from the ongoing goal and repairs a date-only task without adding personal chat',async()=>{
 const {store,goal,plan,trigger,commit,background}=setup()
 expect(await commit([{op:'task.create',content:'周一预约周二瑜伽课',scheduled_at:'2027-01-04T09:00:00+08:00',repeat:'weekly',trigger,reminder_plan:plan}])).toMatchObject({status:'applied'})
 const thursday=store.insertTask({userId,goalId:goal.id,content:'周四预约周五瑜伽课',scheduledAt:'2027-01-07T09:00:00+08:00'})
 const before=store.messagesByGoal(userId,goal.id,{limit:100}).items.length
 background()
 expect(await commit([{op:'task.update',task_id:thursday.id,base_revision:thursday.currentRevision,fields:{trigger,repeat:'weekly',reminder_plan:{...plan,evidence_event_id:'routine'}}}])).toMatchObject({status:'applied'})
 const tasks=store.goalDetail(userId,goal.id).tasks
 expect(tasks).toHaveLength(2)
 expect(tasks.map(t=>t.reminderPlan)).toEqual(expect.arrayContaining([expect.objectContaining({repeat:'weekly',weekday:1}),expect.objectContaining({repeat:'weekly',weekday:4})]))
 expect(store.getTask(userId,thursday.id)).toMatchObject({id:thursday.id,status:'open',content:thursday.content,scheduledAt:thursday.scheduledAt})
 expect(store.messagesByGoal(userId,goal.id,{limit:100}).items).toHaveLength(before)
})
it('completes only the reported weekly occurrence and retains the next cycle and count across duplicate feedback',async()=>{
 const {store,service,goal,plan,trigger,commit}=setup()
 await commit([{op:'task.create',content:'周四预约周五瑜伽课',scheduled_at:'2027-01-07T09:00:00+08:00',repeat:'weekly',trigger,reminder_plan:plan}])
 const task=store.goalDetail(userId,goal.id).tasks[0]!
 const complete=(id:string)=>service.acceptEvent({event_id:id,schema_version:'1',event_type:'along.message',kind:'task.completed',task_id:task.id,occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.message',kind:'task.completed',task_id:task.id}},{userId,deviceId})
 // A real booking can happen before the reminder; that occurrence must still advance the cursor.
 vi.setSystemTime(new Date('2027-01-07T00:30:00Z'))
 expect(complete('week_1')).toMatchObject({status:'accepted'})
 expect(store.getTask(userId,task.id)).toMatchObject({status:'open',scheduledAt:'2027-01-14T01:00:00.000Z',reminderPlan:{repeat:'weekly',weekday:4}})
 expect(complete('week_1')).toMatchObject({status:'duplicate'})
 expect(complete('week_1_tap_again')).toMatchObject({status:'accepted'})
 expect(store.taskExecution(userId,task.id).count).toBe(1)
 vi.setSystemTime(new Date('2027-01-14T02:00:00Z'))
 expect(complete('week_2')).toMatchObject({status:'accepted'})
 expect(store.getTask(userId,task.id)).toMatchObject({status:'open',scheduledAt:'2027-01-21T01:00:00.000Z'})
 expect(store.taskExecution(userId,task.id).count).toBe(2)
 store.appendTaskRevision({userId,taskId:task.id,status:'cancelled'})
 expect(complete('late_after_cancel')).toMatchObject({status:'rejected',reason:'task_cancelled'})
 expect(store.getTask(userId,task.id)?.status).toBe('cancelled')
 expect(store.taskExecution(userId,task.id).count).toBe(2)
})
it.each(['周五去广州一趟','仅本周四预约周五瑜伽课','如果每周四预约周五瑜伽课会怎样','不要每周四预约周五瑜伽课'])('does not invent weekly authority for %s',text=>{
 expect(supportsRecurrence(text,text,'瑜伽','周四预约周五瑜伽课','weekly',4)).toBe(false)
})
it('validates the activity identity across a preceding-day clause without requiring redundant weekday prose',async()=>{
 const {plan,trigger,commit}=setup()
 const op=(at:string)=>({op:'task.create',content:'提前一天预约瑜伽：预约周五的瑜伽课程',scheduled_at:at,repeat:'weekly',trigger,
  reminder_plan:{...plan,action:'预约瑜伽'}})
 expect(await commit([op('2027-01-07T09:00:00+08:00')])).toMatchObject({status:'applied'})
 expect(await commit([op('2027-01-08T09:00:00+08:00')])).toMatchObject({status:'invalid',reason:'task_scoped_repeat_evidence_required',diagnostic:{op_index:0}})
})
it('retains a daily action and its adjacent lead-time reminder without borrowing cadence from an unrelated action',()=>{
 const quote='每天凌晨2点前入睡，提前半小时提醒我'
 expect(supportsRecurrence(quote,quote,'入睡','睡前准备并在凌晨2点前入睡','daily',1)).toBe(true)
 expect(supportsRecurrence('每天散步，明天提醒喝水','每天散步，明天提醒喝水','喝水','喝水','daily',1)).toBe(false)
})
