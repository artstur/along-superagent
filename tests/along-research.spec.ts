import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { AlongStore } from '../src/along/store.ts'
import { AlongService } from '../src/along/service.ts'
import { createInbox } from '../src/along/inbox.ts'
import { alongTools } from '../src/along/tools.ts'
import { recommendation, RECOMMENDATION_INPUT, isResearchTaskContent, recommendationNotice, type RecommendationInput } from '../src/along/recommendation.ts'
import { publicHttpsUrl, publicAddress, assertPublicUrl, pagePublication, researchTools, researchWeb, type ResearchWeb } from '../src/along/web-research.ts'
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
 const save=(purpose:ResearchPurpose,content:string,at=Date.now(),fetched=true)=>store.research.save(scope,{publishedAt:new Date(at).toISOString(),title:'合成官方来源',url:'https://www.gz.gov.cn/route',purpose,content:purpose==='weather'?content+'。当前无气象灾害预警信号':content,fetched},at)
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
 expect(result.sources).toHaveLength(3);expect(result.sources[0]).toEqual({id:route.id,title:route.title,url:route.url,retrievedAt:route.retrievedAt,expiresAt:route.expiresAt,publishedAt:route.publishedAt})
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
  expect(await h.runTool('worker-'+ticketId,'along_conversation_read',{})).toMatchObject({task_feedback:expect.arrayContaining([expect.objectContaining({event_id:oldFeedback,source:'task_event',text:'之前走过这条路线，想换一个。'})])})
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
  if(kind==='research'){
   vi.spyOn(h.ctx,'get').mockImplementation((name:string)=>name==='web'?{search:async()=>({sources:[],truncated:false}),fetch:async()=>({url:'https://example.com',statusCode:200,body:{kind:'text',content:''},truncated:false})}:undefined)
   store.triggers.put(store.assertTaskOwner(userId,task.id),{kind:'time',actor:'agent',capability:'research'},1)
  }
  h.runtime.along!.healthFollowup.tick();await h.runtime.idle()
  const ticket=h.runtime.store.tickets.list()[0]!,worker='worker-'+ticket.id
  await vi.waitFor(()=>expect(h.tools.has(worker)).toBe(true));await h.runTool(worker,'along_health_read',{})
  const read=await h.runTool(worker,'along_goal_read',{}) as any
  expect(await h.runTool(worker,'along_changes_commit',{idempotency_key:'complete',base_revision:read.goal.current_revision,input_version:read.goal.input_version,reason:'合成单次任务结果',ops:[{op:'task.update',task_id:task.id,base_revision:1,fields:{status:'done'}}]})).toMatchObject({status:'invalid'})
  if(kind!=='research')expect(h.runtime.along!.service.acceptEvent({event_id:'actual_user_completion_'+kind,schema_version:'1',event_type:'along.message',kind:'task.completed',task_id:task.id,occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.message',kind:'task.completed',task_id:task.id}},{userId,deviceId})).toMatchObject({status:'accepted'})
  const scope={userId,goalId:goal.id,ticketId:ticket.id}
  const source=(purpose:ResearchPurpose,content:string)=>store.research.save(scope,{title:'合成官方资料',url:'https://www.gz.gov.cn/route',purpose,content:purpose==='weather'?content+'。当前无气象灾害预警信号':content,fetched:true})
  const route=source('route','全程6公里'),access=source('access','步道正常开放'),weather=source('weather','周末晴天')
  const rec=plan(route.id,access.id,weather.id);rec.options[0]!.checks[1]!.alertStatus='unknown';rec.options[0]!.checks[1]!.alertEvidence=[]
  rec.summary='当前有生效中的强降雨预警';rec.nextStep='改去另一处户外公园'
  const finished=await h.runTool(worker,'along_health_followup',{outcome:'keep',types:[],reason:'本次资料已整理',text:'当前有生效中的强降雨预警，改去另一处户外公园。',recommendation:rec})
  const item=store.syncPage(userId,0,200).items.find(i=>(i.payload as any).recommendation)!
  if(kind!=='research'){expect(finished).toMatchObject({status:'conflicted'});expect(item).toBeUndefined();expect(store.getTask(userId,task.id)?.status).toBe('done');return}
  expect(item.taskId).toBe(task.id)
  expect((item.payload as any).text).not.toContain('生效中的强降雨预警');expect((item.payload as any).text).not.toContain('改去另一处户外公园')
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
  vi.spyOn(h.ctx,'get').mockImplementation((name:string)=>name==='web'?{search:async()=>({sources:[],truncated:false}),fetch:async()=>({url:'https://example.com',statusCode:200,body:{kind:'text',content:''},truncated:false})}:undefined)
  const goal=store.insertGoal({userId,domain:'custom'});store.appendGoalRevision({goalId:goal.id,userId,title:'持续周末运动',status:'active'});store.ensureInputVersion(userId,goal.id)
  const event='weekly_research_mandate',text='每周五19:00根据天气安排周末徒步'
  expect(h.runtime.along!.service.acceptEvent({event_id:event,schema_version:'1',event_type:'along.user_message',goal_id:goal.id,occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text}},{userId,deviceId})).toMatchObject({status:'accepted'})
  const setup=alongTools({service:h.runtime.along!.service,scopeFor:()=>({userId,allowedGoalId:goal.id,triggerEventId:event})},'setup_weekly').find(t=>t.name==='along_changes_commit')!
  const create={idempotency_key:'weekly_setup',base_revision:1,input_version:store.inputVersion(goal.id),reason:'按真实合成委托安排周期',ops:[{op:'task.create',trigger:{kind:'time',actor:'agent',capability:'research'},content:'周五根据天气安排周末徒步',scheduled_at:'2027-01-08T11:00:00Z',repeat:'weekly',reminder_plan:{state:'scheduled',source:'agent',explanation:'每周五为周末核查资料',evidence:text,action:'安排周末徒步'}}]}
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
  vi.spyOn(h.ctx,'get').mockImplementation((name:string)=>name==='web'?{search:async()=>({sources:[],truncated:false}),fetch:async()=>({url:'https://example.com',statusCode:200,body:{kind:'text',content:''},truncated:false})}:undefined)
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
it('projects an old secondary warning consistently across title, reason, summary, next step and safety facts while retaining route facts',()=>{
 const {store,scope,save}=fixture(),route=save('route','全程6公里'),access=save('access','步道正常开放'),weather=save('weather','周末晴天')
 const old=store.research.save(scope,{url:'https://weibo.com/old-warning',title:'旧警报',content:'当前有生效中的暴雨预警，19:00闭园，30台车辆预约',purpose:'alerts',fetched:true,publishedAt:'2025-01-01T00:00:00Z'})
 const excerpt=store.research.save(scope,{url:'https://trip.com/park',title:'第三方片段',content:'06:00-22:00开放',purpose:'access',fetched:false})
 const rec=plan(route.id,access.id,weather.id)
 rec.summary='当前有生效中的强降雨预警。';rec.nextStep='雷雨预警时改去越秀公园等户外短程。'
 const option=rec.options[0]!;option.title='合成路线（推荐）';option.reason='虽然有暴雨仍可放心去市内公园。'
 option.conditions=['暴雨预警时去另一个户外公园'];option.unknowns=['微博警报日期不明']
 option.checks[1]={kind:'weather',status:'risk',summary:'当前暴雨预警生效',evidence:[{sourceId:old.id,quote:'当前有生效中的暴雨预警'}],alertStatus:'risk',alertEvidence:[{sourceId:old.id,quote:'当前有生效中的暴雨预警'}]}
 option.facts.push({label:'公园闭园时间',value:'19:00',evidence:[{sourceId:old.id,quote:'19:00闭园'}]},
 {label:'车辆预约名额',value:'30台',evidence:[{sourceId:old.id,quote:'30台车辆预约'}]},
 {label:'开放时间（第三方）',value:'06:00-22:00',evidence:[{sourceId:excerpt.id,quote:'06:00-22:00开放'}]})
 const result=recommendation(store.research,scope,rec)
 expect(result).toMatchObject({status:'partial',options:[{status:'conditional',checks:[{status:'ok'},{status:'unknown'}]}]})
 expect(result.summary).not.toContain('当前有生效中的强降雨预警');expect(result.nextStep).toContain('室内');expect(result.nextStep).not.toContain('越秀公园')
 expect(result.options[0]!.title).not.toContain('推荐');expect(result.options[0]!.reason).not.toContain('放心')
 expect(result.options[0]!.facts.map(f=>f.label)).toEqual(['路线距离'])
 expect(result.options[0]!.unknowns.join(' ')).toContain('闭园时间');expect(result.sources.map(s=>s.id)).toContain(old.id)
 const current=store.research.save(scope,{url:'https://www.sz.gov.cn/current-warning',title:'当前预警',content:'当前暴雨红色预警正在生效',purpose:'alerts',fetched:true,publishedAt:new Date().toISOString()})
 option.checks[1]={kind:'weather',status:'risk',summary:'预警生效',evidence:[{sourceId:weather.id,quote:'周末晴天'}],alertStatus:'risk',alertEvidence:[{sourceId:current.id,quote:'当前暴雨红色预警正在生效'}]}
 expect(recommendation(store.research,scope,rec).options[0]!.status).toBe('excluded')
})
it.each(['research','outing'] as const)('routes a fresh chat recommendation on a done %s task using current host state and idempotent calibrated text',async kind=>{
 const {store,scope,save,deviceId}=fixture(),event='done_task_feedback'
 const task=store.insertTask({userId:scope.userId,goalId:scope.goalId,content:kind==='research'?'研究周末徒步路线':'完成推荐路线的徒步'})
 store.appendTaskRevision({userId:scope.userId,taskId:task.id,status:'done'})
 createInbox(store).acceptEvent({event_id:event,schema_version:'1',event_type:'along.user_message',goal_id:scope.goalId,task_id:task.id,occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text:'关于这个方案，再帮我比较一下'}},{userId:scope.userId,deviceId})
 store.recordWorkLink({ticketId:scope.ticketId,taskId:task.id,goalId:scope.goalId,eventId:event,workId:'work_feedback',threadKey:'along:feedback',kind:'ticket'})
 const t=alongTools({service:new AlongService(store),scopeFor:()=>({userId:scope.userId,allowedGoalId:scope.goalId,triggerEventId:event})},scope.ticketId).find(t=>t.name==='along_chat_reply')!
 const route=save('route','全程6公里'),access=save('access','步道正常开放'),weather=save('weather','周末晴天'),rec=plan(route.id,access.id,weather.id)
 rec.options[0]!.checks[1]!.alertStatus='unknown';rec.options[0]!.checks[1]!.alertEvidence=[]
 const args={text:'当前强降雨预警生效，去越秀公园更安全。',notify:'recommendation_ready',recommendation:rec},signal=new AbortController().signal
 expect(await t.execute(t.schema.parse(args),signal)).toMatchObject({reused:false})
 expect(await t.execute(t.schema.parse(args),signal)).toMatchObject({reused:true})
 const item=store.syncPage(scope.userId,0,200).items.find(i=>(i.payload as any).recommendation)!,payload=item.payload as any
 expect(item.taskId).toBe(task.id);expect(payload.text).not.toContain('强降雨预警生效');expect(payload.text).not.toContain('越秀公园')
 expect(store.getMessage(scope.userId,item.messageId!)!.text).toBe(payload.text)
 if(kind==='research')expect(payload.notification).toMatchObject({kind:'task_result',revision:1})
 else expect(payload.notification).toBeUndefined()
})
it('does not turn explicit no-alert, negated or hypothetical weather evidence into an active risk',()=>{
 const {store,scope,save}=fixture(),route=save('route','全程6公里'),access=save('access','步道正常开放'),weather=save('weather','周末晴天')
 for(const quote of ['当前无气象灾害预警信号','当前暴雨预警已解除','如果当前发布暴雨预警，请勿进山']){
  const source=store.research.save(scope,{title:'合成官方气象',url:'https://www.sz.gov.cn/alerts',content:quote,purpose:'alerts',fetched:true,publishedAt:new Date().toISOString()})
  const input=plan(route.id,access.id,weather.id)
  input.options[0]!.checks[1]={kind:'weather',status:'risk',summary:'当前预警生效',evidence:[{sourceId:weather.id,quote:'周末晴天'}],alertStatus:'risk',alertEvidence:[{sourceId:source.id,quote}]}
  const result=recommendation(store.research,scope,input)
  expect(result.options[0]!.checks[1]!.status).toBe('unknown');expect(result.options[0]!.status).toBe('conditional')
  expect(result.summary).not.toContain('已核实限制或天气风险')
 }
 for(const quote of ['没有暴雨','无明显暴雨','如果有雷暴请避开山路']){
  const source=store.research.save(scope,{title:'合成官方预报',url:'https://www.nmc.cn/forecast',content:quote,purpose:'weather',fetched:true,publishedAt:new Date().toISOString()})
  const input=plan(route.id,access.id,weather.id)
  input.options[0]!.checks[1]={kind:'weather',status:'risk',summary:'暴雨风险',evidence:[{sourceId:source.id,quote}]}
  expect(recommendation(store.research,scope,input).options[0]!.checks[1]!.status).toBe('unknown')
 }
})
it('cannot hide unverified access facts behind a route purpose and an innocuous model label',()=>{
 const {store,scope,save}=fixture(),route=save('route','全程6公里'),access=save('access','步道正常开放'),weather=save('weather','周末晴天')
 const secondary=store.research.save(scope,{title:'路线游记',url:'https://trip.com/trail',content:'无需预约。建议任意时间进入。6公里需登记',purpose:'route',fetched:true})
 const input=plan(route.id,access.id,weather.id),option=input.options[0]!
 option.checks.forEach(check=>{check.status='unknown'})
 option.facts.push({label:'小贴士',value:'无需预约',evidence:[{sourceId:secondary.id,quote:'无需预约'}]},
 {label:'路线长度',value:'6公里需登记',evidence:[{sourceId:secondary.id,quote:'6公里需登记'}]},
 {label:'提示',value:'建议任意时间进入',evidence:[{sourceId:secondary.id,quote:'建议任意时间进入'}]})
 const result=recommendation(store.research,scope,input)
 expect(result.options[0]!.facts).toEqual([{label:'路线距离',value:'6公里',sourceIds:[route.id]}])
 expect(result.options[0]!.unknowns.join(' ')).toContain('小贴士')
})
it('renews only the host-bound event budget on a reused ticket, preserving retry limits and fresh sources across restart',async()=>{
 const {store,scope,save,deviceId}=fixture(),path=join(dirs.at(-1)!,'along.sqlite'),inbox=createInbox(store)
 const event=(eventId:string)=>inbox.acceptEvent({event_id:eventId,schema_version:'1',event_type:'along.user_message',goal_id:scope.goalId,occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text:'在同一任务继续核查路线资料'}},{userId:scope.userId,deviceId})
 const web:ResearchWeb={assertProvider:()=>{},search:vi.fn(async()=>({sources:[],truncated:false})),fetch:vi.fn()}
 const signal=new AbortController().signal;let trigger='first_research_event'
 event(trigger)
 const originalSource=save('route','全程6公里')
 const tool=(s:AlongStore)=>alongTools({service:new AlongService(s),web:()=>web,scopeFor:()=>({userId:scope.userId,allowedGoalId:scope.goalId,triggerEventId:trigger})},scope.ticketId).find(t=>t.name==='along_web_search')!
 const search=async(s:AlongStore)=>{const t=tool(s);return await t.execute(t.schema.parse({query:'公开路线资料',purpose:'route'}),signal)}
 for(let n=0;n<16;n++)expect(await search(store)).toMatchObject({status:'empty'})
 expect(await search(store)).toMatchObject({status:'failed',error:{code:'RESEARCH_LIMIT'}})
 expect(web.search).toHaveBeenCalledTimes(16)
 store.close();stores.splice(stores.indexOf(store),1)
 const reopened=new AlongStore(path);stores.push(reopened)
 expect(await search(reopened)).toMatchObject({status:'failed',error:{code:'RESEARCH_LIMIT'}})
 trigger='second_research_event'
 expect(createInbox(reopened).acceptEvent({event_id:trigger,schema_version:'1',event_type:'along.user_message',goal_id:scope.goalId,occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text:'请重新联网，不改原目标和任务'}},{userId:scope.userId,deviceId})).toMatchObject({status:'accepted'})
 for(let n=0;n<16;n++)expect(await search(reopened)).toMatchObject({status:'empty'})
 expect(await search(reopened)).toMatchObject({status:'failed',error:{code:'RESEARCH_LIMIT'}})
 expect(web.search).toHaveBeenCalledTimes(32)
 expect(reopened.research.get(scope,originalSource.id)?.content).toBe('全程6公里')
 const t=tool(reopened)
 expect(()=>t.schema.parse({query:'公开路线资料',purpose:'route',budgetEventId:'invented'})).toThrow()
})
it('does not infer overall clear alerts from mixed active warnings or the absence of a single warning category',()=>{
 const {store,scope,save}=fixture(),route=save('route','全程6公里'),access=save('access','步道正常开放'),weather=save('weather','周末晴天')
 for(const quote of ['当前无雷暴预警，暴雨预警正在生效','当前无雷暴预警','当前无气象灾害预警信号，但预计有暴雨']){
  const source=store.research.save(scope,{title:'合成官方气象',url:'https://www.sz.gov.cn/alerts',content:quote,purpose:'alerts',fetched:true,publishedAt:new Date().toISOString()})
  const input=plan(route.id,access.id,weather.id)
  input.options[0]!.checks[1]!.alertEvidence=[{sourceId:source.id,quote}]
  expect(recommendation(store.research,scope,input)).toMatchObject({status:'partial',options:[{status:'conditional',checks:[{status:'ok'},{status:'unknown'}]}]})
 }
})
it('uses an explicit page publication date instead of search metadata, and leaves missing page dates unverified',async()=>{
 const {store,scope}=fixture(),signal=new AbortController().signal
 let body='# 生态行，绿道游\n\n发布时间：\n\n2019-05-21\n\n绿道总长约16.5公里。'
 const web:ResearchWeb={assertProvider:()=>{},search:async()=>({sources:[{url:'https://www.baiyunshan.com.cn/bys/jqxw/201905/route.shtml',title:'绿道介绍',summary:'绿道总长约16.5公里',publishedAt:'2026-08-12T16:00:00Z'}],truncated:false}),fetch:async()=>({url:'https://www.baiyunshan.com.cn/bys/jqxw/201905/route.shtml',statusCode:200,body:{kind:'text',content:body},truncated:false})}
 const tools=researchTools(store.research,()=>scope,()=>web,async value=>publicHttpsUrl(value))
 const call=async(name:string,args:unknown)=>{const t=tools.find(t=>t.name===name)!;return await t.execute(t.schema.parse(args),signal) as any}
 const search=await call('along_web_search',{query:'官方绿道长度',purpose:'route'})
 expect(search.sources[0].publicationBasis).toBe('search')
 const fetched=await call('along_web_fetch',{source_id:search.sources[0].id,purpose:'route'})
 expect(fetched.source).toMatchObject({publishedAt:'2019-05-21T00:00:00.000Z',publicationBasis:'page',publicationHint:'2026-08-12T16:00:00.000Z'})
 body='# 生态行，绿道游\n\n发布时间：\n\n浏览量：400\n\n绿道总长约16.5公里。'
 const missing=await call('along_web_fetch',{source_id:search.sources[0].id,purpose:'route'})
 expect(missing.source.publishedAt).toBeUndefined();expect(missing.source.publicationBasis).toBeUndefined()
 expect(missing.source.publicationHint).toBe('2026-08-12T16:00:00.000Z')
 expect(pagePublication('发布时间：2019-02-30')).toBeUndefined()
})

it.each(['once','on_change'] as const)('notifies a typed Agent %s output without research keywords using scoped evidence and actual persisted execution',async repeat=>{
 const dir=mkdtempSync(join(tmpdir(),'along-typed-research-dependency-'));dirs.push(dir)
 const seed=new Store(join(dir,'orchestrator.sqlite'));seed.saveSettings({...seed.settings(),eval:{...seed.settings().eval,mode:'auto'},sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}}});seed.close()
 let h=await startRuntime(undefined,{dir})
 try{
  const settings=h.runtime.store.settings(),userId='u_typed_result',deviceId='d_typed_result'
  h.runtime.store.saveSettings({...settings,sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}},policy:{...settings.policy,sources:{along:{allowed:[{id:userId}],admission:{}}}}})
  const quote='评估策略需要成交记录及费用明细',url='https://www.deepseek.com/public-methodology'
  const search=vi.fn(async()=>({sources:[{url,title:'合成公开方法资料',summary:quote}],truncated:false}))
  const fetch=vi.fn(async()=>({url,statusCode:200,body:{kind:'text',content:quote},truncated:false}))
  vi.spyOn(h.ctx,'get').mockImplementation((name:string)=>name==='web'?{search,fetch}:name==='settings'?{describe:()=>[{ns:'web',value:{searchProvider:'deepseek-search-api',fetchProvider:'deepseek-fetch-api'}},{ns:'web-deepseek-api',value:{sendOriginalQuestion:false}}]}:undefined)
  const store=h.runtime.along!.service.alongStore;store.assertUser(userId,deviceId)
  const goal=store.insertGoal({userId,domain:'custom'});store.appendGoalRevision({userId,goalId:goal.id,title:'建立可核对的评估资料',status:'active'});store.ensureInputVersion(userId,goal.id)
  const content='产出评估策略效果所需数据清单与最小评估框架'
  expect(isResearchTaskContent(content)).toBe(false)
  const task=store.insertTask({userId,goalId:goal.id,content});store.appendTaskRevision({userId,taskId:task.id})
  if(repeat==='on_change'){
   store.replaceGoalDataSources(userId,goal.id,[{provider:'okx',reason:'合法连接就绪时整理所需材料，不读取账户数值'}])
   store.sources.acceptEvent({userId,deviceId},{event_id:'typed_result_source',goal_id:goal.id,provider:'okx',generation:1,revision:1,state:'ready',capabilities:['trading_account_summary'],occurred_at:new Date().toISOString(),reference:'synthetic_ref'})
  }
  store.triggers.put(store.assertTaskOwner(userId,task.id),repeat==='once'?{kind:'immediate',actor:'agent',capability:'research'}:{kind:'event',actor:'agent',capability:'research',repeat:'on_change',conditions:[{kind:'source_ready',provider:'okx',capability:'trading_account_summary'}]},1)
  const dependent=store.insertTask({userId,goalId:goal.id,content:'前置资料产出后核算3次25分钟总时长'});store.appendTaskRevision({userId,taskId:dependent.id})
  store.triggers.put(store.assertTaskOwner(userId,dependent.id),{kind:'event',actor:'agent',capability:'calculation',conditions:[{kind:'task_completed',task_id:task.id}]},1)
  await h.runtime.pump();await h.runtime.idle();const ticket=h.runtime.store.tickets.list().find(t=>t.mandate.basis.via==='task_due')!,worker='worker-'+ticket.id
  await vi.waitFor(()=>expect(h.tools.has(worker)).toBe(true));const bound=await h.runTool(worker,'along_task_context',{}) as any
  // Real scoped research tool bodies with controlled provider/DNS seams; no external-network claim.
  const evidenceTools=researchTools(store.research,()=>({userId,goalId:goal.id,ticketId:ticket.id}),()=>researchWeb(h.ctx),async value=>publicHttpsUrl(value))
  const retrieve=async(name:string,args:unknown)=>{const tool=evidenceTools.find(t=>t.name===name)!;return await tool.execute(tool.schema.parse(args),new AbortController().signal) as any}
  const found=await retrieve('along_web_search',{query:'策略评估 所需资料 方法',purpose:'general'})
  const page=await retrieve('along_web_fetch',{source_id:found.sources[0].id,purpose:'general'})
  expect(page).toMatchObject({status:'ok',source:{fetched:true}});expect(search).toHaveBeenCalledTimes(1);expect(fetch).toHaveBeenCalledTimes(1)
  const input={kind:'general',title:'资料清单与最小框架',summary:'已形成材料清单；现有摘要不能证明策略收益表现',constraints:[],options:[{id:'framework',title:'先补齐材料',reason:'提供可核对的评估起点',conditions:[],unknowns:['仍需本人提供逐笔成交记录'],facts:[{label:'材料要求',value:quote,evidence:[{sourceId:page.source.id,quote}]}],checks:[]}],nextStep:'取得成交记录后再评估，当前没有策略表现结论'}
  const finish={outcome:'keep',types:[],reason:'真实资料支持清单，实际分析仍待数据',text:'已保存资料清单与最小框架',recommendation:input}
  expect(await h.runTool(worker,'along_task_finish',finish)).toMatchObject({status:'recorded',reused:false})
  expect(await h.runTool(worker,'along_task_finish',finish)).toMatchObject({reused:true})
  const current=store.getTask(userId,task.id)!,items=store.syncPage(userId,0,200).items
  expect(current.status).toBe(repeat==='once'?'done':'open');expect(store.taskExecution(userId,task.id).count).toBe(1)
  const results=items.filter(i=>(i.payload as any).recommendation)
  expect(results).toHaveLength(1)
  expect(results[0]).toMatchObject({taskId:task.id,goalId:goal.id,payload:{task_execution_revision:bound.task.revision,recommendation:{status:'partial',sources:[{id:page.source.id}]},notification:{kind:repeat==='once'?'task_result':'recommendation_ready',revision:current.currentRevision}}})
  const validated=(results[0]!.payload as any).recommendation
  expect(recommendationNotice({...validated,status:'unavailable'},current,content,true)).toBeUndefined()
  expect(recommendationNotice({...validated,sources:[]},current,content,true)).toBeUndefined()
  expect(recommendationNotice(validated,{status:'done',content:'完成推荐路线的徒步'},'完成推荐路线的徒步')).toBeUndefined()
  await h.runTool(worker,'orchestrator_report',{state:'ready',summary:'框架产出已保存，不等于策略表现评估完成'})
  const finishDependent=async()=>{
   await vi.waitFor(async()=>{await h.runtime.pump();await h.runtime.idle();expect(h.runtime.store.tickets.list().some(t=>!t.ended&&h.runtime.along!.healthFollowup.forTicket(t.id)?.due?.taskId===dependent.id)).toBe(true)})
   const next=h.runtime.store.tickets.list().find(t=>!t.ended&&h.runtime.along!.healthFollowup.forTicket(t.id)?.due?.taskId===dependent.id)!,session='worker-'+next.id
   await vi.waitFor(()=>expect(h.tools.has(session)).toBe(true));await h.runTool(session,'along_task_context',{})
   const receipt=await h.runTool(session,'along_calculate',{calculation:{quantities:[{name:'count',value:'3',unit:'1'},{name:'duration',value:'25',unit:'minute'}],steps:[{id:'total',op:'multiply',inputs:['count','duration']},{id:'minutes',op:'convert',inputs:['total'],unit:'minute'}],result_step:'minutes'}})
   expect(receipt).toMatchObject({result:{value:'75',unit:'minute'}})
   const args={outcome:'keep',types:[],reason:'前置真实产出完成后实际核算',calculation_receipt:receipt.receipt_id}
   expect(await h.runTool(session,'along_task_finish',args)).toMatchObject({reused:false});expect(await h.runTool(session,'along_task_finish',args)).toMatchObject({reused:true})
   await h.runTool(session,'orchestrator_report',{state:'ready',summary:'后续75分钟核算已完成'})
  }
  await finishDependent();expect(store.taskExecution(userId,dependent.id).count).toBe(1)
  // Merely firing a reminder for a human action is not task_completed evidence.
  const human=store.insertTask({userId,goalId:goal.id,content:'本人归档已整理的材料'});store.appendTaskRevision({userId,taskId:human.id})
  store.triggers.put(store.assertTaskOwner(userId,human.id),{kind:'immediate',actor:'user',capability:'reminder'},1)
  const blocked=store.insertTask({userId,goalId:goal.id,content:'本人归档完成后才可继续的计算'});store.appendTaskRevision({userId,taskId:blocked.id})
  store.triggers.put(store.assertTaskOwner(userId,blocked.id),{kind:'event',actor:'agent',capability:'calculation',conditions:[{kind:'task_completed',task_id:human.id}]},1)
  await h.runtime.pump();await h.runtime.idle()
  const humanTicket=h.runtime.store.tickets.list().find(t=>!t.ended&&h.runtime.along!.healthFollowup.forTicket(t.id)?.due?.taskId===human.id)!,humanWorker='worker-'+humanTicket.id
  await vi.waitFor(()=>expect(h.tools.has(humanWorker)).toBe(true));await h.runTool(humanWorker,'along_task_context',{})
  await h.runTool(humanWorker,'along_task_finish',{outcome:'keep',types:[],reason:'只发出提醒，不代表本人已行动',text:'请本人归档材料'})
  await h.runTool(humanWorker,'orchestrator_report',{state:'ready',summary:'人类行动提醒已处理，仍待本人行动'})
  expect(store.triggers.dependencyFact(userId,human.id)).toBeUndefined();expect(store.getTask(userId,human.id)?.status).toBe('open')
  await h.runtime.pump();expect(h.runtime.store.tickets.list().some(t=>h.runtime.along!.healthFollowup.forTicket(t.id)?.due?.taskId===blocked.id)).toBe(false)
  const previousGeneration=store.triggers.get(userId,task.id)!.generation
  store.appendTaskRevision({userId,taskId:task.id,content:'暂停这项产出，等待新材料',status:'open',originEventId:'synthetic_authorized_change'})
  store.triggers.put(store.assertTaskOwner(userId,task.id),{kind:'waiting',actor:'agent',capability:'research',resume:'user_input',reason:'等待用户提供新的材料范围'},store.inputVersion(goal.id))
  expect(store.triggers.get(userId,task.id)!.generation).toBeGreaterThan(previousGeneration)
  expect(store.taskExecution(userId,task.id)).toMatchObject({count:1,records:[{kind:'research',outcome:'researched',recommendationEventId:(results[0]!.payload as any).notification.event_id}]})
  const originalTickets=h.runtime.store.tickets.list().filter(t=>t.mandate.basis.via==='task_due').map(t=>t.id).sort()
  await h.stop();h=await startRuntime(undefined,{dir});await h.runtime.pump();await h.runtime.idle()
  const restored=h.runtime.along!.service.alongStore
  expect(restored.taskExecution(userId,task.id).count).toBe(1);expect(restored.taskExecution(userId,dependent.id).count).toBe(1)
  expect(restored.taskExecution(userId,blocked.id).count).toBe(0)
  expect(h.runtime.store.tickets.list().filter(t=>t.mandate.basis.via==='task_due').map(t=>t.id).sort()).toEqual(originalTickets)


 }finally{await h.stop()}
},30000)
