
import { expect, it } from 'vitest'
import { nextDailyTime, hasDailyMandate } from '../src/along/task-schedule.ts'

it('renews at the delegated civil time across DST gaps and folds, leap day, and an offline period', () => {
  const zone='America/New_York'
  const wall='2026-03-07T07:30:00Z' // 02:30 before the DST gap
  const gap=nextDailyTime(wall,zone,Date.parse(wall))
  expect(gap).toBe('2026-03-08T07:30:00.000Z')
  expect(nextDailyTime(gap,zone,Date.parse(gap),wall)).toBe('2026-03-09T06:30:00.000Z')
  expect(nextDailyTime('2026-10-31T05:30:00Z',zone,Date.parse('2026-10-31T06:00Z'))).toBe('2026-11-01T05:30:00.000Z')
  expect(nextDailyTime('2024-02-27T15:00Z','Asia/Shanghai',Date.parse('2024-02-29T10:00Z'))).toBe('2024-02-29T15:00:00.000Z')
  expect(hasDailyMandate('请每晚提醒我复盘')).toBe(true)
  for(const text of ['只在今天提醒我','我每天走路','不用每天提醒','如果每天提醒我会怎么样','每天跑步。仅今天提醒我。']) expect(hasDailyMandate(text)).toBe(false)
})
