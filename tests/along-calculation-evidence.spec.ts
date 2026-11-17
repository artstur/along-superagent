/** Synthetic private inputs, explicit user parameters and named constants exercise real receipt/source persistence. */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { AlongStore } from '../src/along/store.ts'
import { AlongService } from '../src/along/service.ts'
import { createInbox } from '../src/along/inbox.ts'
import { createChangeSetModule } from '../src/along/changeset.ts'
import { CALCULATION_CONSTANTS, QUANTITY_PARAMETERS, QUANTITY_SOURCES } from '../src/along/calculation-evidence.ts'
import type { CalculationInput } from '../src/along/calculation.ts'
import type { SourceReadScope } from '../src/along/source-state.ts'
const stores:AlongStore[]=[],dirs:string[]=[],reads:DatabaseSync[]=[]
afterEach(()=>{vi.useRealTimers();for(const db of reads.splice(0))db.close();for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true})})
function fixture(text='我的目标是1000美元，按12个月安排，再对比24个月。',data:Record<string,unknown>={tradingEquityUsd:'125.20',assetCount:2,positionCount:2}) {
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
 const dir=mkdtempSync(join(tmpdir(),'along-calculation-evidence-'));dirs.push(dir)
 const store=new AlongStore(join(dir,'along.sqlite'));stores.push(store)
 const db=new DatabaseSync(join(dir,'along.sqlite'),{readOnly:true});reads.push(db)
 const identity={userId:'synthetic_evidence',deviceId:'synthetic_device'};store.assertUser(identity.userId,identity.deviceId)
 const goal=store.insertGoal({userId:identity.userId,domain:'custom'});store.appendGoalRevision({userId:identity.userId,goalId:goal.id,title:'合成来源参数',status:'active'});store.ensureInputVersion(identity.userId,goal.id)
 const service=new AlongService(store,{inbox:createInbox(store),changeset:createChangeSetModule(store)})
 const user=(event_id:string,text:string,goalId=goal.id)=>service.acceptEvent({event_id,schema_version:'1',event_type:'along.user_message',goal_id:goalId,occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text}},identity)
 user('current_parameters',text)
 const task=store.insertTask({userId:identity.userId,goalId:goal.id,content:'计算合成目标的每月差额'});store.appendTaskRevision({userId:identity.userId,taskId:task.id})
 const scope:SourceReadScope={userId:identity.userId,goalId:goal.id,taskId:task.id,taskRevision:store.getTask(identity.userId,task.id)!.currentRevision,inputVersion:store.inputVersion(goal.id),ticketId:'synthetic_ticket',executionKey:'synthetic_occurrence'}
 store.replaceGoalDataSources(identity.userId,goal.id,[{provider:'okx',reason:'合成只读账户'}])
 const event=(extra:Record<string,unknown>={})=>({event_id:'source_ready',goal_id:goal.id,provider:'okx',generation:1,revision:1,state:'ready',capabilities:['trading_account_summary'],occurred_at:new Date().toISOString(),reference:'synthetic_ref',...extra})
 store.sources.acceptEvent(identity,event())
 const read=(s=scope)=>{
  const request=store.sources.createRead(s,{provider:'okx',capability:'trading_account_summary',max_age_seconds:60})
  expect(store.sources.acceptReadResult(identity,{request_id:request.request_id,state:'ready',generation:1,revision:1,observed_at:new Date().toISOString(),reference:'synthetic_ref',data})).toMatchObject({status:'accepted'})
  return request.request_id
 }
 const requestId=read(),equity={name:'equity',value:'125.20',unit:'USD'},sources=[{quantity:'equity',path:['tradingEquityUsd']}]
 const verify=(quantities:CalculationInput['quantities'],parameters:unknown=[],bindings:unknown=sources,s=scope,r=requestId)=>store.calculationEvidence.verify(s,r,bindings,quantities,parameters)
 const calculate=(input:CalculationInput,s=scope)=>store.calculations.calculate({...s,taskContent:task.content},input)
 return {store,db,identity,goal,task,scope,event,requestId,equity,sources,verify,calculate,user,read}
}
const parameters=[{quantity:'target',kind:'user',event_id:'current_parameters',quote:'1000美元'},{quantity:'horizon',kind:'user',event_id:'current_parameters',quote:'12个月'}]
const input:CalculationInput={quantities:[{name:'equity',value:'125.20',unit:'USD'},{name:'target',value:'1000',unit:'USD'},{name:'horizon',value:'12',unit:'month'}],steps:[{id:'gap',op:'subtract',inputs:['target','equity']},{id:'monthly',op:'divide',inputs:['gap','horizon']}],result_step:'monthly'}

it('computes 72.9 USD/month from real private field plus separately labeled current user target/horizon, keeping proof private',()=>{
 const f=fixture(),before=f.db.prepare('SELECT COUNT(*) n FROM sync_outbox').get()!.n
 const evidence=f.verify(input.quantities,parameters),receipt=f.calculate(input)
 expect(evidence).toMatchObject({version:1,read:{request_id:f.requestId},sources:[{quantity:'equity',value:'125.2',unit:'USD'}],parameters:[{kind:'user',quantity:'horizon',value:'12',unit:'month'},{kind:'user',quantity:'target',value:'1000',unit:'USD'}]})
 expect(receipt.calculation.result).toMatchObject({value:'72.9',unit:'USD/month'})
 f.store.calculationEvidence.record(receipt.id,f.requestId,evidence)
 f.store.calculationEvidence.assertCurrent(f.scope,receipt.id,input.quantities)
 expect(f.db.prepare('SELECT COUNT(*) n FROM sync_outbox').get()!.n).toBe(before)
 expect(f.db.prepare('SELECT bindings FROM task_calculation_source').get()!.bindings).toContain('"kind":"user"')
 expect(f.store.taskExecution(f.identity.userId,f.task.id).count).toBe(0) // calculation alone is not published execution
})

it.each(Object.entries(CALCULATION_CONSTANTS))('requires named constant %s rather than a literal exemption', (name,value)=>{
 const f=fixture(),q=[f.equity,{name:'scale',value,unit:'1'}]
 expect(f.verify(q,[{quantity:'scale',kind:'constant',name}]).parameters).toEqual([{quantity:'scale',kind:'constant',name,value,unit:'1'}])
 expect(()=>f.verify(q)).toThrow('explicit source or parameter')
})

it('rejects constant value/unit fabrication, unknown registries, missing private mapping and duplicate evidence',()=>{
 const f=fixture(),constant={quantity:'period',kind:'constant',name:'months_per_year'}
 expect(()=>f.verify([f.equity,{name:'period',value:'24'}],[constant])).toThrow('named standard constant')
 expect(()=>f.verify([f.equity,{name:'period',value:'12',unit:'month'}],[constant])).toThrow('named standard constant')
 expect(()=>f.verify([f.equity],[{quantity:'equity',kind:'constant',name:'arbitrary'}])).toThrow()
 expect(()=>f.verify([{name:'period',value:'12'}],[constant],[])).toThrow('at least one registered')
 expect(()=>f.verify([f.equity],[{quantity:'equity',kind:'constant',name:'months_per_year'}])).toThrow('duplicate quantity evidence')
 expect(()=>f.verify([f.equity],[{quantity:'absent',kind:'constant',name:'zero'}])).toThrow('not a calculation input')
})

it('accepts bounded decimal/thousands literals and explicit monthly units without inventing conversion',()=>{
 const f=fixture('我的目标是50,000美元；每月1000美元；周期12个月。')
 expect(f.verify([f.equity,{name:'target',value:'50000',unit:'USD'}],[{quantity:'target',kind:'user',event_id:'current_parameters',quote:'50,000美元'}]).parameters[0]).toMatchObject({value:'50000',unit:'USD'})
 expect(f.verify([f.equity,{name:'monthly',value:'1000',unit:'USD/month'}],[{quantity:'monthly',kind:'user',event_id:'current_parameters',quote:'每月1000美元'}]).parameters[0]).toMatchObject({value:'1000',unit:'USD/month'})
 for(const [value,unit,quote] of [['1000','CNY','1000美元'],['100','USD','1000美元'],['12','USD','12个月'],['1000','USD','不存在的1000美元'],['1000','1','1000美元'],['12','count','12个月']])
  expect(()=>f.verify([f.equity,{name:'p',value:value!,unit:unit!}],[{quantity:'p',kind:'user',event_id:'current_parameters',quote}])).toThrow()
})

it('rejects foreign, unaccepted, assistant, background and superseded user event references',()=>{
 const f=fixture(),q=[f.equity,{name:'target',value:'1000',unit:'USD'}]
 for(const event_id of ['unknown','other_goal','assistant_fact','background_fact']){
  f.store.appendMessage({userId:f.identity.userId,eventId:event_id,role:event_id==='assistant_fact'?'assistant':'user',direction:event_id==='assistant_fact'?'outbound':'inbound',audience:event_id==='background_fact'?'background':'conversation',text:'1000美元'})
  expect(()=>f.verify(q,[{quantity:'target',kind:'user',event_id,quote:'1000美元'}])).toThrow('current same-goal accepted')
 }
 const other=f.store.insertGoal({userId:f.identity.userId,domain:'custom'});f.store.appendGoalRevision({userId:f.identity.userId,goalId:other.id,title:'另一个目标',status:'active'});f.store.ensureInputVersion(f.identity.userId,other.id)
 f.user('accepted_foreign_goal','目标是1000美元',other.id)
 expect(()=>f.verify(q,[{quantity:'target',kind:'user',event_id:'accepted_foreign_goal',quote:'1000美元'}])).toThrow('current same-goal accepted')
 f.user('new_parameters','目标改为2000美元，不再沿用原参数。')
 const current={...f.scope,inputVersion:f.store.inputVersion(f.goal.id)},id=f.read(current)
 expect(()=>f.verify(q,[{quantity:'target',kind:'user',event_id:'current_parameters',quote:'1000美元'}],f.sources,current,id)).toThrow('current same-goal accepted')
})

it('does not equate ready metadata or an unread request with a usable private input',()=>{
 const f=fixture(),unread=f.store.sources.createRead(f.scope,{provider:'okx',capability:'trading_account_summary',max_age_seconds:120})
 expect(f.store.sources.queryCurrent(f.identity.userId,f.goal.id,'okx')?.state).toBe('ready')
 expect(unread.state).toBe('pending')
 expect(()=>f.verify(input.quantities,parameters,f.sources,f.scope,unread.request_id)).toThrow('fresh authorized source read')
})

it('accepts only registered private fields and their fixed units, never fallback unit labels or unsafe nested paths',()=>{
 const f=fixture()
 expect(()=>f.verify([{...f.equity,unit:'CNY'}])).toThrow('source field unit')
 for(const path of [['unknown'],['unit'],['nested','tradingEquityUsd'],['constructor'],['__proto__']])
  expect(()=>f.verify([f.equity],[],[{quantity:'equity',path}])).toThrow()
 expect(f.verify([{name:'count',value:'2',unit:'count'}],[],[{quantity:'count',path:['positionCount']}]).sources[0]).toMatchObject({unit:'count',value:'2'})
 expect(()=>f.verify([{...f.equity,value:'999'}])).toThrow('does not match')
})

it('never rounds a source number to make a false literal match and supports exact small numeric exponents',()=>{
 const f=fixture('合成精度',{tradingEquityUsd:1.0000000000001,assetCount:2,positionCount:2})
 expect(()=>f.verify([{...f.equity,value:'1'}])).toThrow('does not match')
 const g=fixture('合成精度',{tradingEquityUsd:0.0000001,assetCount:2,positionCount:2})
 expect(g.verify([{...g.equity,value:'0.0000001'}]).sources[0]!.value).toBe('0.0000001')
})

it('keeps same-run retries idempotent and permits genuinely different explicit parameter calculations',()=>{
 const f=fixture(),first=f.calculate(input),proof=f.verify(input.quantities,parameters)
 f.store.calculationEvidence.record(first.id,f.requestId,proof)
 const before=f.db.prepare('SELECT bindings FROM task_calculation_source WHERE receipt_id=?').get(first.id)
 f.store.calculationEvidence.record(first.id,f.requestId,proof)
 expect(f.calculate(input)).toMatchObject({id:first.id,reused:true})
 const changed={...input,quantities:input.quantities.map(q=>q.name==='horizon'?{...q,value:'24'}:q)},otherParameters=parameters.map(p=>p.quantity==='horizon'?{...p,quote:'24个月'}:p)
 const second=f.calculate(changed),secondProof=f.verify(changed.quantities,otherParameters)
 f.store.calculationEvidence.record(second.id,f.requestId,secondProof)
 expect(second.id).not.toBe(first.id)
 expect(second.calculation.result.value).toBe('36.45')
 expect(f.db.prepare('SELECT bindings FROM task_calculation_source WHERE receipt_id=?').get(first.id)).toEqual(before)
 expect(f.db.prepare('SELECT COUNT(*) n FROM task_calculation_source').get()!.n).toBe(2)
})

it('rejects changing an existing receipt to different proof while preserving its original provenance',()=>{
 const f=fixture(),q=[{name:'count',value:'2',unit:'count'}],calc={quantities:q,steps:[{id:'r',op:'ceil' as const,inputs:['count'] as [string]}],result_step:'r'}
 const receipt=f.calculate(calc),proof=f.verify(q,[],[{quantity:'count',path:['assetCount']}])
 f.store.calculationEvidence.record(receipt.id,f.requestId,proof)
 const changed=f.verify(q,[],[{quantity:'count',path:['positionCount']}])
 expect(()=>f.store.calculationEvidence.record(receipt.id,f.requestId,changed)).toThrow('different input evidence')
 expect(JSON.parse(String(f.db.prepare('SELECT bindings FROM task_calculation_source').get()!.bindings)).sources[0].path).toEqual(['assetCount'])
})

it.each(['age','revoke','revision','input','cancel','task_revision'])('rechecks %s before publishing a stored mixed-input calculation',kind=>{
 const f=fixture(),proof=f.verify(input.quantities,parameters),receipt=f.calculate(input);f.store.calculationEvidence.record(receipt.id,f.requestId,proof)
 if(kind==='age')vi.advanceTimersByTime(61_000)
 if(kind==='revoke')f.store.sources.acceptEvent(f.identity,f.event({event_id:'revoke',revision:2,state:'revoked',capabilities:[],reference:'revoked'}))
 if(kind==='revision')f.store.sources.acceptEvent(f.identity,f.event({event_id:'new_version',revision:2,reference:'new_ref'}))
 if(kind==='input')f.user('withdraw','不要继续使用这些参数。')
 if(kind==='cancel')f.store.appendTaskRevision({userId:f.identity.userId,taskId:f.task.id,status:'cancelled'})
 if(kind==='task_revision')f.store.appendTaskRevision({userId:f.identity.userId,taskId:f.task.id,content:'新的计算'})
 expect(()=>f.store.calculationEvidence.assertCurrent(f.scope,receipt.id,input.quantities)).toThrow('fresh authorized source read')
})

it('allows same-stamp cache refresh after expiry without rewriting original proof or losing user parameter labels',()=>{
 const f=fixture(),proof=f.verify(input.quantities,parameters),receipt=f.calculate(input);f.store.calculationEvidence.record(receipt.id,f.requestId,proof)
 const original=f.db.prepare('SELECT bindings FROM task_calculation_source').get()!.bindings
 vi.advanceTimersByTime(61_000);expect(()=>f.store.calculationEvidence.assertCurrent(f.scope,receipt.id,input.quantities)).toThrow()
 f.read();const refreshed=f.verify(input.quantities,parameters)
 expect(refreshed.read.observed_at).not.toBe(proof.read.observed_at)
 f.store.calculationEvidence.record(receipt.id,f.requestId,refreshed)
 f.store.calculationEvidence.assertCurrent(f.scope,receipt.id,input.quantities)
 expect(f.db.prepare('SELECT bindings FROM task_calculation_source').get()!.bindings).toBe(original)
})

it('refuses cross-task and cross-user receipts/read scope, and serializes the actual parameter schema as JSON',()=>{
 const f=fixture(),proof=f.verify(input.quantities,parameters),receipt=f.calculate(input)
 for(const scope of [{...f.scope,userId:'foreign'},{...f.scope,goalId:'foreign'},{...f.scope,taskId:'foreign'},{...f.scope,executionKey:'foreign'}])
  expect(()=>f.verify(input.quantities,parameters,f.sources,scope)).toThrow('fresh authorized source read')
 expect(()=>f.store.calculationEvidence.record('foreign_receipt',f.requestId,proof)).toThrow('receipt is unavailable')
 f.store.calculationEvidence.record(receipt.id,f.requestId,proof)
 expect(()=>f.store.calculationEvidence.assertCurrent({...f.scope,taskId:'foreign'},receipt.id,input.quantities)).toThrow()
 for(const schema of [QUANTITY_PARAMETERS,QUANTITY_SOURCES])expect(JSON.parse(JSON.stringify(z.toJSONSchema(schema)))).toHaveProperty('type','array')
})
