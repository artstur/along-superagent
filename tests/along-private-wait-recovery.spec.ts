/** Controlled synthetic Runtime/Engine/Sessions tool replay: scripted decisions and cache responses, no model/network/device.
 * Staleness uses a scoped Date.now spy, not natural elapsed time; cleanup restores it before stopping the isolated Host. */
import { afterEach, expect, it, vi } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'
import { alongKind } from '../src/sources/along.ts'
let host:Host|undefined
let restoreClock:(()=>void)|undefined
afterEach(async()=>{
 restoreClock?.();restoreClock=undefined
 const active=host;host=undefined
 try{await active?.stop()}finally{vi.restoreAllMocks()}
})
async function fixture(requestFirst=true,oldUser=false,immediate=false,independent=false){
 const userId='u_1234abcd',deviceId='d_1234abcd',h=host=await startRuntime(s=>s.saveSettings({...s.settings(),sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}}}))
 h.runtime.sources.register(alongKind)
 const settings=h.runtime.store.settings()
 h.runtime.store.saveSettings({...settings,sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}},policy:{...settings.policy,sources:{along:{allowed:[{id:userId}],admission:{}}}}})
 const along=h.runtime.along!,store=along.service.alongStore;store.assertUser(userId,deviceId)
 const goal=store.insertGoal({userId,domain:'custom'});store.appendGoalRevision({userId,goalId:goal.id,title:'合成目标与实际摘要参数核算',status:'active'});store.ensureInputVersion(userId,goal.id)
 if(oldUser){
  expect(along.service.acceptEvent({event_id:'previous_parameters',schema_version:'1',event_type:'along.user_message',goal_id:goal.id,occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text:'先记录参考数字900美元，暂时不要执行。'}},{userId,deviceId})).toMatchObject({status:'accepted'})
  await h.runtime.pump();await h.runtime.idle();await vi.waitFor(()=>expect(store.getDelivery('along:'+userId+':previous_parameters')?.status).toBe('delivered'),{timeout:10000})
  const prior=await h.route({kind:'accept',trigger_id:'along:'+userId+':previous_parameters',title:'记录参考信息',worktree_name:'mixed-old-fact',acknowledgement:'保留参考信息，等待继续。'}),priorWorker='worker-'+(prior.ticket as {ticket_id:string}).ticket_id
  await vi.waitFor(()=>expect(h.tools.has(priorWorker)).toBe(true))
  await h.runTool(priorWorker,'along_chat_reply',{text:'收到参考信息，等待你继续。'})
  await h.runTool(priorWorker,'orchestrator_report',{state:'ready',summary:'原始直接参考消息已保留，按要求未执行'})
 }
 const text='读取实际只读摘要权益，扣除预留25美元，算出剩余金额。'+(independent?'另外独立算一下3次25分钟一共多少分钟，不用等账户。':'')
 expect(along.service.acceptEvent({event_id:'current_parameters',schema_version:'1',event_type:'along.user_message',goal_id:goal.id,occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text}},{userId,deviceId})).toMatchObject({status:'accepted'})
 await h.runtime.pump();await h.runtime.idle()
 await vi.waitFor(()=>expect(store.getDelivery('along:'+userId+':current_parameters')?.status).toBe('delivered'),{timeout:10000})
 const routed=await h.route({kind:'accept',trigger_id:'along:'+userId+':current_parameters',title:'合成数据依赖计算',worktree_name:'mixed-review',acknowledgement:'核对参数并安排计算。'})
 const planner='worker-'+(routed.ticket as {ticket_id:string}).ticket_id
 await vi.waitFor(()=>expect(h.tools.has(planner)).toBe(true))
 const plannerTools=[...h.tools.get(planner)!.keys()]
 for(const name of ['along_calculate','along_source_read','along_task_context','along_task_finish'])expect(plannerTools).not.toContain(name)
 await h.runTool(planner,'along_goal_read',{})
 expect(await h.runTool(planner,'along_data_sources_recommend',{base_revision:1,input_version:store.inputVersion(goal.id),sources:[{provider:'okx',reason:'按用户目标核算只读摘要'}]})).toMatchObject({status:'recommended'})
 expect(await h.runTool(planner,'along_changes_commit',{idempotency_key:'mixed_create',base_revision:1,input_version:store.inputVersion(goal.id),reason:'先等待授权摘要，再实际计算',ops:[{op:'task.create',content:'根据目标、周期和只读摘要核算每月差额',trigger:immediate?{kind:'immediate',actor:'agent',capability:'calculation'}:{kind:'event',actor:'agent',capability:'calculation',conditions:[{kind:'source_ready',provider:'okx',capability:'trading_account_summary'}]}}]})).toMatchObject({status:'applied'})
 const task=store.goalDetail(userId,goal.id).tasks[0]!
 await h.runTool(planner,'along_chat_reply',{text:'已安排在数据可读取后核算，结果进入任务详情。'})
 await h.runTool(planner,'orchestrator_report',{state:'ready',summary:'数据依赖任务已持久安排'})
 const headers={'x-along-bridge':'1','x-along-bridge-token':along.bridgeToken,'x-along-user':userId,'x-along-device':deviceId}
 const source={event_id:'verified_source',goal_id:goal.id,provider:'okx',generation:1,revision:1,state:'ready',capabilities:['trading_account_summary'],occurred_at:new Date().toISOString(),reference:'synthetic_ref'}
 expect(await h.alongApi('POST','source-events',source,headers)).toMatchObject({status:200,body:{status:'accepted'}})
 await h.runtime.pump();await h.runtime.idle()
 const ticket=h.runtime.store.tickets.list().find(t=>t.mandate.basis.via==='task_due'&&!t.ended)!
 expect(ticket).toBeDefined();const worker='worker-'+ticket.id;await vi.waitFor(()=>expect(h.tools.has(worker)).toBe(true))
 for(const name of ['along_calculate','along_source_read','along_task_context','along_task_finish'])expect(h.tools.get(worker)!.has(name)).toBe(true)
 expect(h.tools.get(worker)!.has('along_calculation_preview')).toBe(false)
 await h.runTool(worker,'along_task_context',{})
 const tool=h.tools.get(worker)!.get('along_calculate')! as unknown as {parameters:Record<string,unknown>}
 const schema=JSON.parse(JSON.stringify(tool.parameters))
 expect(schema.additionalProperties).toBe(false)
 expect(schema.properties).toHaveProperty('quantity_parameters')
 expect(schema.properties).toHaveProperty('source_request_id')
 const input={calculation:{quantities:[{name:'equity',value:'125.20',unit:'USD'},{name:'target',value:'1000',unit:'USD'},{name:'horizon',value:'12',unit:'month'},{name:'identity',value:'1',unit:'1'}],steps:[{id:'gap',op:'subtract',inputs:['target','equity']},{id:'monthly',op:'divide',inputs:['gap','horizon']},{id:'result',op:'multiply',inputs:['monthly','identity']}],result_step:'result'},quantity_sources:[{quantity:'equity',path:['tradingEquityUsd']}],quantity_parameters:[{quantity:'target',kind:'user',event_id:'current_parameters',quote:'1000美元'},{quantity:'horizon',kind:'user',event_id:'current_parameters',quote:'12个月'},{quantity:'identity',kind:'constant',name:'identity_one'}]}
 const read=async()=>h.runTool(worker,'along_source_read',{provider:'okx',capability:'trading_account_summary',max_age_seconds:60})
 const requested=requestFirst?await read():{request_id:'never_requested',state:'not_requested'}
 const supply=async(observed_at=new Date().toISOString())=>h.alongApi('POST','source-read-results',{request_id:requested.request_id,state:'ready',generation:1,revision:1,observed_at,reference:source.reference,data:{tradingEquityUsd:125.2,assetCount:2,positionCount:1}},headers)
 return {h,store,userId,deviceId,along,goal,task,worker,ticket,source,headers,input,read,requested,supply,plannerTools,schema}
}

const subtract=(requestId:unknown)=>({source_request_id:requestId,calculation:{quantities:[{name:'equity',value:'125.2',unit:'USD'},{name:'reserve',value:'25',unit:'USD'}],steps:[{id:'remaining',op:'subtract',inputs:['equity','reserve']}],result_step:'remaining'},quantity_sources:[{quantity:'equity',path:['tradingEquityUsd']}],quantity_parameters:[{quantity:'reserve',kind:'user',event_id:'current_parameters',quote:'25美元'}]})
it.each(['pending','stale','unavailable'] as const)('persists %s private wait across controlled retry windows and resumes the same occurrence only after fresh data',async state=>{
 const f=await fixture(),base=Date.now();if(state!=='pending')expect(await f.h.alongApi('POST','source-read-results',{request_id:f.requested.request_id,state,generation:1,revision:1,observed_at:new Date().toISOString(),reference:f.source.reference},f.headers)).toMatchObject({status:200})
 await f.h.runTool(f.worker,'orchestrator_report',{state:'blocked',summary:'等待Host真正读取，不能猜数值'})
 const original=f.store.triggers.forDispatch(f.ticket.mandate.basis.via==='task_due'?f.ticket.mandate.basis.eventId:'')!
 const clock=vi.spyOn(Date,'now');restoreClock=()=>clock.mockRestore()
 for(const delta of [61_000,122_000,244_000]){clock.mockReturnValue(base+delta);await f.h.runtime.pump();await f.h.runtime.idle();expect(f.h.runtime.store.tickets.get(f.ticket.id)?.assignments).toHaveLength(1)}
 expect(f.store.taskExecution(f.userId,f.task.id).count).toBe(0)
 expect(await f.supply(new Date(base+244_000).toISOString())).toMatchObject({status:200,body:{state:'ready'}})
 await f.h.runtime.pump();await f.h.runtime.idle();expect(f.h.runtime.store.tickets.get(f.ticket.id)?.assignments).toHaveLength(2)
 expect(f.store.triggers.forDispatch(original.eventId!)?.id).toBe(original.id)
 await f.h.runTool(f.worker,'along_task_context',{});const receipt=await f.h.runTool(f.worker,'along_calculate',subtract(f.requested.request_id));expect(receipt).toMatchObject({result:{value:'100.2',unit:'USD'}})
 await f.h.runTool(f.worker,'along_task_finish',{outcome:'keep',types:[],reason:'新鲜真实缓存后才完成',calculation_receipt:receipt.receipt_id});await f.h.runTool(f.worker,'orchestrator_report',{state:'ready',summary:'100.2USD已存'});await f.h.runtime.pump();expect(f.store.taskExecution(f.userId,f.task.id).count).toBe(1)
},30000)
it.each(['same_revision_refresh','new_revision','new_grant'] as const)('immediate private execution recovers identical numeric input after %s without rewriting old proof',async kind=>{
 const f=await fixture(true,false,true);await f.supply();const first=await f.h.runTool(f.worker,'along_calculate',subtract(f.requested.request_id));
 let requested=f.requested,newFact=f.source
 if(kind==='same_revision_refresh'){const now=Date.now(),clock=vi.spyOn(Date,'now').mockReturnValue(now+61_000);restoreClock=()=>clock.mockRestore();expect(await f.h.runTool(f.worker,'along_source_read',{provider:'okx',capability:'trading_account_summary',max_age_seconds:60})).toMatchObject({state:'stale'});expect(await f.supply(new Date(now+61_000).toISOString())).toMatchObject({status:200})}
 else {if(kind==='new_grant')await f.h.alongApi('POST','source-events',{...f.source,event_id:'old_revoke',revision:2,state:'revoked',capabilities:[]},f.headers);newFact={...f.source,event_id:'new_source_fact',generation:kind==='new_grant'?2:1,revision:kind==='new_grant'?1:2,reference:'new_verified_reference'};expect(await f.h.alongApi('POST','source-events',newFact,f.headers)).toMatchObject({status:200});requested=await f.read();expect(await f.h.alongApi('POST','source-read-results',{request_id:requested.request_id,state:'ready',generation:newFact.generation,revision:newFact.revision,observed_at:new Date(Date.now()).toISOString(),reference:newFact.reference,data:{tradingEquityUsd:125.2,assetCount:2,positionCount:1}},f.headers)).toMatchObject({status:200})}
 const second=await f.h.runTool(f.worker,'along_calculate',subtract(requested.request_id));expect(second).toMatchObject({result:{value:'100.2',unit:'USD'}});if(kind==='same_revision_refresh')expect(second.receipt_id).toBe(first.receipt_id);else expect(second.receipt_id).not.toBe(first.receipt_id)
 expect(await f.h.runTool(f.worker,'along_calculate',subtract(requested.request_id))).toMatchObject({receipt_id:second.receipt_id,reused:true})
 await f.h.runTool(f.worker,'along_task_finish',{outcome:'keep',types:[],reason:'当前真实证明对应的收据才可发布',calculation_receipt:second.receipt_id});await f.h.runTool(f.worker,'orchestrator_report',{state:'ready',summary:'100.2USD当前结果'});expect(f.store.taskExecution(f.userId,f.task.id).count).toBe(1)
},30000)
it('keeps ordinary failed work without a private read on the existing model retry path',async()=>{
 const f=await fixture(false),base=Date.now();await f.h.runTool(f.worker,'orchestrator_report',{state:'failed',summary:'ordinary controlled executor failure, no source read'})
 const clock=vi.spyOn(Date,'now').mockReturnValue(base+61_000);restoreClock=()=>clock.mockRestore();await f.h.runtime.pump();await f.h.runtime.idle();expect(f.h.runtime.store.tickets.get(f.ticket.id)?.assignments).toHaveLength(2)
},30000)
it('a new source revision permits one retry, then actually requesting that revision waits until its fresh result',async()=>{
 const f=await fixture(true,false,true),base=Date.now();await f.h.runTool(f.worker,'orchestrator_report',{state:'blocked',summary:'original private request pending'})
 const next={...f.source,event_id:'new_live_revision',revision:2,reference:'same_grant_ref_two'};expect(await f.h.alongApi('POST','source-events',next,f.headers)).toMatchObject({status:200})
 const clock=vi.spyOn(Date,'now').mockReturnValue(base+61_000);restoreClock=()=>clock.mockRestore();await f.h.runtime.pump();await f.h.runtime.idle();expect(f.h.runtime.store.tickets.get(f.ticket.id)?.assignments).toHaveLength(2)
 await f.h.runTool(f.worker,'along_task_context',{});const request=await f.read();expect(request.request_id).toBe(f.requested.request_id);await f.h.runTool(f.worker,'orchestrator_report',{state:'blocked',summary:'new revision requested; still waiting for Host cache'})
 for(const delta of [122_000,244_000]){clock.mockReturnValue(base+delta);await f.h.runtime.pump();await f.h.runtime.idle();expect(f.h.runtime.store.tickets.get(f.ticket.id)?.assignments).toHaveLength(2)}
 expect(await f.h.alongApi('POST','source-read-results',{request_id:request.request_id,state:'ready',generation:1,revision:2,observed_at:new Date(base+244_000).toISOString(),reference:next.reference,data:{tradingEquityUsd:125.2,assetCount:2,positionCount:1}},f.headers)).toMatchObject({status:200,body:{state:'ready'}})
 await f.h.runtime.pump();await f.h.runtime.idle();expect(f.h.runtime.store.tickets.get(f.ticket.id)?.assignments).toHaveLength(3);await f.h.runTool(f.worker,'along_task_context',{});const receipt=await f.h.runTool(f.worker,'along_calculate',subtract(request.request_id));expect(receipt).toMatchObject({result:{value:'100.2',unit:'USD'}});await f.h.runTool(f.worker,'along_task_finish',{outcome:'keep',types:[],reason:'只在当前版本真实可读后完成',calculation_receipt:receipt.receipt_id});await f.h.runTool(f.worker,'orchestrator_report',{state:'ready',summary:'当前版本100.2USD已存'});expect(f.store.taskExecution(f.userId,f.task.id).count).toBe(1)
},30000)
it('cancelling a pending immediate private task invalidates its read rather than leaving a retry or completion',async()=>{
 const f=await fixture(true,false,true),base=Date.now();await f.h.runTool(f.worker,'orchestrator_report',{state:'blocked',summary:'Host request pending'})
 f.store.appendTaskRevision({userId:f.userId,taskId:f.task.id,status:'cancelled',originEventId:'controlled_authorized_cancellation'})
 const clock=vi.spyOn(Date,'now').mockReturnValue(base+244_000);restoreClock=()=>clock.mockRestore();expect(await f.supply(new Date(base+244_000).toISOString())).toMatchObject({status:400,body:{status:'rejected'}});await f.h.runtime.pump();await f.h.runtime.idle();expect(f.h.runtime.store.tickets.get(f.ticket.id)?.assignments).toHaveLength(1);expect(f.store.taskExecution(f.userId,f.task.id).count).toBe(0);expect(f.store.getTask(f.userId,f.task.id)?.status).toBe('cancelled')
},30000)
