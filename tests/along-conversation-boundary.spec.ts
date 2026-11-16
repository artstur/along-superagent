import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AlongStore } from '../src/along/store.ts'
import { createInbox } from '../src/along/inbox.ts'
import { AlongService } from '../src/along/service.ts'
import { alongTools } from '../src/along/tools.ts'
import { alongSourceRequest, type AlongApiHost } from '../src/along/api.ts'

const user='u_abcd1234',device='d_abcd1234'
const dirs:string[]=[],stores:AlongStore[]=[]
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true})})
function setup(){
  const dir=mkdtempSync(join(tmpdir(),'along-chat-boundary-'));dirs.push(dir)
  const path=join(dir,'along.sqlite'),store=new AlongStore(path);stores.push(store)
  store.assertUser(user,device)
  const goal=store.insertGoal({userId:user,domain:'custom'})
  store.appendGoalRevision({goalId:goal.id,userId:user,title:'原目标',status:'active'})
  const inbox=createInbox(store)
  const say=(eventId:string,text:string,extra={})=>inbox.acceptEvent({event_id:eventId,schema_version:'1',event_type:'along.user_message',
    goal_id:goal.id,occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text},...extra},{userId:user,deviceId:device})
  return {path,store,goal,inbox,say}
}
it('assigns conversation only to direct chat and does not let a client or Worker choose its audience',async()=>{
  const {store,goal,inbox,say}=setup()
  expect(say('human','帮我补齐提醒计划')).toMatchObject({status:'accepted'})
  expect(store.getMessage(user,`msg:${user}:human`)).toMatchObject({audience:'conversation'})
  expect(say('forged','内部消息',{audience:'background'})).toMatchObject({status:'rejected'})
  const service=new AlongService(store,{inbox})
  const tool=alongTools({service,scopeFor:()=>({userId:user,allowedGoalId:goal.id,triggerEventId:'human'})},'t').find(t=>t.name==='along_chat_reply')!
  expect(()=>tool.schema.parse({text:'回答',audience:'background'})).toThrow()
  const result=await tool.execute(tool.schema.parse({text:'请告诉我预约什么时候开放？'}),new AbortController().signal) as {message_id:string}
  expect(store.getMessage(user,result.message_id)).toMatchObject({audience:'conversation',replyToMessageId:`msg:${user}:human`})
})
it('isolates only evidenced development inputs and their exact reply, plan note and execution links; retries append nothing',()=>{
  const {store,goal,say}=setup();say('dev','补齐提醒');say('real','我也想提前入睡',{causation_id:'dev'})
  const source=store.getMessage(user,`msg:${user}:dev`)!
  const answer=store.appendMessage({userId:user,eventId:'answer',role:'assistant',direction:'outbound',text:'已补齐',replyToMessageId:source.id})
  store.linkMessageToGoals(answer.id,[goal.id],'derived')
  store.appendSync({userId:user,kind:'message',goalId:goal.id,messageId:answer.id,payload:{recommendation:{retained:true},notification:{retained:true}}})
  store.saveChangeSet({id:'cs_dev',userId:user,goalId:goal.id,status:'applied',baseRevision:1,inputVersion:1,idempotencyKey:'cs_dev',triggerEventId:'dev',reason:'安排提醒',ops:[]})
  const plan=store.appendMessage({userId:user,eventId:'not_a_prefix',role:'assistant',direction:'outbound',text:'必要问题'})
  store.appendSync({userId:user,kind:'message',goalId:goal.id,messageId:plan.id,changesetId:'cs_dev',payload:{}})
  store.recordRunRecord({ticketId:'ticket',assignmentId:'assignment',userId:user,triggerEventId:'dev'})
  const execution=store.appendMessage({userId:user,eventId:'out:ticket:assignment',role:'assistant',direction:'outbound',text:'ready'})
  const unrelated=store.appendMessage({userId:user,eventId:'plan_lookalike',role:'assistant',direction:'outbound',text:'已补齐',causationId:'dev'})
  const actual=store.appendMessage({userId:user,eventId:'actual_new_user',role:'user',direction:'inbound',text:'我的真实新问题',replyToMessageId:source.id})
  const actualAnswer=store.appendMessage({userId:user,eventId:'actual_new_answer',role:'assistant',direction:'outbound',text:'真实问题的回答',replyToMessageId:actual.id})
  const before=store.goalDetail(user,goal.id),count=store.counts(user)
  const preview=store.isolateDevelopmentEvents(user,['dev'],'private-evidence-manifest.json',{dryRun:true})
  expect(store.getMessage(user,source.id)?.audience).toBe('conversation')
  const result=store.isolateDevelopmentEvents(user,['dev'],'private-evidence-manifest.json')
  expect(result).toEqual(preview)
  expect(new Set(result.changed)).toEqual(new Set([source.id,answer.id,plan.id,execution.id]))
  expect(store.getMessage(user,`msg:${user}:real`)?.audience).toBe('conversation')
  expect(store.getMessage(user,unrelated.id)?.audience).toBe('conversation')
  expect(store.getMessage(user,actual.id)?.audience).toBe('conversation')
  expect(store.getMessage(user,actualAnswer.id)?.audience).toBe('conversation')
  expect(store.goalDetail(user,goal.id)).toEqual(before);expect(store.counts(user)).toEqual(count)
  const cursor=store.syncPage(user,0,200).items.at(-1)!.seq
  expect(store.isolateDevelopmentEvents(user,['dev'],'private-evidence-manifest.json')).toEqual({changed:[]})
  expect(store.syncPage(user,cursor,200).items).toEqual([])
  const item=store.workspaceSync(user,0,200).items.find(i=>i.messageId===answer.id)!
  expect(item.payload).toMatchObject({audience:'background',message:{audience:'background'},recommendation:{retained:true},notification:{retained:true}})
  const correction=store.workspaceSync(user,0,200).items.filter(i=>i.messageId===answer.id).at(-1)!
  expect(correction.payload).toMatchObject({classification_only:true,notification:{retained:true}})
  expect(()=>alongTools({service:new AlongService(store),scopeFor:()=>({userId:user,triggerEventId:'dev',allowedGoalId:goal.id})},'t')
    .find(t=>t.name==='along_chat_reply')!.schema.parse({text:'x',audience:'conversation'})).toThrow()
})
it('rejects unresolved or foreign evidence atomically and never quarantines later real chat on the same root',()=>{
  const {store,say}=setup();say('known','maintenance');say('later','真实反馈',{causation_id:'known'})
  const before=store.workspaceSync(user,0,200)
  expect(()=>store.isolateDevelopmentEvents(user,['known','missing'],'evidence')).toThrow()
  expect(store.workspaceSync(user,0,200)).toEqual(before)
  expect(()=>store.isolateDevelopmentEvents('u_other',['known'],'evidence')).toThrow()
  expect(()=>store.isolateDevelopmentEvents(user,['known'],'')).toThrow()
})
it('uses current durable visibility on every replay and preserves paged cursor sequences for old clients',()=>{
  const {store,say}=setup();say('dev','开发验收');say('human','真实问题')
  const original=store.syncPage(user,0,1),seq=original.items[0]!.seq
  store.isolateDevelopmentEvents(user,['dev'],'evidence')
  const old=store.workspaceSync(user,0,1,0)
  expect(old.nextCursor).toBe(original.nextCursor);expect(old.items[0]).toMatchObject({seq,kind:'changeset_note'})
  expect(old.items[0]!.payload).not.toHaveProperty('message');expect(old.items[0]!.payload).not.toHaveProperty('text')
  expect(store.workspaceSync(user,0,1,1).items[0]!.payload).toMatchObject({message:{audience:'background'}})
  expect(store.workspaceSync(user,seq,1,0).items[0]!.payload).toMatchObject({message:{eventId:'human',audience:'conversation'}})
})
it('API requires explicit new-client capability before sending background carriers and rejects unsupported versions',async()=>{
  const {store,goal,say,inbox}=setup();say('dev','development');store.isolateDevelopmentEvents(user,['dev'],'evidence')
  const host={along:new AlongService(store,{inbox}),bridgeToken:'synthetic'} as AlongApiHost
  const call=(v?:string)=>alongSourceRequest(host,{method:'GET',path:'sync',query:new URLSearchParams({user_id:user,...(v===undefined?{}:{conversation_version:v})}),
    headers:{'x-along-bridge':'1','x-along-bridge-token':'synthetic','x-along-user':user,'x-along-device':device},body:async()=>undefined})
  const old=await call(),modern=await call('1')
  expect(old.status).toBe(200);expect(modern.status).toBe(200)
  expect((old.body as {items:unknown[]}).items).toEqual(expect.arrayContaining([expect.objectContaining({kind:'changeset_note',goalId:goal.id})]))
  expect((modern.body as {items:unknown[]}).items).toEqual(expect.arrayContaining([expect.objectContaining({kind:'message',payload:expect.objectContaining({audience:'background'})})]))
  expect((await call('2')).status).toBe(400)
})
it('task facts keep their audit body without appearing as a user-authored chat',()=>{
  const {store,goal,inbox}=setup()
  const task=store.insertTask({userId:user,goalId:goal.id,content:'散步'})
  expect(inbox.acceptEvent({event_id:'completed',schema_version:'1',event_type:'along.message',kind:'task.completed',task_id:task.id,
    occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.message',kind:'task.completed',task_id:task.id}},{userId:user,deviceId:device})).toMatchObject({status:'accepted'})
  expect(store.getMessage(user,`msg:${user}:completed`)).toMatchObject({audience:'background',text:'任务完成反馈：散步'})
  expect(store.getTask(user,task.id)?.status).toBe('done')
})
it('migrates only proven execution and automatic-update records while preserving human wording and essential questions',()=>{
  const {path,store,goal,say}=setup();say('human','ready 补齐提醒 followup_lookalike')
  for(const [eventId,text] of [['execution','完成'],['followup_update','更新'],['followup_ask','缺必要信息？']] as const){
    const m=store.appendMessage({userId:user,eventId,role:'assistant',direction:'outbound',text})
    store.appendSync({userId:user,kind:'message',goalId:goal.id,messageId:m.id,payload:eventId==='execution'?{presentation:'execution'}:{}})
  }
  stores.splice(stores.indexOf(store),1);store.close()
  const raw=new DatabaseSync(path)
  for(const [event,result] of [['update','update'],['ask','ask']] as const)raw.prepare('INSERT INTO health_dispatch(event_id,user_id,goal_id,input_version,snapshot,result,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(event,user,goal.id,1,'{}',JSON.stringify({outcome:result}),new Date().toISOString())
  raw.exec("ALTER TABLE message DROP COLUMN audience; UPDATE meta SET value='7' WHERE key='schema_version'");raw.close()
  const next=new AlongStore(path);stores.push(next)
  expect(next.getMessage(user,`msg:${user}:execution`)?.audience).toBe('background')
  expect(next.getMessage(user,`msg:${user}:followup_update`)?.audience).toBe('background')
  expect(next.getMessage(user,`msg:${user}:followup_ask`)?.audience).toBe('conversation')
  expect(next.getMessage(user,`msg:${user}:human`)?.audience).toBe('conversation')
  expect(next.counts(user).messages).toBe(4)
})

it('keeps automatic execution wording out of a legacy phone sync without losing its durable audit',()=>{
  const {store,goal}=setup()
  const m=store.appendMessage({userId:user,eventId:'automatic',role:'assistant',direction:'outbound',audience:'background',text:'内部执行：补齐重复规则'})
  store.linkMessageToGoals(m.id,[goal.id],'derived')
  store.appendSync({userId:user,kind:'message',goalId:goal.id,messageId:m.id,payload:{text:m.text,presentation:'execution'}})
  expect(store.workspaceSync(user,0,200,0).items[0]).toMatchObject({kind:'changeset_note'})
  expect(store.workspaceSync(user,0,200,0).items[0]!.payload).not.toHaveProperty('text')
  expect(store.getMessage(user,m.id)?.text).toBe('内部执行：补齐重复规则')
})
it('a hidden development input cannot acquire a new conversational reply through the registered tool',async()=>{
  const {store,goal,say}=setup();say('dev','后台维护')
  store.isolateDevelopmentEvents(user,['dev'],'private-verified-source')
  const tool=alongTools({service:new AlongService(store),scopeFor:()=>({userId:user,allowedGoalId:goal.id,triggerEventId:'dev'})},'t').find(t=>t.name==='along_chat_reply')!
  await expect(tool.execute(tool.schema.parse({text:'维护完成'}),new AbortController().signal)).rejects.toThrow('no user chat')
  expect(store.counts(user).messages).toBe(1)
  const real=store.appendMessage({userId:user,eventId:'actual_reply',role:'user',direction:'inbound',text:'我真正的追问',replyToMessageId:`msg:${user}:dev`})
  expect(real.audience).toBe('conversation')
  expect(store.isCurrentChatInput(user,'dev',goal.id)).toBe(false)
})

it('Worker conversation pages exclude background before LIMIT and keep task facts distinctly sourced',async()=>{
  const {store,goal,say,inbox}=setup()
  for(let n=0;n<3;n++)say('human_'+n,'真实消息 '+n)
  for(let n=0;n<8;n++){
    const m=store.appendMessage({userId:user,eventId:'automatic_'+n,role:'assistant',direction:'outbound',audience:'background',text:'后台执行 '+n})
    store.linkMessageToGoals(m.id,[goal.id],'derived')
  }
  const tool=alongTools({service:new AlongService(store,{inbox}),scopeFor:()=>({userId:user,allowedGoalId:goal.id})},'t')
    .find(t=>t.name==='along_conversation_read')!
  const first=await tool.execute(tool.schema.parse({limit:2}),new AbortController().signal) as {messages:{event_id:string}[],next_before_seq:number}
  expect(first.messages.map(m=>m.event_id)).toEqual(['human_1','human_2'])
  expect(first.next_before_seq).toBe(2)
  const next=await tool.execute(tool.schema.parse({limit:2,before_seq:first.next_before_seq}),new AbortController().signal) as {messages:{event_id:string}[]}
  expect(next.messages.map(m=>m.event_id)).toEqual(['human_0'])
  store.isolateDevelopmentEvents(user,['human_2'],'explicit-dev-fixture')
  const after=await tool.execute(tool.schema.parse({limit:2}),new AbortController().signal) as {messages:{event_id:string}[]}
  expect(after.messages.map(m=>m.event_id)).toEqual(['human_0','human_1'])
  const task=store.insertTask({userId:user,goalId:goal.id,content:'步行'})
  inbox.acceptEvent({event_id:'fact',schema_version:'1',event_type:'along.message',kind:'task.feedback',task_id:task.id,
    occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.message',kind:'task.feedback',task_id:task.id,note:'完成了半程'}},{userId:user,deviceId:device})
  const facts=await tool.execute(tool.schema.parse({limit:2}),new AbortController().signal) as {messages:{event_id:string}[],task_feedback:unknown[]}
  expect(facts.messages.map(m=>m.event_id)).not.toContain('fact')
  expect(facts.task_feedback).toEqual([expect.objectContaining({event_id:'fact',source:'task_event',kind:'task.feedback',text:'完成了半程'})])
})

it('never re-extracts or reuses background development text as a personal memory while preserving its audit',()=>{
  const {store,say}=setup();say('dev','我喜欢开发验收样例');say('real','我喜欢散步')
  const source=store.getMessage(user,`msg:${user}:dev`)!
  const memory=store.memory.save(user,{quote:source.text,topic:'测试偏好',category:'preference',assertion:'explicit',sourceMessageIds:[source.id],replaces:[],conflictsWith:[],backendIds:[]},source.seq,[],'active')
  expect(store.memory.effective(user).map(m=>m.id)).toContain(memory.id)
  store.isolateDevelopmentEvents(user,['dev'],'verified-maintenance-source')
  expect(store.memory.sources(user).map(m=>m.id)).toEqual([`msg:${user}:real`])
  expect(store.memory.contextAllowed(user,source.id,source.text)).toBe(false)
  expect(store.memory.effective(user)).toEqual([])
  const verified=store.appendMessage({userId:user,eventId:'legitimate_background',role:'assistant',direction:'outbound',audience:'background',text:'合成已核实的任务事实'})
  const legitimate=store.memory.save(user,{quote:verified.text,topic:'任务事实',category:'fact',assertion:'explicit',sourceMessageIds:[verified.id],replaces:[],conflictsWith:[],backendIds:[]},verified.seq,[],'active')
  expect(store.memory.effective(user).map(m=>m.id)).toEqual([legitimate.id])
  expect(store.memory.memories(user).find(m=>m.id===memory.id)?.status).toBe('active')
})
