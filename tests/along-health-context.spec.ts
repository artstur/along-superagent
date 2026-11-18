import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createInbox } from '../src/along/inbox.ts'
import { healthInterpretation } from '../src/along/health-context.ts'
import { AlongStore } from '../src/along/store.ts'
import { EventEnvelopeSchema } from '../src/along/envelope.ts'
import { significantHealthChange } from '../src/along/health.ts'
const summary = { type:'sleep',metric_version:'2026-11-18T04:00:00Z',unit:'min',statistic:'night_sum',
 window:{start:'2026-11-17T10:00:00Z',end:'2026-11-18T10:00:00Z'},timezone:'Asia/Shanghai',value:420,availability:'ok',summarizer_version:'along-health-v1' }
const context = {windowDays:7,daysWithData:5,averageThroughAt:'2026-11-17T10:00:00Z',latestWindowOpen:true,
 latestNightMinutes:420,averageMinutes:420,latestSleepStartAt:'2026-11-17T17:00:00Z',latestWakeAt:'2026-11-18T00:00:00Z'} as const
it('retains only validated aggregate sleep context without treating the statistics window as the observed sleep interval',()=>{
 const result=EventEnvelopeSchema.safeParse({schema_version:'1',event_id:'sleep_context',event_type:'along.health_summary_updated',occurred_at:summary.metric_version,
 timezone:summary.timezone,payload:{event_type:'along.health_summary_updated',summaries:[{...summary,context}]}})
 expect(result.success).toBe(true)
 if(result.success&&result.data.payload.event_type==='along.health_summary_updated') expect(result.data.payload.summaries[0]).toMatchObject({context})
})
it('reassesses observed timing changes even when the scalar duration is identical',()=>{
 const row={id:'h',userId:'u',type:'sleep',metricVersion:summary.metric_version,windowStart:summary.window.start,windowEnd:summary.window.end,
 timezone:summary.timezone,unit:'min',statistic:'night_sum',value:420,availability:'ok' as const,summarizerVersion:'along-health-v1',adapter:'known' as const,eventId:'e',receivedAt:summary.metric_version,superseded:false,context}
 expect(significantHealthChange({...row,context:{...context,latestSleepStartAt:'2026-11-17T19:00:00Z',latestWakeAt:'2026-11-18T02:00:00Z'}},row)).toBe(true)
 expect(significantHealthChange({...row,metricVersion:'2026-11-18T05:00:00Z'},row)).toBe(false)
})

function wire(row: unknown = { ...summary, context }) {
  return { schema_version: '1', event_id: 'aggregate_context', event_type: 'along.health_summary_updated',
    occurred_at: summary.metric_version, timezone: summary.timezone,
    payload: { event_type: 'along.health_summary_updated', summaries: [row] } }
}
it.each([
  { ...summary, context: { ...context, samples: [{ start: 'private' }] } },
  { ...summary, context: { ...context, user_id: 'foreign' } },
  { ...summary, type: 'steps', unit: 'count', context },
  { ...summary, summarizer_version: 'unknown-producer', context },
  { ...summary, context: { ...context, latestWakeAt: '2026-11-18T05:00:00Z' } },
  { ...summary, context: { ...context, latestSleepStartAt: '2026-11-16T09:00:00Z' } },
  { ...summary, context: { ...context, latestSleepStartAt: '2026-11-18T01:00:00Z' } },
  { ...summary, context: { ...context, latestNightMinutes: 1441 } },
])('rejects invalid/unbounded aggregate context before any business state is written', row => {
  expect(EventEnvelopeSchema.safeParse(wire(row)).success).toBe(false)
})
it('keeps old scalar-only wires valid and observed bounds separate from aggregation and civil interpretation', () => {
  expect(EventEnvelopeSchema.safeParse(wire(summary)).success).toBe(true)
  const previousEvening = { ...context, latestSleepStartAt: '2026-11-17T15:00:00Z' }
  expect(EventEnvelopeSchema.safeParse(wire({ ...summary, context: previousEvening })).success).toBe(true)
  expect(new Intl.DateTimeFormat('en-GB', { timeZone: summary.timezone, hour: '2-digit', hourCycle: 'h23' })
    .format(new Date(previousEvening.latestSleepStartAt))).toBe('23')
  const interpretation = healthInterpretation('sleep')!.join(' ')
  expect(interpretation).toContain('duration')
  expect(interpretation).toContain('fragmented')
  expect(interpretation).toContain('full night across midnight')
  expect(interpretation).toContain('unknown')
})
it('persists validated context per user and migrates a scalar schema15 row without changing original fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-context-migration-'))
  const file = join(dir, 'along.sqlite')
  try {
    const store = new AlongStore(file)
    store.assertUser('u_context', 'd_context')
    const inbox = createInbox(store)
    expect(inbox.acceptEvent(wire(), { userId: 'u_context', deviceId: 'd_context' })).toMatchObject({ status: 'accepted' })
    expect(store.latestHealthSummaries('u_context')[0]).toMatchObject({ value: 420, context })
    expect(store.latestHealthSummaries('foreign')).toEqual([])
    store.close()
    const raw = new DatabaseSync(file)
    raw.exec('ALTER TABLE health_summary DROP COLUMN context')
    raw.exec("UPDATE meta SET value='15' WHERE key='schema_version'")
    const before = raw.prepare('SELECT * FROM health_summary').all()
    raw.close()
    const migrated = new AlongStore(file)
    expect(migrated.latestHealthSummaries('u_context')[0]?.value).toBe(420)
    expect(migrated.latestHealthSummaries('u_context')[0]?.context).toBeUndefined()
    migrated.close()
    const checked = new DatabaseSync(file)
    expect(checked.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value).toBe('16')
    const columns = Object.keys(before[0]!).map(key => '"' + key + '"').join(',')
    expect(checked.prepare('SELECT ' + columns + ' FROM health_summary').all()).toEqual(before)
    checked.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// Exact labels emitted by HealthKitReader.activityName (Client main1601858), plus its numeric fallback.
it.each(['yoga','walking','hiking','running','cycling','swimming','pilates','strength_training','functional_strength_training','hiit','healthkit_activity_3000'])(
  'accepts the actual native activity label %s without dropping a legitimate pattern', activity => {
    const workoutContext={windowDays:28,weekStartAt:'2026-11-15T16:00:00Z',todayMinutes:0,todayCount:0,yesterdayMinutes:60,
      latestWorkoutAt:'2026-11-17T11:00:00Z',patterns:[{activity,weekday:3,hour:19,count:4,recentCount:1,averageMinutes:60,lastObservedAt:'2026-11-17T11:00:00Z'}]}
    const result=EventEnvelopeSchema.safeParse(wire({...summary,type:'workout',statistic:'sum',context:workoutContext}))
    expect(result.success).toBe(true)
    if(result.success&&result.data.payload.event_type==='along.health_summary_updated')
      expect(result.data.payload.summaries[0]?.context).toEqual(workoutContext)
  })
