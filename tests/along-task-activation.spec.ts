import { afterEach,expect,it,vi } from 'vitest'
import { mkdtempSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AlongStore } from '../src/along/store.ts'
import { TaskActivation } from '../src/along/task-activation.ts'
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
