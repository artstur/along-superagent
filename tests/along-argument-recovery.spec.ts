import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach,expect,it,vi } from 'vitest'
import { z } from 'zod'
import { startRuntime } from './fixtures/host.ts'
import { alongKind } from '../src/sources/along.ts'
import { executeToolArguments } from '../src/app/tool-arguments.ts'
import { alongTools } from '../src/along/tools.ts'
import { AlongStore } from '../src/along/store.ts'
import { AlongService } from '../src/along/service.ts'
import { createInbox } from '../src/along/inbox.ts'
import { createChangeSetModule } from '../src/along/changeset.ts'
const dirs:string[]=[],stores:AlongStore[]=[]
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true})})
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'along-args-'));dirs.push(dir)
 const store=new AlongStore(join(dir,'along.sqlite'));stores.push(store)
 const userId='synthetic_user',deviceId='synthetic_device',event='synthetic_input';store.assertUser(userId,deviceId)
 const goal=store.insertGoal({userId,domain:'custom'});store.appendGoalRevision({goalId:goal.id,userId,title:'合成研究目标',status:'active'});store.ensureInputVersion(userId,goal.id)
 const inbox=createInbox(store),service=new AlongService(store,{inbox,changeset:createChangeSetModule(store)})
 expect(inbox.acceptEvent({event_id:event,occurred_at:new Date().toISOString(),schema_version:'1',event_type:'along.user_message',goal_id:goal.id,timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text:'整理当前资料，保留原有提醒。'}},{userId,deviceId})).toMatchObject({status:'accepted'})
 const tools=alongTools({service,scopeFor:()=>({userId,allowedGoalId:goal.id,triggerEventId:event})},'synthetic_ticket')
 const run=(name:string,args:unknown)=>{const t=tools.find(t=>t.name===name)!;return executeToolArguments(t.schema,args,new AbortController().signal,t.execute,t.invalidArguments)}
 return {store,userId,goal,tools,run}
}
it('recovers observed revision/source/explanation failures without executing or writing, then accepts a corrected complete call',async()=>{
 const {store,userId,goal,tools,run}=fixture()
 const task=store.insertTask({goalId:goal.id,userId,content:'查天气后决定散步地点'});store.appendTaskRevision({taskId:task.id,userId,content:task.content})
 const valid={idempotency_key:'synthetic_fix',base_revision:1,input_version:store.inputVersion(goal.id),reason:'保留原任务',ops:[{op:'task.update',task_id:task.id,base_revision:1,fields:{reminder_plan:{state:'off',reason:'untimed'}}}]}
 const badVersions=structuredClone(valid) as any;badVersions.ops[0].base_revision='1'
 const before={task:store.getTask(userId,task.id),changes:store.changeSetsByGoal(userId,goal.id),sync:store.workspaceSync(userId,0,200)}
 const invalid=await run('along_changes_commit',badVersions)
 expect(invalid).toMatchObject({current_versions:{base_revision:1,input_version:store.inputVersion(goal.id),tasks:[{task_id:task.id,base_revision:1}]},status:'invalid',reason:'invalid_arguments',issues:[{path:'ops.0.base_revision',message:expect.stringContaining('number')}],guidance:expect.stringContaining('JSON integers')})
 const badPlan=structuredClone(valid) as any;badPlan.ops[0].fields.reminder_plan={state:'scheduled',source:'manual'}
 expect(await run('along_changes_commit',badPlan)).toMatchObject({status:'invalid',reason:'invalid_arguments',issues:expect.arrayContaining([{path:'ops.0.fields.reminder_plan.source',message:expect.any(String)},{path:'ops.0.fields.reminder_plan.explanation',message:expect.any(String)}]),guidance:expect.stringContaining('scheduled plans require explanation')})
 expect({task:store.getTask(userId,task.id),changes:store.changeSetsByGoal(userId,goal.id),sync:store.workspaceSync(userId,0,200)}).toEqual(before)
 expect(await run('along_changes_commit',valid)).toMatchObject({status:'applied'})
 expect(store.getTask(userId,task.id)?.currentRevision).toBe(2)
 const schema=z.toJSONSchema(tools.find(t=>t.name==='along_changes_commit')!.schema) as any
 expect(schema.properties.base_revision.type).toBe('integer')
 const variants=schema.properties.ops.items.oneOf??schema.properties.ops.items.anyOf
 const update=variants.find((v:any)=>v.properties?.op?.const==='task.update')
 expect(update.properties.base_revision.type).toBe('integer');expect(update.required).toContain('base_revision')
 const scheduled=update.properties.fields.properties.reminder_plan.anyOf[0].oneOf.find((v:any)=>v.properties.state.const==='scheduled')
 expect(scheduled.properties.source.enum).toEqual(['agent','user']);expect(scheduled.required).toContain('explanation')
})
it('gives a complete human result structure for array titles/missing option fields, with no rejected message sync',async()=>{
 const {store,userId,tools,run}=fixture(),before=store.workspaceSync(userId,0,200)
 const malformed={text:'合成研究结果',recommendation:{kind:'hiking',title:['a','b'],summary:'待核实',constraints:[],options:[{id:'a',title:'合成路线'}],nextStep:'继续核实'}}
 const result=await run('along_chat_reply',malformed) as any
 expect(result).toMatchObject({status:'invalid',reason:'invalid_arguments',issues:expect.arrayContaining([{path:'recommendation.title',message:expect.stringContaining('string')}]),guidance:expect.stringContaining('ONE object'),structure_example:{text:expect.any(String),recommendation:{title:expect.any(String),options:[{conditions:[],facts:[],checks:expect.any(Array)}]}}})
 expect(store.workspaceSync(userId,0,200)).toEqual(before)
 const chat=tools.find(t=>t.name==='along_chat_reply')!
 expect(chat.schema.safeParse(result.structure_example).success).toBe(true)
 const rec=z.toJSONSchema(chat.schema) as any
 expect(rec.properties.recommendation.properties.title.type).toBe('string')
 expect(rec.properties.recommendation.properties.options.items.required).toEqual(expect.arrayContaining(['title','reason','conditions','unknowns','facts','checks']))
 expect(await run('along_chat_reply',{text:'条件尚未核实。',recommendation:{kind:'general',title:'资料待核实',summary:'未确认当前条件',constraints:[],options:[],nextStep:'下次继续核实'}})).toMatchObject({status:'replied'})
})
it('preserves thrown strict errors and zero execution for tools with no opt-in formatter',async()=>{
 const execute=vi.fn(async()=>({ok:true})),schema=z.object({revision:z.number().int()}).strict()
 await expect(executeToolArguments(schema,{revision:'2'},new AbortController().signal,execute)).rejects.toBeInstanceOf(z.ZodError)
 expect(execute).not.toHaveBeenCalled()
 expect(await executeToolArguments(schema,{revision:2},new AbortController().signal,execute)).toEqual({ok:true})
})

it('delivers Along schema recovery through actual session registration and leaves unrelated tools strict',async()=>{
 const user='u_abcd1234',device='d_abcd1234'
 const h=await startRuntime(s=>s.saveSettings({...s.settings(),sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}},policy:{...s.settings().policy,sources:{along:{allowed:[{id:user}],admission:{}}}}}))
 try {
  h.runtime.sources.register(alongKind)
  const settings=h.runtime.store.settings()
  h.runtime.store.saveSettings({...settings,sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}},feishu:{enabled:false,config:{}}},policy:{...settings.policy,sources:{along:{allowed:[{id:user}],admission:{}}}}})
  const along=h.runtime.along!,store=along.service.alongStore
  expect((await h.alongApi('POST','pairing',{user_id:user,device_id:device},{'x-along-bridge':'1','x-along-bridge-token':along.bridgeToken!,'x-along-user':user,'x-along-device':device})).status).toBe(200)
  const goal=store.insertGoal({userId:user,domain:'custom'});store.appendGoalRevision({userId:user,goalId:goal.id,title:'合成研究',status:'active'});store.ensureInputVersion(user,goal.id)
  const event='schema_runtime'
  expect(along.service.acceptEvent({event_id:event,schema_version:'1',event_type:'along.user_message',goal_id:goal.id,occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text:'整理当前路线资料。'}},{userId:user,deviceId:device}).status).toBe('accepted')
  const trigger='along:'+user+':'+event
  await vi.waitFor(()=>expect(store.getDelivery(trigger)?.status).toBe('delivered'),{timeout:10000})
  const decision=await h.route({kind:'accept',trigger_id:trigger,title:'合成研究',worktree_name:'schema-worker',acknowledgement:'收到。'})
  const worker='worker-'+(decision.ticket as {ticket_id:string}).ticket_id;await h.runtime.idle()
  const before=store.workspaceSync(user,0,200)
  expect(await h.runTool(worker,'along_changes_commit',{idempotency_key:'bad',base_revision:'1',input_version:1,reason:'合成',ops:[]})).toMatchObject({status:'invalid',reason:'invalid_arguments',issues:expect.arrayContaining([{path:'base_revision',message:expect.any(String)}]),required_types:{task_base_revision:expect.stringContaining('JSON integer')}})
  expect(store.workspaceSync(user,0,200)).toEqual(before)
  await expect(h.runTool(h.runtime.masterId,'orchestrator_prompts_save',{})).rejects.toThrow()
  const parameters=(h.tools.get(worker)!.get('along_changes_commit') as any).parameters
  expect(parameters.properties.base_revision).toMatchObject({type:'integer',description:expect.stringContaining('never a quoted string')})
 } finally {await h.stop()}
})
