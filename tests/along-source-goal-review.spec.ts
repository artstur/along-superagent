/** Controlled synthetic replay through actual Runtime/API/tools. No model, network, device or production data. */
import {afterEach,expect,it,vi} from 'vitest'
import {startRuntime,type Host} from './fixtures/host.ts'
import {alongKind} from '../src/sources/along.ts'
import {Store} from '../src/app/store.ts'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
let host:Host|undefined
const dirs:string[]=[]
const userId='u_1234abcd',deviceId='d_1234abcd'
afterEach(async()=>{vi.restoreAllMocks();await host?.stop();host=undefined;for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})
async function setup(dir?:string){
 if(dir){const db=new Store(join(dir,'orchestrator.sqlite'));db.saveSettings({...db.settings(),eval:{...db.settings().eval,mode:'auto'},sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}},policy:{...db.settings().policy,sources:{along:{allowed:[{id:userId}],admission:{}}}}});db.close()}
 const h=host=dir?await startRuntime(undefined,{dir}):await startRuntime(s=>s.saveSettings({...s.settings(),sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}}}));if(!dir)h.runtime.sources.register(alongKind)
 const settings=h.runtime.store.settings();h.runtime.store.saveSettings({...settings,sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}},policy:{...settings.policy,sources:{along:{allowed:[{id:userId}],admission:{}}}}})
 const along=h.runtime.along!,store=along.service.alongStore;store.assertUser(userId,deviceId)
 const goal=store.insertGoal({userId,domain:'custom'});store.appendGoalRevision({userId,goalId:goal.id,title:'了解账户摘要并复核交易策略',context:['希望先记录当前权益，再根据交易历史和策略规则分析表现'],status:'active'});store.ensureInputVersion(userId,goal.id)
 along.service.acceptEvent({event_id:'original_goal',schema_version:'1',event_type:'along.user_message',goal_id:goal.id,occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text:'记录当前账户权益；我会导出交易历史并整理策略规则，然后再分析表现。'}},{userId,deviceId})
 store.markDelivered('along:'+userId+':original_goal',new Date().toISOString())
 store.replaceGoalDataSources(userId,goal.id,[{provider:'okx',reason:'读取已授权的账户摘要'}])
 const tasks=['导出交易历史','整理策略规则'].map(content=>{const task=store.insertTask({userId,goalId:goal.id,content});store.appendTaskRevision({userId,taskId:task.id});return store.getTask(userId,task.id)!})
 const headers={'x-along-bridge':'1','x-along-bridge-token':along.bridgeToken,'x-along-user':userId,'x-along-device':deviceId}
 const fact={event_id:'source_ready',goal_id:goal.id,provider:'okx',generation:1,revision:1,state:'ready',capabilities:['trading_account_summary'],occurred_at:new Date().toISOString(),reference:'synthetic_ref'}
 const source=(patch:Record<string,unknown>={})=>h.alongApi('POST','source-events',{...fact,...patch},headers)
 const worker=async()=>{await vi.waitFor(async()=>{await h.runtime.pump();await h.runtime.idle();expect(h.runtime.store.tickets.list().some(t=>t.mandate.basis.via==='source_review'&&!t.ended)).toBe(true)},{timeout:10_000});const ticket=h.runtime.store.tickets.list().find(t=>t.mandate.basis.via==='source_review'&&!t.ended)!;const session='worker-'+ticket.id;await vi.waitFor(()=>expect(h.tools.has(session)).toBe(true));return {ticket,session}}
 const commit=(session:string,ops:unknown[],key='review_changes')=>h.runTool(session,'along_changes_commit',{idempotency_key:key,base_revision:store.getGoal(userId,goal.id)!.currentRevision,input_version:store.inputVersion(goal.id),reason:'保全人类行动，明确真实等待和单独有用的摘要步骤',ops})
 const waiting=tasks.map(task=>({op:'task.update',task_id:task.id,base_revision:task.currentRevision,fields:{trigger:{kind:'waiting',actor:'user',capability:'reminder',resume:'user_input',reason:task.content+'需要本人提供材料，账户摘要不包含交易历史或策略规则'}}}))
 return {h,along,store,goal,tasks,headers,fact,source,worker,commit,waiting}
}
it('atomic source acceptance dispatches a private review, preserves old actions, and executes only a genuinely separate typed calculation',async()=>{
 const f=await setup(),before=f.store.counts(userId).messages
 expect(await f.source()).toMatchObject({status:200,body:{status:'accepted'}})
 expect(f.store.health.pending().filter(d=>d.sourceReview)).toHaveLength(1)
 expect(await f.source()).toMatchObject({status:200,body:{status:'accepted',reused:true}})
 const {ticket,session}=await f.worker(),names=[...f.h.tools.get(session)!.keys()]
 expect(names.sort()).toEqual(['along_source_review_context','along_source_review_finish','along_goal_read','along_conversation_read','along_task_list','along_data_sources_catalog','along_changes_commit','orchestrator_report'].sort())
 const context=await f.h.runTool(session,'along_source_review_context',{})
 expect(context).toMatchObject({source:{private_data_read:false,unavailable_coverage:expect.arrayContaining(['trade_history'])},tasks:expect.arrayContaining([{...f.tasks[0],execution:expect.anything()}])})
 await expect(f.h.runTool(session,'along_source_review_finish',{outcome:'need_data',reason:'缺交易历史',needs:['需要本人导出交易历史']})).rejects.toThrow('legacy_trigger_not_persisted')
 expect(await f.commit(session,[{op:'task.update',task_id:f.tasks[0]!.id,base_revision:1,fields:{status:'done'}}],'bad_status')).toMatchObject({status:'invalid',reason:'outside_source_review'})
 expect(await f.commit(session,[...f.waiting,{op:'task.create',content:'记录当前账户权益摘要',trigger:{kind:'event',actor:'agent',capability:'calculation',conditions:[{kind:'source_ready',provider:'okx',capability:'trading_account_summary'}]}}])).toMatchObject({status:'applied'})
 expect(await f.h.runTool(session,'along_source_review_finish',{outcome:'need_data',reason:'摘要只支持权益记录，策略分析仍需交易历史和规则',needs:['本人导出交易历史和策略规则']})).toMatchObject({status:'reviewed',task_completed:false})
 await f.h.runTool(session,'orchestrator_report',{state:'ready',summary:'后台编排已持久化；人类任务等待本人材料，未声称策略分析完成'})
 expect(f.store.health.state(f.goal.id)).toBeUndefined();expect(f.store.conversationContextPage(userId,f.goal.id,undefined,100).items.filter(m=>m.audience==='conversation')).toHaveLength(before)
 for(const original of f.tasks){const task=f.store.getTask(userId,original.id)!;expect(task).toMatchObject({content:original.content,status:original.status,scheduledAt:original.scheduledAt});expect(f.store.triggers.get(userId,task.id)?.definition).toMatchObject({kind:'waiting',actor:'user',resume:'user_input'});expect(f.store.taskExecution(userId,task.id).count).toBe(0)}
 expect(f.store.syncPage(userId,0,200).items.some(i=>(i.payload as any).notification)).toBe(false)
 await f.h.runtime.pump();await f.h.runtime.idle()
 const due=f.h.runtime.store.tickets.list().find(t=>t.mandate.basis.via==='task_due'&&!t.ended)!;expect(due).toBeDefined()
 const execution='worker-'+due.id;await vi.waitFor(()=>expect(f.h.tools.has(execution)).toBe(true));await f.h.runTool(execution,'along_task_context',{})
 const read=await f.h.runTool(execution,'along_source_read',{provider:'okx',capability:'trading_account_summary',max_age_seconds:1800});expect(read).toMatchObject({state:'pending'})
 expect(await f.h.alongApi('POST','source-read-results',{request_id:read.request_id,state:'ready',generation:1,revision:1,observed_at:new Date().toISOString(),reference:f.fact.reference,data:{tradingEquityUsd:125.2,assetCount:2,positionCount:1}},f.headers)).toMatchObject({status:200,body:{status:'accepted'}})
 const receipt=await f.h.runTool(execution,'along_calculate',{calculation:{quantities:[{name:'equity',value:'125.2',unit:'USD'},{name:'one',value:'1',unit:'1'}],steps:[{id:'record',op:'multiply',inputs:['equity','one']}],result_step:'record'},source_request_id:read.request_id,quantity_sources:[{quantity:'equity',path:['tradingEquityUsd']}],quantity_parameters:[{quantity:'one',kind:'constant',name:'identity_one'}]})
 expect(receipt).toMatchObject({persisted:true,result:{value:'125.2',unit:'USD'}})
 expect(await f.h.runTool(execution,'along_task_finish',{outcome:'keep',types:[],reason:'只记录已读取权益，不代表策略分析',calculation_receipt:receipt.receipt_id})).toMatchObject({status:'recorded'})
 await f.h.runTool(execution,'orchestrator_report',{state:'ready',summary:'权益记录已保存至对应任务详情'})
 const created=f.store.goalDetail(userId,f.goal.id).tasks.find(t=>!f.tasks.some(old=>old.id===t.id))!;expect(f.store.taskExecution(userId,created.id).count).toBe(1)
 expect(await f.source({event_id:'price_update',revision:2,reference:'new_ref'})).toMatchObject({status:200})
 await f.h.runtime.pump();expect(f.h.runtime.store.tickets.list().filter(t=>t.mandate.basis.via==='source_review')).toHaveLength(1)
 expect(f.h.runtime.store.triggers.get(ticket.origin.triggerId)).toMatchObject({human:false,meta:{event_type:'along.source_ready_review'}})
},30_000)
it('rolls source acceptance back if its durable review cannot be saved, and reconciles a pre-upgrade accepted fact',async()=>{
 const f=await setup(),spy=vi.spyOn(f.store.health,'requestSourceReview').mockImplementation(()=>{throw new Error('synthetic durable outbox failure')})
 expect(()=>f.along.service.acceptSourceEvent({userId,deviceId},f.fact)).toThrow('durable outbox failure')
 expect(f.store.sources.queryCurrent(userId,f.goal.id,'okx')).toBeUndefined();expect(f.store.health.pending()).toHaveLength(0)
 spy.mockRestore()
 // Simulates an already accepted metadata fact from a version before this bootstrap existed.
 f.store.sources.acceptEvent({userId,deviceId},f.fact)
 expect(f.store.health.pending()).toHaveLength(0)
 await f.worker();expect(f.store.health.pending().filter(d=>d.sourceReview)).toHaveLength(1)
},30_000)
it.each(['revoked','generation','input_version','paired_device'])('rejects stale review capabilities after %s and never mutates old tasks',async kind=>{
 const f=await setup();await f.source();const {ticket,session}=await f.worker();await f.h.runTool(session,'along_source_review_context',{})
 if(kind==='revoked')await f.source({event_id:'revoke',revision:2,state:'revoked',capabilities:[],reference:'revoked_ref'})
 if(kind==='generation')await f.source({event_id:'new_grant',generation:2,reference:'generation_two'})
 if(kind==='input_version')f.store.raiseInputVersion(userId,f.goal.id,'new_user_input')
 if(kind==='paired_device')f.store.assertUser(userId,'d_5678abcd')
 await expect(f.commit(session,f.waiting)).rejects.toThrow('unavailable')
 await expect(f.h.runTool(session,'along_source_review_finish',{outcome:'keep',reason:'旧工作不能提交'})).rejects.toThrow('unavailable')
 await f.h.runtime.pump()
 const basis=ticket.mandate.basis;if(basis.via!=='source_review')throw new Error('wrong review kind')
 expect(f.store.health.get(basis.eventId)?.sourceReview?.retired).toBe(true)
 for(const task of f.tasks){expect(f.store.getTask(userId,task.id)).toEqual(task);expect(f.store.taskExecution(userId,task.id).count).toBe(0)}
},30_000)
it('preserves an existing clock and unrelated typed fields, and refuses converting the old action into Agent execution',async()=>{
 const f=await setup(),clock=f.store.insertTask({userId,goalId:f.goal.id,content:'本人核对月度账单',scheduledAt:'2030-02-01T02:00:00.000Z'});f.store.appendTaskRevision({userId,taskId:clock.id})
 const typed=f.store.insertTask({userId,goalId:f.goal.id,content:'保持未受影响的独立研究任务'});f.store.appendTaskRevision({userId,taskId:typed.id});const typedBefore=f.store.getTask(userId,typed.id)!
 f.store.triggers.put(typedBefore,{kind:'waiting',actor:'agent',capability:'research',resume:'user_input',reason:'等待本人给出比较范围'},f.store.inputVersion(f.goal.id));const triggerBefore=f.store.triggers.get(userId,typed.id)!.definition
 await f.source();const {session}=await f.worker();await f.h.runTool(session,'along_source_review_context',{})
 expect(await f.commit(session,[{op:'task.update',task_id:f.tasks[0]!.id,base_revision:1,fields:{trigger:{kind:'immediate',actor:'agent',capability:'calculation'}}}],'relabel')).toMatchObject({status:'invalid',reason:'source_review_legacy_actor_or_clock_preserved'})
 expect(await f.commit(session,[{op:'task.update',task_id:typed.id,base_revision:1,fields:{trigger:'keep'}}],'typed')).toMatchObject({status:'invalid',reason:'outside_source_review'})
 expect(await f.commit(session,[...f.waiting,{op:'task.update',task_id:clock.id,base_revision:1,fields:{trigger:{kind:'time',actor:'user',capability:'reminder'}}}])).toMatchObject({status:'applied'})
 expect(await f.h.runTool(session,'along_source_review_finish',{outcome:'need_data',reason:'等待本人提供两类分析材料，原有账单时间保留',needs:['交易历史和策略规则']})).toMatchObject({status:'reviewed'})
 expect(f.store.getTask(userId,clock.id)).toMatchObject({content:clock.content,status:'open',scheduledAt:clock.scheduledAt})
 expect(f.store.getTask(userId,typed.id)).toMatchObject(typedBefore);expect(f.store.triggers.get(userId,typed.id)!.definition).toEqual(triggerBefore)
},30_000)
it('does not enqueue legacy bootstrap for a fully typed goal and does not duplicate one pending review for price changes',async()=>{
 const f=await setup();for(const task of f.tasks)f.store.triggers.put(task,{kind:'waiting',actor:'user',capability:'reminder',resume:'user_input',reason:'等待本人材料'},f.store.inputVersion(f.goal.id))
 await f.source();await f.h.runtime.pump();expect(f.store.health.pending().filter(d=>d.sourceReview)).toHaveLength(0)
 const legacy=f.store.insertTask({userId,goalId:f.goal.id,content:'后来发现的旧版人工材料任务'});f.store.appendTaskRevision({userId,taskId:legacy.id})
 await f.h.runtime.pump();const first=f.store.health.pending().filter(d=>d.sourceReview);expect(first).toHaveLength(1)
 await f.source({event_id:'new_price',revision:2,reference:'new_ref'});await f.h.runtime.pump()
 expect(f.store.health.pending().filter(d=>d.sourceReview).map(d=>d.eventId)).toEqual(first.map(d=>d.eventId))
},30_000)
it('resumes the same durable review and failed-ticket retry after Runtime restart without fake user input',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'along-source-review-restart-'));dirs.push(dir)
 const f=await setup(dir);await f.source();const id=f.store.health.pending().find(d=>d.sourceReview)!.eventId
 await f.h.stop();host=undefined;const h=host=await startRuntime(undefined,{dir});await h.runtime.pump();await h.runtime.idle()
 await vi.waitFor(async()=>{await h.runtime.pump();await h.runtime.idle();expect(h.runtime.store.tickets.list().filter(t=>t.mandate.basis.via==='source_review')).toHaveLength(1)},{timeout:10_000})
 const ticket=h.runtime.store.tickets.list().find(t=>t.mandate.basis.via==='source_review')!,session='worker-'+ticket.id;await vi.waitFor(()=>expect(h.tools.has(session)).toBe(true))
 await h.runTool(session,'orchestrator_report',{state:'failed',summary:'synthetic temporary outage'})
 await h.runtime.pump();expect(h.runtime.store.tickets.get(ticket.id)?.assignments).toHaveLength(1)
 const saved=h.runtime.store.tickets.get(ticket.id)!;saved.assignments.at(-1)!.report!.at='2020-01-01T00:00:00Z';h.runtime.store.tickets.save(saved)
 await h.runtime.pump();await h.runtime.idle();expect(h.runtime.store.tickets.get(ticket.id)?.assignments).toHaveLength(2)
 const store=h.runtime.along!.service.alongStore;expect(store.health.pending().filter(d=>d.sourceReview).map(d=>d.eventId)).toEqual([id])
 expect(store.conversationContextPage(userId,f.goal.id,undefined,100).items.filter(m=>m.audience==='conversation').map(m=>m.eventId)).toEqual(['original_goal'])
},30_000)
