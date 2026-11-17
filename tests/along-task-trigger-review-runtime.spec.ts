/** Real Engine/Runtime/SQLite and registered tools; model choices are fixture-controlled, no production data. */
import {afterEach,expect,it,vi} from 'vitest'
import {startRuntime,type Host} from './fixtures/host.ts'
import {alongKind} from '../src/sources/along.ts'
import {Store} from '../src/app/store.ts'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {alongSourceRequest} from '../src/along/api.ts'
const userId='u_1234abcd',deviceId='d_1234abcd'
let host:Host|undefined
const dirs:string[]=[]
afterEach(async()=>{await host?.stop();host=undefined;vi.useRealTimers();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true})})
async function setup(dir?:string){
 if(dir){const db=new Store(join(dir,'orchestrator.sqlite'));db.saveSettings({...db.settings(),eval:{...db.settings().eval,mode:'auto'},sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}},policy:{...db.settings().policy,sources:{along:{allowed:[{id:userId}],admission:{}}}}});db.close()}
 const h=host=dir?await startRuntime(undefined,{dir}):await startRuntime(s=>s.saveSettings({...s.settings(),sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}}}));if(!dir)h.runtime.sources.register(alongKind)
 const settings=h.runtime.store.settings();h.runtime.store.saveSettings({...settings,sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}},policy:{...settings.policy,sources:{along:{allowed:[{id:userId}],admission:{}}}}})
 const service=h.runtime.along!.service,store=service.alongStore;store.assertUser(userId,deviceId)
 const goal=store.insertGoal({userId,domain:'custom'});store.appendGoalRevision({userId,goalId:goal.id,title:'每周学习语言',context:['固定上课并提前预约'],status:'active'});store.ensureInputVersion(userId,goal.id)
 service.acceptEvent({event_id:'accepted_original_goal',schema_version:'1',event_type:'along.user_message',goal_id:goal.id,occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text:'每周四9点提醒我预约西语课。'}},{userId,deviceId})
 // This is preexisting user evidence, not a new maintenance-generated user event or runnable planner request.
 store.markDelivered('along:'+userId+':accepted_original_goal',new Date().toISOString())
 const task=store.insertTask({userId,goalId:goal.id,content:'周四预约周五西语课',scheduledAt:'2030-01-03T01:00:00.000Z'});store.appendTaskRevision({userId,taskId:task.id})
 const body={task_id:task.id,evidence_event_id:'accepted_original_goal',reason:'复核这一既有任务的持久trigger和周期'}
 const request=()=>alongSourceRequest({along:service,bridgeToken:'b'.repeat(64),settings:{} as any},{method:'POST',path:'maintenance/task-trigger-reviews',query:new URLSearchParams(),headers:{'x-along-bridge':'1','x-along-bridge-token':'b'.repeat(64),'x-along-user':userId,'x-along-device':deviceId},body:async()=>body})
 const worker=async()=>{await h.runtime.pump();await h.runtime.idle();const ticket=h.runtime.store.tickets.list().find(t=>t.mandate.basis.via==='task_trigger_review'&&!t.ended)!;expect(ticket).toBeDefined();await vi.waitFor(()=>expect(h.tools.has('worker-'+ticket.id)).toBe(true));return{ticket,session:'worker-'+ticket.id}}
 return{h,service,store,goal,task,request,worker}
}
it('automatically dispatches a new private Worker, repairs only the bound task, and reports ready after durable verification',async()=>{
 const f=await setup(),messages=f.store.counts(userId).messages,review=await f.request();expect(review).toMatchObject({status:200,body:{status:'pending',reused:false}})
 const {ticket,session}=await f.worker();const trigger=f.h.runtime.store.triggers.get(ticket.origin.triggerId)!
 expect(trigger).toMatchObject({human:false,meta:{event_type:'along.task_trigger_review',task_id:f.task.id}});expect(trigger.meta.health_dispatch).toBeUndefined()
 expect([...f.h.tools.get(session)!.keys()].sort()).toEqual(['along_task_review_context','along_task_review_finish','along_goal_read','along_conversation_read','along_task_list','along_changes_commit','orchestrator_report'].sort())
 await expect(f.h.runTool(session,'orchestrator_report',{state:'ready',summary:'只诊断，不落地'})).rejects.toThrow('not complete')
 const context=await f.h.runTool(session,'along_task_review_context',{});expect(context).toMatchObject({review:{origin:'host_task_trigger_maintenance',evidence_event_id:'accepted_original_goal'},task:{id:f.task.id},evidence:{text:'每周四9点提醒我预约西语课。'}})
 const definition={kind:'time',actor:'user',capability:'reminder'}
 const commit=(ops:unknown[])=>f.h.runTool(session,'along_changes_commit',{idempotency_key:'task_review_repair',base_revision:f.store.getGoal(userId,f.goal.id)!.currentRevision,input_version:f.store.inputVersion(f.goal.id),reason:'保留原钟点，补上真实每周委托',ops})
 expect(await commit([{op:'goal.update',fields:{title:'unauthorized'}}])).toMatchObject({status:'invalid',reason:'outside_task_review'})
 expect(await commit([{op:'task.update',task_id:f.task.id,base_revision:1,fields:{trigger:definition,repeat:'weekly',reminder_plan:{state:'scheduled',source:'agent',explanation:'保留原先09点，落实每周委托',evidence:'每周四9点提醒我预约西语课',action:'西语课',evidence_event_id:'accepted_original_goal'}}}])).toMatchObject({status:'applied'})
 expect(await f.request()).toMatchObject({body:{review_id:(review.body as any).review_id,reused:true}})
 expect(await f.h.runTool(session,'along_task_review_finish',{outcome:'repaired',reason:'已读取并核对真实每周四09点排程',expected_trigger:definition,expected_repeat:'weekly'})).toMatchObject({status:'done',reused:false})
 expect(await f.h.runTool(session,'orchestrator_report',{state:'ready',summary:'已保留原时间并补上每周四触发'})).toMatchObject({notification:'internal_only'})
 expect(f.store.getTask(userId,f.task.id)).toMatchObject({status:'open',scheduledAt:f.task.scheduledAt,reminderPlan:{repeat:'weekly',weekday:4,timezone:'Asia/Shanghai'}})
 expect(f.store.health.state(f.goal.id)).toBeUndefined();expect(f.store.taskExecution(userId,f.task.id).count).toBe(0)
 expect(f.store.conversationContextPage(userId,f.goal.id,undefined,100).items).toHaveLength(messages)
 expect(f.store.syncPage(userId,0,100).items.some(i=>(i.payload as any).notification)).toBe(false)
 await f.h.runtime.pump();expect(f.h.runtime.store.tickets.list().filter(t=>t.mandate.basis.via==='task_trigger_review')).toHaveLength(1)
},30_000)
it('invalidates a pending Worker on new input and rejects its old capabilities rather than pretending a clock or observation happened',async()=>{
 const f=await setup();await f.request();const {ticket,session}=await f.worker();await f.h.runTool(session,'along_task_review_context',{})
 f.store.raiseInputVersion(userId,f.goal.id,'synthetic_new_input')
 await expect(f.h.runTool(session,'along_task_review_finish',{outcome:'waiting',reason:'旧输入已过期'})).rejects.toThrow('unavailable')
 await f.h.runtime.pump();const d=f.store.health.get(ticket.mandate.basis.via==='task_trigger_review'?ticket.mandate.basis.eventId:'')!
 expect(d.repair?.retired).toBe(true);expect(f.store.triggers.get(userId,f.task.id)).toBeUndefined();expect(f.store.health.state(f.goal.id)).toBeUndefined()
},30_000)

it('retries a failed private review after durable report backoff on the same Ticket and occurrence',async()=>{
 const f=await setup();await f.request();const {ticket,session}=await f.worker()
 await f.h.runTool(session,'orchestrator_report',{state:'failed',summary:'synthetic temporary model outage'})
 await f.h.runtime.pump();expect(f.h.runtime.store.tickets.get(ticket.id)?.assignments).toHaveLength(1)
 const saved=f.h.runtime.store.tickets.get(ticket.id)!;saved.assignments.at(-1)!.report!.at='2020-01-01T00:00:00Z';f.h.runtime.store.tickets.save(saved)
 await f.h.runtime.pump();await f.h.runtime.idle();expect(f.h.runtime.store.tickets.list().filter(t=>t.mandate.basis.via==='task_trigger_review')).toHaveLength(1);expect(f.h.runtime.store.tickets.get(ticket.id)?.assignments).toHaveLength(2)
 expect(f.store.health.pending().filter(d=>d.repair)).toHaveLength(1);expect(f.store.taskExecution(userId,f.task.id).count).toBe(0)
},30_000)
it('recovers the durable review after real Runtime restarts without fabricating a new user event or duplicate Worker',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'along-task-review-restart-'));dirs.push(dir);const f=await setup(dir),request=await f.request(),id=(request.body as any).review_id
 await f.h.stop();host=undefined
 let h=host=await startRuntime(undefined,{dir});await h.runtime.pump();await h.runtime.idle()
 await vi.waitFor(()=>expect(h.runtime.store.tickets.list().filter(t=>t.mandate.basis.via==='task_trigger_review')).toHaveLength(1),{timeout:10_000})
 const first=h.runtime.store.tickets.list().filter(t=>t.mandate.basis.via==='task_trigger_review');expect(first).toHaveLength(1)
 const before=h.runtime.along!.service.alongStore.counts(userId);expect(h.runtime.along!.service.alongStore.health.get(id)?.repair?.taskId).toBe(f.task.id)
 await h.stop();host=undefined;h=host=await startRuntime(undefined,{dir});await h.runtime.pump();await h.runtime.idle()
 expect(h.runtime.store.tickets.list().filter(t=>t.mandate.basis.via==='task_trigger_review').map(t=>t.id)).toEqual(first.map(t=>t.id))
 expect(h.runtime.along!.service.alongStore.counts(userId).tasks).toBe(before.tasks);expect(h.runtime.along!.service.alongStore.health.state(f.goal.id)).toBeUndefined()
 expect(h.runtime.along!.service.alongStore.conversationContextPage(userId,f.goal.id,undefined,100).items.map(m=>m.eventId)).toEqual(['accepted_original_goal'])
},30_000)
