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
  checks:z.array(z.object({kind:z.enum(['access','weather']),status:z.enum(['ok','risk','unknown']),summary:line(600),evidence,alertStatus:z.enum(['clear','risk','unknown']).optional(),alertEvidence:evidence.optional()}).strict()).max(2),
 }).strict()).max(3),nextStep:line(600),
}).strict()
export type RecommendationInput=z.infer<typeof RECOMMENDATION_INPUT>
export interface Recommendation {
 version:1;kind:'hiking'|'general';status:'ready'|'partial'|'unavailable';title:string;summary:string;timeWindow?:string;constraints:string[];
 options:{id:string;title:string;reason:string;status:'recommended'|'conditional'|'excluded';conditions:string[];unknowns:string[];
 facts:{label:string;value:string;sourceIds:string[]}[];checks:{kind:'access'|'weather';status:'ok'|'risk'|'unknown';summary:string;sourceIds:string[]}[];sourceIds:string[]}[];
 sources:ResearchSource[];retrievedAt:string;validUntil:string;nextStep:string
}
// Government publishers and the national meteorological center are known first-party sources.
// Unknown operator domains stay unknown; a source calling itself official is insufficient.
const primary=(source:ResearchEvidence)=>{const host=new URL(source.url).hostname.toLowerCase();return /(?:^|\.)gov(?:\.(?:cn|hk|mo|uk|au|nz|sg))?$/.test(host)||host==='nmc.cn'||host.endsWith('.nmc.cn')}
const noActiveAlert=(quote:string)=>/当前(?:暂无|没有|无|未发布).{0,30}(?:预警|警报)|(?:暂无|没有|无).{0,20}(?:生效|有效|正在生效).{0,20}(?:预警|警报)|no\s+(?:active|current)\s+(?:weather\s+)?(?:warnings?|alerts?)/i.test(quote)
/** Research is an informational action; it is distinct from carrying out the physical activity. */
export function isResearchTaskContent(content:string):boolean {
 if(/(?:完成|走完|进行|参加|出发|攀登|去爬|去登).*(?:徒步|路线|登山|公园)|\b(?:complete|finish|go|do)\b.{0,30}\b(?:hike|walk|climb|trail)\b/i.test(content))return false
 return /研究|查询|查天气|比较|(?:安排|规划|决定|挑选|选择|推荐).*(?:徒步|目的地|路线|去哪里)|\bresearch\b|\brecommend\b|\bcheck (?:the )?weather\b|\bplan\b.{0,40}\b(?:route|hike|weekend)\b/i.test(content)
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
 const options:Recommendation['options']=input.options.map((option,optionIndex)=>{
  if(new Set(option.checks.map(c=>c.kind)).size!==option.checks.length)throw Error('recommendation checks must be unique')
  const optionSources=new Set<string>()
  let uncertain=false
  const facts=option.facts.map((fact,factIndex)=>{
   const sources=refs(fact.evidence);sources.forEach(s=>optionSources.add(s.id))
   const numbers=(value:string)=>[...value.matchAll(/\d+(?:\.\d+)?/g)].map(match=>Number(match[0]))
   const quotedNumbers=numbers(fact.evidence.map(e=>e.quote).join(' '))
   const unsupported=[...new Set(numbers(fact.value).filter(value=>!quotedNumbers.includes(value)))]
   if(unsupported.length)throw Error(`precise recommendation fact is not supported by its quote: options[${optionIndex}] (${option.id}).facts[${factIndex}] ${JSON.stringify(fact.label)}; unsupported numbers: ${unsupported.join(', ')}. Remove this fact or add exact quotes containing these numbers; move unverified details to this option’s unknowns. Keep the full recommendation object and all other required fields unchanged when resubmitting.`)
   if(sources.some(s=>Date.parse(s.expiresAt)<=now))uncertain=true
   return {label:fact.label,value:fact.value,sourceIds:[...new Set(sources.map(s=>s.id))]}
  })
  const checks=option.checks.map(check=>{
   const sources=refs(check.evidence);sources.forEach(s=>optionSources.add(s.id))
   if(sources.some(s=>Date.parse(s.expiresAt)<=now))uncertain=true
   // A search excerpt is discovery evidence. Safety decisions require a fetched page for that purpose.
   const valid=sources.length>0&&sources.every(s=>s.fetched&&s.purpose===check.kind&&Date.parse(s.expiresAt)>now
    &&(check.kind!=='weather'||!s.publishedAt||Date.parse(s.publishedAt)>=now-36*3600_000&&Date.parse(s.publishedAt)<=now+300_000))
   let status=check.status==='ok'&&!valid?'unknown' as const:check.status
   let summary=check.summary
   const alertSources=refs(check.alertEvidence??[]);alertSources.forEach(s=>optionSources.add(s.id))
   if(alertSources.some(s=>Date.parse(s.expiresAt)<=now))uncertain=true
   if(input.kind==='hiking'&&check.kind==='access'&&status==='ok'&&!sources.every(primary)){
    status='unknown';summary='尚未取得可确认的官方开放与预约依据；第三方资料仅供参考。'
   }
   if(input.kind==='hiking'&&check.kind==='weather'){
    const alertClear=check.alertStatus==='clear'&&alertSources.length>0&&alertSources.every((s,index)=>s.fetched&&primary(s)
      &&['alerts','weather'].includes(s.purpose)&&Date.parse(s.expiresAt)>now
      &&(!s.publishedAt||Date.parse(s.publishedAt)>=now-36*3600_000&&Date.parse(s.publishedAt)<=now+300_000)
      &&noActiveAlert(check.alertEvidence![index]!.quote))
    if(check.alertStatus==='risk'){status='risk';summary='当前气象警报或天气风险未排除，暂不安排该路线。'}
    else if(status==='ok'&&(!sources.every(primary)||!alertClear)){
     status='unknown';summary='预报资料不能单独确认当前警报状态；官方天气与有效警报仍需核实。'
    }
   }
   if(status==='unknown'&&check.status==='ok'&&summary===check.summary)summary='此项依据尚未满足当前有效性要求，仍需核实。'
   return {kind:check.kind,status,summary,sourceIds:[...new Set([...sources,...alertSources].map(s=>s.id))]}
  })
  const risk=checks.some(c=>c.status==='risk')
  const checked=checks.every(check=>check.status==='ok')&&(input.kind!=='hiking'||['access','weather'].every(kind=>checks.some(c=>c.kind===kind&&c.status==='ok')))
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
