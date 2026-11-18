import { expect, it } from 'vitest'
import { AlongStore } from '../src/along/store.ts'
import { EventEnvelopeSchema } from '../src/along/envelope.ts'
import { significantHealthChange } from '../src/along/health.ts'
const summary = { type:'sleep',metric_version:'2026-11-18T04:00:00Z',unit:'min',statistic:'night_sum',
 window:{start:'2026-11-17T10:00:00Z',end:'2026-11-18T10:00:00Z'},timezone:'Asia/Shanghai',value:420,availability:'ok',summarizer_version:'along-health-v1' }
const context = {windowDays:7,daysWithData:5,averageThroughAt:'2026-11-17T10:00:00Z',latestWindowOpen:true,
 latestNightMinutes:420,averageMinutes:420,latestSleepStartAt:'2026-11-17T17:00:00Z',latestWakeAt:'2026-11-18T00:00:00Z'}
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
