/** Civil-time review opportunities, not clinical rules or evidence of a new observation. */
import type { HealthSummaryRow } from './store.ts'
import { nextDailyTime } from './task-schedule.ts'

export const HEALTH_DAILY_DDL = `
CREATE TABLE IF NOT EXISTS health_review_schedule (
 goal_id TEXT PRIMARY KEY REFERENCES goal(id), user_id TEXT NOT NULL, input_version INTEGER NOT NULL,
 timezone TEXT NOT NULL, next_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS health_daily_review (
 event_id TEXT PRIMARY KEY REFERENCES health_dispatch(event_id), timezone TEXT NOT NULL, local_date TEXT NOT NULL,
 scheduled_at TEXT NOT NULL
);
`
export interface DailyHealthReview { timezone: string; localDate: string; scheduledAt: string }
export function healthLocalDate(at: string | number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at))
}
export function healthTimezone(summaries: readonly HealthSummaryRow[]): string | undefined {
  for (const row of [...summaries].sort((a,b) => Date.parse(b.metricVersion) - Date.parse(a.metricVersion))) {
    if(!row.timezone)continue
    try { healthLocalDate(Date.now(), row.timezone); return row.timezone } catch { /* Invalid source zone cannot become a host-local clock. */ }
  }
  return undefined
}
function defaultWallTime(now: number, timezone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(now)).map(({type,value}) => [type,Number(value)]))
  const target = Date.UTC(parts.year!,parts.month!-1,parts.day!,9)
  let instant = target
  for(let attempt=0;attempt<3;attempt++) {
    const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'})
      .formatToParts(new Date(instant)).map(({type,value})=>[type,Number(value)]))
    instant += target-Date.UTC(p.year!,p.month!-1,p.day!,p.hour!,p.minute!,p.second!)
  }
  return new Date(instant).toISOString()
}
/** Prefer a Worker-selected next-day instant; otherwise use the observed wake clock, then 09:00 local.
 * Neither default asserts that the user woke then or authorizes a notification. */
export function nextHealthReviewAt(summaries: readonly HealthSummaryRow[], timezone: string, now: number, requested?: string): string {
  if(requested) {
    const at=Date.parse(requested)
    if(!Number.isFinite(at)||at<=now||at>now+48*3600_000||healthLocalDate(at,timezone)<=healthLocalDate(now,timezone))
      throw new Error('next_review_at must be a future next-local-day review within 48 hours')
    return new Date(at).toISOString()
  }
  const sleep=summaries.find(row=>row.type==='sleep'&&row.availability==='ok')
  const context=sleep?.context
  const wake=context?.windowDays===7?context.latestWakeAt:undefined
  const anchor=wake&&Date.parse(wake)<=now?new Date(Date.parse(wake)+30*60_000).toISOString():defaultWallTime(now,timezone)
  return nextDailyTime(new Date(now).toISOString(),timezone,now,anchor)
}
