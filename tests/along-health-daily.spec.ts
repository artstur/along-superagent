import { expect,it,vi,afterEach } from 'vitest'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AlongStore,type HealthSummaryRow } from '../src/along/store.ts'
import { healthLocalDate,nextHealthReviewAt } from '../src/along/health-daily.ts'
afterEach(()=>vi.useRealTimers())
it('uses source civil time including DST and never falls back to the host timezone',()=>{
 const now=Date.parse('2026-11-24T04:00:00Z')
 expect(healthLocalDate(now,'America/Los_Angeles')).toBe('2026-11-23')
 expect(nextHealthReviewAt([],'Asia/Shanghai',now)).toBe('2026-11-25T01:00:00.000Z')
 expect(nextHealthReviewAt([],'America/New_York',Date.parse('2026-10-31T14:00:00Z'))).toBe('2026-11-01T14:00:00.000Z')
 expect(()=>nextHealthReviewAt([],'Asia/Shanghai',now,'2026-11-24T05:00:00Z')).toThrow('next-local-day')
 expect(()=>nextHealthReviewAt([],'Asia/Shanghai',now,'2026-11-27T04:00:00Z')).toThrow('48 hours')
})
it('persists next review and one local-day dispatch across reopening without regenerating old goals or messages',()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-24T04:00:00Z'))
 const dir=mkdtempSync(join(tmpdir(),'health-daily-persist-')),path=join(dir,'along.sqlite')
 let store=new AlongStore(path)
 try {
  store.assertUser('u','d');const goal=store.insertGoal({userId:'u',domain:'custom'})
  store.appendGoalRevision({userId:'u',goalId:goal.id,title:'合成健康目标',status:'active'});store.ensureInputVersion('u',goal.id)
  const snapshot=[{id:'h_sleep',userId:'u',eventId:'e',receivedAt:'2026-11-24T04:00:00Z',superseded:false,type:'sleep',metricVersion:'2026-11-24T04:00:00Z',timezone:'Asia/Shanghai',value:420,availability:'ok',summarizerVersion:'along-health-v1',adapter:'known',windowEnd:'2026-11-24T10:00:00Z'}] as HealthSummaryRow[]
  const d=store.health.dispatch('u',goal.id,1,snapshot);store.health.read(d.eventId,snapshot)
  store.health.finish(store.health.get(d.eventId)!,{outcome:'keep',types:['sleep'],reason:'保留原计划'})
  const schedule=store.health.reviewSchedule(goal.id);expect(schedule?.nextAt).toBe('2026-11-25T01:00:00.000Z')
  const review={timezone:'Asia/Shanghai',localDate:'2026-11-25',scheduledAt:schedule!.nextAt}
  const first=store.health.dispatchDaily('u',goal.id,1,snapshot,review)
  store.close();store=new AlongStore(path)
  expect(store.health.reviewSchedule(goal.id)).toEqual(schedule)
  expect(store.health.dispatchDaily('u',goal.id,1,snapshot,review).eventId).toBe(first.eventId)
  expect(store.health.pending()).toHaveLength(1)
  expect(store.counts('u').messages).toBe(0)
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
})
