import { afterEach,expect,it,vi } from 'vitest'
import { startRuntime } from './fixtures/host.ts'
import { assertAlongReport,explicitWeeklyTaskRequest } from '../src/along/completion.ts'
import { alongKind } from '../src/sources/along.ts'
const user='u_cccc1111',device='d_cccc1111',zone='Asia/Shanghai',at='2027-01-08T11:00:00.000Z'
const action='查天气后决定甲乙徒步地点',quote='补上每周五北京时间19:00'+action
const rec=(sourceId:string)=>({kind:'hiking',title:'条件式候选',summary:'待核实出行条件',constraints:[],options:[{id:'a',title:'合成路线',reason:'供比较',conditions:[],unknowns:['开放与天气待核实'],facts:[{label:'路线长度',value:'3公里',evidence:[{sourceId,quote:'路线全长3公里'}]}],checks:[]}],nextStep:'出发前核查官方条件'})
afterEach(()=>vi.useRealTimers())
async function fixture(text='刚才仍是单次。请继续原任务：'+quote){
 vi.useFakeTimers({toFake:['Date']}).setSystemTime(new Date('2027-01-03T05:00:00Z'))
 const h=await startRuntime(s=>s.saveSettings({...s.settings(),sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}}}))
 h.runtime.sources.register(alongKind);const settings=h.runtime.store.settings()
 h.runtime.store.saveSettings({...settings,sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}},policy:{...settings.policy,sources:{along:{allowed:[{id:user}],admission:{}}}}})
 const store=h.runtime.along!.service.alongStore;store.assertUser(user,device)
 const goal=store.insertGoal({userId:user,domain:'custom'});store.appendGoalRevision({goalId:goal.id,userId:user,title:'合成周末活动',status:'active'});store.ensureInputVersion(user,goal.id)
 const task=store.insertTask({goalId:goal.id,userId:user,content:action,scheduledAt:at});store.appendTaskRevision({taskId:task.id,userId:user,content:action,scheduledAt:at})
 store.health.savePlan(task.id,{state:'scheduled',source:'agent',explanation:'保留既有时刻',repeat:'once',timezone:zone,wallTime:at})
 const other=store.insertTask({goalId:goal.id,userId:user,content:'归还图书'});store.appendTaskRevision({taskId:other.id,userId:user,content:other.content});const otherBefore=store.getTask(user,other.id)
 const event='weekly_followup'
 expect(h.runtime.along!.service.acceptEvent({event_id:event,schema_version:'1',event_type:'along.user_message',goal_id:goal.id,task_id:task.id,occurred_at:new Date().toISOString(),timezone:zone,payload:{event_type:'along.user_message',text}},{userId:user,deviceId:device}).status).toBe('accepted')
 const trigger='along:'+user+':'+event;await h.runtime.pump();await h.runtime.idle()
 await vi.waitFor(()=>expect(store.getDelivery(trigger)?.status).toBe('delivered'),{timeout:10000})
 const decision=await h.route({kind:'accept',trigger_id:trigger,title:'继续合成原任务',worktree_name:'weekly-followup',acknowledgement:'继续处理。'})
 const ticketId=(decision.ticket as {ticket_id:string}).ticket_id,worker='worker-'+ticketId;await h.runtime.idle()
 const source=store.research.save({userId:user,goalId:goal.id,ticketId},{title:'合成路线资料',url:'https://www.gz.gov.cn/synthetic',purpose:'route',content:'路线全长3公里',fetched:true})
 return {h,store,goal,task,other,otherBefore,worker,ticketId,event,source}
}
it.each(['recommendation_first','update_first'])('does not complete an explicit weekly request after reading once; allows %s',async order=>{
 const {h,store,goal,task,other,otherBefore,worker,source}=await fixture()
 try {
  expect(await h.runTool(worker,'along_task_list',{})).toMatchObject({tasks:expect.arrayContaining([expect.objectContaining({task_id:task.id,reminder_plan:expect.objectContaining({repeat:'once'})})])})
  if(order==='recommendation_first')expect(await h.runTool(worker,'along_chat_reply',{text:'路线已整理，每周安排尚未补上。',recommendation:rec(source.id)})).toMatchObject({status:'replied'})
  const before=store.getTask(user,task.id)
  await expect(h.runTool(worker,'orchestrator_report',{state:'ready',summary:'本次已处理。'})).rejects.toThrow('requested_weekly_plan_incomplete')
  expect(store.getTask(user,task.id)).toEqual(before)
  const goalRead=await h.runTool(worker,'along_goal_read',{})
  expect(await h.runTool(worker,'along_changes_commit',{idempotency_key:'weekly_apply',base_revision:(goalRead.goal as any).current_revision,input_version:(goalRead.goal as any).input_version,reason:'为原任务补充明确的每周安排',ops:[{op:'task.update',task_id:task.id,base_revision:1,fields:{repeat:'weekly',reminder_plan:{state:'scheduled',source:'agent',explanation:'沿用原周五19点完成研究',evidence:quote,action}}}]})).toMatchObject({status:'applied'})
  if(order==='update_first')expect(await h.runTool(worker,'along_chat_reply',{text:'原任务每周安排已补，路线仍待核实。',recommendation:rec(source.id)})).toMatchObject({status:'replied'})
  expect(store.getTask(user,task.id)).toMatchObject({id:task.id,status:'open',scheduledAt:at,reminderPlan:{repeat:'weekly',weekday:5,timezone:zone}})
  expect(store.getTask(user,other.id)).toEqual(otherBefore)
  expect(await h.runTool(worker,'orchestrator_report',{state:'ready',summary:'每周安排和条件式资料均已处理。'})).toMatchObject({reported:true})
  const cards=store.workspaceSync(user,0,200).items.filter(i=>(i.payload as any).recommendation)
  expect(cards).toHaveLength(1);const card=cards[0]!.payload as any;expect(card.recommendation.sources).toHaveLength(1)
  expect(card.recommendation.summary.includes('该结果生成时')).toBe(order==='recommendation_first')
  expect(card.recommendation.nextStep.includes('该结果生成时')).toBe(order==='recommendation_first')
  if(order==='recommendation_first'){expect(card.text).toContain('该结果生成时');expect(card.text).toContain('以任务当前安排为准');expect(card.text).not.toContain('当前仍是单次')}
  expect(card.notification.revision).toBe(order==='recommendation_first'?1:2)
  expect(card.notification.revision===store.getTask(user,task.id)!.currentRevision).toBe(order==='update_first')
  expect(card.recommendation.summary.length).toBeLessThanOrEqual(1200);expect(card.recommendation.nextStep.length).toBeLessThanOrEqual(600)
  await expect(h.runTool(worker,'orchestrator_report',{state:'ready',summary:'重复'})).rejects.toThrow('Ticket ended')
 } finally {await h.stop()}
})

it('recognizes only the quoted current imperative and shared task action, preserving negative and one-off boundaries',()=>{
 expect(explicitWeeklyTaskRequest({text:'请继续原任务：'+quote,timezone:zone},action)).toMatchObject({weekday:5,zone,clock:'19:00'})
 for(const text of ['每周五19:00'+action,'我会'+quote,'例如：'+quote,'他说：'+quote,'如果'+quote,'不要'+quote,quote+'，只提醒一次','请继续原任务：补上每周五北京时间19:00归还图书'])
  expect(explicitWeeklyTaskRequest({text,timezone:zone},action),text).toBeUndefined()
 expect(explicitWeeklyTaskRequest({text:quote},action)).toMatchObject({validTimezone:false})
})
it('checks the original bound task even after its content/status changes or reply targets another owned task',async()=>{
 const {h,store,task,other,worker,event,ticketId,source}=await fixture()
 try {
  const before=store.getTask(user,task.id)!
  store.appendTaskRevision({taskId:task.id,userId:user,content:'换个标题',status:'done',originEventId:event})
  expect(await h.runTool(worker,'along_chat_reply',{text:'路线可比较。',task_id:other.id,recommendation:rec(source.id)})).toMatchObject({status:'replied'})
  await expect(h.runTool(worker,'orchestrator_report',{state:'ready',summary:'已处理'})).rejects.toThrow('requested_weekly_plan_incomplete')
  expect(store.getTask(user,task.id)).toMatchObject({status:'done'})
  const host={service:{alongStore:store},scopeFor:()=>({userId:user,allowedGoalId:before.goalId,triggerEventId:event})}
  for(const state of ['progress','blocked','failed','dropped'])expect(()=>assertAlongReport(host,ticketId,state)).not.toThrow()
  expect(()=>assertAlongReport({...host,scopeFor:()=>({...host.scopeFor(),userId:'someone_else'})},ticketId,'ready')).not.toThrow()
 }finally{await h.stop()}
})
it('checks real open weekly mandate, clock, zone and future occurrence, without treating metadata alone as completion',async()=>{
 const {h,store,task,worker,ticketId,event,goal}=await fixture()
 try {
  const host={service:{alongStore:store},scopeFor:()=>({userId:user,allowedGoalId:goal.id,triggerEventId:event})}
  const read=await h.runTool(worker,'along_goal_read',{}),versions=read.goal as any
  expect(await h.runTool(worker,'along_changes_commit',{idempotency_key:'weekly_valid',base_revision:versions.current_revision,input_version:versions.input_version,reason:'落实每周安排',ops:[{op:'task.update',task_id:task.id,base_revision:1,fields:{repeat:'weekly',reminder_plan:{state:'scheduled',source:'agent',explanation:'保留既有19点',evidence:quote,action}}}]})).toMatchObject({status:'applied'})
  expect(()=>assertAlongReport(host,ticketId,'ready')).not.toThrow();expect(()=>assertAlongReport(host,ticketId,'ready')).not.toThrow()
  // Without an explicit preserve-next-instant clause, the postcondition does not invent a fixed start date.
  store.appendTaskRevision({taskId:task.id,userId:user,scheduledAt:'2027-01-15T11:00:00Z',originEventId:event})
  expect(()=>assertAlongReport(host,ticketId,'ready')).not.toThrow()
  store.appendTaskRevision({taskId:task.id,userId:user,scheduledAt:at,originEventId:event})
  const plan=store.getTask(user,task.id)!.reminderPlan!,mandate=store.health.daily(task.id)!
  for(const patch of [{status:'done' as const},{scheduledAt:'2027-01-08T12:00:00Z'},{scheduledAt:'2027-01-07T11:00:00Z'},{scheduledAt:'2027-01-01T11:00:00Z'}]) {
   store.appendTaskRevision({taskId:task.id,userId:user,...patch,originEventId:event})
   expect(()=>assertAlongReport(host,ticketId,'ready')).toThrow('requested_weekly_plan_incomplete')
   store.appendTaskRevision({taskId:task.id,userId:user,status:'open',scheduledAt:at,originEventId:event})
  }
  store.health.savePlan(task.id,{...plan,timezone:'UTC'} as any);expect(()=>assertAlongReport(host,ticketId,'ready')).toThrow('requested_weekly_plan_incomplete')
  store.health.savePlan(task.id,plan);store.health.setDaily(task.id)
  expect(()=>assertAlongReport(host,ticketId,'ready')).toThrow('requested_weekly_plan_incomplete')
  store.health.setDaily(task.id,{eventId:mandate.evidence,zone:mandate.zone,wallTime:mandate.wallTime,weekday:mandate.weekday,quote:mandate.quote,action:mandate.action})
  expect(()=>assertAlongReport(host,ticketId,'ready')).not.toThrow()
  await h.runtime.stop()
  const reopened=await startRuntime(undefined,{dir:h.directory})
  try {
   const along=reopened.runtime.along!
   expect(along.service.alongStore.getTask(user,task.id)).toMatchObject({status:'open',scheduledAt:at,reminderPlan:{repeat:'weekly'}})
   expect(()=>assertAlongReport({service:along.service,scopeFor:id=>along.worklink.workScopeForTicket(id)},ticketId,'ready')).not.toThrow()
  }finally{await reopened.stop()}
 }finally{await h.stop()}
})
it('does not force a reminder edit or annotate a card for ordinary recommendation feedback',async()=>{
 const {h,store,worker,source}=await fixture('请继续比较原任务的路线资料，暂不改提醒。')
 try {
  expect(await h.runTool(worker,'along_chat_reply',{text:'条件待核实',recommendation:rec(source.id)})).toMatchObject({status:'replied'})
  const card=store.workspaceSync(user,0,200).items.find(i=>(i.payload as any).recommendation)!.payload as any
  expect(card.recommendation.summary).not.toContain('该结果生成时')
  expect(await h.runTool(worker,'orchestrator_report',{state:'ready',summary:'条件式推荐已交付'})).toMatchObject({reported:true})
 }finally{await h.stop()}
})
it('honors an explicit preserve-next-instant instruction instead of accepting a silently skipped week',async()=>{
 const {h,store,task,worker,ticketId,event,goal}=await fixture('请继续原任务：'+quote+'。保持已定的下一次时刻不变。')
 try {
  const read=(await h.runTool(worker,'along_goal_read',{})).goal as any
  expect(await h.runTool(worker,'along_changes_commit',{idempotency_key:'weekly_preserve',base_revision:read.current_revision,input_version:read.input_version,reason:'保留下一次时刻并补每周',ops:[{op:'task.update',task_id:task.id,base_revision:1,fields:{repeat:'weekly',reminder_plan:{state:'scheduled',source:'agent',explanation:'保留原19点',evidence:quote,action}}}]})).toMatchObject({status:'applied'})
  const host={service:{alongStore:store},scopeFor:()=>({userId:user,allowedGoalId:goal.id,triggerEventId:event})}
  expect(()=>assertAlongReport(host,ticketId,'ready')).not.toThrow()
  store.appendTaskRevision({taskId:task.id,userId:user,scheduledAt:'2027-01-15T11:00:00Z',originEventId:event})
  expect(()=>assertAlongReport(host,ticketId,'ready')).toThrow('requested_weekly_plan_incomplete')
 }finally{await h.stop()}
})
it('does not accept shortening the requested action while persisting otherwise valid weekly metadata',async()=>{
 const {h,store,task,worker,ticketId,event,goal}=await fixture()
 try {
  const read=(await h.runTool(worker,'along_goal_read',{})).goal as any
  expect(await h.runTool(worker,'along_changes_commit',{idempotency_key:'weekly_shorten',base_revision:read.current_revision,input_version:read.input_version,reason:'合成缩短行动反例',ops:[{op:'task.update',task_id:task.id,base_revision:1,fields:{content:'查天气',repeat:'weekly',reminder_plan:{state:'scheduled',source:'agent',explanation:'保留既有时刻',evidence:quote,action:'查天气'}}}]})).toMatchObject({status:'applied'})
  expect(store.getTask(user,task.id)).toMatchObject({status:'open',content:'查天气',reminderPlan:{repeat:'weekly'}})
  const host={service:{alongStore:store},scopeFor:()=>({userId:user,allowedGoalId:goal.id,triggerEventId:event})}
  expect(()=>assertAlongReport(host,ticketId,'ready')).toThrow('requested_weekly_plan_incomplete')
 }finally{await h.stop()}
})
