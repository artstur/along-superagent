import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AlongStore } from '../src/along/store.ts'
import { AlongService } from '../src/along/service.ts'
import { createInbox } from '../src/along/inbox.ts'
import { createChangeSetModule } from '../src/along/changeset.ts'
import { alongTools } from '../src/along/tools.ts'
import { alongSourceRequest, type AlongApiHost } from '../src/along/api.ts'
import { localWeekday, supportsRecurrence } from '../src/along/reminder-plan.ts'
import { nextDailyTime } from '../src/along/task-schedule.ts'
import { startRuntime } from './fixtures/host.ts'
import { alongKind } from '../src/sources/along.ts'

const user='u_abc12345',device='d_abc12345', timezone='Asia/Shanghai'
const first='2027-01-04T02:00:00.000Z' // Monday 10:00 in Shanghai
const explanation='提前准备，保留确认时间。'
const agent={state:'scheduled',source:'agent',explanation}
const once=(content:string,at:string)=>({op:'task.create',content,scheduled_at:at,reminder_plan:agent})
const off={state:'off',reason:'opt_out'}
const dirs:string[]=[]
const stores:AlongStore[]=[]
const now=()=>vi.useFakeTimers({toFake:['Date']}).setSystemTime(new Date('2027-01-03T05:00:00Z'))
afterEach(()=>{vi.useRealTimers();for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true})})

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'along-plan-'));dirs.push(dir)
  const store=new AlongStore(join(dir,'along.sqlite'));stores.push(store);store.assertUser(user,device)
  const inbox=createInbox(store),service=new AlongService(store,{inbox,changeset:createChangeSetModule(store)})
  const goal=store.insertGoal({userId:user,domain:'custom'})
  store.appendGoalRevision({goalId:goal.id,userId:user,title:'合成课表',status:'active'});store.ensureInputVersion(user,goal.id)
  let trigger='';let counter=0
  function say(text:string) {
    trigger='e_'+ ++counter
    expect(inbox.acceptEvent({event_id:trigger,schema_version:'1',event_type:'along.user_message',goal_id:goal.id,occurred_at:new Date().toISOString(),timezone,
      payload:{event_type:'along.user_message',text}},{userId:user,deviceId:device})).toMatchObject({status:'accepted'})
  }
  const tool=alongTools({service,scopeFor:()=>({userId:user,allowedGoalId:goal.id,triggerEventId:trigger})},'test').find(t=>t.name==='along_changes_commit')!
  const commit=(ops:unknown[],key='key_'+ ++counter)=>tool.execute(tool.schema.parse({
    idempotency_key:key,base_revision:1,input_version:store.inputVersion(goal.id),reason:'同步合成提醒计划',ops}),new AbortController().signal)
  const api=(path:string)=>alongSourceRequest({along:service,bridgeToken:'only-synthetic'} as AlongApiHost,{method:'GET',path,query:new URLSearchParams({user_id:user}),headers:{
    'x-along-bridge':'1','x-along-bridge-token':'only-synthetic','x-along-user':user,'x-along-device':device},body:async()=>undefined})
  return {store,say,commit,goal,api}
}
it('requires a decision at the normal Worker entry, sends Agent arrangements and questions into real sync and task snapshots',async()=>{
  now()
  const {store,say,commit,goal,api}=fixture()
  say('周二和周五上课，前一天要预约。每天凌晨2点前入睡。某场次只能在开放预约后申请。')
  expect(await commit([{op:'task.create',content:'周一预约'}])).toMatchObject({status:'invalid',reason:'reminder_plan_required'})
  const question='这个场次的预约几点开放？'
  const ops=[once('周一预约周二课程',first),once('周四预约周五课程','2027-01-07T02:00:00.000Z'),
    once('睡前放下手机','2027-01-03T17:30:00.000Z'),{op:'task.create',content:'预约特殊场次',reminder_plan:{state:'needs_time',question}},
    {op:'task.create',content:'了解不同课程',reminder_plan:{state:'off',reason:'untimed'}}]
  expect(await commit(ops,'one')).toMatchObject({status:'applied',reused:false})
  expect(await commit(ops,'one')).toMatchObject({status:'applied',reused:true})
  const detail=await api('goals/'+goal.id)
  expect(detail.status).toBe(200)
  const tasks=(detail.body as {tasks:{content:string}[]}).tasks
  expect(tasks.find(t=>t.content==='周一预约周二课程')).toMatchObject({scheduledAt:first,reminderPlan:{state:'scheduled',source:'agent',repeat:'once',explanation}})
  expect(tasks.find(t=>t.content==='睡前放下手机')).toMatchObject({scheduledAt:'2027-01-03T17:30:00.000Z',reminderPlan:{source:'agent'}})
  expect(tasks.find(t=>t.content==='预约特殊场次')).toMatchObject({reminderPlan:{state:'needs_time',question}})
  const sync=await api('sync');expect(sync.status).toBe(200)
  const items=(sync.body as {items:{kind:string,payload:{snapshot?:{tasks:unknown[]},message?:{role:string,text:string},notification?:unknown}}[]}).items
  expect(items.filter(i=>i.kind==='task_updated')).toHaveLength(5)
  expect(items.find(i=>i.kind==='task_updated')?.payload.snapshot).toMatchObject({tasks:expect.arrayContaining([expect.objectContaining({scheduledAt:first,reminderPlan:expect.objectContaining({source:'agent'})})])})
  const replies=items.filter(i=>i.payload.message?.role==='assistant')
  expect(replies).toHaveLength(1);expect(replies[0]!.payload.message!.text).toContain(question)
  expect(replies[0]!.payload.message!.text).toContain('我为');expect(replies[0]!.payload.notification).toBeUndefined()
  const task=store.goalDetail(user,goal.id).tasks.find(t=>t.scheduledAt===first)!
  say('把预约稍微推迟')
  const op=(fields:unknown)=>({op:'task.update',task_id:task.id,base_revision:store.currentRevision('task',task.id),fields})
  expect(await commit([op({scheduled_at:'2027-01-04T02:30:00Z',reminder_plan:agent})])).toMatchObject({status:'applied'})
  say('取消提醒')
  expect(await commit([op({reminder_plan:off})])).toMatchObject({status:'applied'})
  expect(JSON.parse(JSON.stringify(store.getTask(user,task.id)))).not.toHaveProperty('scheduledAt')
  expect(store.getTask(user,task.id)?.reminderPlan).toEqual(off)
  say('调整一下任务描述')
  expect(await commit([op({scheduled_at:first,reminder_plan:agent})])).toMatchObject({status:'invalid',reason:'reminder_declined'})
  expect(store.health.recentUnnotifiedTasks(first).map(r=>r.due.taskId)).not.toContain(task.id)
})
it('requires task-linked original words for an exact clock and recurring action, and separates a deadline and a booking day',async()=>{
  now();const {say,commit}=fixture()
  async function submit(text:string,content:string,quote:string,action:string,at=first,repeat='once'){
    say(text);return commit([{op:'task.create',content,scheduled_at:at,repeat,reminder_plan:{state:'scheduled',source:'user',explanation,evidence:quote,action}}])
  }
  for(const [text,content,quote,action,at] of [
    ['每天凌晨2点前入睡','入睡','每天凌晨2点前入睡','入睡','2027-01-03T18:00:00Z'],
    ['上午10点提醒我喝水，下午3点提醒我取快递','取快递','上午10点提醒我喝水','取快递',first],
    ['上午10点提醒我喝水和下午3点提醒我取快递','取快递','上午10点提醒我喝水和下午3点提醒我取快递','取快递',first],
    ['上午10点开会，请提醒我准备材料','准备材料','上午10点开会，请提醒我准备材料','准备材料',first],
  ] as const) expect(await submit(text,content,quote,action,at)).toMatchObject({status:'invalid'})
  const positive='每周一上午10点提醒我预约周二课程'
  expect(await submit(positive,'预约周二课程',positive,'预约周二课程',first,'weekly')).toMatchObject({status:'applied'})
  expect(await submit(positive,'预约周二课程',positive,'预约周二课程','2027-01-05T02:00:00Z','weekly')).toMatchObject({status:'invalid'})
  expect(await submit(positive,'预约牙医',positive,'预约牙医',first,'weekly')).toMatchObject({status:'invalid'})
  expect(supportsRecurrence('禁止每周一上午提醒我预约周二课程',positive.slice(0,4),'预约周二课程','预约周二课程','weekly',1)).toBe(false)
  expect(nextDailyTime(first,timezone,Date.parse('2027-01-26T05:00:00Z'),first,1)).toBe('2027-02-01T02:00:00.000Z')
})
it.each([
  ['weekly','每周一上午提醒我预约周二课程','预约周二课程','2027-01-04T02:00:00.000Z','2027-01-11T02:00:00.000Z'],
  ['weekly','每周四上午提醒我预约周五课程','预约周五课程','2027-01-07T02:00:00.000Z','2027-01-14T02:00:00.000Z'],
  ['daily','每天提醒我散步十分钟','散步十分钟','2027-01-04T02:00:00.000Z','2027-01-05T02:00:00.000Z'],
])('renews the committed %s reminder via the registered due Worker at its delegated local day',async(repeat,quote,action,at,next)=>{
  now()
  const h=await startRuntime(s=>s.saveSettings({...s.settings(),sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}},policy:{...s.settings().policy,sources:{along:{allowed:[{id:user}],admission:{}}}}}))
  try {
    h.runtime.sources.register(alongKind)
    const settings=h.runtime.store.settings()
    h.runtime.store.saveSettings({...settings,sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}},feishu:{enabled:false,config:{}}}})
    const along=h.runtime.along!,store=along.service.alongStore
    const paired=await h.alongApi('POST','pairing',{user_id:user,device_id:device},{'x-along-bridge':'1','x-along-bridge-token':along.bridgeToken!,'x-along-user':user,'x-along-device':device})
    expect(paired.status).toBe(200)
    const goal=store.insertGoal({userId:user,domain:'custom'});store.appendGoalRevision({userId:user,goalId:goal.id,title:'合成预约',status:'active'});store.ensureInputVersion(user,goal.id)
    const event='synthetic_week'
    const accepted=along.service.acceptEvent({event_id:event,schema_version:'1',event_type:'along.user_message',goal_id:goal.id,
      occurred_at:new Date().toISOString(),timezone,payload:{event_type:'along.user_message',text:quote}},{userId:user,deviceId:device})
    expect(accepted.status).toBe('accepted')
    const trigger='along:'+user+':'+event
    await vi.waitFor(()=>expect(store.getDelivery(trigger)?.status).toBe('delivered'),{timeout:10000})
    const decision=await h.route({kind:'accept',trigger_id:trigger,title:'提交合成任务',worktree_name:'schedule-worker',acknowledgement:'收到。'})
    const worker='worker-'+(decision.ticket as {ticket_id:string}).ticket_id
    await h.runtime.idle()
    expect(await h.runTool(worker,'along_changes_commit',{idempotency_key:'schedule',base_revision:1,input_version:store.inputVersion(goal.id),reason:'按行动日排程',ops:[{
      op:'task.create',content:action,scheduled_at:at,repeat,reminder_plan:{...agent,evidence:quote,action}}]})).toMatchObject({status:'applied'})
    await h.runTool(worker,'orchestrator_report',{state:'ready',summary:'安排已保存。'})
    vi.setSystemTime(Date.parse(at)+1000)
    await h.runtime.pump();await h.runtime.idle()
    const due=h.runtime.store.tickets.list().find(t=>t.mandate.basis.via==='task_due'&&!t.ended)!
    expect(due).toBeDefined()
    const dw='worker-'+due.id;await vi.waitFor(()=>expect(h.tools.has(dw)).toBe(true))
    await h.runTool(dw,'along_health_read',{})
    expect(await h.runTool(dw,'along_health_followup',{outcome:'keep',types:[],reason:'保留既有节奏。'})).toMatchObject({status:'recorded'})
    const task=store.goalDetail(user,goal.id).tasks[0]!
    expect(task).toMatchObject({scheduledAt:next,previousDailyOccurrence:at,reminderPlan:{repeat,...(repeat==='weekly'?{weekday:localWeekday(at,timezone)}:{})}})
    const notes=store.workspaceSync(user,0,200).items.filter(i=>(i.payload as {notification?:{kind:string}}).notification?.kind==='reminder_due')
    expect(notes).toHaveLength(1)
  } finally {await h.stop()}
},25000)
