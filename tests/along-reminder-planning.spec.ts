import { mkdtempSync,rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
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
    ['上午10点开会请提醒我提前准备材料','准备材料','上午10点开会请提醒我提前准备材料','准备材料',first],
    ['原本上午10点提醒我喝水的安排取消','喝水','上午10点提醒我喝水','喝水',first],
    ['不要上午10点提醒我喝水','喝水','上午10点提醒我喝水','喝水',first],
    ['后天上午10点提醒我喝水','喝水','后天上午10点提醒我喝水','喝水',first],
    ['上午10点开会，请提醒我准备材料','准备材料','上午10点开会，请提醒我准备材料','准备材料',first],
  ] as const) expect(await submit(text,content,quote,action,at)).toMatchObject({status:'invalid'})
  expect(await submit('上午10点提醒我喝水','喝水','上午10点提醒我喝水','喝水')).toMatchObject({status:'applied'})
  const positive='每周一上午10点提醒我预约周二课程'
  expect(await submit(positive,'预约周二课程',positive,'预约周二课程',first,'weekly')).toMatchObject({status:'applied'})
  expect(await submit(positive,'预约周二课程',positive,'预约周二课程','2027-01-05T02:00:00Z','weekly')).toMatchObject({status:'invalid'})
  expect(await submit(positive,'预约牙医',positive,'预约牙医',first,'weekly')).toMatchObject({status:'invalid'})
  expect(supportsRecurrence('禁止每周一上午提醒我预约周二课程',positive.slice(0,4),'预约周二课程','预约周二课程','weekly',1)).toBe(false)
  expect(nextDailyTime(first,timezone,Date.parse('2027-01-26T05:00:00Z'),first,1)).toBe('2027-02-01T02:00:00.000Z')
})
it('binds an overall delegation to each named action and its own day, including the day before class',async()=>{
  now();const {say,commit,store,goal}=fixture()
  const booking='每周二和周五上陶艺课，前一天要预约'
  const daily='每天凌晨2点前要收拾完画具'
  say('我想'+booking+'。'+daily+'。请帮我安排任务和提醒，具体提醒时刻你来安排。')
  const create=(content:string,at:string,repeat:string,evidence:string,action:string)=>({
    op:'task.create',content,scheduled_at:at,repeat,reminder_plan:{...agent,evidence,action}})
  const monday=create('预约周二陶艺课',first,'weekly',booking,'预约陶艺课')
  const thursday=create('预约周五陶艺课','2027-01-07T02:00:00Z','weekly',booking,'陶艺课')
  const cleanup=create('收拾画具','2027-01-03T17:30:00Z','daily',daily,'收拾画具')
  expect(await commit([{...thursday,scheduled_at:first}])).toMatchObject({status:'invalid'})
  expect(await commit([{...monday,content:'预约周二牙医'}])).toMatchObject({status:'invalid'})
  expect(await commit([monday,thursday,cleanup])).toMatchObject({status:'applied'})
  const tasks=store.goalDetail(user,goal.id).tasks
  expect(tasks.find(t=>t.content===monday.content)?.reminderPlan).toMatchObject({source:'agent',repeat:'weekly',weekday:1,timezone,wallTime:first})
  const synced=store.workspaceSync(user,0,200).items.find(i=>i.kind==='task_updated')!.payload as {snapshot:{tasks:{content:string,reminderPlan?:unknown}[]}}
  expect(synced.snapshot.tasks.find(t=>t.content===monday.content)?.reminderPlan).toMatchObject({timezone,wallTime:first})
  expect(tasks.find(t=>t.content===thursday.content)?.reminderPlan).toMatchObject({source:'agent',repeat:'weekly',weekday:4})
  expect(tasks.find(t=>t.content===cleanup.content)?.reminderPlan).toMatchObject({source:'agent',repeat:'daily'})
  const booked=tasks.find(t=>t.content===monday.content)!
  say('请将预约的提醒推迟半小时')
  expect(await commit([{op:'task.update',task_id:booked.id,base_revision:booked.currentRevision,fields:{
    scheduled_at:'2027-01-04T02:30:00.000Z',reminder_plan:agent}}])).toMatchObject({status:'applied'})
  expect(store.getTask(user,booked.id)?.reminderPlan).toMatchObject({repeat:'weekly',weekday:1,timezone,wallTime:'2027-01-04T02:30:00.000Z'})
  expect(store.health.daily(booked.id)?.evidence).toBe('e_1')
  say('我想'+booking+'。请帮我安排任务和提醒。这次只提醒一次。')
  expect(await commit([monday])).toMatchObject({status:'invalid'})
})
it('migrates a schema-5 daily mandate without rewriting the prior task or inventing a reminder source',()=>{
  now();const dir=mkdtempSync(join(tmpdir(),'along-plan-v5-'));dirs.push(dir)
  const path=join(dir,'along.sqlite'),original=new AlongStore(path)
  original.assertUser(user,device)
  const g=original.insertGoal({userId:user,domain:'custom'})
  const t=original.insertTask({userId:user,goalId:g.id,content:'旧任务',scheduledAt:first})
  original.health.setDaily(t.id,{eventId:'original_mandate',zone:timezone,wallTime:first})
  original.close()
  const raw=new DatabaseSync(path)
  raw.exec(`DROP TABLE task_reminder_plan; ALTER TABLE task_daily DROP COLUMN weekday; ALTER TABLE task_daily DROP COLUMN evidence_quote;
    ALTER TABLE task_daily DROP COLUMN task_action; UPDATE meta SET value='5' WHERE key='schema_version';`)
  raw.close()
  const upgraded=new AlongStore(path);stores.push(upgraded)
  const migrated=upgraded.getTask(user,t.id)!
  expect(migrated.scheduledAt).toBe(first)
  expect(migrated.reminderPlan).toBeUndefined()
  expect(upgraded.health.daily(t.id)).toEqual({evidence:'original_mandate',zone:timezone,wallTime:first})
})
it.each([
  ['weekly','每周一上午提醒我预约周二课程','预约周二课程','2027-01-04T02:00:00.000Z','2027-01-11T02:00:00.000Z',timezone,undefined],
  ['weekly','每周四上午提醒我预约周五课程','预约周五课程','2027-01-07T02:00:00.000Z','2027-01-14T02:00:00.000Z',timezone,undefined],
  ['daily','每天提醒我散步十分钟','散步十分钟','2027-01-04T02:00:00.000Z','2027-01-05T02:00:00.000Z',timezone,undefined],
  ['daily','每天提醒我整理画具','整理画具','2027-03-13T07:30:00.000Z','2027-03-14T07:30:00.000Z','America/New_York','2027-03-15T06:30:00.000Z'],
] as const)('renews the committed %s reminder via the registered due Worker at its delegated local day',async(repeat,quote,action,at,next,zone,following)=>{
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
      occurred_at:new Date().toISOString(),timezone:zone,payload:{event_type:'along.user_message',text:quote}},{userId:user,deviceId:device})
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
    expect(task).toMatchObject({scheduledAt:next,previousDailyOccurrence:at,reminderPlan:{repeat,timezone:zone,wallTime:at,...(repeat==='weekly'?{weekday:localWeekday(at,zone)}:{})}})
    const notes=store.workspaceSync(user,0,200).items.filter(i=>(i.payload as {notification?:{kind:string}}).notification?.kind==='reminder_due')
    expect(notes).toHaveLength(1)
    if (following) {
      await h.runTool(dw,'orchestrator_report',{state:'ready',summary:'下一次已排。'})
      vi.setSystemTime(Date.parse(next)+1000)
      await h.runtime.pump();await h.runtime.idle()
      const id=h.runtime.store.tickets.list().find(t=>t.mandate.basis.via==='task_due'&&!t.ended)!.id
      const second='worker-'+id;await vi.waitFor(()=>expect(h.tools.has(second)).toBe(true))
      await h.runTool(second,'along_health_read',{})
      await h.runTool(second,'along_health_followup',{outcome:'keep',types:[],reason:'回到原当地钟点。'})
      const snapshot=store.workspaceSync(user,0,200).items.at(-1)!.payload as {snapshot:{tasks:unknown[]}}
      expect(snapshot.snapshot.tasks[0]).toMatchObject({scheduledAt:following,reminderPlan:{wallTime:at,timezone:zone}})
    }
  } finally {await h.stop()}
},25000)


it('keeps the booking weekday separate from the activity weekday when the Worker cites only the activity name',async()=>{
  now();const {say,commit}=fixture()
  const text='每周一提醒我预约周二陶艺课'
  say(text)
  const op=(at:string,action='陶艺课')=>({op:'task.create',content:'预约周二陶艺课',scheduled_at:at,repeat:'weekly',
    reminder_plan:{...agent,evidence:text,action}})
  expect(await commit([op('2027-01-05T02:00:00Z')])).toMatchObject({status:'invalid',reason:'task_scoped_repeat_evidence_required'})
  expect(await commit([op(first)])).toMatchObject({status:'applied'})
  expect(await commit([op(first,'预约周二陶艺课')])).toMatchObject({status:'applied'})
  for(const [message,content,action] of [
    ['每周一提醒我预订周二陶艺课','预订周二陶艺课','陶艺课'],
    ['Every Monday remind me to book Tuesday pottery class','book Tuesday pottery class','pottery class'],
    ['Every Monday remind me to reserve Tuesday pottery class','reserve Tuesday pottery class','pottery class'],
  ]) {
    expect(supportsRecurrence(message!,message!,action!,content!,'weekly',2)).toBe(false)
    expect(supportsRecurrence(message!,message!,action!,content!,'weekly',1)).toBe(true)
  }
  const followsReminder='每周提醒我周二预约周三课程'
  expect(supportsRecurrence(followsReminder,followsReminder,'课程','预约周三课程','weekly',2)).toBe(true)
  expect(supportsRecurrence(followsReminder,followsReminder,'课程','预约周三课程','weekly',3)).toBe(false)
})
