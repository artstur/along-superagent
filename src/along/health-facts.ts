/** Fact freshness and noise filtering shared by scheduling and the final write guard. */
import { isDeepStrictEqual } from 'node:util'
import type { HealthSummaryRow } from './store.ts'
const thresholds:Record<string,number>={steps:500,workout:5,active_energy:50,weight:0.1,resting_heart_rate:3,wrist_temperature:0.1,sleep:15}
export const healthFactTypes:readonly string[]=Object.keys(thresholds)
export function healthSummaryIsCurrent(s:HealthSummaryRow,now=Date.now()):boolean {
  if(s.summarizerVersion!=='along-health-v1')return true
  const end=Date.parse(s.windowEnd??'')
  if(['steps','workout','active_energy'].includes(s.type))return end>now
  if(s.type==='sleep')return end>now-36*3600_000
  if(s.type==='resting_heart_rate')return s.availability!=='ok'||end>now-7*86400_000
  if(s.type==='wrist_temperature')return s.availability!=='ok'||end>now-30*86400_000
  return true
}
export function significantHealthChange(current:HealthSummaryRow,previous?:HealthSummaryRow):boolean {
  const comparable=(s:HealthSummaryRow)=>[s.type,s.windowStart,s.windowEnd,s.timezone,s.unit,s.statistic,s.summarizerVersion]
  if(!previous||!isDeepStrictEqual(comparable(current),comparable(previous))||current.availability!==previous.availability||!isDeepStrictEqual(current.context,previous.context))return true
  return current.availability==='ok'&&typeof current.value==='number'&&typeof previous.value==='number'&&
    Math.abs(current.value-previous.value)+1e-9>=(thresholds[current.type]??0)
}
/** A pure timestamp refresh does not invalidate work; corrected relevant observations do. */
export function healthSnapshotSuperseded(current:readonly HealthSummaryRow[],read:readonly HealthSummaryRow[],watched:readonly string[],initial:readonly HealthSummaryRow[]=[]):boolean {
  for(const type of watched) {
    const before=[...read,...initial].find(row=>row.type===type&&row.adapter==='known'&&row.summarizerVersion==='along-health-v1')
    const latest=current.find(row=>row.type===type&&row.adapter==='known'&&row.summarizerVersion==='along-health-v1')
    if(before&&!healthSummaryIsCurrent(before))return true
    if(latest&&healthSummaryIsCurrent(latest)&&significantHealthChange(latest,before))return true
  }
  return false
}
