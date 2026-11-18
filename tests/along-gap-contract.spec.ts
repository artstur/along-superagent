/** Controlled Date and research evidence; real Runtime/Engine/API/SQLite/registered tools. No personal data. */
import { afterEach, expect, it, vi } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'
import { Store } from '../src/app/store.ts'
import { researchTools,publicHttpsUrl } from '../src/along/web-research.ts'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userId='u_gap_contract',deviceId='d_gap_contract'
let h:Host|undefined
const dirs:string[]=[]
afterEach(async()=>{await h?.stop();h=undefined;vi.useRealTimers();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})
function availableWeb(host:Host){
 const original=host.ctx.get.bind(host.ctx)
 vi.spyOn(host.ctx,'get').mockImplementation((name:string)=>name==='web'?{search:async()=>({sources:[],truncated:false}),fetch:async()=>({})}:name==='settings'?{describe:()=>[{ns:'web',value:{searchProvider:'deepseek-search-api',fetchProvider:'deepseek-fetch-api'}},{ns:'web-deepseek-api',value:{sendOriginalQuestion:false}}]}:original(name as never))
}
async function start(){
 const directory=mkdtempSync(join(tmpdir(),'along-gap-runtime-'));dirs.push(directory)
 const seed=new Store(join(directory,'orchestrator.sqlite'));seed.saveSettings({...seed.settings(),sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}}});seed.close()
 const host=await startRuntime(undefined,{dir:directory})
 availableWeb(host)
 const s=host.runtime.store.settings()
 host.runtime.store.saveSettings({...s,eval:{...s.eval,mode:'auto'},sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}},policy:{...s.policy,sources:{along:{allowed:[{id:userId}],admission:{}}}}})
 host.runtime.along!.service.alongStore.assertUser(userId,deviceId)
 return h=host
}
async function dispatchInput(eventId:string,text:string,goalId?:string){
 const service=h!.runtime.along!.service,store=service.alongStore
 const wire={event_id:eventId,schema_version:'1',event_type:'along.user_message',...(goalId?{goal_id:goalId}:{}),occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text}}
 expect(service.acceptEvent(wire,{userId,deviceId})).toMatchObject({status:'accepted'})
 await h!.runtime.pump();await h!.runtime.idle()
 await vi.waitFor(()=>expect(store.getDelivery('along:'+userId+':'+eventId)?.status).toBe('delivered'),{timeout:10000})
 const route=await h!.route({kind:'accept',trigger_id:'along:'+userId+':'+eventId,title:'处理当步用户请求',worktree_name:'gap-contract',acknowledgement:'处理当步请求。'})
 const worker='worker-'+(route.ticket as {ticket_id:string}).ticket_id
 await h!.runtime.idle();await vi.waitFor(()=>expect(h!.tools.has(worker)).toBe(true))
 return {worker,wire}
}

it('O06.04 does not research or publish a future weekly recommendation before its clock, including after restart',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-18T06:00:00Z'))
 await start()
 const user='每周五晚上帮我查广州深圳周末的天气和路线开放情况，合适时给我徒步推荐，不适合就告诉我原因；执行时间你合理选。'
 const {worker:planner}=await dispatchInput('future_weekly',user)
 const committed=await h!.runTool(planner,'along_changes_commit',{idempotency_key:'future_weekly_plan',base_revision:0,input_version:1,reason:'只安排用户授权的未来周五研究',ops:[
  {op:'goal.create',domain:'custom',title:'周五研究周末徒步',context:[user]},
  {op:'task.create',content:'查广州深圳周末的天气和路线开放情况；合适时给出徒步推荐，不适合时说明原因',scheduled_at:'2026-11-20T19:00:00+08:00',repeat:'weekly',reminder_plan:{state:'scheduled',source:'agent',recurrence_source:'agent',action:'查广州深圳周末的天气和路线开放情况',evidence:'每周五晚上帮我查广州深圳周末的天气和路线开放情况，合适时给我徒步推荐，不适合就告诉我原因',explanation:'用户授权周五晚例行研究，选择19点执行'},trigger:{kind:'time',actor:'agent',capability:'research'}}
 ]})
 expect(committed).toMatchObject({status:'applied'})
 const store=h!.runtime.along!.service.alongStore,goalId=store.conversationGoal(userId,'future_weekly')!,task=store.listTasks(userId,{goalId},{limit:20}).items[0]!
 await expect(h!.runTool(planner,'along_web_search',{query:'广州 徒步 开放',purpose:'access'})).rejects.toThrow('Research execution is already queued')
 await h!.runTool(planner,'along_chat_reply',{text:'已安排周五19点执行，届时查证后交付；当前没有推荐结果。'})
 await h!.runTool(planner,'orchestrator_report',{state:'ready',summary:'未来时间触发已持久保存'})
 const noEarlyResult=()=>{
  const s=h!.runtime.along!.service.alongStore
  expect(h!.runtime.store.tickets.list().filter(t=>t.mandate.basis.via==='task_due')).toHaveLength(0)
  expect(s.taskExecution(userId,task.id).count).toBe(0)
  expect(s.syncPage(userId,0,200).items.filter(i=>(i.payload as any).recommendation)).toHaveLength(0)
  expect(s.getTask(userId,task.id)?.trigger).toMatchObject({kind:'time',state:'scheduled'})
 }
 await h!.runtime.pump();await h!.runtime.idle();noEarlyResult()
 const dir=h!.directory;await h!.stop();h=await startRuntime(undefined,{dir});availableWeb(h)
 vi.setSystemTime(new Date('2026-11-20T10:59:59Z'))
 await h!.runtime.pump();await h!.runtime.idle();noEarlyResult()
 vi.setSystemTime(new Date('2026-11-20T11:00:00Z'))
 await h!.runtime.pump();await h!.runtime.idle()
 const due=h!.runtime.store.tickets.list().find(t=>t.mandate.basis.via==='task_due')!
 expect(due).toBeDefined();const worker='worker-'+due.id
 await vi.waitFor(()=>expect(h!.tools.has(worker)).toBe(true))
 expect(await h!.runTool(worker,'along_task_context',{})).toMatchObject({task:{task_id:task.id},trigger:{kind:'time',actor:'agent',capability:'research'}})
 // Controlled fetched evidence is introduced only after the actual due occurrence exists.
 const s=h!.runtime.along!.service.alongStore,scope={userId,goalId,ticketId:due.id}
 const url='https://www.gz.gov.cn/synthetic-gap-fixture',content='全程6公里。步道正常开放。周末晴天。当前无气象灾害预警信号'
 const web={assertProvider:()=>{},search:async()=>({sources:[{url,title:'合成来源',summary:content}],truncated:false}),fetch:async()=>({url,statusCode:200,body:{kind:'text' as const,content},truncated:false})}
 const tools=researchTools(s.research,()=>scope,()=>web,async value=>publicHttpsUrl(value))
 const call=async(name:string,args:unknown)=>{const tool=tools.find(t=>t.name===name)!;return await tool.execute(tool.schema.parse(args),new AbortController().signal) as any}
 const source=async(purpose:'route'|'access'|'weather')=>{const found=await call('along_web_search',{query:'合成公共步道 '+purpose,purpose});const fetched=await call('along_web_fetch',{source_id:found.sources[0].id,purpose});expect(fetched.status).toBe('ok');return fetched.source}
 const route=await source('route'),access=await source('access'),weather=await source('weather')
 const finished=await h!.runTool(worker,'along_task_finish',{outcome:'keep',types:[],reason:'到达授权时间后完成合成研究',text:'合成周末候选已保存',recommendation:{kind:'hiking',title:'合成周末候选',summary:'仅供时间边界回归的合成结果',timeWindow:'周末',constraints:[],options:[{id:'route_one',title:'合成步道',reason:'回归时间边界',conditions:['出发前再核查'],unknowns:[],facts:[{label:'距离',value:'6公里',evidence:[{sourceId:route.id,quote:'全程6公里'}]}],checks:[{kind:'access',status:'ok',summary:'步道正常开放',evidence:[{sourceId:access.id,quote:'步道正常开放'}]},{kind:'weather',status:'ok',summary:'周末晴天',evidence:[{sourceId:weather.id,quote:'周末晴天'}],alertStatus:'clear',alertEvidence:[{sourceId:weather.id,quote:'当前无气象灾害预警信号'}]}]}],nextStep:'本结果为隔离合成回归，不是实际出行推荐'}})
 expect(finished).toMatchObject({status:'recorded'})
 await h!.runTool(worker,'orchestrator_report',{state:'ready',summary:'在实际到点后持久保存合成研究结果'})
 expect(s.taskExecution(userId,task.id).count).toBe(1)
 const results=s.syncPage(userId,0,200).items.filter(i=>(i.payload as any).recommendation)
 expect(results).toHaveLength(1);expect(results[0]?.taskId).toBe(task.id)
 expect(s.getTask(userId,task.id)?.status).toBe('open')
 expect(Date.parse(s.getTask(userId,task.id)!.scheduledAt!)).toBeGreaterThan(Date.now())
},30000)

it('O12.04 durably waits for user input, survives restart and resumes the same task from an actual accepted reply once',async()=>{
 await start()
 const s=h!.runtime.along!.service.alongStore,goal=s.insertGoal({userId,domain:'custom'})
 s.appendGoalRevision({userId,goalId:goal.id,title:'缺少策略材料的目标',status:'active'});s.ensureInputVersion(userId,goal.id)
 const task=s.insertTask({userId,goalId:goal.id,content:'拿到用户说明的策略规则后整理可核对的评估材料清单'});s.appendTaskRevision({userId,taskId:task.id})
 s.triggers.put(s.assertTaskOwner(userId,task.id),{kind:'waiting',actor:'agent',capability:'research',resume:'user_input',reason:'等待用户提供策略规则说明，不能索取聊天密钥'},1)
 await h!.runtime.pump();await h!.runtime.idle()
 expect(h!.runtime.store.tickets.list().filter(t=>t.mandate.basis.via==='task_due')).toHaveLength(0)
 expect(s.getTask(userId,task.id)?.trigger).toMatchObject({state:'waiting'})
 const dir=h!.directory;await h!.stop();h=await startRuntime(undefined,{dir});availableWeb(h)
 const restored=h!.runtime.along!.service.alongStore
 expect(restored.triggers.get(userId,task.id)?.definition).toMatchObject({kind:'waiting',resume:'user_input'})
 await h!.runtime.pump();await h!.runtime.idle()
 expect(h!.runtime.store.tickets.list().filter(t=>t.mandate.basis.via==='task_due')).toHaveLength(0)
 const {worker:planner,wire}=await dispatchInput('provided_strategy','策略只做现货，记录每次买卖日期、数量和费用；先整理需要保留哪些材料，不评价收益。',goal.id)
 await h!.runTool(planner,'along_chat_reply',{text:'已收到策略规则说明；会整理材料清单，不需要聊天中的API密钥，也不会用缺失成交数据评价收益。'})
 await h!.runTool(planner,'orchestrator_report',{state:'ready',summary:'已处理新输入，释放原等待任务'})
 await h!.runtime.pump();await h!.runtime.idle()
 const due=h!.runtime.store.tickets.list().filter(t=>t.mandate.basis.via==='task_due')
 expect(due).toHaveLength(1);const worker='worker-'+due[0]!.id
 await vi.waitFor(()=>expect(h!.tools.has(worker)).toBe(true))
 expect(await h!.runTool(worker,'along_task_context',{})).toMatchObject({task:{task_id:task.id}})
 expect(restored.inputVersion(goal.id)).toBe(2)
 expect(restored.taskExecution(userId,task.id).count).toBe(0)
 expect(h!.runtime.along!.service.acceptEvent(wire,{userId,deviceId})).toMatchObject({status:'duplicate'})
 for(let n=0;n<3;n++){await h!.runtime.pump();await h!.runtime.idle()}
 expect(h!.runtime.store.tickets.list().filter(t=>t.mandate.basis.via==='task_due').map(t=>t.id)).toEqual(due.map(t=>t.id))
 expect(restored.getTask(userId,task.id)?.id).toBe(task.id)
},30000)
