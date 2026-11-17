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
 const text='我的目标是1000美元，按12个月安排，再对比24个月。请根据只读账户摘要核算每月差额。'+(independent?'另外独立算一下3次25分钟一共多少分钟，不用等账户。':'')
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

it('controlled synthetic mixed inputs (no model) persist the real tool result and honest labels once',async()=>{
 const f=await fixture()
 expect(f.requested).toMatchObject({state:'pending'})
 expect(await f.supply()).toMatchObject({status:200,body:{status:'accepted'}})
 const args={...f.input,source_request_id:f.requested.request_id}
 const receipt=await f.h.runTool(f.worker,'along_calculate',args)
 expect(receipt).toMatchObject({persisted:true,reused:false,result:{value:'72.9',unit:'USD/month'},input_sources:[{quantity:'equity',kind:'private_field',unit:'USD'},{quantity:'horizon',kind:'user_parameter',unit:'month'},{quantity:'identity',kind:'named_constant',unit:'1'},{quantity:'target',kind:'user_parameter',unit:'USD'}]})
 expect(await f.h.runTool(f.worker,'along_calculate',args)).toMatchObject({receipt_id:receipt.receipt_id,reused:true})
 const corrected=structuredClone(args);corrected.calculation.quantities.find(q=>q.name==='horizon')!.value='24';corrected.quantity_parameters.find(p=>p.quantity==='horizon')!.quote='24个月'
 const second=await f.h.runTool(f.worker,'along_calculate',corrected)
 expect(second).toMatchObject({persisted:true,result:{value:'36.45',unit:'USD/month'}});expect(second.receipt_id).not.toBe(receipt.receipt_id)
 const finish={outcome:'keep',types:[],reason:'按真实缓存字段和明确用户参数核算，恒等常量不改变数值',calculation_receipt:receipt.receipt_id}
 expect(await f.h.runTool(f.worker,'along_task_finish',finish)).toMatchObject({status:'recorded',reused:false})
 expect(await f.h.runTool(f.worker,'along_task_finish',finish)).toMatchObject({reused:true})
 await f.h.runTool(f.worker,'orchestrator_report',{state:'ready',summary:'私有审计：权益125.2USD，差额72.9USD/month；收据只证明算术与输入归属'})
 const assignment=f.h.runtime.store.tickets.get(f.ticket.id)!.assignments.at(-1)!
 expect(f.store.getRunRecord(f.ticket.id,assignment.id)?.reportSummary).toContain('125.2')
 expect(f.store.getTask(f.userId,f.task.id)?.status).toBe('done')
 expect(f.store.taskExecution(f.userId,f.task.id).count).toBe(1)
 const completeSync=f.store.syncPage(f.userId,0,200).items
 expect(JSON.stringify(completeSync)).not.toContain('125.2')
 expect(completeSync.some(i=>i.kind==='message'&&(i.payload as any).presentation==='execution'&&String((i.payload as any).message?.eventId??'').startsWith('out:'+f.ticket.id+':'))).toBe(false)
 const outbox=completeSync.filter(i=>(i.payload as {calculation_receipt_id?:string}).calculation_receipt_id)
 expect(outbox).toHaveLength(1);expect(JSON.stringify(outbox)).not.toContain('125.2');expect(JSON.stringify(outbox)).not.toContain('1000美元')
},30000)

async function stillOpen(f:Awaited<ReturnType<typeof fixture>>){
 expect(f.store.getTask(f.userId,f.task.id)?.status).toBe('open')
 expect(f.store.taskExecution(f.userId,f.task.id).count).toBe(0)
 await expect(f.h.runTool(f.worker,'orchestrator_report',{state:'ready',summary:'不得把拒绝当作完成'})).rejects.toThrow('not complete')
}

it('ready metadata with no read request cannot manufacture a receipt or finish',async()=>{
 const f=await fixture(false)
 expect(f.store.sources.queryCurrent(f.userId,f.goal.id,'okx')).toMatchObject({state:'ready'})
 expect(await f.h.alongApi('GET','source-reads?user_id='+f.userId,undefined,f.headers)).toMatchObject({status:200,body:{requests:[]}})
 await expect(f.h.runTool(f.worker,'along_calculate',f.input)).rejects.toThrow('source-dependent calculation requires')
 await expect(f.h.runTool(f.worker,'along_task_finish',{outcome:'keep',types:[],reason:'没有实际读取',calculation_receipt:'invented_receipt'})).rejects.toThrow()
 await stillOpen(f)
},30000)

it('a real pending read is not data and cannot calculate',async()=>{
 const f=await fixture()
 await expect(f.h.runTool(f.worker,'along_calculate',{...f.input,source_request_id:f.requested.request_id})).rejects.toThrow('fresh authorized source read')
 await stillOpen(f)
},30000)

it.each(['fake_path','wrong_usd_unit','missing_parameter_labels','unlabeled_parameter','implicit_literal_one','strict_unknown_argument'])('actual registered schema and host proof reject %s without counting an execution',async kind=>{
 const f=await fixture();expect(await f.supply()).toMatchObject({status:200,body:{status:'accepted'}})
 const args:Record<string,unknown>={...structuredClone(f.input),source_request_id:f.requested.request_id}
 if(kind==='fake_path')(args.quantity_sources as typeof f.input.quantity_sources)[0]!.path=['invented_private_value']
 if(kind==='wrong_usd_unit')(args.calculation as typeof f.input.calculation).quantities[0]!.unit='CNY'
 if(kind==='missing_parameter_labels')delete args.quantity_parameters
 if(kind==='unlabeled_parameter')(args.quantity_parameters as {kind:string}[])[0]!.kind='unlabeled'
 if(kind==='implicit_literal_one')args.quantity_parameters=(args.quantity_parameters as {quantity:string}[]).filter(p=>p.quantity!=='identity')
 if(kind==='strict_unknown_argument')args.user_id='foreign'
 await expect(f.h.runTool(f.worker,'along_calculate',args)).rejects.toThrow()
 if(kind==='strict_unknown_argument'||kind==='unlabeled_parameter'){
  // Same valid payload is still new: invalid schema never entered the body to persist a receipt.
  expect(await f.h.runTool(f.worker,'along_calculate',{...f.input,source_request_id:f.requested.request_id})).toMatchObject({reused:false})
 }
 await stillOpen(f)
},30000)

it('an earlier accepted same-goal user number is not the current explicit parameter',async()=>{
 const f=await fixture(true,true);expect(await f.supply()).toMatchObject({status:200,body:{status:'accepted'}})
 const args={...structuredClone(f.input),source_request_id:f.requested.request_id}
 args.calculation.quantities.find(q=>q.name==='target')!.value='900'
 Object.assign(args.quantity_parameters.find(p=>p.quantity==='target')!,{event_id:'previous_parameters',quote:'900美元'})
 await expect(f.h.runTool(f.worker,'along_calculate',args)).rejects.toThrow('current same-goal accepted direct evidence')
 await stillOpen(f)
},30000)

it.each(['stale','revoked','source_revision','user_input','task_revision'])('a valid mixed receipt cannot finish after %s changes',async kind=>{
 const f=await fixture();expect(await f.supply()).toMatchObject({status:200,body:{status:'accepted'}})
 const receipt=await f.h.runTool(f.worker,'along_calculate',{...f.input,source_request_id:f.requested.request_id})
 if(kind==='stale'){
  const now=Date.now(),spy=vi.spyOn(Date,'now').mockReturnValue(now+61_000)
  restoreClock=()=>spy.mockRestore()
 }
 if(kind==='revoked'||kind==='source_revision')expect(await f.h.alongApi('POST','source-events',{...f.source,event_id:'new_'+kind,revision:2,reference:'changed_ref',...kind==='revoked'?{state:'revoked',capabilities:[]}:{}},f.headers)).toMatchObject({status:200,body:{status:'accepted'}})
 if(kind==='user_input')expect(f.along.service.acceptEvent({event_id:'corrected_user',schema_version:'1',event_type:'along.user_message',goal_id:f.goal.id,occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text:'不要再用原参数，目标改为2000美元。'}},{userId:f.userId,deviceId:f.deviceId})).toMatchObject({status:'accepted'})
 if(kind==='task_revision')f.store.appendTaskRevision({userId:f.userId,taskId:f.task.id,content:'新版本的合成核算任务',originEventId:'trusted_host_revision'})
 const finish=()=>f.h.runTool(f.worker,'along_task_finish',{outcome:'keep',types:[],reason:'旧收据不得越过新状态',calculation_receipt:receipt.receipt_id})
 if(kind==='stale')await expect(finish()).rejects.toThrow('fresh authorized source read')
 else expect(await finish()).toMatchObject({status:'conflicted',reason:'conflicted_input'})
 await stillOpen(f)
},30000)

it.each(['stale','revoked'])('revalidates private receipt evidence even on an immediate trigger after %s',async kind=>{
 const f=await fixture(true,false,true);expect(await f.supply()).toMatchObject({status:200,body:{status:'accepted'}})
 const receipt=await f.h.runTool(f.worker,'along_calculate',{...f.input,source_request_id:f.requested.request_id})
 if(kind==='stale'){const spy=vi.spyOn(Date,'now').mockReturnValue(Date.now()+61_000);restoreClock=()=>spy.mockRestore()}
 else expect(await f.h.alongApi('POST','source-events',{...f.source,event_id:'revoked_immediate',revision:2,state:'revoked',capabilities:[]},f.headers)).toMatchObject({status:200})
 await expect(f.h.runTool(f.worker,'along_task_finish',{outcome:'keep',types:[],reason:'不得用立即触发绕过私有数据复核',calculation_receipt:receipt.receipt_id})).rejects.toThrow('fresh authorized source read')
 await stillOpen(f)
},30000)
it('an immediate occurrence that requested private data cannot drop evidence labels to pretend the numbers are public',async()=>{
 const f=await fixture(true,false,true)
 const unbound={calculation:f.input.calculation}
 await expect(f.h.runTool(f.worker,'along_calculate',unbound)).rejects.toThrow('source-dependent calculation requires')
 expect(await f.supply()).toMatchObject({status:200,body:{status:'accepted'}})
 expect(await f.read()).toMatchObject({state:'ready'})
 await expect(f.h.runTool(f.worker,'along_calculate',unbound)).rejects.toThrow('source-dependent calculation requires')
 expect(f.store.taskExecution(f.userId,f.task.id).count).toBe(0)
 expect(f.store.syncPage(f.userId,0,200).items.some(i=>(i.payload as any).calculation_receipt_id)).toBe(false)
},30000)

it('a private read wait does not block an independent real calculation in the same goal or taint its separate occurrence',async()=>{
 const f=await fixture(true,false,false,true)
 expect(f.requested.state).toBe('pending')
 // Controlled Host idle transition after the real read tool; no user event, fake result or time travel.
 f.h.runtime.engine.report(f.ticket.id,{state:'waiting',summary:'Private read pending; wait on actual Host response.'})
 const independent=f.store.insertTask({userId:f.userId,goalId:f.goal.id,content:'计算3次25分钟的总时长'});f.store.appendTaskRevision({userId:f.userId,taskId:independent.id})
 f.store.triggers.put(f.store.assertTaskOwner(f.userId,independent.id),{kind:'immediate',actor:'agent',capability:'calculation'},f.store.inputVersion(f.goal.id))
 await f.h.runtime.pump();await f.h.runtime.idle()
 const ticket=f.h.runtime.store.tickets.list().find(t=>t.mandate.basis.via==='task_due'&&!t.ended&&t.id!==f.ticket.id)!;expect(ticket).toBeDefined()
 const worker='worker-'+ticket.id;await vi.waitFor(()=>expect(f.h.tools.has(worker)).toBe(true));expect(await f.h.runTool(worker,'along_task_context',{})).toMatchObject({task:{task_id:independent.id}})
 const receipt=await f.h.runTool(worker,'along_calculate',{calculation:{quantities:[{name:'count',value:'3',unit:'1'},{name:'duration',value:'25',unit:'minute'}],steps:[{id:'total',op:'multiply',inputs:['count','duration']},{id:'minutes',op:'convert',inputs:['total'],unit:'minute'}],result_step:'minutes'}})
 expect(receipt).toMatchObject({result:{value:'75',unit:'minute'}})
 await f.h.runTool(worker,'along_task_finish',{outcome:'keep',types:[],reason:'独立步骤真实完成，不等待账户',calculation_receipt:receipt.receipt_id})
 await f.h.runTool(worker,'orchestrator_report',{state:'ready',summary:'75分钟已持久化'})
 expect(f.store.taskExecution(f.userId,independent.id).count).toBe(1);expect(f.store.taskExecution(f.userId,f.task.id).count).toBe(0)
 expect(f.store.getTask(f.userId,f.task.id)?.status).toBe('open')
},30000)
