/** Opt-in real inference against isolated Runtime/SQLite/tools. Never uses a formal phone or cloud workspace. */
import { expect,it,vi } from 'vitest'
import { readFileSync,writeFileSync,mkdirSync,statSync } from 'node:fs'
import { resolve,dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { startRuntime,type Host } from './fixtures/host.ts'
import { alongKind } from '../src/sources/along.ts'
import { composeAlongPrompt } from '../src/app/along-prompts.ts'
import { defaultPrompts } from '../src/app/prompts.ts'
import { bundledSkills } from '../src/app/skill-files.ts'

const enabled=process.env.ALONG_LIVE_HEALTH_EVAL==='1'
it.skipIf(!enabled)('uses actual model decisions on synthetic health scenarios and saves only scoped durable outcomes',async()=>{
 const envPath=process.env.ALONG_LIVE_HEALTH_ENV_FILE
 if(!envPath)throw new Error('Provide an existing owner-only test provider env file; never put credentials in arguments or fixtures')
 if((statSync(envPath).mode&0o077)!==0)throw new Error('Test credential file must be owner-only')
 const env:Record<string,string>={}
 for(const line of readFileSync(envPath,'utf8').split('\n')) {
  const match=/^(MEMORY_LLM_[A-Z_]+)=(.*)$/.exec(line)
  if(match)env[match[1]!]=match[2]!.trim().replace(/^(['"])(.*)\1$/,'$2')
 }
 const base=new URL(env.MEMORY_LLM_BASE_URL!),key=env.MEMORY_LLM_API_KEY,model=env.MEMORY_LLM_MODEL
 if(base.protocol!=='https:'||base.search||base.username||base.password||!key||!model)throw new Error('Test model configuration is incomplete or unsafe')
 const endpoint=base.href.replace(/\/$/,'')+'/chat/completions'
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/proactive-health-quality.json',import.meta.url),'utf8'))
 const system=composeAlongPrompt(defaultPrompts(),{role:'worker',via:'health'})+'\n\n'+
   [bundledSkills.alongGoal,bundledSkills.alongTask,bundledSkills.alongHealth,bundledSkills.alongScheduling]
     .map(skill=>'## Loaded skill '+skill.name+'\n'+skill.content).join('\n\n')
 const output=resolve(process.env.ALONG_LIVE_HEALTH_OUTPUT??'.artifacts/proactive-health-live.json')
 const report:any={kind:'real-model-isolated-runtime-fixtures',model,apiHost:base.hostname,promptSha256:createHash('sha256').update(system).digest('hex'),
   boundary:'Actual inference + current registered Along tools/SQLite; fixture DSH transport. Not a production phone, notification delivery, cloud deployment or complete DSH adapter validation.',cases:[]}
 mkdirSync(dirname(output),{recursive:true})
 const save=()=>writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600})
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(fixture.now))
 try {
  const selected=(process.env.ALONG_LIVE_HEALTH_CASES??'').split(',').filter(Boolean)
  for(const scenario of fixture.cases.filter((item:any)=>!selected.length||selected.includes(item.id))) {
   let host:Host|undefined
   const result:any={id:scenario.id,rubric:scenario.reviewRubric,requests:0,usage:[],tools:[]}
   report.cases.push(result)
   try {
    const userId='u_quality_'+scenario.id.replaceAll('-','_'),deviceId='d_quality'
    host=await startRuntime(store=>store.saveSettings({...store.settings(),sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}},
      policy:{...store.settings().policy,sources:{along:{allowed:[{id:userId}],admission:{}}}}}))
    host.runtime.sources.register(alongKind)
    const settings=host.runtime.store.settings()
    host.runtime.store.saveSettings({...settings,eval:{...settings.eval,mode:'auto'},sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}},
      policy:{...settings.policy,sources:{along:{allowed:[{id:userId}],admission:{}}}}})
    const store=host.runtime.along!.service.alongStore;store.assertUser(userId,deviceId)
    const goal=store.insertGoal({userId,domain:'custom'});store.appendGoalRevision({userId,goalId:goal.id,title:scenario.goal,status:'active',context:[]});store.ensureInputVersion(userId,goal.id)
    const originalText=scenario.goal+'\n明确要求：'+scenario.userConstraints.join('；')+'\n用户提供的情况：'+JSON.stringify(scenario.profile)
    expect(host.runtime.along!.service.acceptEvent({event_id:'quality_original',schema_version:'1',event_type:'along.user_message',goal_id:goal.id,
      occurred_at:fixture.now,timezone:fixture.timezone,payload:{event_type:'along.user_message',text:originalText}},{userId,deviceId})).toMatchObject({status:'accepted'})
    // This test exercises the automatic health Worker, not Router inference; prevent a second planning
    // fixture from competing with it. The original accepted user evidence remains in the business DB.
    store.markDelivered('along:'+userId+':quality_original',fixture.now)
    const fixed:Record<string,any>[]=[]
    for(const existing of scenario.existingTasks) {
      const task=store.insertTask({userId,goalId:goal.id,content:existing.content,scheduledAt:existing.trigger});store.appendTaskRevision({userId,taskId:task.id})
      fixed.push({id:task.id,content:task.content,scheduledAt:task.scheduledAt,status:task.status})
    }
    const sleep=scenario.sleep,observed=typeof sleep.observedAsleepMinutes==='number'
    const context=observed?{windowDays:7,daysWithData:0,averageThroughAt:'2026-11-23T10:00:00Z',latestWindowOpen:true,latestNightMinutes:sleep.observedAsleepMinutes,
      ...(sleep.observedAsleepBounds?{latestSleepStartAt:sleep.observedAsleepBounds[0],latestWakeAt:sleep.observedAsleepBounds[1]}:{})}:undefined
    expect(host.runtime.along!.service.acceptEvent({event_id:'quality_sleep',schema_version:'1',event_type:'along.health_summary_updated',occurred_at:fixture.now,timezone:fixture.timezone,
      payload:{event_type:'along.health_summary_updated',summaries:[{type:'sleep',metric_version:fixture.now,timezone:fixture.timezone,unit:'min',statistic:'night_sum',
        window:{start:'2026-11-23T10:00:00Z',end:'2026-11-24T10:00:00Z'},availability:observed?'ok':'unavailable',summarizer_version:'along-health-v1',
        ...(observed?{value:sleep.observedAsleepMinutes,context}:{})}]}},{userId,deviceId})).toMatchObject({status:'accepted'})
    await host.runtime.pump();await host.runtime.idle()
    const ticket=host.runtime.store.tickets.list().find(t=>t.mandate.basis.via==='health')!
    if(!ticket)throw new Error('No isolated health Worker dispatched')
    const worker='worker-'+ticket.id;await vi.waitFor(()=>expect(host!.tools.has(worker)).toBe(true),{timeout:10000})
    const dispatch=host.runtime.along!.healthFollowup.forTicket(ticket.id)!
    const allowed=new Set(['along_conversation_read','along_goal_read','along_task_list','along_health_read','along_changes_commit','along_task_update','along_task_cancel',
      'along_health_followup','along_execution_capabilities','along_memory_search','orchestrator_report'])
    const registered=[...host.tools.get(worker)!.values()].filter(tool=>allowed.has(tool.name))
      .map(tool=>tool as typeof tool&{description:string;parameters:Record<string,unknown>})
    const tools=registered.map(tool=>({type:'function',function:{name:tool.name,description:tool.description,
      parameters:tool.parameters}}))
    const messages:any[]=[{role:'system',content:system},{role:'user',content:host.runtime.store.triggers.get(ticket.origin.triggerId)!.text+
      '\nThis is an isolated synthetic acceptance scenario; tools and read data are authoritative. Execute the useful minimum review through the registered tools and finish it durably; do not send personal chat or invent observations. Only the test runtime is connected. The source timezone/current planning time is '+fixture.now+'.'}]
    for(let turn=0;turn<9;turn++) {
      const payload:any={model,messages,tools,tool_choice:'auto',stream:false,[env.MEMORY_LLM_OUTPUT_TOKEN_PARAMETER??'max_tokens']:3000}
      if(env.MEMORY_LLM_OMIT_TEMPERATURE!=='true')payload.temperature=0.2
      if(env.MEMORY_LLM_EXTRA_BODY)Object.assign(payload,JSON.parse(env.MEMORY_LLM_EXTRA_BODY))
      const response=await fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(60000)})
      result.requests++
      if(!response.ok)throw new Error('model_http_'+response.status)
      const data:any=await response.json(),message=data.choices?.[0]?.message
      result.usage.push(data.usage??{})
      if(!message)throw new Error('model_missing_message')
      messages.push({role:'assistant',content:message.content??null,...(message.tool_calls?{tool_calls:message.tool_calls}:{})})
      if(!message.tool_calls?.length){result.finalText=message.content;break}
      for(const call of message.tool_calls) {
        const name=call.function?.name
        let answer:any
        try {if(!allowed.has(name))throw new Error('tool_not_allowed');answer=await host.runTool(worker,name,JSON.parse(call.function.arguments))}
        catch(error){answer={error:error instanceof Error?error.message:'tool_failed'}}
        result.tools.push({name,args:JSON.parse(call.function.arguments||'{}'),result:answer})
        messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(answer)})
      }
      save()
      if(store.health.get(dispatch.eventId)?.result&&host.runtime.store.tickets.get(ticket.id)?.ended)break
    }
    result.assessment=store.health.get(dispatch.eventId)?.result
    result.tasks=store.listTasks(userId,{goalId:goal.id},{limit:100}).items
    result.nextReview=store.health.reviewSchedule(goal.id)
    result.fixedTasksPreserved=fixed.every(before=>{const after=store.getTask(userId,before.id);return after?.status===before.status&&after?.scheduledAt===before.scheduledAt})
    result.chatClean=store.conversationContextPage(userId,goal.id,undefined,100).items.every(message=>message.role==='user')
    result.durable=!!result.assessment
   }catch(error){result.error=error instanceof Error?error.message:'probe_failed'}
   finally {await host?.stop();save()}
  }
 }finally {vi.useRealTimers();save()}
 expect(report.cases.every((row:any)=>row.durable&&row.fixedTasksPreserved&&row.chatClean),JSON.stringify(report.cases.map((row:any)=>({id:row.id,error:row.error,durable:row.durable,fixedTasksPreserved:row.fixedTasksPreserved,chatClean:row.chatClean})))).toBe(true)
},600000)
