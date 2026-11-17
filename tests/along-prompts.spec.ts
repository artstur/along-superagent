/** Along prompt assembly runs through actual Sessions decoration; all identities, text and environment here are synthetic. */
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { alongPromptParts, alongPromptProvenance, composeAlongPrompt } from '../src/app/along-prompts.ts'
import { builtInParts, composePrompt, defaultPrompts, Prompts } from '../src/app/prompts.ts'
import { Sessions, type SessionsHost } from '../src/app/sessions.ts'
import { alongSkills, bundledSkills } from '../src/app/skill-files.ts'
import { Store } from '../src/app/store.ts'
import type { Ticket } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'

interface Skill { name:string;content:string;resourceBase?:{path:string} }
interface Section { name:string;order:number;complete?:boolean;interpolate?:boolean;text:(context:{signal?:AbortSignal})=>string }
const cleanups:(()=>void)[]=[]
afterEach(()=>{while(cleanups.length)cleanups.pop()!()})
async function decorated(options:{source?:string;via?:string;master?:boolean;alongOnly?:boolean}={}) {
 const dir=mkdtempSync(join(tmpdir(),'along-prompt-')),store=new Store(join(dir,'db'))
 cleanups.push(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
 const initial=store.settings()
 store.saveSettings({...initial,sources:{along:{enabled:true,config:{}},github:{enabled:options.alongOnly===false,config:{}}}})
 const config={...defaultPrompts(),scope:'REPOSITORY_SCOPE_SENTINEL',delivery:'REPOSITORY_DELIVERY_SENTINEL',
  skills:{'along-extra':'A discoverable custom Along capability.','release':'REPOSITORY_CUSTOM_SKILL','along-task':'SHADOW_BUILTIN'},
  overrides:{'runtime/worker':{text:'REPOSITORY_ROLE_SENTINEL'},'along/worker':{text:builtInParts()['along/worker'].text+'\nALONG_OVERRIDE_SENTINEL'}}}
 const prompts=new Prompts(store,()=>100_000,()=>[],()=>false)
 prompts.save(config,0,'panel')
 const actor={source:options.source??'along'}
 const ticket={id:'synthetic',mandate:{actor,basis:{via:options.via??'chat'},strength:'explicit'}} as unknown as Ticket
 const ctx=new Context(),agentCtx=new Context(),registered=new Map<string,Skill>()
 let section:Section|undefined
 agentCtx.reflect.provide('skills',{register:(s:Skill)=>{registered.set(s.name,s);return()=>registered.delete(s.name)}})
 agentCtx.reflect.provide('systemPrompt',{section:(s:Section)=>{section=s;return()=>{}}})
 agentCtx.reflect.provide('tools',{register:()=>()=>{},get:()=>undefined,restrict:()=>()=>{},guard:()=>()=>{}})
 const agent={id:options.master?'master':'worker-synthetic',status:'idle',ctx:agentCtx,session:{snapshotEvents:()=>[],header:{}}} as unknown as Agent
 const host={context:ctx,masterId:'master',lifetime:new AbortController().signal,closing:()=>false,
  store:{tickets:{get:()=>ticket},settings:()=>store.settings(),get:store.get.bind(store),set:store.set.bind(store),keys:store.keys.bind(store)},
  prompts,effects:{handle:()=>{},enqueue:()=>{},idle:()=>Promise.resolve(),pending:()=>false},health:{set:()=>{}},environment:vi.fn(()=>[]),tools:()=>[] } as unknown as SessionsHost
 const sessions=new Sessions(host);cleanups.push(()=>sessions.dispose())
 await sessions['decorate'](agent)
 return {store,prompts,config,agent,registered,section:section!,host}
}

it('actual Along Worker decoration selects only its business contract and registers capabilities without expanding their bodies',async()=>{
 const h=await decorated()
 const text=h.section.text({signal:new AbortController().signal})
 expect(h.section.complete).toBe(true)
 expect(text).toContain('ALONG_OVERRIDE_SENTINEL')
 for(const forbidden of ['REPOSITORY_SCOPE_SENTINEL','REPOSITORY_DELIVERY_SENTINEL','REPOSITORY_ROLE_SENTINEL','REPOSITORY_CUSTOM_SKILL','SHADOW_BUILTIN','Use gh for ALL','DSH_SUPERAGENT_DIR'])expect(text).not.toContain(forbidden)
 expect(h.host.environment).not.toHaveBeenCalled()
 for(const skill of alongSkills){
  expect(text).toContain(skill.name)
  expect(text).not.toContain(skill.content.trim())
  expect(h.registered.get(skill.name)?.content).toBe(skill.content)
  expect(readFileSync(join(h.registered.get(skill.name)!.resourceBase!.path,'SKILL.md'),'utf8')).toContain(skill.content)
 }
 expect([...h.registered.keys()]).toEqual(['dsh-superagent-along-extra',...alongSkills.map(s=>s.name)])
 expect(h.registered.get(bundledSkills.alongTask.name)?.content).not.toBe('SHADOW_BUILTIN')
 expect(text).toContain('dsh-superagent-along-extra')
 expect(h.store.get(KV.sessions.prompts(h.agent.id))).toEqual([1])
 expect(h.store.get(`session-along-prompt:${h.agent.id}`)).toEqual({revision:1,...alongPromptProvenance(h.config,{role:'worker',via:'chat'})})
 const set=vi.spyOn(h.host.store,'set')
 h.section.text({signal:new AbortController().signal})
 expect(set).not.toHaveBeenCalled() // unchanged request neither churns revision nor provenance
 const original=bundledSkills.alongCalculation.content
 try {
  bundledSkills.alongCalculation.content+='\nSynthetic changed arithmetic instruction.'
  h.section.text({signal:new AbortController().signal})
  expect(set).toHaveBeenCalledTimes(1) // a skill-only package update changes provenance even if index/role text is identical
  const updated=h.store.get<{sha256:string;skills:{name:string;sha256:string}[]}>(`session-along-prompt:${h.agent.id}`)!
  expect(updated.sha256).toBe(alongPromptProvenance(h.config,{role:'worker',via:'chat'}).sha256)
  expect(updated.skills).toEqual(alongPromptProvenance(h.config,{role:'worker',via:'chat'}).skills)
 } finally {bundledSkills.alongCalculation.content=original}

})

it.each(['task_due','health','scheduled'])('selects exactly the %s addon on real automatic Worker decoration',async via=>{
 const h=await decorated({via,...via==='scheduled'?{source:'along-maintenance'}:{}}),text=h.section.text({})
 const names=alongPromptParts(h.config,{role:'worker',via}).map(p=>p.key)
 const expected=via==='task_due'?'task-due':via==='scheduled'?'maintenance':'health'
 expect(names).toEqual(['along/shared','along/worker','along/'+expected,'along/skill-index'])
 expect(text).toContain(builtInParts()[`along/${expected}`].text)
 for(const other of ['task-due','health','maintenance'] as const)if(other!==expected)expect(text).not.toContain(builtInParts()[`along/${other}`].text)
 expect(h.store.get(`session-along-prompt:${h.agent.id}`)).toBeUndefined() // preview is not a model request
})

it('Along-only Router routes with its own role and never inherits repository admission or delivery rules',async()=>{
 const h=await decorated({master:true}),text=h.section.text({signal:new AbortController().signal})
 expect(text).toContain('## Along Router')
 expect(text).not.toContain('## Along Worker')
 expect(text).not.toContain('REPOSITORY_')
 expect([...h.registered.keys()]).not.toContain('dsh-superagent-github')
})

it('generic repository Worker and mixed-source Router retain generic prompt composition and source skills',async()=>{
 for(const options of [{source:'github'}, {master:true,alongOnly:false}]){
  const h=await decorated(options),text=h.section.text({})
  expect(text).toContain('REPOSITORY_SCOPE_SENTINEL')
  expect(text).not.toContain('## Along authority and evidence')
  expect(h.section.complete).toBe(options.master===true?true:undefined)
  expect(h.registered.has('dsh-superagent-github')).toBe(true)
  expect(h.registered.has('dsh-superagent-along-calculation')).toBe(false)
 }
})

it('Along-specific override versions survive restart and cannot alter generic repository assembly',()=>{
 const dir=mkdtempSync(join(tmpdir(),'along-prompt-version-'));let store=new Store(join(dir,'db'))
 try{
  const prompts=new Prompts(store,()=>100_000,()=>[],()=>false),config=defaultPrompts(),generic=composePrompt(config,'worker')
  const changed=prompts.save({...config,overrides:{'along/worker':{text:'A SOURCE_OWNED_WORKER.'}}},0,'panel')
  expect(composeAlongPrompt(changed.config,{role:'worker'})).toContain('A SOURCE_OWNED_WORKER.')
  expect(composePrompt(changed.config,'worker')).toBe(generic)
  store.close();store=new Store(join(dir,'db'))
  const restored=new Prompts(store,()=>100_000,()=>[],()=>false).current()
  expect(alongPromptProvenance(restored.config,{role:'worker'})).toEqual(alongPromptProvenance(changed.config,{role:'worker'}))
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
})

it('hashes the assembled Along role and every skill independently; only the changed content affects its provenance',()=>{
 const config=defaultPrompts(),context={role:'worker' as const,via:'task_due'},text=composeAlongPrompt(config,context),proof=alongPromptProvenance(config,context)
 expect(proof.sha256).toBe(createHash('sha256').update(text).digest('hex'))
 expect(proof.characters).toBeLessThan(8500)
 const irrelevant={...config,delivery:'Different repository delivery',overrides:{'runtime/shared':{text:'repo-only'}}}
 expect(alongPromptProvenance(irrelevant,context)).toEqual(proof)
 expect(alongPromptProvenance({...config,overrides:{'along/task-due':{text:'changed task occurrence contract'}}},context).sha256).not.toBe(proof.sha256)
 expect(proof.skills).toHaveLength(7)
})

it('committed fixture is real source assembly, not a copied or historical model prompt',()=>{
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/along-prompt-provenance.json',import.meta.url),'utf8')) as Record<string,unknown>
 expect(fixture).toEqual({kind:'synthetic-source-assembly',...alongPromptProvenance(defaultPrompts(),{role:'worker',via:'task_due'})})
 const sample=readFileSync(new URL('../docs/along/fixtures/worker-task-due.txt',import.meta.url),'utf8')
 expect(sample).toBe(composeAlongPrompt(defaultPrompts(),{role:'worker',via:'task_due'})+'\n')
})

it('DSH actual assembly keeps the complete Along section over the coding persona while retaining registered tool definitions',async()=>{
 const h=await decorated({via:'task_due'}),ctx=new Context()
 try{
  await ctx.plugin(SystemPrompt,{personaPrefix:'REPOSITORY_PERSONA_SENTINEL'})
  ctx.systemPrompt.section(h.section)
  ctx.systemPrompt.tools(()=>({schemas:[{name:'synthetic_bound_tool',description:'A retained tool protocol.',parameters:{type:'object',properties:{}}}]}))
  const assembled=await ctx.systemPrompt.assemble({signal:new AbortController().signal})
  expect(assembled.sections).toHaveLength(1)
  expect(assembled.sections[0]!.text).toBe(h.section.text({}))
  expect(assembled.sections[0]!.text).not.toContain('REPOSITORY_PERSONA_SENTINEL')
  expect(assembled.tools.map(tool=>tool.name)).toContain('synthetic_bound_tool')
  expect(assembled.sections[0]!.text).toContain('along_task_context')
  expect(assembled.sections[0]!.text).toContain('orchestrator_report')
 }finally{await ctx.fiber.dispose()}
})
