/** Model content is useful only with the host's actual, scoped retrieval evidence. */
import { z } from 'zod'
import type { ResearchScope, ResearchStore, ResearchSource, ResearchEvidence } from './research-store.ts'
const line=(max:number)=>z.string().trim().min(1).max(max)
const lines=z.array(line(300)).max(12)
const evidence=z.array(z.object({sourceId:line(96),quote:line(1500)}).strict()).max(8)
export const RECOMMENDATION_INPUT = z.object({
 kind:z.enum(['hiking','general']), title:line(120),summary:line(1200),timeWindow:line(240).optional(),constraints:lines,
 options:z.array(z.object({id:line(96).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),title:line(120),reason:line(600),conditions:lines,unknowns:lines,
  facts:z.array(z.object({label:line(80),value:line(300),evidence:evidence.min(1)}).strict()).max(16),
  checks:z.array(z.object({kind:z.enum(['access','weather']),status:z.enum(['ok','risk','unknown']),summary:line(600),evidence}).strict()).max(2),
 }).strict()).max(3),nextStep:line(600),
}).strict()
export type RecommendationInput=z.infer<typeof RECOMMENDATION_INPUT>
export interface Recommendation {
 version:1;kind:'hiking'|'general';status:'ready'|'partial'|'unavailable';title:string;summary:string;timeWindow?:string;constraints:string[];
 options:{id:string;title:string;reason:string;status:'recommended'|'conditional'|'excluded';conditions:string[];unknowns:string[];
 facts:{label:string;value:string;sourceIds:string[]}[];checks:{kind:'access'|'weather';status:'ok'|'risk'|'unknown';summary:string;sourceIds:string[]}[];sourceIds:string[]}[];
 sources:ResearchSource[];retrievedAt:string;validUntil:string;nextStep:string
}
const normalized=(text:string)=>text.normalize('NFKC').replace(/\s+/g,' ').trim()
export function recommendation(store:ResearchStore,scope:ResearchScope,input:RecommendationInput,now=Date.now()):Recommendation {
 const used=new Map<string,ResearchEvidence>()
 const refs=(items:{sourceId:string;quote:string}[])=>items.map(item=>{
  const source=store.get(scope,item.sourceId)
  if(!source)throw Error('recommendation source outside this research scope')
  if(!normalized(source.content).includes(normalized(item.quote)))throw Error('recommendation quote not found in retrieved evidence')
  used.set(source.id,source);return source
 })
 if(new Set(input.options.map(o=>o.id)).size!==input.options.length)throw Error('recommendation option ids must be unique')
 const options:Recommendation['options']=input.options.map(option=>{
  if(new Set(option.checks.map(c=>c.kind)).size!==option.checks.length)throw Error('recommendation checks must be unique')
  const optionSources=new Set<string>()
  let uncertain=false
  const facts=option.facts.map(fact=>{
   const sources=refs(fact.evidence);sources.forEach(s=>optionSources.add(s.id))
   const numbers=(value:string)=>[...value.matchAll(/\d+(?:\.\d+)?/g)].map(match=>Number(match[0]))
   const quotedNumbers=numbers(fact.evidence.map(e=>e.quote).join(' '))
   if(numbers(fact.value).some(value=>!quotedNumbers.includes(value)))throw Error('precise recommendation fact is not supported by its quote')
   if(sources.some(s=>Date.parse(s.expiresAt)<=now))uncertain=true
   return {label:fact.label,value:fact.value,sourceIds:[...new Set(sources.map(s=>s.id))]}
  })
  const checks=option.checks.map(check=>{
   const sources=refs(check.evidence);sources.forEach(s=>optionSources.add(s.id))
   // A search excerpt is discovery evidence. Safety decisions require a fetched page for that purpose.
   const valid=sources.length>0&&sources.every(s=>s.fetched&&s.purpose===check.kind&&Date.parse(s.expiresAt)>now
    &&(check.kind!=='weather'||!s.publishedAt||Date.parse(s.publishedAt)>=now-36*3600_000&&Date.parse(s.publishedAt)<=now+300_000))
   return {kind:check.kind,status:check.status==='ok'&&!valid?'unknown' as const:check.status,
    summary:check.summary,sourceIds:[...new Set(sources.map(s=>s.id))]}
  })
  const risk=checks.some(c=>c.status==='risk')
  const checked=input.kind!=='hiking'||['access','weather'].every(kind=>checks.some(c=>c.kind===kind&&c.status==='ok'))
  const status=risk?'excluded' as const:checked&&!uncertain&&optionSources.size>0&&option.unknowns.length===0?'recommended' as const:'conditional' as const
  return {id:option.id,title:option.title,reason:option.reason,status,conditions:option.conditions,unknowns:option.unknowns,facts,checks,sourceIds:[...optionSources]}
 })
 if(used.size>30)throw Error('too many recommendation sources')
 const sources=[...used.values()].map(({id,title,url,retrievedAt,expiresAt,publishedAt})=>({id,title,url,retrievedAt,expiresAt,...(publishedAt?{publishedAt}:{})}))
 const validUntil=sources.length?new Date(Math.min(...sources.map(s=>Date.parse(s.expiresAt)))).toISOString():new Date(now).toISOString()
 return {version:1,kind:input.kind,status:options.some(o=>o.status==='recommended')?'ready':sources.length&&options.some(o=>o.status==='conditional')?'partial':'unavailable',
  title:input.title,summary:input.summary,...(input.timeWindow?{timeWindow:input.timeWindow}:{}),constraints:input.constraints,options,sources,
  retrievedAt:new Date(now).toISOString(),validUntil,nextStep:input.nextStep}
}
