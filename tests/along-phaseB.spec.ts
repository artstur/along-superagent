import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { startRuntime } from './fixtures/host.ts'
import { AlongStore } from '../src/along/store.ts'
import { createInbox } from '../src/along/inbox.ts'
import { createChangeSetModule } from '../src/along/changeset.ts'
import { alongKind } from '../src/sources/along.ts'
import { alongTools } from '../src/along/tools.ts'
import { AlongService } from '../src/along/service.ts'

const USER='u_bbbbbbbb', DEVICE='d_bbbbbbbb'
const envelope=(eventId: string,text: string,extra: Record<string,unknown>={})=>({event_id:eventId,schema_version:'1',event_type:'along.user_message',
  occurred_at:'2026-11-15T12:00:00Z',timezone:'Asia/Shanghai',...extra,payload:{event_type:'along.user_message',text}})
let host: Awaited<ReturnType<typeof startRuntime>> | undefined
afterEach(async()=>{await host?.stop();host=undefined})

it('returns lossless JSON from goal and task tools under the real Harness output contract',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'along-b-json-')),store=new AlongStore(join(directory,'along.sqlite'))
  try {
    store.assertUser(USER,DEVICE)
    const goal=store.insertGoal({userId:USER,domain:'custom'})
    store.appendGoalRevision({goalId:goal.id,userId:USER,title:'改善睡眠',status:'active'})
    store.insertTask({goalId:goal.id,userId:USER,content:'睡前放下手机'})
    const tools=alongTools({service:new AlongService(store),scopeFor:()=>({userId:USER,allowedGoalId:goal.id})},'json-ticket')
    for(const name of ['along_goal_read','along_task_list','along_health_read','along_data_sources_catalog']) {
      const tool=tools.find(tool=>tool.name===name)!
      const result=await tool.execute(tool.schema.parse({}),new AbortController().signal)
      expect(result).toStrictEqual(JSON.parse(JSON.stringify(result)))
    }
    const commit=tools.find(tool=>tool.name==='along_changes_commit')!
    const base={idempotency_key:'schema-contract',base_revision:0,input_version:1,reason:'接口验证'}
    const qualitative={op:'goal.create',domain:'custom',title:'改善睡眠',context:null}
    expect(()=>commit.schema.parse({...base,ops:[qualitative]})).not.toThrow()
    for(const op of [{...qualitative,metric:{}},{...qualitative,metric:{type:'sleep',target:8,unit:'hours',period:'day'}},
      {...qualitative,domain:'health'},{...qualitative,extra:'untrusted'},{...qualitative,op:'goal.delete'}]) {
      expect(()=>commit.schema.parse({...base,ops:[op]})).toThrow()
    }
    for (const [operation, path] of [
      [{ op: 'task.update', task_id: 't_feedback', base_revision: '2', fields: { content: '今天晚饭后散步' } }, ['ops', 0, 'base_revision']],
      [{ op: 'goal.update', fields: { context: { item: ['临时安排'] } } }, ['ops', 0, 'fields', 'context']],
    ] as const) {
      const rejected = commit.schema.safeParse({ ...base, ops: [operation] })
      expect(rejected.success).toBe(false)
      if (!rejected.success) expect(rejected.error.issues).toEqual([expect.objectContaining({ code: 'invalid_type', path: [...path] })])
    }

  }finally{store.close();rmSync(directory,{recursive:true,force:true})}
})

it('persists an observation and answer without a goal, then applies explicit intent and later chat corrections through real registered tools',async()=>{
  const h=host=await startRuntime(store=>store.saveSettings({...store.settings(),sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}}}))
  h.runtime.sources.register(alongKind)
  const settings=h.runtime.store.settings()
  h.runtime.store.saveSettings({...settings,sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}},feishu:{enabled:false,config:{}}}})
  const along=h.runtime.along!,store=along.service.alongStore
  const headers={'x-along-bridge':'1','x-along-bridge-token':along.bridgeToken,'x-along-user':USER,'x-along-device':DEVICE}
  const call=(method:string,path:string,body?:unknown)=>h.alongApi(method,path,body,headers)
  expect((await call('POST','pairing',{user_id:USER,device_id:DEVICE})).status).toBe(200)
  const dispatch=async(eventId:string,text:string,extra:Record<string,unknown>={})=>{
    expect((await call('POST','events',envelope(eventId,text,extra))).body).toMatchObject({status:'accepted'})
    const trigger=`along:${USER}:${eventId}`
    await vi.waitFor(()=>expect(store.getDelivery(trigger)?.status).toBe('delivered'),{timeout:10_000})
    await h.runtime.idle()
    if(eventId==='b_observation') {
      const refused=await h.runTool(h.runtime.masterId,'orchestrator_route',{decisions:[{kind:'ignore',trigger_id:trigger,reason:'No repository change requested'}]})
      expect(refused).toMatchObject({results:[{refused:expect.stringContaining('conversational work')}]})
      const invalidStop=await h.runTool(h.runtime.masterId,'orchestrator_route',{decisions:[{kind:'stop',trigger_id:trigger,ticket_id:'missing-ticket',reason:'mistaken target'}]})
      expect(invalidStop).toMatchObject({results:[{refused:expect.stringContaining('stop only a live Ticket')}]})
      expect(h.runtime.store.triggers.disposition(trigger)?.decisionId).toBeUndefined()
    }
    const accepted=await h.route({kind:'accept',trigger_id:trigger,title:'处理用户聊天',worktree_name:eventId.replaceAll('_','-'),acknowledgement:'收到。'})
    await h.runtime.idle()
    return `worker-${(accepted.ticket as {ticket_id:string}).ticket_id}`
  }
  // A test host controls model decisions; the storage, routing, worker tools and sync are real.
  const observation=await dispatch('b_observation','最近睡得不好')
  const history=await h.runTool(observation,'along_conversation_read',{})
  expect(history).toMatchObject({messages:[{text:'最近睡得不好'}]})
  const answer={text:'最近是入睡困难，还是容易醒？'}
  expect(await h.runTool(observation,'along_chat_reply',answer)).toMatchObject({status:'replied',reused:false})
  expect(await h.runTool(observation,'along_chat_reply',answer)).toMatchObject({status:'replied',reused:true})
  expect(store.counts(USER).goals).toBe(0)
  await h.runTool(observation,'orchestrator_report',{state:'ready',summary:'已回应现象，未创建目标。'})
  const action=await dispatch('b_action','我想改善睡眠，先从睡前少看手机开始',{causation_id:'b_observation'})
  expect(await h.runTool(action,'along_conversation_read',{})).toMatchObject({messages:expect.arrayContaining([{seq:1,event_id:'b_observation',role:'user',text:'最近睡得不好',at:expect.any(String)}])})
  expect(await h.runTool(action,'along_changes_commit',{idempotency_key:'b_create',base_revision:0,input_version:1,reason:'根据你的意图建立睡眠目标',ops:[
    {op:'goal.create',domain:'custom',title:'改善睡眠',context:['先减少睡前刷手机']},
    {op:'task.create',content:'今晚睡前把手机放到床外',reminder_plan:{state:'scheduled',source:'agent',explanation:'给睡前准备留出时间。'},scheduled_at:new Date(Date.now()+3600_000).toISOString()},
  ]})).toMatchObject({status:'applied'})
  const goal=store.listGoals(USER).items[0]!
  expect(await h.runTool(action,'along_data_sources_catalog',{})).toMatchObject({sources:expect.any(Array)})
  expect(await h.runTool(action,'along_data_sources_recommend',{base_revision:1,input_version:1,
    sources:[{provider:'apple-health',reason:'睡眠目标需要所选睡眠摘要'}]})).toMatchObject({status:'recommended',data_sources:[{provider:'apple-health',status:'recommended'}]})
  expect(store.workspaceSync(USER,0,200).items.at(-1)?.payload).toMatchObject({snapshot:{dataSources:[{provider:'apple-health',status:'recommended'}]}})
  await h.runTool(action,'along_chat_reply',{text:'已建立改善睡眠的目标，今晚先把手机放到床外。'})
  await h.runTool(action,'orchestrator_report',{state:'ready',summary:'目标和下一步已生效。'})
  const first=await dispatch('b_old_plan','这周提前睡觉',{goal_id:goal.id})
  const latest=await dispatch('b_correction','这周出差，先保留睡前不刷手机',{goal_id:goal.id})
  const read=await h.runTool(first,'along_goal_read',{}) as {goal:{current_revision:number,input_version:number}}
  // Even copying the new version number cannot revive the earlier instruction.
  expect(await h.runTool(first,'along_changes_commit',{idempotency_key:'b_stale',base_revision:read.goal.current_revision,input_version:read.goal.input_version,
    reason:'旧输入的方案',ops:[{op:'goal.update',fields:{title:'过时方案'}}]})).toMatchObject({status:'conflicted',reason:'conflicted_input'})
  expect(await h.runTool(first,'along_chat_reply',{text:'不应发送的旧回复'})).toMatchObject({status:'conflicted'})
  expect(await h.runTool(latest,'along_changes_commit',{idempotency_key:'b_correct',base_revision:read.goal.current_revision,input_version:read.goal.input_version,
    reason:'按出差安排调整',ops:[{op:'goal.update',fields:{context:['这周出差，保留睡前不刷手机']}}]})).toMatchObject({status:'applied'})
  await h.runTool(latest,'along_chat_reply',{text:'已按出差安排调整，保留睡前不刷手机。'})
  const recommend=await dispatch('b_recommend','推荐一个适合今晚的放松方法，准备好后通知我',{goal_id:goal.id})
  const target=store.listTasks(USER,{goalId:goal.id}).items[0]!
  const recommendation={text:'今晚先花三分钟做放松练习。',notify:'recommendation_ready',task_id:target.id}
  await expect(h.runTool(recommend,'along_chat_reply',{...recommendation,task_id:'t_unknown'})).rejects.toThrow('outside this goal')
  await h.runTool(recommend,'along_chat_reply',recommendation)
  await h.runTool(recommend,'along_chat_reply',recommendation)
  const sync=await call('GET',`sync?user_id=${USER}&after_seq=0&limit=200`)
  const items=sync.body.items as {kind:string,goalId?:string,payload:Record<string,unknown>}[]
  expect(items.filter(i=>i.payload.notification)).toMatchObject([{kind:'message',goalId:goal.id,taskId:target.id,payload:{notification:{kind:'recommendation_ready',event_id:expect.any(String)}}}])
  expect(items.filter(item=>item.goalId===goal.id).every(item=>(item.payload.snapshot as {revision:{title:string}}).revision.title==='改善睡眠')).toBe(true)
  expect(items.some(item=>(item.payload.message as {text?:string})?.text===answer.text)).toBe(true)
  expect(JSON.stringify(items)).not.toContain(along.bridgeToken)
  expect(store.messagesByGoal(USER,goal.id).items.map(message=>message.text)).toContain('最近睡得不好')
},45_000)

it('blocks stale or duplicate goal creation in one goal-less conversation, and refuses forged conversation ancestry',()=>{
  const directory=mkdtempSync(join(tmpdir(),'along-b-input-'))
  const store=new AlongStore(join(directory,'along.sqlite')),inbox=createInbox(store),changes=createChangeSetModule(store)
  try {
    const identity={userId:USER,deviceId:DEVICE}
    inbox.acceptEvent(envelope('b_root','我想运动'),identity)
    inbox.acceptEvent(envelope('b_newer','先不要建目标，我再想想',{causation_id:'b_root'}),identity)
    const input={idempotency_key:'create_old',base_revision:0,input_version:1,reason:'旧消息的目标',ops:[{op:'goal.create' as const,domain:'custom' as const,title:'运动',metric:null,context:null}]}
    expect(changes.commitChangeSet(input,{userId:USER,triggerEventId:'b_root'})).toMatchObject({status:'conflicted',reason:'conflicted_input'})
    expect(store.counts(USER).goals).toBe(0)
    expect(inbox.acceptEvent(envelope('b_forged','接着说',{causation_id:'foreign_event'}),identity)).toMatchObject({status:'rejected',reason:'not_found'})
    inbox.acceptEvent(envelope('b_other_root','我想学习日语'),identity)
    const create={...input,idempotency_key:'create_valid'}
    expect(changes.commitChangeSet(create,{userId:USER,triggerEventId:'b_other_root'})).toMatchObject({status:'applied'})
    expect(changes.commitChangeSet({...create,idempotency_key:'create_duplicate'},{userId:USER,triggerEventId:'b_other_root'})).toMatchObject({status:'conflicted'})
    const goal=store.listGoals(USER).items[0]!
    inbox.acceptEvent(envelope('b_continue','每周学三次',{causation_id:'b_other_root'}),identity)
    expect(store.findInboxEvent(USER,'b_continue')?.goalId).toBe(goal.id)
    expect(store.inputVersion(goal.id)).toBe(2)
  } finally {store.close();rmSync(directory,{recursive:true,force:true})}
})
