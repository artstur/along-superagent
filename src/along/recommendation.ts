/** Model content is useful only with the host's actual, scoped retrieval evidence. */
import { z } from 'zod'
import type { ResearchScope, ResearchStore, ResearchSource, ResearchEvidence } from './research-store.ts'
const line=(max:number)=>z.string().trim().min(1).max(max)
const lines=z.array(line(300)).max(12)
const evidence=z.array(z.object({sourceId:line(96),quote:line(1500)}).strict()).max(8)
export const RECOMMENDATION_INPUT = z.object({
 kind:z.enum(['hiking','general']), title:line(120).describe('One string, never an array of option titles.'),summary:line(1200),timeWindow:line(240).optional(),constraints:lines,
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
export const hikingIntent=(text:string):boolean=>/徒步|登山|爬山|\b(?:hiking|hike|trekking|trails?)\b/i.test(text)
/** Conservatively distinguish an information task from doing the physical activity. */
export function isResearchTaskContent(content:string):boolean {
 if(/(?:完成|走完|进行|参加|出发|攀登|去爬|去登).*(?:徒步|路线|登山|公园)|\b(?:complete|finish|go|do)\b.{0,30}\b(?:hike|walk|climb|trail)\b/i.test(content))return false
 return /研究|查询|查天气|比较|(?:安排|规划|决定|挑选|选择|推荐).*(?:徒步|目的地|路线|去哪里)|\bresearch\b|\brecommend\b|\bcheck (?:the )?weather\b|\bplan\b.{0,40}\b(?:route|hike|weekend)\b/i.test(content)
}
const normalized=(text:string)=>text.normalize('NFKC').replace(/\s+/g,' ').trim()
const weatherClauses=(quote:string)=>normalized(quote).split(/[，,。；;!?！？]/).filter(clause=>
 !noActiveAlert(clause)&&!/(?:没有|暂无|未见|未出现|未发布|未生效|不再|解除|取消|终止|失效)|无(?:明显|任何|持续)?(?:暴雨|雷暴|台风|雷电|大风|强风)|如果|假如|如遇|若遇|若有|若出现|若发布|一旦|倘若|当.{0,25}(?:预警|警报|暴雨|雷暴).{0,10}时|\b(?:no|not|without|if|would|cancelled|canceled|lifted|expired)\b/i.test(clause))
const activeAlert=(quote:string)=>weatherClauses(quote).some(clause=>/(?:当前|正在|现正).{0,35}(?:预警|警报)|(?:预警|警报).{0,25}(?:生效中|正在生效|已生效)|(?:已|正在)发布.{0,25}(?:预警|警报)|(?:current|active).{0,25}(?:warning|alert)/i.test(clause))
const severeWeather=(quote:string)=>weatherClauses(quote).some(clause=>/暴雨|雷暴|台风|雷电|大风|强风|极端高温|heavy rain|thunderstorm|typhoon|strong wind/i.test(clause))
const routeMeasure=(fact:{label:string;value:string},origins:ResearchEvidence[])=>/\d/.test(fact.value)&&origins.every(source=>source.purpose==='route')
 &&/距离|长度|里程|爬升|海拔|用时|耗时|distance|length|ascent|elevation|duration/i.test(fact.label)
 &&fact.value.replace(/全程|大约|约|总长|累计|往返|单程|上升|下降|爬升|海拔|高度|公里|千米|分钟|小时|米|hours?|minutes?|km|min|m|h|[0-9\s.,+~～–—/:;，。、()（）-]/gi,'')===''

const recentPublication=(source:ResearchEvidence,now:number)=>source.publicationBasis==='page'&&!!source.publishedAt&&Date.parse(source.publishedAt)>=now-36*3600_000&&Date.parse(source.publishedAt)<=now+300_000
const plainRouteTitle=(title:string)=>title.replace(/[（(【\[][^）)】\]]*(?:推荐|首选|备选|不建议|安全|优先)[^）)】\]]*[）)】\]]/g,'').replace(/^(?:推荐|首选|优先|安全路线)[:：]?\s*/,'').trim()||'待核实路线'
const needsProjection=(kind:Recommendation['kind'],options:Recommendation['options'])=>kind==='hiking'&&(!options.length||options.some(option=>option.status!=='recommended'))
/** Older clients receive the same conservative conclusion as the structured card. */
export function recommendationText(value:Recommendation|undefined,proposed:string):string {
 if(!value||!needsProjection(value.kind,value.options))return proposed
 return [value.summary,...value.options.map(option=>`${option.title}：${option.status==='excluded'?'暂不安排':option.status==='conditional'?'出行条件待核实':'现有条件已核对，出发前仍需复查'}`),value.nextStep].join('\n').slice(0,1200)
}
/** Notification routing uses task state and the original action, never the model’s notify label. */
export function recommendationNotice(value:Recommendation|undefined,task:{status:string;content:string}|undefined,originalContent=task?.content):'recommendation_ready'|'task_result'|undefined {
 if(!value||value.status==='unavailable')return undefined
 if(!task||task.status==='open')return 'recommendation_ready'
 return task.status==='done'&&!!originalContent&&isResearchTaskContent(originalContent)?'task_result':undefined
}
export function recommendation(store:ResearchStore,scope:ResearchScope,input:RecommendationInput,now=Date.now()):Recommendation {
 const kind=scope.requiredKind??input.kind
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
  const factSources:ResearchEvidence[][]=[]
  const facts=option.facts.map((fact,factIndex)=>{
   const sources=refs(fact.evidence);factSources.push(sources);sources.forEach(s=>optionSources.add(s.id))
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
   const primaryCurrent=sources.length>0&&valid&&sources.every(primary)
   if(kind==='hiking'&&check.kind==='access'&&status!=='unknown'&&!primaryCurrent){
    status='unknown';summary='尚未取得可确认的官方开放与预约依据；第三方或过期资料仅供参考。'
   }
   if(kind==='hiking'&&check.kind==='weather'){
    const validAlert=(source:ResearchEvidence)=>source.fetched&&primary(source)&&['alerts','weather'].includes(source.purpose)&&Date.parse(source.expiresAt)>now
    const alertClear=check.alertStatus==='clear'&&alertSources.length>0&&alertSources.every((source,index)=>validAlert(source)
      &&(!source.publishedAt||recentPublication(source,now))&&noActiveAlert(normalized(check.alertEvidence![index]!.quote))
      &&!activeAlert(check.alertEvidence![index]!.quote)&&!severeWeather(check.alertEvidence![index]!.quote)
      &&!/(?:雷暴|暴雨|台风|雷电|大风|强风|高温|thunderstorm|typhoon|heavy rain|strong wind)/i.test(check.alertEvidence![index]!.quote))
    const alertRisk=check.alertStatus==='risk'&&alertSources.length>0&&alertSources.every((source,index)=>validAlert(source)&&recentPublication(source,now)&&activeAlert(check.alertEvidence![index]!.quote))
    const forecastRisk=check.alertStatus!=='risk'&&check.status==='risk'&&primaryCurrent&&sources.every(source=>recentPublication(source,now))&&check.evidence.some(item=>severeWeather(item.quote))
    if(alertRisk||forecastRisk){status='risk';summary='已核实的气象警报或恶劣天气影响尚未排除，暂不安排该路线。'}
    else if(check.alertStatus==='risk'||status==='risk'||status==='ok'&&(!primaryCurrent||!alertClear)){
     status='unknown';summary='尚无可确认的当前天气与生效警报结论；第三方、日期不明的警报和普通预报不能证明当前风险或无警报。'
    }
   }
   if(status==='unknown'&&check.status!=='unknown'&&summary===check.summary)summary='此项依据尚未满足当前有效性要求，仍需核实。'
   return {kind:check.kind,status,summary,sourceIds:[...new Set([...sources,...alertSources].map(s=>s.id))]}
  })
  const risk=checks.some(c=>c.status==='risk')
  const checked=checks.every(check=>check.status==='ok')&&(kind!=='hiking'||['access','weather'].every(kind=>checks.some(c=>c.kind===kind&&c.status==='ok')))
  const removed:string[]=[]
  const retainedFacts=kind!=='hiking'?facts:facts.filter((fact,index)=>{
   const origins=factSources[index]!,label=fact.label+' '+fact.value
   const access=origins.some(source=>source.purpose==='access')||/开放|闭园|门票|费用|价格|预约|名额|通行|入园|open|close|admission|ticket|booking/i.test(label)
   const weather=origins.some(source=>['weather','alerts'].includes(source.purpose))||/警报|预警|天气|降雨|温度|风速|风力|alert|warning|weather|rain|temperature/i.test(label)
   const keep=origins.every(source=>source.fetched&&Date.parse(source.expiresAt)>now)
    &&(!access||origins.every(primary)&&checks.some(check=>check.kind==='access'&&check.status==='ok'))
    &&(!weather||origins.every(primary)&&checks.some(check=>check.kind==='weather'&&check.status==='ok'))
    &&(checks.some(check=>check.kind==='access'&&check.status==='ok')&&checks.some(check=>check.kind==='weather'&&check.status==='ok')||routeMeasure(fact,origins))
   if(!keep)removed.push(fact.label)
   return keep
  })
  const unknowns=removed.length?[`以下参数当前值尚未核实：${removed.join('、').slice(0,250)}`,...option.unknowns].slice(0,12):option.unknowns
  const status=risk?'excluded' as const:checked&&!uncertain&&optionSources.size>0&&unknowns.length===0?'recommended' as const:'conditional' as const
  const projected=kind==='hiking'&&status!=='recommended'
  return {id:option.id,title:projected?plainRouteTitle(option.title):option.title,
   reason:projected?(status==='excluded'?'有已核实的开放限制或天气风险，当前暂不安排；下方保留资料供比较。':'已保留路线资料供比较，关键出行条件仍待核实，当前不确认可出行。'):option.reason,
   status,conditions:projected?['出发前复查官方开放、预约、当地天气和生效警报','有警报或关键条件不明时选择室内活动或延期']:option.conditions,
   unknowns,facts:retainedFacts,checks,sourceIds:[...optionSources]}
 })
 if(used.size>30)throw Error('too many recommendation sources')
 const sources=[...used.values()].map(({id,title,url,retrievedAt,expiresAt,publishedAt})=>({id,title,url,retrievedAt,expiresAt,...(publishedAt?{publishedAt}:{})}))
 const validUntil=sources.length?new Date(Math.min(...sources.map(s=>Date.parse(s.expiresAt)))).toISOString():new Date(now).toISOString()
 const projected=needsProjection(kind,options)
 const summary=projected?`已整理${options.length}个路线候选供比较。${options.some(option=>option.status==='recommended')?'部分候选现有条件已核对，其余候选仍有待核实条件。':'目前尚不能确认户外出行条件。'}${options.some(option=>option.status==='excluded')?'有已核实限制或天气风险的候选暂不安排。':''}请结合下方事实、来源和未知项继续核对。`:input.summary
 const nextStep=projected?'出发前核实官方开放、预约、当地天气和当前生效警报。有警报或关键条件未确认时，选择室内活动或延期；条件核实后再安排徒步。':input.nextStep
 return {version:1,kind,status:options.some(o=>o.status==='recommended')?'ready':sources.length&&options.some(o=>o.status==='conditional')?'partial':'unavailable',
  title:projected?'徒步候选与出行条件':input.title,summary,...(input.timeWindow?{timeWindow:input.timeWindow}:{}),constraints:input.constraints,options,sources,
  retrievedAt:new Date(now).toISOString(),validUntil,nextStep}
}
