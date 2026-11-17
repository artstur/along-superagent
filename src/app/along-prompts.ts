/** Assembles the Along business role contract and discoverable skill index without repository delivery policy. */
import { createHash } from 'node:crypto'
import { builtInPart, SKILL_PREFIX, type PromptConfig } from './prompts.ts'
import { alongSkills } from './skill-files.ts'
export type AlongPromptRole = 'orchestrator'|'worker'
export interface AlongPromptContext { role:AlongPromptRole; via?:string }
/** Custom Along skills remain discoverable; a team's entry cannot replace a packaged capability silently. */
export function alongSkillDefinitions(config:PromptConfig) {
  return [...Object.entries(config.skills).filter(([name])=>name.startsWith('along-')&&!alongSkills.some(skill=>skill.name===`${SKILL_PREFIX}${name}`))
    .map(([name,content])=>({name:`${SKILL_PREFIX}${name}`,description:content.replace(/\s+/g,' ').slice(0,120)||'Custom dsh-superagent operational skill.',content})),...alongSkills]
}
/** Source keys are stable and independently overrideable through the existing versioned PromptConfig store. */
export function alongPromptParts(config:PromptConfig,context:AlongPromptContext) {
  const names=['shared',context.role,...context.role==='worker'&&context.via==='scheduled'?['maintenance']:
    context.role==='worker'&&context.via==='task_due'?['task-due']:
    context.role==='worker'&&context.via==='health'?['health']:[]]
  return [...names.map(name=>{
    const key=`along/${name}`
    return {key,text:config.overrides?.[key]?.text??builtInPart(key)!.text}
  }),{key:'along/skill-index',text:'## Along skills (load on demand)\n'+alongSkillDefinitions(config).map(s=>`- ${s.name}: ${s.description}`).join('\n')}]
}
export function composeAlongPrompt(config:PromptConfig,context:AlongPromptContext):string {
  return alongPromptParts(config,context).map(part=>part.text).join('\n\n')
}
/** Hash actual assembled text, not merely a source filename or configuration revision. No private context is returned. */
export function alongPromptProvenance(config:PromptConfig,context:AlongPromptContext) {
  const parts=alongPromptParts(config,context),text=parts.map(p=>p.text).join('\n\n')
  return {sha256:createHash('sha256').update(text).digest('hex'),characters:text.length,
    parts:parts.map(p=>({key:p.key,sha256:createHash('sha256').update(p.text).digest('hex')})),
    skills:alongSkillDefinitions(config).map(s=>({name:s.name,sha256:createHash('sha256').update(s.content).digest('hex')}))}
}
