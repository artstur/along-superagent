/** Synthetic data through actual Runtime/API/registered tools. No account, network, phone or model fixture success claim. */
import {afterEach,expect,it,vi} from 'vitest'
import {readFileSync,mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {Store} from '../src/app/store.ts'
import {startRuntime,type Host} from './fixtures/host.ts'
import {alongKind} from '../src/sources/along.ts'
import {OKXHistoryReportSchema,okxHistoryResultText} from '../src/along/okx-history.ts'
import {SOURCE_CAPABILITY,SourceEventSchema} from '../src/along/source-state.ts'
import {migrateAlongSchema} from '../src/along/migrate.ts'
import {ALONG_SCHEMA_VERSION} from '../src/along/schema.ts'
let host:Host|undefined
const dirs:string[]=[]
afterEach(async()=>{vi.restoreAllMocks();await host?.stop();host=undefined;for(const p of dirs.splice(0))rmSync(p,{recursive:true,force:true})})
const userId='u_1234abcd',deviceId='d_1234abcd'
const fixture=JSON.parse(readFileSync(new URL('./fixtures/okx-history-report.json',import.meta.url),'utf8'))
function report(now=Date.now()) {
 const value=structuredClone(fixture),shift=now-Date.parse(value.windowEnd)
 for(const field of ['windowStart','windowEnd'])value[field]=new Date(Date.parse(value[field])+shift).toISOString()
 for(const rows of [value.sampleFills,value.sampleBills])for(const row of rows)row.ts=String(Number(row.ts)+shift)
 return value
}
async function setup(dir?:string){
 if(dir){const db=new Store(join(dir,'orchestrator.sqlite'));db.saveSettings({...db.settings(),eval:{...db.settings().eval,mode:'auto'},sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}},policy:{...db.settings().policy,sources:{along:{allowed:[{id:userId}],admission:{}}}}});db.close()}
 const h=host=dir?await startRuntime(undefined,{dir}):await startRuntime(s=>s.saveSettings({...s.settings(),sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}}}));if(!dir)h.runtime.sources.register(alongKind)
 const settings=h.runtime.store.settings();h.runtime.store.saveSettings({...settings,sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}},policy:{...settings.policy,sources:{along:{allowed:[{id:userId}],admission:{}}}}})
 const along=h.runtime.along!,store=along.service.alongStore;store.assertUser(userId,deviceId)
 const goal=store.insertGoal({userId,domain:'custom'});store.appendGoalRevision({userId,goalId:goal.id,title:'观察OKX交易与账单以复核策略',context:['真实用户希望分析实际交易与策略效果，规则尚未提供'],status:'active'});store.ensureInputVersion(userId,goal.id)
 along.service.acceptEvent({event_id:'original_goal',schema_version:'1',event_type:'along.user_message',goal_id:goal.id,occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text:'请读取我的只读账户成交和账单分析策略，策略规则我稍后提供。'}},{userId,deviceId})
 store.markDelivered('along:'+userId+':original_goal',new Date().toISOString());store.replaceGoalDataSources(userId,goal.id,[{provider:'okx',reason:'用户希望分析真实成交和账单'}])
 const tasks=['导出旧成交材料','本人整理策略规则'].map(content=>{const t=store.insertTask({userId,goalId:goal.id,content});store.appendTaskRevision({userId,taskId:t.id});return store.getTask(userId,t.id)!})
 const headers={'x-along-bridge':'1','x-along-bridge-token':along.bridgeToken,'x-along-user':userId,'x-along-device':deviceId}
 const fact={event_id:'summary_ready',goal_id:goal.id,provider:'okx',generation:1,revision:1,state:'ready',capabilities:['trading_account_summary'],occurred_at:new Date().toISOString(),reference:'summary_ref'}
 const source=(patch:Record<string,unknown>={})=>h.alongApi('POST','source-events',{...fact,...patch},headers)
 const worker=async(via:string)=>{await vi.waitFor(async()=>{await h.runtime.pump();await h.runtime.idle();expect(h.runtime.store.tickets.list().some(t=>t.mandate.basis.via===via&&!t.ended),'waiting for '+via+' tickets:'+JSON.stringify(h.runtime.store.tickets.list().map(t=>({via:t.mandate.basis.via,ended:t.ended})))).toBe(true)},{timeout:10_000});const t=h.runtime.store.tickets.list().find(t=>t.mandate.basis.via===via&&!t.ended)!;const session='worker-'+t.id;await vi.waitFor(()=>expect(h.tools.has(session)).toBe(true));return {ticket:t,session}}
 const commit=(session:string,ops:unknown[],key:string)=>h.runTool(session,'along_changes_commit',{idempotency_key:key,base_revision:store.getGoal(userId,goal.id)!.currentRevision,input_version:store.inputVersion(goal.id),reason:'根据真实能力补充独立分析，保全原人工行为',ops})
 return {h,along,store,goal,tasks,headers,fact,source,worker,commit}
}
async function readyHistory(dir?:string){
 const f=await setup(dir);expect(await f.source()).toMatchObject({status:200,body:{status:'accepted'}})
 const summary=await f.worker('source_review');await f.h.runTool(summary.session,'along_source_review_context',{})
 expect(await f.commit(summary.session,f.tasks.map(t=>({op:'task.update',task_id:t.id,base_revision:1,fields:{trigger:{kind:'waiting',actor:'user',capability:'reminder',resume:'user_input',reason:'此人工材料尚需本人提供'}}})),'summary_wait')).toMatchObject({status:'applied'})
 await f.h.runTool(summary.session,'along_source_review_finish',{outcome:'need_data',reason:'摘要不含成交和账单，原人工任务保持待提供',needs:['成交和账单明细及策略规则']});await f.h.runTool(summary.session,'orchestrator_report',{state:'ready',summary:'保留人工任务等待，未假造收益分析'})
 const historyFact={event_id:'history_ready',revision:2,reference:'history_ref',capabilities:['trading_account_summary','trading_history']}
 expect(await f.source(historyFact)).toMatchObject({status:200,body:{status:'accepted'}})
 const history=await f.worker('source_review');expect(history.ticket.id).not.toBe(summary.ticket.id)
 expect(await f.h.runTool(history.session,'along_source_review_context',{})).toMatchObject({review:{legacy_task_ids:[]},source:{private_data_read:false,available_reports:[{capability:'trading_history'}]}})
 expect(await f.commit(history.session,[{op:'task.create',content:'依据成交与账单报告复核实际费用与已观测盈亏分量',trigger:{kind:'event',actor:'agent',capability:'research',repeat:'on_change',conditions:[{kind:'source_ready',provider:'okx',capability:'trading_history'}]}}],'history_task')).toMatchObject({status:'applied'})
 await f.h.runTool(history.session,'along_source_review_finish',{outcome:'revise',reason:'单独创建只读历史分析；原人工材料与规则仍待本人'});await f.h.runTool(history.session,'orchestrator_report',{state:'ready',summary:'历史能力分析任务已持久化'})
 const due=await f.worker('task_due');await f.h.runTool(due.session,'along_task_context',{})
 const read=await f.h.runTool(due.session,'along_source_read',{provider:'okx',capability:'trading_history',max_age_seconds:1800})
 expect(read).toMatchObject({state:'pending',capability:'trading_history'})
 const data=report();const deliver=(patch:Record<string,unknown>={})=>f.h.alongApi('POST','source-read-results',{request_id:read.request_id,state:'ready',generation:1,revision:2,observed_at:data.windowEnd,reference:'history_ref',data,...patch},f.headers)
 return {...f,historyFact,due,read,data,deliver}
}
it('validates the real Host fixture and does not permit incomplete or raw payloads to claim a full history report',()=>{
 expect(SOURCE_CAPABILITY.parse('trading_history')).toBe('trading_history');expect(OKXHistoryReportSchema.parse(fixture)).toEqual(fixture)
 const bad=structuredClone(fixture);bad.coverage.streams[0].status='truncated';bad.coverage.streams[0].reason='page_limit';expect(OKXHistoryReportSchema.safeParse(bad).success).toBe(false)
 bad.coverage.complete=false;expect(OKXHistoryReportSchema.safeParse(bad).success).toBe(true)
 for(const capabilities of [[],['trading_history','trading_history'],['unregistered']])expect(SourceEventSchema.safeParse({event_id:'e',goal_id:'g',provider:'okx',generation:1,revision:1,state:'ready',capabilities,occurred_at:new Date().toISOString(),reference:'r'}).success).toBe(false)
 const text=okxHistoryResultText(fixture,'缺少策略规则时不能做因果归属。');expect(text).toContain('9.9');expect(text).toContain('USDT');expect(text).toContain('不是全账户净收益');expect(text).not.toContain(fixture.sampleBills[0].billId)
})
it('new history after a completed summary review dispatches once, reads actual scoped data and saves private research without a fake web source',async()=>{
 const f=await readyHistory();expect(await f.deliver()).toMatchObject({status:200,body:{status:'accepted',state:'ready'}})
 const ready=await f.h.runTool(f.due.session,'along_source_read',{provider:'okx',capability:'trading_history',max_age_seconds:1800});expect(ready).toMatchObject({state:'ready',data:{totals:f.data.totals}})
 await expect(f.h.runTool(f.due.session,'along_task_finish',{outcome:'keep',types:[],reason:'不允许省略实际私有证据',text:'即使是文字也不能跳过读取证明'})).rejects.toThrow('actual fresh source_request_id')
 const finish={outcome:'keep',types:[],reason:'已根据真实报告保存费用分量与覆盖限制，策略归属仍需本人',text:'普通交易分量不能代表全账户收益；需要本人提供策略规则和映射再比较策略。',source_request_id:f.read.request_id}
 expect(await f.h.runTool(f.due.session,'along_task_finish',finish)).toMatchObject({status:'recorded',reused:false});expect(await f.h.runTool(f.due.session,'along_task_finish',finish)).toMatchObject({status:'recorded',reused:true})
 await f.h.runTool(f.due.session,'orchestrator_report',{state:'ready',summary:'授权报告分析已回原任务详情，未做完整策略收益推断'})
 const task=f.store.goalDetail(userId,f.goal.id).tasks.find(t=>!f.tasks.some(old=>old.id===t.id))!;expect(task.status).toBe('open');expect(f.store.taskExecution(userId,task.id)).toMatchObject({count:1,records:[{kind:'research',outcome:'researched'}]})
 const result=f.store.syncPage(userId,0,200).items.find(i=>i.kind==='message'&&i.taskId===task.id)!;expect(result.payload).toMatchObject({notification:{kind:'task_result'},text:expect.stringContaining('普通交易账单盈亏分量10')});expect(result.payload).not.toHaveProperty('recommendation');expect(JSON.stringify(result)).not.toContain(f.data.sampleBills[0].billId)
 expect(f.store.conversationContextPage(userId,f.goal.id,undefined,100).items.filter(m=>m.audience==='conversation').map(m=>m.eventId)).toEqual(['original_goal'])
 for(const old of f.tasks){expect(f.store.getTask(userId,old.id)).toMatchObject({content:old.content,status:'open'});expect(f.store.taskExecution(userId,old.id).count).toBe(0)}
 for(let i=0;i<3;i++){expect(await f.source(f.historyFact)).toMatchObject({status:200});await f.h.runtime.pump()}
 expect(f.h.runtime.store.tickets.list().filter(t=>t.mandate.basis.via==='source_review')).toHaveLength(2);expect(f.store.taskExecution(userId,task.id).count).toBe(1)
 // Later source loss does not fabricate another execution or erase the already completed historical receipt.
 await f.source({event_id:'revoked',revision:3,state:'revoked',capabilities:[],reference:'revoked_ref'});expect(f.store.taskExecution(userId,task.id).count).toBe(1)
},30_000)
it.each(['missing','summary','foreign','stale','revoked','cancelled'])('rejects %s history result evidence without completing the research or old human actions',async kind=>{
 const f=await readyHistory();expect(await f.deliver()).toMatchObject({body:{status:'accepted',state:'ready'}})
 let request=f.read.request_id
 if(kind==='missing')request='sread_missing'
 if(kind==='summary'){
  request=(await f.h.runTool(f.due.session,'along_source_read',{provider:'okx',capability:'trading_account_summary',max_age_seconds:1800})).request_id
  expect(await f.deliver({request_id:request,data:{tradingEquityUsd:100,assetCount:1,positionCount:1}})).toMatchObject({body:{state:'ready'}})
 }
 if(kind==='foreign'){
  const scope=f.along.healthFollowup.sourceScope(f.due.ticket.id);request=f.store.sources.createRead({...scope,taskId:f.tasks[0]!.id,taskRevision:f.store.getTask(userId,f.tasks[0]!.id)!.currentRevision,executionKey:'foreign_occurrence'},{provider:'okx',capability:'trading_history',max_age_seconds:1800}).request_id
  expect(await f.deliver({request_id:request})).toMatchObject({body:{state:'ready'}})
 }
 if(kind==='stale'){
  // Preserve actual observation time rather than weakening the freshness bound.
  await f.source({event_id:'source_update',revision:3,reference:'new_ref',capabilities:['trading_account_summary','trading_history']})
 }
 if(kind==='revoked')await f.source({event_id:'revoke',revision:3,state:'revoked',capabilities:[],reference:'gone'})
 if(kind==='cancelled'){
  const scope=f.along.healthFollowup.sourceScope(f.due.ticket.id);f.store.appendTaskRevision({userId,taskId:scope.taskId,status:'cancelled',originEventId:'genuine_stop_fixture'})
 }
 let refused=false
 try{const result=await f.h.runTool(f.due.session,'along_task_finish',{outcome:'keep',types:[],reason:'不能凭错误读取证据完成',text:'这不是可授权的新鲜历史分析',source_request_id:request});refused=result.status!=='recorded'}catch{refused=true}
 expect(refused).toBe(true)
 for(const old of f.tasks)expect(f.store.taskExecution(userId,old.id).count).toBe(0)
 const task=f.store.goalDetail(userId,f.goal.id).tasks.find(t=>!f.tasks.some(old=>old.id===t.id))!;expect(f.store.taskExecution(userId,task.id).count).toBe(0)
},30_000)
it('refuses fake recent observation timestamps and malformed history even from an authenticated Host callback',async()=>{
 const f=await readyHistory();expect(await f.deliver({observed_at:new Date(Date.parse(f.data.windowEnd)+1000).toISOString()})).toMatchObject({status:400});expect(await f.deliver({data:{...f.data,apiKey:'forbidden'}})).toMatchObject({status:400});expect(await f.deliver()).toMatchObject({status:200,body:{state:'ready'}})
},30_000)
it('migrates schema14 review metadata without altering old business rows or erasing completed summary reviews',()=>{
 const dir=mkdtempSync(join(tmpdir(),'okx-history-schema-'));dirs.push(dir);const db=new DatabaseSync(join(dir,'db'));migrateAlongSchema(db)
 const at=new Date().toISOString()
 db.prepare('INSERT INTO user(id,name,device_id,created_at) VALUES(?,?,?,?)').run(userId,'synthetic',deviceId,at)
 db.prepare('INSERT INTO goal(id,user_id,domain,status,current_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('g_old',userId,'custom','active',1,at,at)
 db.prepare('INSERT INTO health_dispatch(event_id,user_id,goal_id,input_version,snapshot,result,created_at) VALUES(?,?,?,?,?,?,?)').run('old_review',userId,'g_old',1,'[]','{"outcome":"keep"}',at)
 db.prepare('INSERT INTO source_goal_review(event_id,provider,source_event_id,generation,revision,reference,device_id,legacy_tasks,original_task_ids) VALUES(?,?,?,?,?,?,?,?,?)').run('old_review','okx','old_source',1,1,'old_ref',deviceId,'[]','[]')
 const before=db.prepare('select * from goal').all();db.exec('ALTER TABLE source_goal_review DROP COLUMN capabilities');db.prepare("UPDATE meta SET value='14' WHERE key='schema_version'").run()
 migrateAlongSchema(db);expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value).toBe(String(ALONG_SCHEMA_VERSION));expect(db.prepare('pragma table_info(source_goal_review)').all().find(x=>x.name==='capabilities')?.dflt_value).toBe(`'["trading_account_summary"]'`);expect(db.prepare('select * from goal').all()).toEqual(before);expect(db.prepare('select capabilities from source_goal_review where event_id=?').get('old_review')?.capabilities).toBe('["trading_account_summary"]');expect(db.prepare('select result from health_dispatch where event_id=?').get('old_review')?.result).toBe('{"outcome":"keep"}');db.close()
})

it('keeps completed private history execution and capability-review deduplication across an actual Runtime restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'okx-history-runtime-'));dirs.push(dir)
 const f=await readyHistory(dir);await f.deliver()
 await f.h.runTool(f.due.session,'along_task_finish',{outcome:'keep',types:[],reason:'已读取并保存受限历史报告',text:'策略规则仍需本人提供，不能把交易分量当账户收益。',source_request_id:f.read.request_id})
 await f.h.runTool(f.due.session,'orchestrator_report',{state:'ready',summary:'有证据的历史结果已保存'})
 const task=f.store.goalDetail(userId,f.goal.id).tasks.find(t=>!f.tasks.some(old=>old.id===t.id))!;expect(f.store.taskExecution(userId,task.id).count).toBe(1)
 await f.h.stop();host=undefined;const h=host=await startRuntime(undefined,{dir});await h.runtime.pump();await h.runtime.idle()
 const store=h.runtime.along!.service.alongStore;expect(store.taskExecution(userId,task.id).count).toBe(1)
 expect(await h.alongApi('POST','source-events',{...f.fact,...f.historyFact},f.headers)).toMatchObject({body:{status:'accepted',reused:true}})
 for(let i=0;i<3;i++){await h.runtime.pump();await h.runtime.idle()}
 expect(h.runtime.store.tickets.list().filter(t=>t.mandate.basis.via==='source_review')).toHaveLength(2)
 expect(store.taskExecution(userId,task.id).count).toBe(1);for(const old of f.tasks)expect(store.taskExecution(userId,old.id).count).toBe(0)
},30_000)
it('does not turn an unavailable public web research executor into a runnable task',async()=>{
 const f=await setup(),task=f.store.insertTask({userId,goalId:f.goal.id,content:'公开联网核实资料'});f.store.appendTaskRevision({userId,taskId:task.id})
 f.store.triggers.put(f.store.getTask(userId,task.id)!,{kind:'immediate',actor:'agent',capability:'research'},f.store.inputVersion(f.goal.id))
 await f.h.runtime.pump();await f.h.runtime.idle()
 expect(f.store.triggers.get(userId,task.id)).toMatchObject({state:'waiting',reason:'等待执行能力恢复',capabilityMissing:true})
 expect(f.h.runtime.store.tickets.list().some(t=>t.mandate.basis.via==='task_due')).toBe(false)
 expect(f.store.taskExecution(userId,task.id).count).toBe(0)
},30_000)
