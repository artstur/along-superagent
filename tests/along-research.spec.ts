import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { AlongStore } from '../src/along/store.ts'
import { AlongService } from '../src/along/service.ts'
import { createInbox } from '../src/along/inbox.ts'
import { alongTools } from '../src/along/tools.ts'
import { recommendation, RECOMMENDATION_INPUT, type RecommendationInput } from '../src/along/recommendation.ts'
import { publicHttpsUrl, publicAddress, assertPublicUrl, researchTools, researchWeb, type ResearchWeb } from '../src/along/web-research.ts'
import type { ResearchPurpose } from '../src/along/research-store.ts'
import { startRuntime } from './fixtures/host.ts'
import { alongKind } from '../src/sources/along.ts'

const dirs:string[]=[],stores:AlongStore[]=[]
afterEach(()=>{vi.useRealTimers();for(const s of stores.splice(0))s.close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'along-research-'));dirs.push(dir)
 const store=new AlongStore(join(dir,'along.sqlite'));stores.push(store);const userId='u_research',deviceId='d_research'
 store.assertUser(userId,deviceId);const goal=store.insertGoal({userId,domain:'custom'})
 store.appendGoalRevision({goalId:goal.id,userId,title:'合成周末活动',status:'active'});store.ensureInputVersion(userId,goal.id)
 const scope={userId,goalId:goal.id,ticketId:'research_ticket'}
 const save=(purpose:ResearchPurpose,content:string,at=Date.now(),fetched=true)=>store.research.save(scope,{title:'合成官方来源',url:'https://www.gz.gov.cn/route',purpose,content:purpose==='weather'?content+'。当前无气象灾害预警信号':content,fetched},at)
 return {store,scope,save,deviceId}
}
const plan=(route:string,access:string,weather:string):RecommendationInput=>({kind:'hiking',title:'周末徒步选择',summary:'比较当前可核实信息',timeWindow:'周末',constraints:['轻松路线'],options:[{
 id:'route_one',title:'合成官方步道',reason:'与轻松运动偏好匹配',conditions:['出发前再次核查'],unknowns:[],facts:[{label:'路线距离',value:'6公里',evidence:[{sourceId:route,quote:'全程6公里'}]}],
 checks:[{kind:'access',status:'ok',summary:'步道开放',evidence:[{sourceId:access,quote:'步道正常开放'}]},
 {kind:'weather',status:'ok',summary:'周末天气可行',evidence:[{sourceId:weather,quote:'周末晴天'}],alertStatus:'clear',alertEvidence:[{sourceId:weather,quote:'当前无气象灾害预警信号'}]}]}],nextStep:'确认具体出发时段'})
it('keeps actual fetched source identities, host times, useful comparison and no model URLs in a structured recommendation',()=>{
 const {store,scope,save}=fixture(),route=save('route','全程6公里'),access=save('access','步道正常开放'),weather=save('weather','周末晴天')
 const result=recommendation(store.research,scope,plan(route.id,access.id,weather.id))
 expect(result).toMatchObject({version:1,status:'ready',options:[{status:'recommended',facts:[{sourceIds:[route.id]}]}]})
 expect(result.sources).toHaveLength(3);expect(result.sources[0]).toEqual({id:route.id,title:route.title,url:route.url,retrievedAt:route.retrievedAt,expiresAt:route.expiresAt})
 expect(RECOMMENDATION_INPUT.safeParse({...plan(route.id,access.id,weather.id),sources:[{url:'https://evil.invalid'}]}).success).toBe(false)
})
it('refuses foreign user, goal or ticket citations and invented quotes, even when an id exists',()=>{
 const {store,scope,save}=fixture(),source=save('route','全程6公里'),input=plan(source.id,source.id,source.id)
 for(const other of [{...scope,userId:'u_foreign'},{...scope,goalId:'g_foreign'},{...scope,ticketId:'other'}])
  expect(()=>recommendation(store.research,other,input)).toThrow('outside this research scope')
 const unsupported=structuredClone(input);unsupported.options[0]!.facts[0]!.value='99公里'
 expect(()=>recommendation(store.research,scope,unsupported)).toThrow('not supported')
 input.options[0]!.facts[0]!.evidence[0]!.quote='捏造99公里'
 expect(()=>recommendation(store.research,scope,input)).toThrow('quote not found')
})
it('never recommends closed routes, hazardous weather, old evidence, missing checks or mere search summaries',()=>{
 const {store,scope,save}=fixture(),route=save('route','全程6公里'),access=save('access','步道正常开放。临时关闭'),weather=save('weather','周末晴天。雷暴预警')
 const baseline=plan(route.id,access.id,weather.id)
 for(const kind of ['access','weather']){
  const input=structuredClone(baseline),check=input.options[0]!.checks.find(c=>c.kind===kind)!
  check.status='risk';check.summary=kind==='access'?'临时关闭':'雷暴天气';check.evidence[0]!.quote=kind==='access'?'临时关闭':'雷暴预警'
  expect(recommendation(store.research,scope,input)).toMatchObject({status:'unavailable',options:[{status:'excluded'}]})
 }
 const stale=save('weather','周末晴天',Date.now()-4*3600_000)
 expect(recommendation(store.research,scope,plan(route.id,access.id,stale.id))).toMatchObject({status:'partial',options:[{status:'conditional',checks:[{status:'ok'},{status:'unknown'}]}]})
 const summary=save('access','步道正常开放',Date.now(),false)
 expect(recommendation(store.research,scope,plan(route.id,summary.id,weather.id)).options[0]?.status).toBe('conditional')
 const missing=structuredClone(baseline);missing.options[0]!.checks=[]
 expect(recommendation(store.research,scope,missing).status).toBe('partial')
 expect(recommendation(store.research,scope,{...baseline,options:[]}).status).toBe('unavailable')
})
it('rejects local, private, credentials, sensitive queries and unsupported source URLs before provider use',async()=>{
 for(const url of ['http://www.gz.gov.cn/a','https://localhost/a','https://x.internal/a','https://127.0.0.1/a','https://[::1]/',
 'https://user:pass@www.gz.gov.cn','https://www.gz.gov.cn:8443','https://www.gz.gov.cn/?token=secret','https://example.invalid'])
  expect(()=>publicHttpsUrl(url)).toThrow()
 for(const ip of ['127.0.0.1','169.254.169.254','10.1.1.1','100.64.0.1','172.16.0.1','192.168.0.1','198.18.0.1','198.51.100.3','203.0.113.3','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1'])expect(publicAddress(ip)).toBe(false)
 for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])expect(publicAddress(ip)).toBe(true)
 const resolver=vi.fn(async()=>[{address:'127.0.0.1',family:4}]) as unknown as Parameters<typeof assertPublicUrl>[1]
 await expect(assertPublicUrl('https://www.gz.gov.cn/a',resolver)).rejects.toThrow('PUBLIC_DNS')
})
it('calls the existing web seam, stores real source content and only fetches a receipt in this scope',async()=>{
 const {store,scope}=fixture()
 const web:ResearchWeb={assertProvider:vi.fn(),search:vi.fn(async()=>({sources:[{url:'https://www.gz.gov.cn/route',title:'官方路线',summary:'全程6公里'}],truncated:false})),fetch:vi.fn(async()=>({url:'https://www.gz.gov.cn/route',statusCode:200,body:{kind:'text' as const,content:'步道正常开放。全程6公里'},truncated:false}))}
 const tools=researchTools(store.research,()=>scope,()=>web,async value=>publicHttpsUrl(value)),signal=new AbortController().signal
 const call=async(name:string,args:unknown)=>{const t=tools.find(t=>t.name===name)!;return await t.execute(t.schema.parse(args),signal) as any}
 const searched=await call('along_web_search',{query:'官方步道 开放',purpose:'access'})
 expect(searched).toMatchObject({status:'ok',untrustedContent:true,sources:[{fetched:false,content:'全程6公里'}]})
 const fetched=await call('along_web_fetch',{source_id:searched.sources[0].id,purpose:'access'})
 expect(fetched).toMatchObject({status:'ok',source:{fetched:true,content:'步道正常开放。全程6公里'}})
 expect(store.research.get(scope,fetched.source.id)?.content).toContain('正常开放')
 expect(await call('along_web_fetch',{source_id:'foreign_source',purpose:'weather'})).toMatchObject({status:'failed',error:{code:'RESEARCH_SOURCE_NOT_FOUND'}})
 expect(web.fetch).toHaveBeenCalledTimes(1);expect(web.assertProvider).toHaveBeenCalledWith('fetch')
})
it('returns explicit empty, unavailable and sanitized non-retryable auth failures, and retries a transient 429 only once',async()=>{
 const {store,scope}=fixture(),signal=new AbortController().signal
 const run=async(web:ResearchWeb|undefined)=>{
  const t=researchTools(store.research,()=>scope,()=>web,async value=>publicHttpsUrl(value))[0]!
  return await t.execute(t.schema.parse({query:'合成公开查询',purpose:'general'}),signal)
 }
 expect(await run(undefined)).toMatchObject({status:'unavailable',error:{code:'WEB_PROVIDER_UNAVAILABLE'}})
 const web:ResearchWeb={assertProvider:()=>{},search:vi.fn(async()=>({sources:[],truncated:false})),fetch:vi.fn()}
 expect(await run(web)).toMatchObject({status:'empty'})
 web.search=vi.fn(async()=>{throw Object.assign(Error('HTTP 401 token=never-show-this'),{code:'WEB_PROVIDER_ERROR'})})
 const auth=await run(web)
 expect(auth).toMatchObject({status:'failed',error:{code:'WEB_PROVIDER_CREDENTIAL_MISSING',retryable:false}})
 expect(JSON.stringify(auth)).not.toContain('never-show');expect(web.search).toHaveBeenCalledTimes(1)
 web.search=vi.fn().mockRejectedValueOnce(Object.assign(Error('HTTP 429'),{code:'WEB_PROVIDER_ERROR'})).mockResolvedValueOnce({sources:[],truncated:false})
 expect(await run(web)).toMatchObject({status:'empty'});expect(web.search).toHaveBeenCalledTimes(2)
})
it('fails closed when the public settings select an unsafe local fetch provider or are unavailable',()=>{
 const context=(provider:string)=>({get:(name:string)=>name==='web'?{search:async()=>({sources:[],truncated:false}),fetch:async()=>({})}:name==='settings'?{describe:()=>[{ns:'web',value:{fetchProvider:provider,searchProvider:'deepseek-search-api'}}]}:undefined})
 const unsafe=researchWeb(context('http') as any)!
 expect(()=>unsafe.assertProvider('fetch')).toThrow('REMOTE_PROVIDER_REQUIRED')
 expect(()=>researchWeb(context('deepseek-fetch-api') as any)!.assertProvider('fetch')).not.toThrow()
 expect(researchWeb({get:()=>undefined} as any)).toBeUndefined()
 expect(()=>researchWeb(context('deepseek-fetch-api') as any)!.assertProvider('search')).toThrow('QUERY_PRIVACY')
 const privateSearch={get:(name:string)=>name==='web'?{search:async()=>({sources:[],truncated:false}),fetch:async()=>({})}:name==='settings'?{describe:()=>[{ns:'web',value:{searchProvider:'deepseek-search-api',fetchProvider:'deepseek-fetch-api'}},{ns:'web-deepseek-api',value:{sendOriginalQuestion:false}}]}:undefined}
 expect(()=>researchWeb(privateSearch as any)!.assertProvider('search')).not.toThrow()
})
it('persists a recommendation in existing message sync with original goal/task, idempotent event and unchanged reminders',async()=>{
 const {store,scope,save,deviceId}=fixture(),inbox=createInbox(store),event='research_chat'
 inbox.acceptEvent({event_id:event,schema_version:'1',event_type:'along.user_message',goal_id:scope.goalId,occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text:'帮我比较周末徒步路线'}},{userId:scope.userId,deviceId})
 const task=store.insertTask({userId:scope.userId,goalId:scope.goalId,content:'周五安排周末活动',scheduledAt:'2027-01-08T11:00:00Z'})
 const before=store.getTask(scope.userId,task.id)
 const tool=alongTools({service:new AlongService(store),scopeFor:()=>({userId:scope.userId,allowedGoalId:scope.goalId,triggerEventId:event})},scope.ticketId).find(t=>t.name==='along_chat_reply')!
 const route=save('route','全程6公里'),access=save('access','步道正常开放'),weather=save('weather','周末晴天')
 const args={text:'已比较周末路线。',notify:'recommendation_ready',task_id:task.id,recommendation:plan(route.id,access.id,weather.id)},signal=new AbortController().signal
 expect(await tool.execute(tool.schema.parse(args),signal)).toMatchObject({status:'replied',reused:false})
 expect(await tool.execute(tool.schema.parse(args),signal)).toMatchObject({status:'replied',reused:true})
 await expect(tool.execute(tool.schema.parse({...args,recommendation:{...args.recommendation,title:'不同标题'}}),signal)).rejects.toThrow('different content')
 const messages=store.syncPage(scope.userId,0,200).items.filter(i=>i.kind==='message'&&(i.payload as any).recommendation)
 expect(messages).toHaveLength(1);expect(messages[0]).toMatchObject({goalId:scope.goalId,taskId:task.id,payload:{recommendation:{status:'ready'},notification:{kind:'recommendation_ready'}}})
 expect(store.getTask(scope.userId,task.id)).toEqual(before)
})
it('delivers a due research result through the existing bound followup and leaves the actual outing task open',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2027-01-08T11:00:00Z'))
 const h=await startRuntime(store=>store.saveSettings({...store.settings(),sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}}}))
 try{
  h.runtime.sources.register(alongKind)
  const settings=h.runtime.store.settings(),store=h.runtime.along!.service.alongStore
  const userId='u_due_research',deviceId='d_due_research'
  h.runtime.store.saveSettings({...settings,sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}},eval:{...settings.eval,mode:'auto'},policy:{...settings.policy,sources:{along:{allowed:[{id:userId}],admission:{}}}}})
  store.assertUser(userId,deviceId);const goal=store.insertGoal({userId,domain:'custom'})
  store.appendGoalRevision({goalId:goal.id,userId,title:'合成周末运动',status:'active'});store.ensureInputVersion(userId,goal.id)
  const due=store.insertTask({userId,goalId:goal.id,content:'周五根据天气安排周末徒步',scheduledAt:'2027-01-08T10:59:00Z'})
  const outing=store.insertTask({userId,goalId:goal.id,content:'周末完成徒步'})
  h.runtime.along!.healthFollowup.tick();await h.runtime.idle()
  const ticket=h.runtime.store.tickets.list()[0]!
  await vi.waitFor(()=>expect(h.tools.has('worker-'+ticket.id)).toBe(true),{timeout:10000})
  const scope={userId,goalId:goal.id,ticketId:ticket.id}
  await h.runTool('worker-'+ticket.id,'along_health_read',{})
  const source=(purpose:ResearchPurpose,content:string)=>store.research.save(scope,{title:'合成官方来源',url:'https://www.gz.gov.cn/route',purpose,content:purpose==='weather'?content+'。当前无气象灾害预警信号':content,fetched:true})
  const route=source('route','全程6公里'),access=source('access','步道正常开放'),weather=source('weather','周末晴天')
  const input={outcome:'keep',types:[],reason:'按原委托完成路线研究',text:'周末路线已整理，出发前复核天气。',recommendation:plan(route.id,access.id,weather.id)}
  expect(await h.runTool('worker-'+ticket.id,'along_health_followup',input)).toMatchObject({status:'recorded',reused:false})
  expect(await h.runTool('worker-'+ticket.id,'along_health_followup',input)).toMatchObject({status:'recorded',reused:true})
  const messages=store.syncPage(userId,0,200).items.filter(i=>(i.payload as any).recommendation)
  expect(messages).toHaveLength(1);expect(messages[0]).toMatchObject({goalId:goal.id,taskId:due.id,payload:{recommendation:{status:'ready'},notification:{kind:'recommendation_ready'}}})
  expect(store.getTask(userId,outing.id)?.status).toBe('open')
 }finally{await h.stop()}
},30_000)
it('keeps general recommendations conditional for unknown or expired checks, including expiry outside a fact',()=>{
 const {store,scope,save}=fixture(),route=save('route','全程6公里'),access=save('access','步道正常开放'),weather=save('weather','周末晴天',Date.now()-4*3600_000)
 const input=plan(route.id,access.id,weather.id);input.kind='general'
 expect(recommendation(store.research,scope,input)).toMatchObject({status:'partial',options:[{status:'conditional',checks:[{status:'ok'},{status:'unknown'}]}]})
 const unknown=structuredClone(input);unknown.options[0]!.checks=[{kind:'weather',status:'unknown',summary:'日期待确认',evidence:[]}]
 expect(recommendation(store.research,scope,unknown).options[0]?.status).toBe('conditional')
})
it('preserves a task feedback association through real inbox, WorkLink and recommendation reply by default',async()=>{
 const h=await startRuntime(s=>s.saveSettings({...s.settings(),sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}}}))
 try{
  h.runtime.sources.register(alongKind);const settings=h.runtime.store.settings()
  h.runtime.store.saveSettings({...settings,sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}},policy:{...settings.policy,sources:{along:{allowed:[{id:'u_feedback_research'}],admission:{}}}}})
  const store=h.runtime.along!.service.alongStore,userId='u_feedback_research',deviceId='d_feedback_research'
  store.assertUser(userId,deviceId);const goal=store.insertGoal({userId,domain:'custom'})
  store.appendGoalRevision({goalId:goal.id,userId,title:'合成周末活动',status:'active'});store.ensureInputVersion(userId,goal.id)
  const task=store.insertTask({goalId:goal.id,userId,content:'安排周末活动'})
  const oldFeedback='research_old_feedback'
  expect(h.runtime.along!.service.acceptEvent({event_id:oldFeedback,schema_version:'1',event_type:'along.message',kind:'task.feedback',task_id:task.id,occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.message',kind:'task.feedback',task_id:task.id,note:'之前走过这条路线，想换一个。'}},{userId,deviceId})).toMatchObject({status:'accepted'})
  const eventId='research_feedback'
  h.runtime.along!.service.acceptEvent({event_id:eventId,schema_version:'1',event_type:'along.user_message',goal_id:goal.id,task_id:task.id,occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text:'关于这个路线，帮我比较备选方案'}},{userId,deviceId})
  await h.runtime.pump();await h.runtime.idle()
  const candidate='along:'+userId+':'+eventId
  await vi.waitFor(()=>expect(store.getDelivery(candidate)?.status).toBe('delivered'),{timeout:10000})
  await h.runtime.idle()
  const routed=await h.route({kind:'accept',trigger_id:candidate,title:'比较备选路线',worktree_name:'research-feedback',acknowledgement:'开始比较。'})
  const ticketId=(routed.ticket as {ticket_id:string}).ticket_id
  await h.runtime.idle();await vi.waitFor(()=>expect(h.tools.has('worker-'+ticketId)).toBe(true),{timeout:10000})
  expect(store.getWorkLink(ticketId)?.taskId).toBe(task.id)
  expect(await h.runTool('worker-'+ticketId,'along_goal_read',{})).toMatchObject({bound_task_id:task.id})
  expect(await h.runTool('worker-'+ticketId,'along_conversation_read',{})).toMatchObject({messages:expect.arrayContaining([expect.objectContaining({event_id:oldFeedback,text:'之前走过这条路线，想换一个。'})])})
  const rec={kind:'general',title:'备选信息暂不可用',summary:'稍后重试',constraints:[],options:[],nextStep:'稍后继续'}
  await h.runTool('worker-'+ticketId,'along_chat_reply',{text:'检索暂不可用，可以稍后继续。',recommendation:rec})
  const reply=store.syncPage(userId,0,200).items.find(i=>(i.payload as any).recommendation)
  expect(reply).toMatchObject({goalId:goal.id,taskId:task.id})
  expect(store.getTask(userId,task.id)?.status).toBe('open')
  const guard=((h.agents.get('worker-'+ticketId) as any).ctx.tools.guard as any).mock.calls[0][0]
  expect(guard({name:'web_fetch'})).toContain('along_web_fetch')
  expect(guard({name:'along_web_fetch'})).toBeUndefined()
 }finally{await h.stop()}
},30_000)
it('downgrades secondary access and unsupported no-alert conclusions, replacing contradictory check text',()=>{
 const {store,scope,save}=fixture(),route=save('route','全程6公里'),weather=save('weather','周末晴天')
 const secondary=store.research.save(scope,{url:'https://trip.com/public-route',title:'第三方路线记录',content:'步道正常开放',purpose:'access',fetched:true})
 const input=plan(route.id,secondary.id,weather.id)
 const access=recommendation(store.research,scope,input).options[0]!.checks[0]!
 expect(access).toMatchObject({status:'unknown'});expect(access.summary).toContain('官方');expect(access.summary).not.toBe('步道开放')
 const official=save('access','步道正常开放'),forecastOnly=store.research.save(scope,{url:'https://www.nmc.cn/public-forecast',title:'预报',content:'周末晴天',purpose:'weather',fetched:true})
 const unsupported=plan(route.id,official.id,forecastOnly.id)
 unsupported.options[0]!.checks[1]!.summary='天气适合，无大风预警信号'
 unsupported.options[0]!.checks[1]!.alertEvidence=[{sourceId:forecastOnly.id,quote:'周末晴天'}]
 const result=recommendation(store.research,scope,unsupported)
 expect(result).toMatchObject({status:'partial',options:[{status:'conditional',checks:[{status:'ok'},{status:'unknown'}]}]})
 expect(result.options[0]!.checks[1]!.summary).not.toContain('无大风预警')
})
it('pinpoints a rejected precise fact and lets the complete original envelope recover after removing only that fact',async()=>{
 const {store,scope,save,deviceId}=fixture(),event='recover_research'
 createInbox(store).acceptEvent({event_id:event,schema_version:'1',event_type:'along.user_message',goal_id:scope.goalId,occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text:'帮我比较路线'}},{userId:scope.userId,deviceId})
 const t=alongTools({service:new AlongService(store),scopeFor:()=>({userId:scope.userId,allowedGoalId:scope.goalId,triggerEventId:event})},scope.ticketId).find(t=>t.name==='along_chat_reply')!
 const route=save('route','开放:6:00-19:00'),access=save('access','步道正常开放'),weather=save('weather','周末晴天')
 const rec=plan(route.id,access.id,weather.id)
 rec.options[0]!.facts=[{label:'开放时间',value:'6:00-19:00，18:30关闭设施',evidence:[{sourceId:route.id,quote:'开放:6:00-19:00'}]}]
 const args={text:'已整理路线。',recommendation:rec},signal=new AbortController().signal
 await expect(t.execute(t.schema.parse(args),signal)).rejects.toThrow(/options\[0\].*facts\[0\].*开放时间.*unsupported numbers: 18, 30/)
 expect(store.syncPage(scope.userId,0,200).items.some(i=>(i.payload as any).recommendation)).toBe(false)
 rec.options[0]!.facts=[];rec.options[0]!.unknowns.push('设施关闭时刻尚未核实')
 expect(await t.execute(t.schema.parse(args),signal)).toMatchObject({status:'replied',reused:false})
 expect(store.syncPage(scope.userId,0,200).items.filter(i=>(i.payload as any).recommendation)).toHaveLength(1)
})
it.each(['research','outing','recommended_outing'] as const)('uses the current revision for a finished %s result without reviving a completed physical activity',async(kind)=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2027-01-08T11:00:00Z'))
 const h=await startRuntime(s=>s.saveSettings({...s.settings(),sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}}}))
 try{
  h.runtime.sources.register(alongKind);const settings=h.runtime.store.settings(),userId='u_finished',deviceId='d_finished'
  h.runtime.store.saveSettings({...settings,sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}},policy:{...settings.policy,sources:{along:{allowed:[{id:userId}],admission:{}}}}})
  const store=h.runtime.along!.service.alongStore;store.assertUser(userId,deviceId)
  const goal=store.insertGoal({userId,domain:'custom'});store.appendGoalRevision({goalId:goal.id,userId,title:'合成活动',status:'active'});store.ensureInputVersion(userId,goal.id)
  const task=store.insertTask({userId,goalId:goal.id,content:kind==='research'?'根据天气安排周末徒步':kind==='outing'?'完成周末徒步':'完成推荐路线的徒步',scheduledAt:'2027-01-08T10:59:00Z'})
  store.appendTaskRevision({userId,taskId:task.id})
  h.runtime.along!.healthFollowup.tick();await h.runtime.idle()
  const ticket=h.runtime.store.tickets.list()[0]!,worker='worker-'+ticket.id
  await vi.waitFor(()=>expect(h.tools.has(worker)).toBe(true));await h.runTool(worker,'along_health_read',{})
  const read=await h.runTool(worker,'along_goal_read',{}) as any
  expect(await h.runTool(worker,'along_changes_commit',{idempotency_key:'complete',base_revision:read.goal.current_revision,input_version:read.goal.input_version,reason:'合成单次任务结果',ops:[{op:'task.update',task_id:task.id,base_revision:1,fields:{status:'done'}}]})).toMatchObject({status:'applied'})
  const scope={userId,goalId:goal.id,ticketId:ticket.id}
  const source=(purpose:ResearchPurpose,content:string)=>store.research.save(scope,{title:'合成官方资料',url:'https://www.gz.gov.cn/route',purpose,content:purpose==='weather'?content+'。当前无气象灾害预警信号':content,fetched:true})
  const route=source('route','全程6公里'),access=source('access','步道正常开放'),weather=source('weather','周末晴天')
  await h.runTool(worker,'along_health_followup',{outcome:'update',types:[],reason:'本次资料已整理',text:'已整理有出处的候选信息。',recommendation:plan(route.id,access.id,weather.id)})
  const item=store.syncPage(userId,0,200).items.find(i=>(i.payload as any).recommendation)!
  expect(item.taskId).toBe(task.id)
  if(kind==='research')expect(item.payload).toMatchObject({notification:{kind:'task_result',revision:2}})
  else expect((item.payload as any).notification).toBeUndefined()
 }finally{await h.stop()}
},30_000)
it('renews the same weekly research task across repeated ticks and restart, emitting one recommendation for each occurrence',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2027-01-08T10:59:00Z'))
 const dir=mkdtempSync(join(tmpdir(),'along-weekly-research-'));dirs.push(dir)
 const userId='u_weekly_research',deviceId='d_weekly_research',seed=new Store(join(dir,'orchestrator.sqlite'))
 seed.saveSettings({...seed.settings(),eval:{...seed.settings().eval,mode:'auto'},sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}},policy:{...seed.settings().policy,sources:{along:{allowed:[{id:userId}],admission:{}}}}});seed.close()
 let h=await startRuntime(undefined,{dir})
 try{
  let store=h.runtime.along!.service.alongStore;store.assertUser(userId,deviceId)
  const goal=store.insertGoal({userId,domain:'custom'});store.appendGoalRevision({goalId:goal.id,userId,title:'持续周末运动',status:'active'});store.ensureInputVersion(userId,goal.id)
  const event='weekly_research_mandate',text='每周五19:00根据天气安排周末徒步'
  expect(h.runtime.along!.service.acceptEvent({event_id:event,schema_version:'1',event_type:'along.user_message',goal_id:goal.id,occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text}},{userId,deviceId})).toMatchObject({status:'accepted'})
  const setup=alongTools({service:h.runtime.along!.service,scopeFor:()=>({userId,allowedGoalId:goal.id,triggerEventId:event})},'setup_weekly').find(t=>t.name==='along_changes_commit')!
  const create={idempotency_key:'weekly_setup',base_revision:1,input_version:store.inputVersion(goal.id),reason:'按真实合成委托安排周期',ops:[{op:'task.create',content:'周五根据天气安排周末徒步',scheduled_at:'2027-01-08T11:00:00Z',repeat:'weekly',reminder_plan:{state:'scheduled',source:'agent',explanation:'每周五为周末核查资料',evidence:text,action:'安排周末徒步'}}]}
  const created=await setup.execute(setup.schema.parse(create),new AbortController().signal);expect(created).toEqual({status:'applied',changeset_id:expect.any(String),goal_revision:expect.any(Number),reused:false})
  const task=store.goalDetail(userId,goal.id).tasks[0]!
  const count=()=>store.syncPage(userId,0,200).items.filter(i=>(i.payload as any).recommendation)
  const review=async(when:string,next:string,index:number)=>{
   vi.setSystemTime(new Date(when));h.runtime.along!.healthFollowup.tick();await h.runtime.pump();await h.runtime.idle()
   await vi.waitFor(()=>expect(h.runtime.store.tickets.list().some(t=>t.mandate.basis.via==='task_due'&&!t.ended)).toBe(true),{timeout:5000})
   const ticket=h.runtime.store.tickets.list().find(t=>t.mandate.basis.via==='task_due'&&!t.ended)!,worker='worker-'+ticket.id
   await vi.waitFor(()=>expect(h.tools.has(worker)).toBe(true))
   expect(await h.runTool(worker,'along_health_read',{})).toMatchObject({review:{taskId:task.id,repeat:'weekly',weekday:5,next_occurrence_if_kept:next}})
   const read=await h.runTool(worker,'along_goal_read',{}) as any
   expect(await h.runTool(worker,'along_changes_commit',{idempotency_key:'do_not_finish_'+index,base_revision:read.goal.current_revision,input_version:read.goal.input_version,reason:'不应永久结束周期研究',ops:[{op:'task.update',task_id:task.id,base_revision:store.getTask(userId,task.id)!.currentRevision,fields:{status:'done'}}]})).toMatchObject({status:'invalid',reason:'recurring_research_remains_open'})
   for(const [n,fields] of [{reminder_plan:{state:'off',reason:'untimed'}},{scheduled_at:null},{repeat:'once'},{content:'只做一次的其他事项'}].entries()){
    expect(await h.runTool(worker,'along_changes_commit',{idempotency_key:'keep_cadence_'+index+'_'+n,base_revision:read.goal.current_revision,input_version:read.goal.input_version,reason:'不应删除既有周期',ops:[{op:'task.update',task_id:task.id,base_revision:store.getTask(userId,task.id)!.currentRevision,fields}]})).toMatchObject({status:'invalid',reason:'recurring_research_remains_open'})
   }
   const scope={userId,goalId:goal.id,ticketId:ticket.id},source=(purpose:ResearchPurpose,content:string)=>store.research.save(scope,{title:'合成官方资料',url:'https://www.gz.gov.cn/route',purpose,content:purpose==='weather'?content+'。当前无气象灾害预警信号':content,fetched:true})
   const route=source('route','全程6公里'),access=source('access','步道正常开放'),weather=source('weather','周末晴天')
   const input={outcome:'keep',types:[],reason:'本周期资料核查完成，保留持续任务',text:'本周末资料已整理。',recommendation:plan(route.id,access.id,weather.id)}
   expect(await h.runTool(worker,'along_health_followup',input)).toMatchObject({reused:false})
   expect(await h.runTool(worker,'along_health_followup',input)).toMatchObject({reused:true})
   const current=store.getTask(userId,task.id)!
   expect(current).toMatchObject({id:task.id,status:'open',scheduledAt:next})
   expect(count()).toHaveLength(index)
   expect(count().at(-1)!.payload).toMatchObject({notification:{kind:'recommendation_ready',revision:current.currentRevision}})
   await h.runTool(worker,'orchestrator_report',{state:'ready',summary:'完成本周期研究并续排'})
   for(let n=0;n<3;n++)h.runtime.along!.healthFollowup.tick()
   await h.runtime.idle();expect(count()).toHaveLength(index)
  }
  await review('2027-01-08T11:00:00Z','2027-01-15T11:00:00.000Z',1)
  await h.stop();h=await startRuntime(undefined,{dir});store=h.runtime.along!.service.alongStore
  for(let n=0;n<3;n++)h.runtime.along!.healthFollowup.tick()
  await h.runtime.idle();expect(count()).toHaveLength(1)
  expect(h.runtime.store.tickets.list().filter(t=>t.mandate.basis.via==='task_due')).toHaveLength(1)
  await review('2027-01-15T11:00:00Z','2027-01-22T11:00:00.000Z',2)
 }finally{await h.stop()}
},30_000)
it('binds hiking safety to the original human intent even when the model labels its reply general',async()=>{
 const {store,scope,save,deviceId}=fixture(),event='cannot_downgrade_hiking'
 createInbox(store).acceptEvent({event_id:event,schema_version:'1',event_type:'along.user_message',goal_id:scope.goalId,occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text:'请推荐周末徒步路线'}},{userId:scope.userId,deviceId})
 const t=alongTools({service:new AlongService(store),scopeFor:()=>({userId:scope.userId,allowedGoalId:scope.goalId,triggerEventId:event})},scope.ticketId).find(t=>t.name==='along_chat_reply')!
 const route=save('route','全程6公里'),access=store.research.save(scope,{title:'第三方路线',url:'https://trip.com/route',purpose:'access',content:'步道正常开放',fetched:true}),weather=save('weather','周末晴天')
 const rec=plan(route.id,access.id,weather.id);rec.kind='general';rec.options[0]!.checks[1]!.alertEvidence=[]
 await t.execute(t.schema.parse({text:'候选仍需核实。',recommendation:rec}),new AbortController().signal)
 const result=(store.syncPage(scope.userId,0,200).items.find(i=>(i.payload as any).recommendation)!.payload as any).recommendation
 expect(result).toMatchObject({kind:'hiking',status:'partial',options:[{status:'conditional',checks:[{status:'unknown'},{status:'unknown'}]}]})
})
