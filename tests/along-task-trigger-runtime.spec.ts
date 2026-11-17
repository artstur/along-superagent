/** Real Runtime/Engine/SQLite/tool registration. Only the model's decisions are fixture-driven. */
import { afterEach, expect, it, vi } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'
import { alongKind } from '../src/sources/along.ts'
import { alongTools } from '../src/along/tools.ts'

const userId='u_trigger',deviceId='d_trigger'
let host:Host|undefined
afterEach(async()=>{await host?.stop();host=undefined})

it('executes a newly planned immediate calculation through the durable due outbox and records one real result',async()=>{
 const h=host=await startRuntime(s=>s.saveSettings({...s.settings(),sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}}}))
 h.runtime.sources.register(alongKind)
 const settings=h.runtime.store.settings()
 h.runtime.store.saveSettings({...settings,sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}},policy:{...settings.policy,sources:{along:{allowed:[{id:userId}],admission:{}}}}})
 const service=h.runtime.along!.service,store=service.alongStore
 store.assertUser(userId,deviceId)
 expect(service.acceptEvent({event_id:'new_budget',schema_version:'1',event_type:'along.user_message',occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text:'帮我算一下4200元预算减去1350元房租和860元生活费后还剩多少，马上算。'}},{userId,deviceId})).toMatchObject({status:'accepted'})
 await h.runtime.pump();await h.runtime.idle()
 const candidate='along:'+userId+':new_budget'
 await vi.waitFor(()=>expect(store.getDelivery(candidate)?.status).toBe('delivered'),{timeout:10_000})
 const route=await h.route({kind:'accept',trigger_id:candidate,title:'核算预算余额',worktree_name:'budget-trigger',acknowledgement:'开始核算。'})
 const planner='worker-'+(route.ticket as {ticket_id:string}).ticket_id
 await h.runtime.idle();await vi.waitFor(()=>expect(h.tools.has(planner)).toBe(true))
 const create={idempotency_key:'budget_create',base_revision:0,input_version:1,reason:'按用户要求立即计算预算余额',ops:[
  {op:'goal.create',domain:'custom',title:'核算预算余额',context:[]},
  {op:'task.create',content:'计算4200元预算扣除1350元房租和860元生活费后的余额',trigger:{kind:'immediate',actor:'agent',capability:'calculation'}}
 ]}
 const committed=await h.runTool(planner,'along_changes_commit',create)
 expect(committed,JSON.stringify(committed)).toMatchObject({status:'applied'})
 const goalId=store.conversationGoal(userId,'new_budget')!,task=store.listTasks(userId,{goalId},{limit:20}).items[0]!
 expect(task.trigger).toMatchObject({kind:'immediate',state:'pending'})
 // The new goal's original planner must finish before its automatic task starts.
 await h.runtime.pump();await h.runtime.idle()
 expect(h.runtime.store.tickets.list().filter(t=>t.mandate.basis.via==='task_due')).toHaveLength(0)
 expect(await h.runTool(planner,'along_changes_commit',{idempotency_key:'no_preview_completion',base_revision:1,input_version:1,reason:'不能把计划或预览当执行完成',ops:[{op:'task.update',task_id:task.id,base_revision:task.currentRevision,fields:{status:'done'}}]})).toMatchObject({status:'invalid',reason:'task_completion_requires_executor'})
 await h.runTool(planner,'along_chat_reply',{text:'已安排立即核算，结果会保存在任务详情。'})
 await h.runTool(planner,'orchestrator_report',{state:'ready',summary:'已建立计算目标并持久安排立即执行'})
 await h.runtime.pump();await h.runtime.idle()
 const due=h.runtime.store.tickets.list().find(t=>t.mandate.basis.via==='task_due'&&!t.ended)!
 expect(due).toBeDefined()
 const worker='worker-'+due.id
 await vi.waitFor(()=>expect(h.tools.has(worker)).toBe(true))
 expect(await h.runTool(worker,'along_task_context',{})).toMatchObject({task:{task_id:task.id},trigger:{kind:'immediate',actor:'agent',capability:'calculation'}})
 await expect(h.runTool(worker,'along_task_finish',{outcome:'keep',types:[],reason:'口算完成'})).rejects.toThrow('actual persisted tool receipt')
 const input={calculation:{quantities:[{name:'budget',value:'4200',unit:'CNY'},{name:'rent',value:'1350',unit:'CNY'},{name:'living',value:'860',unit:'CNY'}],steps:[{id:'after_rent',op:'subtract',inputs:['budget','rent']},{id:'balance',op:'subtract',inputs:['after_rent','living']}],result_step:'balance'}}
 const receipt=await h.runTool(worker,'along_calculate',input)
 expect(receipt).toMatchObject({persisted:true,reused:false,result:{value:'1990',unit:'CNY'}})
 expect(await h.runTool(worker,'along_calculate',input)).toMatchObject({receipt_id:receipt.receipt_id,reused:true})
 const finish={outcome:'keep',types:[],reason:'确定性工具已核算余额',calculation_receipt:receipt.receipt_id}
 expect(await h.runTool(worker,'along_task_finish',finish)).toMatchObject({status:'recorded',reused:false})
 expect(await h.runTool(worker,'along_task_finish',finish)).toMatchObject({reused:true})
 await h.runTool(worker,'orchestrator_report',{state:'ready',summary:'余额1990元，结果已保存'})
 expect(store.getTask(userId,task.id)?.status).toBe('done')
 expect(store.taskExecution(userId,task.id)).toMatchObject({count:1,records:[{kind:'calculation',outcome:'calculated',summary:'计算结果：1990 CNY'}]})
 const results=store.syncPage(userId,0,200).items.filter(i=>(i.payload as {calculation_receipt_id?:string}).calculation_receipt_id)
 expect(results).toHaveLength(1)
 expect(results[0]).toMatchObject({taskId:task.id,payload:{text:'计算结果：1990 CNY',notification:{kind:'task_result'}}})
 expect(store.conversationContextPage(userId,goalId,undefined,100).items.map(m=>m.text)).toEqual([
  '帮我算一下4200元预算减去1350元房租和860元生活费后还剩多少，马上算。','已安排立即核算，结果会保存在任务详情。'
 ])
 await h.runtime.pump();await h.runtime.idle()
 expect(h.runtime.store.tickets.list().filter(t=>t.mandate.basis.via==='task_due')).toHaveLength(1)
},30_000)

it('unlocks an event task from verified source metadata, reads a bound private summary, and evaluates already-ready subscriptions',async()=>{
 const userId='u_1234abcd',deviceId='d_1234abcd'
 const h=host=await startRuntime(s=>s.saveSettings({...s.settings(),sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}}}))
 h.runtime.sources.register(alongKind)
 const settings=h.runtime.store.settings()
 h.runtime.store.saveSettings({...settings,sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}},policy:{...settings.policy,sources:{along:{allowed:[{id:userId}],admission:{}}}}})
 const along=h.runtime.along!,store=along.service.alongStore
 store.assertUser(userId,deviceId)
 const goal=store.insertGoal({userId,domain:'custom'});store.appendGoalRevision({userId,goalId:goal.id,title:'计算只读摘要中两项余额的合计',status:'active'});store.ensureInputVersion(userId,goal.id)
 store.replaceGoalDataSources(userId,goal.id,[{provider:'okx',reason:'用户指定只读摘要核算'}])
 const headers={'x-along-bridge':'1','x-along-bridge-token':along.bridgeToken,'x-along-user':userId,'x-along-device':deviceId}
 const setup=alongTools({service:along.service,scopeFor:()=>({userId,allowedGoalId:goal.id})},'setup_event').find(t=>t.name==='along_changes_commit')!
 const create=async(key:string)=>{
  const input={idempotency_key:key,base_revision:1,input_version:1,reason:'在已验证只读摘要就绪后计算合计',ops:[{op:'task.create',content:'计算只读摘要两项余额合计',trigger:{kind:'event',actor:'agent',capability:'calculation',conditions:[{kind:'source_ready',provider:'okx',capability:'trading_account_summary'}]}}]}
  expect(await setup.execute(setup.schema.parse(input),new AbortController().signal)).toMatchObject({status:'applied'})
  return store.listTasks(userId,{goalId:goal.id},{limit:20}).items.find(t=>!known.has(t.id))!
 }
 const known=new Set<string>(),first=await create('event_create');known.add(first.id)
 await h.runtime.pump();await h.runtime.idle()
 expect(h.runtime.store.tickets.list()).toHaveLength(0)
 expect(store.getTask(userId,first.id)?.trigger).toMatchObject({state:'waiting'})
 const event={event_id:'source_ready_fixture',goal_id:goal.id,provider:'okx',generation:1,revision:1,state:'ready',capabilities:['trading_account_summary'],occurred_at:new Date().toISOString(),reference:'synthetic_ref_1'}
 expect(await h.alongApi('POST','source-events',event,headers)).toMatchObject({status:200,body:{status:'accepted',event_id:event.event_id}})
 expect(await h.alongApi('POST','source-events',event,headers)).toMatchObject({status:200,body:{reused:true,applied:false}})
 const dispatch=async()=>{
  await h.runtime.pump();await h.runtime.idle()
  const ticket=h.runtime.store.tickets.list().find(t=>t.mandate.basis.via==='task_due'&&!t.ended)!
  expect(ticket).toBeDefined();const worker='worker-'+ticket.id
  await vi.waitFor(()=>expect(h.tools.has(worker)).toBe(true))
  await h.runTool(worker,'along_task_context',{})
  return {ticket,worker}
 }
 const {worker}=await dispatch()
 const requested=await h.runTool(worker,'along_source_read',{provider:'okx',capability:'trading_account_summary'})
 expect(requested).toMatchObject({state:'pending'})
 await expect(h.runTool(worker,'along_calculate',{source_request_id:requested.request_id,quantity_sources:[{quantity:'a',path:['first']}],calculation:{quantities:[{name:'a',value:'999',unit:'TEST'}],steps:[{id:'result',op:'ceil',inputs:['a']}],result_step:'result'}})).rejects.toThrow('fresh authorized source read')
 const queue=await h.alongApi('GET','source-reads?user_id='+userId,undefined,headers)
 expect(queue).toMatchObject({status:200,body:{requests:[{request_id:requested.request_id,goal_id:goal.id,generation:1,revision:1}]}})
 const result={request_id:requested.request_id,state:'ready',generation:1,revision:1,observed_at:new Date().toISOString(),reference:event.reference,data:{synthetic:true,first:'125.20',second:'74.80',unit:'TEST'}}
 expect(await h.alongApi('POST','source-read-results',result,headers)).toMatchObject({status:200,body:{status:'accepted',request_id:requested.request_id}})
 expect(await h.alongApi('POST','source-read-results',result,headers)).toMatchObject({status:200,body:{status:'reused'}})
 expect(await h.runTool(worker,'along_source_read',{provider:'okx',capability:'trading_account_summary'})).toMatchObject({state:'ready',data:result.data})
 await expect(h.runTool(worker,'along_calculate',{source_request_id:requested.request_id,quantity_sources:[{quantity:'a',path:['first']}],calculation:{quantities:[{name:'a',value:'125.20',unit:'CNY'}],steps:[{id:'result',op:'ceil',inputs:['a']}],result_step:'result'}})).rejects.toThrow('source field unit')
 await expect(h.runTool(worker,'along_calculate',{source_request_id:requested.request_id,quantity_sources:[{quantity:'a',path:['first']}],calculation:{quantities:[{name:'a',value:'999',unit:'TEST'}],steps:[{id:'result',op:'ceil',inputs:['a']}],result_step:'result'}})).rejects.toThrow('does not match')
 await expect(h.runTool(worker,'along_calculate',{calculation:{quantities:[{name:'a',value:'999',unit:'TEST'}],steps:[{id:'result',op:'ceil',inputs:['a']}],result_step:'result'}})).rejects.toThrow('source-dependent calculation requires')
 const calculation=await h.runTool(worker,'along_calculate',{source_request_id:requested.request_id,quantity_sources:[{quantity:'a',path:['first']},{quantity:'b',path:['second']}],calculation:{quantities:[{name:'a',value:'125.20',unit:'TEST'},{name:'b',value:'74.80',unit:'TEST'}],steps:[{id:'total',op:'add',inputs:['a','b']}],result_step:'total'}})
 expect(calculation).toMatchObject({result:{value:'200',unit:'TEST'}})
 await h.runTool(worker,'along_task_finish',{outcome:'keep',types:[],reason:'按当前授权合成摘要完成核算',calculation_receipt:calculation.receipt_id})
 await h.runTool(worker,'orchestrator_report',{state:'ready',summary:'合成摘要合计200 TEST'})
 expect(JSON.stringify(store.syncPage(userId,0,200))).not.toContain('125.20')
 const second=await create('already_ready');known.add(second.id)
 const next=await dispatch()
 expect(await h.runTool(next.worker,'along_task_context',{})).toMatchObject({task:{task_id:second.id}})
 expect(await h.alongApi('POST','source-events',{...event,event_id:'disconnect_fixture',revision:2,state:'disconnected',capabilities:[]},headers)).toMatchObject({status:200})
 await expect(h.runTool(next.worker,'along_source_read',{provider:'okx',capability:'trading_account_summary'})).rejects.toThrow('superseded')
 await h.runtime.pump();await h.runtime.idle()
 expect(store.getTask(userId,second.id)?.status).toBe('open')
 expect(store.getTask(userId,second.id)?.trigger).toMatchObject({state:'waiting'})
 expect(store.taskExecution(userId,second.id).count).toBe(0)
},30_000)

it('does not complete a research operation from an empty unavailable recommendation with no actual sources',async()=>{
 const h=host=await startRuntime(s=>s.saveSettings({...s.settings(),sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}}}))
 h.runtime.sources.register(alongKind)
 const settings=h.runtime.store.settings()
 h.runtime.store.saveSettings({...settings,sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}},policy:{...settings.policy,sources:{along:{allowed:[{id:userId}],admission:{}}}}})
 vi.spyOn(h.ctx,'get').mockImplementation((name:string)=>name==='web'?{search:async()=>({sources:[],truncated:false}),fetch:async()=>({url:'https://example.com',statusCode:200,body:{kind:'text',content:''},truncated:false})}:undefined)
 const store=h.runtime.along!.service.alongStore;store.assertUser(userId,deviceId)
 const goal=store.insertGoal({userId,domain:'custom'});store.appendGoalRevision({userId,goalId:goal.id,title:'研究合成活动方案',status:'active'});store.ensureInputVersion(userId,goal.id)
 const task=store.insertTask({userId,goalId:goal.id,content:'研究合成活动方案'});store.appendTaskRevision({userId,taskId:task.id})
 store.triggers.put(store.assertTaskOwner(userId,task.id),{kind:'immediate',actor:'agent',capability:'research'},1)
 await h.runtime.pump();await h.runtime.idle()
 const ticket=h.runtime.store.tickets.list().find(t=>t.mandate.basis.via==='task_due')!,worker='worker-'+ticket.id
 await vi.waitFor(()=>expect(h.tools.has(worker)).toBe(true));await h.runTool(worker,'along_task_context',{})
 await expect(h.runTool(worker,'along_task_finish',{outcome:'keep',types:[],reason:'不能把空方案当执行完成',text:'联网暂不可用',recommendation:{kind:'general',title:'资料暂不可用',summary:'没有可信资料',constraints:[],options:[],nextStep:'稍后重试'}})).rejects.toThrow('actual verified sources')
 await expect(h.runTool(worker,'orchestrator_report',{state:'ready',summary:'假完成'})).rejects.toThrow('not complete')
 expect(store.getTask(userId,task.id)?.status).toBe('open');expect(store.taskExecution(userId,task.id).count).toBe(0)
},30_000)
