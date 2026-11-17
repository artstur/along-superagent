import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { AlongStore } from '../src/along/store.ts'
import { AlongService } from '../src/along/service.ts'
import { createInbox } from '../src/along/inbox.ts'
import { createChangeSetModule, type CommitScope } from '../src/along/changeset.ts'
import { alongTools } from '../src/along/tools.ts'
import { WORK_TOOLS } from '../src/app/sessions.ts'

const user='u_sources',device='d_sources'
const dirs:string[]=[],stores:AlongStore[]=[]
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true})})
function setup(domain:'custom'|'health'='custom') {
  const dir=mkdtempSync(join(tmpdir(),'along-sources-'));dirs.push(dir)
  const path=join(dir,'along.sqlite'),store=new AlongStore(path);stores.push(store);store.assertUser(user,device)
  const goal=store.insertGoal({userId:user,domain})
  store.appendGoalRevision({goalId:goal.id,userId:user,title:domain==='custom'?'复盘OKX交易':'每周运动',status:'active',
    ...(domain==='health'?{metric:{type:'workout',target:120,unit:'分钟',period:'week'}}:{})})
  store.ensureInputVersion(user,goal.id)
  const inbox=createInbox(store),service=new AlongService(store,{inbox,changeset:createChangeSetModule(store)})
  const say=(eventId:string,text='复盘我的OKX交易')=>inbox.acceptEvent({event_id:eventId,schema_version:'1',event_type:'along.user_message',
    goal_id:goal.id,occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text}},{userId:user,deviceId:device})
  say('initial')
  const scope:CommitScope={userId:user,allowedGoalId:goal.id,triggerEventId:'initial'}
  const tools=()=>alongTools({service,scopeFor:()=>scope},'ticket')
  const call=async(name:string,args:unknown={})=>{const tool=tools().find(t=>t.name===name);expect(tool, name).toBeDefined();return tool!.execute(tool!.schema.parse(args),new AbortController().signal)}
  const input=(sources:unknown[]= [{provider:'okx',reason:'读取此目标的交易与持仓历史'}])=>({base_revision:store.getGoal(user,goal.id)!.currentRevision,input_version:store.inputVersion(goal.id),sources})
  return {path,store,goal,say,scope,tools,call,input,service}
}

it('offers truthful official setup capabilities and registers them in Worker sessions',async()=>{
  const h=setup()
  expect(await h.call('along_data_sources_catalog')).toMatchObject({sources:expect.arrayContaining([
    expect.objectContaining({provider:'okx',name:'OKX',access:'native_read_only',url:'https://www.okx.com/account/my-api'}),
    expect.objectContaining({provider:'apple-health',access:'native_permission'})
  ])})
  expect(WORK_TOOLS).toContain('along_data_sources_catalog');expect(WORK_TOOLS).toContain('along_data_sources_recommend')
})

it('persists only this goal’s recommendations, syncs them, deduplicates retries and survives reopening',async()=>{
  const h=setup()
  expect((h.store.goalDetail(user,h.goal.id) as any).dataSources).toEqual([])
  expect(await h.call('along_data_sources_recommend',h.input())).toMatchObject({status:'recommended',reused:false})
  const expected=[{provider:'okx',status:'recommended',reason:'读取此目标的交易与持仓历史'}]
  expect((h.store.goalDetail(user,h.goal.id) as any).dataSources).toEqual(expected)
  expect(h.store.workspaceSync(user,0,200).items.at(-1)?.payload).toMatchObject({snapshot:{dataSources:expected}})
  const cursor=h.store.syncPage(user,0,200).items.at(-1)!.seq
  expect(await h.call('along_data_sources_recommend',h.input())).toMatchObject({status:'recommended',reused:true})
  expect(h.store.syncPage(user,cursor,200).items).toEqual([])
  expect((await h.call('along_goal_read') as any).data_sources).toEqual(expected)
  h.store.close();stores.splice(stores.indexOf(h.store),1)
  const reopened=new AlongStore(h.path);stores.push(reopened)
  expect((reopened.goalDetail(user,h.goal.id) as any).dataSources).toEqual(expected)
})

it('can replace and withdraw sources but never accept model URLs, connected claims, duplicate providers or foreign goal ids',async()=>{
  const h=setup();await h.call('along_data_sources_recommend',h.input())
  const tool=h.tools().find(t=>t.name==='along_data_sources_recommend')!
  for(const sources of [[{provider:'okx',reason:'r',url:'https://evil.example'}],[{provider:'okx',reason:'r',status:'connected'}],
    [{provider:'unknown',reason:'r'}],[{provider:'okx',reason:'r'.repeat(241)}],[{provider:'okx',reason:'r'},{provider:'okx',reason:'r'}]]) {
    expect(()=>tool.schema.parse(h.input(sources))).toThrow()
  }
  expect(()=>tool.schema.parse({...h.input(),goal_id:'foreign'})).toThrow()
  await h.call('along_data_sources_recommend',h.input([{provider:'apple-health',reason:'睡眠是本目标所需的数据'}]))
  expect((h.store.goalDetail(user,h.goal.id) as any).dataSources).toEqual([{provider:'apple-health',status:'recommended',reason:'睡眠是本目标所需的数据'}])
  await h.call('along_data_sources_recommend',h.input([]))
  expect((h.store.goalDetail(user,h.goal.id) as any).dataSources).toEqual([])
})

it('refuses superseded chats, stale goal/input versions, non-chat work, archived goals and foreign ownership',async()=>{
  const h=setup(),original=h.input()
  expect(await h.call('along_data_sources_recommend',{...original,base_revision:0})).toMatchObject({status:'conflicted',reason:'conflicted_revision'})
  expect(await h.call('along_data_sources_recommend',{...original,input_version:999})).toMatchObject({status:'conflicted',reason:'conflicted_input'})
  h.say('newer','改成另一个目标')
  expect(await h.call('along_data_sources_recommend',h.input())).toMatchObject({status:'conflicted',reason:'conflicted_input'})
  h.scope.triggerEventId=undefined
  await expect(h.call('along_data_sources_recommend',h.input())).rejects.toThrow('current user chat')
  h.scope.triggerEventId='newer';h.scope.userId='other'
  await expect(h.call('along_data_sources_recommend',h.input())).rejects.toThrow()
  expect((h.store.goalDetail(user,h.goal.id) as any).dataSources).toEqual([])
  h.scope.userId=user
  h.store.appendGoalRevision({goalId:h.goal.id,userId:user,title:'归档',status:'archived'})
  await expect(h.call('along_data_sources_recommend',h.input())).rejects.toThrow('active')
})

it('resolves the goal created by this original conversation without a caller-supplied goal id',async()=>{
  const h=setup();h.scope.allowedGoalId=undefined
  // The original event is already linked by the trusted receiver to this conversation's goal.
  expect(await h.call('along_data_sources_recommend',h.input())).toMatchObject({status:'recommended'})
  expect((h.store.goalDetail(user,h.goal.id) as any).dataSources[0].provider).toBe('okx')
})

it('allows recommendation after initial goal creation in the same goal-less chat',async()=>{
  const h=setup(),inbox=createInbox(h.store)
  expect(inbox.acceptEvent({event_id:'new_chat',schema_version:'1',event_type:'along.user_message',
    occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.user_message',text:'我希望看清我在OKX交易的情况'}},
    {userId:user,deviceId:device})).toMatchObject({status:'accepted'})
  h.scope.allowedGoalId=undefined;h.scope.triggerEventId='new_chat'
  expect(await h.call('along_changes_commit',{base_revision:0,input_version:1,idempotency_key:'create',reason:'建立交易复盘目标',
    ops:[{op:'goal.create',domain:'custom',title:'OKX交易复盘',context:[]}]})).toMatchObject({status:'applied'})
  expect(await h.call('along_data_sources_recommend',{base_revision:1,input_version:1,sources:[{provider:'okx',reason:'复盘需要成交历史'}]})).toMatchObject({status:'recommended'})
  const goal=h.store.conversationGoal(user,'new_chat')!
  expect((h.store.goalDetail(user,goal) as any).dataSources).toMatchObject([{provider:'okx'}])
})

it('migrates schema 8 without rewriting existing goals or personal conversations',()=>{
  const h=setup(),before=h.store.goalDetail(user,h.goal.id)
  h.store.close();stores.splice(stores.indexOf(h.store),1)
  const db=new DatabaseSync(h.path)
  db.exec("DROP TABLE goal_data_sources; UPDATE meta SET value='8' WHERE key='schema_version'");db.close()
  const migrated=new AlongStore(h.path);stores.push(migrated)
  expect(migrated.goalDetail(user,h.goal.id)).toEqual(before)
  expect(migrated.getMessage(user,`msg:${user}:initial`)?.text).toBe('复盘我的OKX交易')
})

it('projects Apple Health only for health goals or current semantically relevant watched types',()=>{
  const h=setup(),health=setup('health')
  expect((h.store.goalDetail(user,h.goal.id) as any).dataSources).toEqual([])
  expect((health.store.goalDetail(user,health.goal.id) as any).dataSources).toMatchObject([{provider:'apple-health',status:'recommended'}])
  const d=h.store.health.dispatch(user,h.goal.id,h.store.inputVersion(h.goal.id),[])
  h.store.health.finish(d,{outcome:'keep',types:['sleep'],reason:'睡眠与此目标相关'})
  expect((h.store.goalDetail(user,h.goal.id) as any).dataSources).toMatchObject([{provider:'apple-health'}])
  h.say('changed','只看投资，不关联健康')
  expect((h.store.goalDetail(user,h.goal.id) as any).dataSources).toEqual([])
})
