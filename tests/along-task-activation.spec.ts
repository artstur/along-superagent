import { afterEach,expect,it,vi } from 'vitest'
import { mkdtempSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AlongStore } from '../src/along/store.ts'
import { TaskActivation } from '../src/along/task-activation.ts'
import { ALONG_CHANGE_SET_INPUT_SCHEMA, createChangeSetModule } from '../src/along/changeset.ts'
const dirs:string[]=[],stores:AlongStore[]=[]
afterEach(()=>{vi.useRealTimers();for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true})})
function fixture(){
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
 const dir=mkdtempSync(join(tmpdir(),'along-activation-'));dirs.push(dir)
 const path=join(dir,'along.sqlite'),store=new AlongStore(path);stores.push(store)
 const userId='u_activation';store.assertUser(userId,'d_activation')
 const goal=store.insertGoal({userId,domain:'custom'});store.appendGoalRevision({userId,goalId:goal.id,title:'合成确定性计算',status:'active'});store.ensureInputVersion(userId,goal.id)
 const task=store.insertTask({userId,goalId:goal.id,content:'计算合成预算余额'});store.appendTaskRevision({userId,taskId:task.id})
 store.triggers.put(store.assertTaskOwner(userId,task.id),{kind:'immediate',actor:'agent',capability:'calculation'},1)
 return {path,store,userId,goal,task}
}
it('rearms a pending immediate occurrence after newer input and retains only its logical execution key',()=>{
 const {store,userId,goal,task}=fixture(),activation=new TaskActivation({store})
 activation.prepare();const prior=store.getTask(userId,task.id)!,occ=store.triggers.forTime(userId,task.id,prior.scheduledAt!)!
 expect(activation.allowDue(prior)).toBe(true)
 store.raiseInputVersion(userId,goal.id,'synthetic_new_input');vi.setSystemTime(new Date('2030-01-01T00:00:01Z'))
 activation.prepare();const next=store.getTask(userId,task.id)!,resumed=store.triggers.forTime(userId,task.id,next.scheduledAt!)!
 expect(activation.allowDue(next)).toBe(true)
 expect(resumed).toMatchObject({id:occ.id,inputVersion:2,dueAt:next.scheduledAt,state:'pending'})
 expect(next.currentRevision).toBeGreaterThan(prior.currentRevision)
})
it.each(['permission','capability'])('recovers an armed occurrence after temporary %s loss without a duplicate',reason=>{
 const {store,userId,task}=fixture();let available=true,allowed=true
 const activation=new TaskActivation({store,available:()=>available,allowed:()=>allowed})
 activation.prepare();const at=store.getTask(userId,task.id)!.scheduledAt!,first=store.triggers.forTime(userId,task.id,at)!
 if(reason==='permission')allowed=false;else available=false
 activation.prepare();expect(activation.allowDue(store.assertTaskOwner(userId,task.id))).toBe(false)
 available=allowed=true;activation.prepare()
 expect(activation.allowDue(store.assertTaskOwner(userId,task.id))).toBe(true)
 expect(store.triggers.forTime(userId,task.id,at)?.id).toBe(first.id)
})
it('restores the same durable pending occurrence after reopening its SQLite file and never revives cancelled work',()=>{
 const f=fixture();new TaskActivation({store:f.store}).prepare()
 const task=f.store.assertTaskOwner(f.userId,f.task.id),first=f.store.triggers.forTime(f.userId,task.id,task.scheduledAt!)!
 f.store.close();stores.splice(stores.indexOf(f.store),1)
 const store=new AlongStore(f.path);stores.push(store);const activation=new TaskActivation({store})
 activation.prepare();expect(store.triggers.forTime(f.userId,task.id,task.scheduledAt!)?.id).toBe(first.id)
 expect(activation.allowDue(store.assertTaskOwner(f.userId,task.id))).toBe(true)
 store.appendTaskRevision({userId:f.userId,taskId:task.id,status:'cancelled'});activation.prepare()
 expect(store.triggers.byId(f.userId,first.id)?.state).toBe('invalidated')
 expect(activation.allowDue(store.assertTaskOwner(f.userId,task.id))).toBe(false)
})
it('does not mistake an installed calculator for missing source readiness, and rejects the unbound wait at runtime planning',()=>{
 const {store,userId,goal,task}=fixture()
 store.triggers.put(store.assertTaskOwner(userId,task.id),{kind:'waiting',actor:'agent',capability:'calculation',resume:'capability_available',reason:'等待账户摘要'},1)
 new TaskActivation({store,available:()=>true}).prepare()
 expect(store.getTask(userId,task.id)?.scheduledAt).toBeUndefined()
 expect(store.triggers.get(userId,task.id)).toMatchObject({state:'waiting'})
 expect(createChangeSetModule(store,{available:()=>true}).commitChangeSet({idempotency_key:'bad_capability_wait',goal_id:goal.id,base_revision:1,input_version:1,reason:'等待真实数据',ops:[{op:'task.create',content:'等待摘要后核算',trigger:{kind:'waiting',actor:'agent',capability:'calculation',resume:'capability_available',reason:'等待账户摘要'}}]},{userId,allowedGoalId:goal.id})).toMatchObject({status:'invalid',reason:'waiting_trigger_requires_condition'})
})
it('resumes an actually unavailable executor after restart, but keeps source-conditioned waits tied to the source',()=>{
 const f=fixture()
 f.store.triggers.put(f.store.assertTaskOwner(f.userId,f.task.id),{kind:'waiting',actor:'agent',capability:'research',resume:'capability_available',reason:'研究工具暂不可用'},1)
 new TaskActivation({store:f.store,available:()=>false}).prepare()
 // A different wait must not erase the independently persisted missing-capability observation.
 new TaskActivation({store:f.store,available:()=>true,allowed:()=>false}).prepare()
 f.store.close();stores.splice(stores.indexOf(f.store),1)
 const store=new AlongStore(f.path);stores.push(store)
 new TaskActivation({store,available:()=>true}).prepare()
 expect(store.getTask(f.userId,f.task.id)?.scheduledAt).toBeDefined()
 const restored=new TaskActivation({store,available:()=>true});restored.prepare();expect(restored.allowDue(store.assertTaskOwner(f.userId,f.task.id))).toBe(true)
 const task=store.insertTask({userId:f.userId,goalId:f.goal.id,content:'摘要就绪后核算'});store.appendTaskRevision({userId:f.userId,taskId:task.id})
 store.triggers.put(store.assertTaskOwner(f.userId,task.id),{kind:'event',actor:'agent',capability:'calculation',conditions:[{kind:'source_ready',provider:'okx',capability:'trading_account_summary'}]},1)
 const a=new TaskActivation({store,available:()=>true});a.prepare()
 expect(store.getTask(f.userId,task.id)?.scheduledAt).toBeUndefined()
})
it('requires actual user completion instead of an automatic human reminder or executor substitution',()=>{
 const {store,userId,goal,task}=fixture(),at=new Date(Date.now()-1000).toISOString()
 store.appendTaskRevision({userId,taskId:task.id,scheduledAt:at})
 const current=store.assertTaskOwner(userId,task.id)
 store.triggers.put(current,{kind:'time',actor:'user',capability:'reminder'},1)
 new TaskActivation({store,available:()=>true}).prepare()
 const d=store.health.dispatchDue(userId,goal.id,1,{taskId:task.id,revision:current.currentRevision,dueAt:at},[])
 store.health.read(d.eventId,[])
 const commit=(key:string,fields:unknown)=>createChangeSetModule(store).commitChangeSet(ALONG_CHANGE_SET_INPUT_SCHEMA.parse({idempotency_key:key,goal_id:goal.id,base_revision:1,input_version:1,reason:'到点不代表真人已完成',ops:[{op:'task.update',task_id:task.id,base_revision:current.currentRevision,fields}]}),{userId,allowedGoalId:goal.id,triggerEventId:d.eventId})
 expect(commit('no_human_done',{status:'done'})).toMatchObject({status:'invalid',reason:'human_completion_requires_user_feedback'})
 expect(commit('no_executor_substitution',{trigger:{kind:'immediate',actor:'agent',capability:'calculation'}})).toMatchObject({status:'invalid',reason:'human_executor_cannot_be_replaced_by_due_work'})
 expect(store.getTask(userId,task.id)?.status).toBe('open')
 expect(store.taskExecution(userId,task.id).count).toBe(0)
})
it('keeps private-history research independent of public provider configuration but still requires its actual source condition',()=>{
 const {store,userId,goal,task}=fixture();let ready=false
 store.triggers.put(store.assertTaskOwner(userId,task.id),{kind:'event',actor:'agent',capability:'research',conditions:[{kind:'source_ready',provider:'okx',capability:'trading_history'}]},1)
 const activation=new TaskActivation({store,available:()=>false,source:()=>ready?{state:'ready',generation:1,revision:1,reference:'fixture-history',capabilities:['trading_history']}:undefined})
 activation.prepare();expect(store.getTask(userId,task.id)?.scheduledAt).toBeUndefined()
 ready=true;activation.prepare()
 const current=store.assertTaskOwner(userId,task.id)
 expect(activation.allowDue(current)).toBe(true)
 const dispatch=store.health.dispatchDue(userId,goal.id,1,{taskId:task.id,revision:current.currentRevision,dueAt:current.scheduledAt!},[])
 activation.bind(dispatch);expect(activation.capabilityAvailable(dispatch)).toBe(true)
 ready=false;activation.prepare();expect(activation.allowDue(store.assertTaskOwner(userId,task.id))).toBe(false)
})
