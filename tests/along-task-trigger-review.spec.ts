import {afterEach,expect,it} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {ALONG_SCHEMA_VERSION} from '../src/along/schema.ts'
import {AlongStore} from '../src/along/store.ts'
import {AlongService} from '../src/along/service.ts'
import {createInbox} from '../src/along/inbox.ts'
import {createChangeSetModule} from '../src/along/changeset.ts'
import {alongSourceRequest} from '../src/along/api.ts'
import {requestTaskReview,taskReviewContext,finishTaskReview,taskReviewCurrent} from '../src/along/task-repair.ts'

const dirs:string[]=[],stores:AlongStore[]=[]
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true})})
function fixture(text='每周四9点提醒我预约西语课。'){
 const dir=mkdtempSync(join(tmpdir(),'along-task-repair-'));dirs.push(dir);const path=join(dir,'along.sqlite')
 const store=new AlongStore(path);stores.push(store)
 const identity={userId:'u_00112233',deviceId:'d_00112233'},userId=identity.userId;store.assertUser(userId,identity.deviceId)
 const goal=store.insertGoal({userId,domain:'custom'});store.appendGoalRevision({userId,goalId:goal.id,title:'每周学习语言',context:['持续上课，提前预约'],status:'active'});store.ensureInputVersion(userId,goal.id)
 const service=new AlongService(store,{inbox:createInbox(store),changeset:createChangeSetModule(store),taskReviews:{requestTaskReview:(who,body)=>requestTaskReview(store,who,body)}})
 service.acceptEvent({event_id:'real_synthetic_user',schema_version:'1',event_type:'along.user_message',goal_id:goal.id,occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text}},identity)
 const task=store.insertTask({userId,goalId:goal.id,content:'周四预约周五西语课',scheduledAt:'2030-01-03T01:00:00.000Z'});store.appendTaskRevision({userId,taskId:task.id})
 const input={task_id:task.id,evidence_event_id:'real_synthetic_user',reason:'复核这项任务的持久触发和重复安排'}
 const request=()=>requestTaskReview(store,identity,input)
 const dispatch=()=>store.health.get(request().review_id)!
 const context=()=>taskReviewContext(store,dispatch())
 const definition={kind:'time' as const,actor:'user' as const,capability:'reminder' as const}
 let seq=0
 const commit=(ops:unknown[],d=dispatch())=>service.commitChangeSet({idempotency_key:'repair_'+ ++seq,goal_id:goal.id,
  base_revision:store.getGoal(userId,goal.id)!.currentRevision,input_version:store.inputVersion(goal.id),reason:'按真实用户委托修复同一任务',ops},
  {userId,allowedGoalId:goal.id,triggerEventId:d.eventId})
 const repair=()=>commit([{op:'task.update',task_id:task.id,base_revision:store.getTask(userId,task.id)!.currentRevision,fields:{trigger:definition,repeat:'weekly',reminder_plan:{state:'scheduled',source:'agent',explanation:'保留原来的09点，落实每周委托',evidence:'每周四9点提醒我预约西语课',action:'西语课',evidence_event_id:input.evidence_event_id}}}])
 return{dir,path,store,identity,userId,goal,task,service,input,request,dispatch,context,definition,commit,repair}
}
it('persists one distinct non-observation review and reuses its original capture across own applied revisions and restart',()=>{
 const f=fixture(),first=f.request();expect(first).toMatchObject({status:'pending',reused:false});expect(f.request()).toMatchObject({review_id:first.review_id,reused:true})
 const d=f.dispatch();expect(d).toMatchObject({snapshot:[],repair:{taskId:f.task.id,revision:1,evidenceEventId:f.input.evidence_event_id,deviceId:f.identity.deviceId}});expect(d.due).toBeUndefined()
 f.context();expect(f.repair()).toMatchObject({status:'applied'});expect(f.request().review_id).toBe(first.review_id)
 f.store.close();stores.splice(stores.indexOf(f.store),1);const reopened=new AlongStore(f.path);stores.push(reopened)
 expect(reopened.health.get(first.review_id)?.repair).toMatchObject(d.repair!);expect(requestTaskReview(reopened,f.identity,f.input).review_id).toBe(first.review_id)
})
it('requires accepted direct owned goal evidence, current pairing and an open active task',()=>{
 const f=fixture();expect(()=>requestTaskReview(f.store,{...f.identity,deviceId:'d_ffffffff'},f.input)).toThrow('task_review_identity_mismatch')
 expect(()=>requestTaskReview(f.store,f.identity,{...f.input,user_id:f.userId})).toThrow()
 expect(()=>requestTaskReview(f.store,f.identity,{...f.input,evidence_event_id:'unknown'})).toThrow('task_review_evidence_mismatch')
 const other=f.store.insertGoal({userId:f.userId,domain:'custom'});f.store.appendGoalRevision({userId:f.userId,goalId:other.id,title:'另一目标',status:'active'})
 const foreign=f.store.insertTask({userId:f.userId,goalId:other.id,content:'别的目标任务'})
 expect(()=>requestTaskReview(f.store,f.identity,{...f.input,task_id:foreign.id})).toThrow('task_review_evidence_mismatch')
 f.store.appendTaskRevision({userId:f.userId,taskId:f.task.id,status:'cancelled'});expect(f.request).toThrow('task_review_unavailable')
})
it('constrains the existing ChangeSet writer to this task and preserves its clock, content and status',()=>{
 const f=fixture();f.context();const before=f.store.goalDetail(f.userId,f.goal.id)
 const other=f.store.insertTask({userId:f.userId,goalId:f.goal.id,content:'untouched sibling'})
 for(const op of [{op:'goal.update',title:'rewrite goal'},{op:'task.cancel',task_id:f.task.id,base_revision:1},
  {op:'task.update',task_id:other.id,base_revision:0,fields:{trigger:f.definition}},
  ...[{content:'rewrite'},{status:'done'},{scheduled_at:'2030-01-03T02:00:00Z'}].map(fields=>({op:'task.update',task_id:f.task.id,base_revision:1,fields}))]){
  expect(f.commit([op])).toMatchObject({status:'invalid'})
 }
 expect(f.store.getTask(f.userId,f.task.id)?.content).toBe(before.tasks[0]!.content);expect(f.store.getTask(f.userId,f.task.id)?.scheduledAt).toBe(f.task.scheduledAt)
 expect(f.store.getTask(f.userId,other.id)?.content).toBe('untouched sibling')
})
it('rejects plans and unpersisted trigger/cadence, then verifies the actual weekly repair without chat, notification, execution or health baseline',()=>{
 const f=fixture(),d=f.dispatch(),before=f.store.counts(f.userId)
 const snapshot=[{id:'synthetic_existing_health',type:'steps'}] as any;const baseline=f.store.health.dispatch(f.userId,f.goal.id,f.store.inputVersion(f.goal.id),snapshot);f.store.health.read(baseline.eventId,snapshot);f.store.health.finish(baseline,{outcome:'keep',types:['steps'],reason:'synthetic established baseline'})
 const health=f.store.health.state(f.goal.id);expect(health?.seenTypes).toEqual(['steps'])
 expect(()=>finishTaskReview(f.store,d,{outcome:'repaired',reason:'计划修好',expected_trigger:f.definition,expected_repeat:'weekly'})).toThrow('task_review_unavailable')
 f.context();expect(()=>finishTaskReview(f.store,f.dispatch(),{outcome:'repaired',reason:'只说已修好',expected_trigger:f.definition,expected_repeat:'weekly'})).toThrow('task_review_trigger_not_persisted')
 expect(f.repair()).toMatchObject({status:'applied'})
 expect(()=>finishTaskReview(f.store,f.dispatch(),{outcome:'repaired',reason:'伪报单次',expected_trigger:f.definition,expected_repeat:'once'})).toThrow('task_review_time_plan_not_persisted')
 const args={outcome:'repaired',reason:'已持久化并核对每周四09点',expected_trigger:f.definition,expected_repeat:'weekly'}
 expect(finishTaskReview(f.store,f.dispatch(),args)).toEqual({status:'done',reused:false});expect(finishTaskReview(f.store,f.dispatch(),args)).toEqual({status:'done',reused:true})
 expect(f.store.health.state(f.goal.id)).toEqual(health);expect(f.store.counts(f.userId).messages).toBe(before.messages)
 expect(f.store.taskExecution(f.userId,f.task.id).count).toBe(0);expect(f.store.syncPage(f.userId,0,100).items.some(i=>(i.payload as any).notification)).toBe(false)
 expect(f.store.getTask(f.userId,f.task.id)).toMatchObject({status:'open',content:f.task.content,scheduledAt:f.task.scheduledAt,reminderPlan:{repeat:'weekly',weekday:4,timezone:'Asia/Shanghai'}})
})
it.each(['input','cancel','archive','foreign_revision','pairing'] as const)('rejects an obsolete repair after %s changes',kind=>{
 const f=fixture(),d=f.dispatch();f.context()
 if(kind==='input')f.store.raiseInputVersion(f.userId,f.goal.id,'new_real_input')
 if(kind==='cancel')f.store.appendTaskRevision({userId:f.userId,taskId:f.task.id,status:'cancelled'})
 if(kind==='archive')f.store.appendGoalRevision({userId:f.userId,goalId:f.goal.id,title:'archived',status:'archived'})
 if(kind==='foreign_revision')f.store.appendTaskRevision({userId:f.userId,taskId:f.task.id,originEventId:'different_work'})
 if(kind==='pairing')f.store.assertUser(f.userId,'d_ffffffff')
 expect(taskReviewCurrent(f.store,d)).toBe(false);expect(f.commit([{op:'task.update',task_id:f.task.id,base_revision:1,fields:{trigger:f.definition}}],d)).toMatchObject({status:'invalid',reason:'task_review_unavailable'})
 expect(()=>finishTaskReview(f.store,d,{outcome:'waiting',reason:'不能使用旧授权'})).toThrow('task_review_unavailable')
})
it('records waiting separately without pretending that an unconfigured trigger is complete',()=>{
 const f=fixture();f.context();expect(finishTaskReview(f.store,f.dispatch(),{outcome:'waiting',reason:'缺少必要预约窗口，等待真实补充'})).toMatchObject({status:'waiting'})
 expect(f.request()).toMatchObject({status:'waiting',reused:true});expect(f.store.triggers.get(f.userId,f.task.id)).toBeUndefined();expect(f.store.taskExecution(f.userId,f.task.id).count).toBe(0)
})
it('keeps the entry under original private bridge authentication and refuses body or device identity forgery',async()=>{
 const f=fixture(),token='a'.repeat(64),host={along:f.service,bridgeToken:token,settings:{} as any}
 const call=(body:unknown,headers:Record<string,string>={})=>alongSourceRequest(host,{method:'POST',path:'maintenance/task-trigger-reviews',query:new URLSearchParams(),headers:{'x-along-bridge':'1','x-along-bridge-token':token,'x-along-user':f.userId,'x-along-device':f.identity.deviceId,...headers},body:async()=>body})
 expect(await call(f.input,{'x-along-bridge-token':'wrong'})).toMatchObject({status:401});expect(await call({...f.input,user_id:f.userId})).toMatchObject({status:400,body:{error:'identity_in_body'}})
 expect(await call(f.input,{'x-along-device':'d_ffffffff'})).toMatchObject({status:400,body:{error:'task_review_identity_mismatch'}});expect(await call(f.input)).toMatchObject({status:200,body:{status:'pending'}})
})

it('migrates schema 11 to 12 transactionally while preserving all original goals, tasks and evidence',()=>{
 const f=fixture(),before=f.store.goalDetail(f.userId,f.goal.id);f.store.close();stores.splice(stores.indexOf(f.store),1)
 const old=new DatabaseSync(f.path);old.exec('DROP TABLE task_trigger_review');old.prepare("UPDATE meta SET value='11' WHERE key='schema_version'").run();old.close()
 const reopened=new AlongStore(f.path);stores.push(reopened);expect(reopened.goalDetail(f.userId,f.goal.id)).toEqual(before)
 expect(requestTaskReview(reopened,f.identity,f.input)).toMatchObject({status:'pending'})
 const probe=new DatabaseSync(f.path);expect(probe.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value).toBe(String(ALONG_SCHEMA_VERSION));probe.close()
})

it('retains old pairing invalidation while a legitimately new bound device receives a distinct review',()=>{
 const f=fixture(),old=f.dispatch(),replacement={userId:f.userId,deviceId:'d_ffffffff'};f.store.assertUser(f.userId,replacement.deviceId)
 const newer=requestTaskReview(f.store,replacement,f.input);expect(newer.review_id).not.toBe(old.eventId);expect(taskReviewCurrent(f.store,old)).toBe(false);expect(f.store.health.get(newer.review_id)?.repair?.deviceId).toBe(replacement.deviceId)
})

it('cannot clear an existing clock through implicit off-plan effects, and rolls back a misbehaving writer',()=>{
 const f=fixture(),d=f.dispatch();f.context()
 expect(f.commit([{op:'task.update',task_id:f.task.id,base_revision:1,fields:{trigger:{kind:'immediate',actor:'agent',capability:'reminder'},reminder_plan:{state:'off',reason:'untimed'}}}])).toMatchObject({status:'invalid',reason:'task_review_clock_preserved'})
 const broken=new AlongService(f.store,{changeset:{commitChangeSet(){f.store.appendTaskRevision({userId:f.userId,taskId:f.task.id,scheduledAt:null,originEventId:d.eventId});return{status:'applied'}}}})
 expect(()=>broken.commitChangeSet({idempotency_key:'synthetic_writer_fault',goal_id:f.goal.id,base_revision:1,input_version:f.store.inputVersion(f.goal.id),reason:'controlled writer fault',ops:[{op:'task.update',task_id:f.task.id,base_revision:1,fields:{trigger:f.definition}}]}, {userId:f.userId,allowedGoalId:f.goal.id,triggerEventId:d.eventId})).toThrow('task_review_fields_changed')
 expect(f.store.getTask(f.userId,f.task.id)).toMatchObject({currentRevision:1,scheduledAt:f.task.scheduledAt})
})
it('an ordinary health-context read cannot substitute for the explicit maintenance context capability',()=>{
 const f=fixture(),d=f.dispatch();f.store.health.read(d.eventId,[])
 expect(f.commit([{op:'task.update',task_id:f.task.id,base_revision:1,fields:{trigger:f.definition}}])).toMatchObject({status:'invalid',reason:'task_review_unavailable'})
})
it('keeps the review and its outbox in the caller transaction when admission is rolled back',()=>{
 const f=fixture();expect(()=>f.store.atomic(()=>{f.request();throw Error('controlled rollback')})).toThrow('controlled rollback')
 expect(f.store.health.pending().filter(d=>d.repair)).toEqual([]);expect(f.request()).toMatchObject({status:'pending',reused:false})
})

it('honors the actually persisted Agent-inferred cadence authority without reapplying the old user-wording template',()=>{
 const quote='我想持续学习西语，坚持固定上课，西语课需要提前预约。',f=fixture(quote);f.context()
 expect(f.commit([{op:'task.update',task_id:f.task.id,base_revision:1,fields:{trigger:f.definition,repeat:'weekly',reminder_plan:{state:'scheduled',source:'agent',recurrence_source:'agent',explanation:'在长期授权目标内推定每周复查，并保留既有钟点',evidence:quote,action:'西语课',evidence_event_id:f.input.evidence_event_id}}}])).toMatchObject({status:'applied'})
 expect(f.store.getTask(f.userId,f.task.id)?.reminderPlan).toMatchObject({repeat:'weekly',recurrenceSource:'agent'})
 expect(finishTaskReview(f.store,f.dispatch(),{outcome:'repaired',reason:'已核对宿主接受的语义推定周期',expected_trigger:f.definition,expected_repeat:'weekly'})).toMatchObject({status:'done'})
 const limited='只在本周四预约一次西语课。',once=fixture(limited);once.context()
 expect(once.commit([{op:'task.update',task_id:once.task.id,base_revision:1,fields:{trigger:once.definition,repeat:'weekly',reminder_plan:{state:'scheduled',source:'agent',recurrence_source:'agent',explanation:'不能越过用户单次限制',evidence:limited,action:'西语课',evidence_event_id:once.input.evidence_event_id}}}])).toMatchObject({status:'invalid'})
})
