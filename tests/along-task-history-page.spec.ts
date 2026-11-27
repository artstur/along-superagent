/**
 * 历史任务按需分页（`GET /goals/:id/tasks`）：目标快照有界（最多 200 条任务），
 * 历史入口靠分页路由读到最旧的一条已完成任务，不放大每次同步的目标快照。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AlongStore } from '../src/along/store.ts'
import { createInbox } from '../src/along/inbox.ts'
import { AlongService } from '../src/along/service.ts'
import { alongSourceRequest, type AlongApiHost } from '../src/along/api.ts'

const user = 'u_0a1b2c3d', device = 'd_0a1b2c3d', goalId = 'g_hist00001'
let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'along-history-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

function seeded(count: number) {
  const store = new AlongStore(join(directory, 'along.sqlite'))
  store.assertUser(user, device)
  store.insertGoal({ userId: user, domain: 'custom', goalId })
  store.appendGoalRevision({ userId: user, goalId, title: '历史目标', status: 'active' })
  store.ensureInputVersion(user, goalId)
  for (let index = 0; index < count; index++) {
    const taskId = 't_hist_' + String(index).padStart(3, '0')
    store.insertTask({ userId: user, goalId, taskId, content: '历史任务 ' + index })
    store.appendTaskRevision({ userId: user, taskId, status: 'done' })
  }
  const host = { along: new AlongService(store, { inbox: createInbox(store) }), bridgeToken: 'synthetic' } as AlongApiHost
  const call = (query: URLSearchParams) => alongSourceRequest(host, {
    method: 'GET', path: 'tasks', query,
    headers: { 'x-along-bridge': '1', 'x-along-bridge-token': 'synthetic', 'x-along-user': user, 'x-along-device': device },
    body: async () => undefined,
  })
  return { store, call }
}

describe('paged goal task reads', () => {
  it('keeps the goal snapshot bounded while the paged route reaches the oldest completed task', async () => {
    const { store, call } = seeded(201)
    // 快照有界：只带最近 200 条任务，最旧的一条不在快照里。
    const snapshot = store.goalDetail(user, goalId).tasks
    expect(snapshot).toHaveLength(200)
    expect(snapshot.some(task => task.id === 't_hist_000')).toBe(false)

    const first = await call(new URLSearchParams({ user_id: user, goal_id: goalId, status: 'done', limit: '200' }))
    expect(first.status).toBe(200)
    const page = first.body as { items: { id: string; status: string }[]; nextCursor?: string }
    expect(page.items).toHaveLength(200)
    expect(page.items.every(task => task.status === 'done')).toBe(true)
    expect(page.nextCursor).toBeTruthy()

    const second = await call(new URLSearchParams({ user_id: user, goal_id: goalId, status: 'done', limit: '200', cursor: page.nextCursor! }))
    expect(second.status).toBe(200)
    const tail = second.body as { items: { id: string }[]; nextCursor?: string }
    expect(tail.items.map(task => task.id)).toContain('t_hist_000')
    expect(tail.nextCursor).toBeUndefined()
    store.close()
  })

  it('carries the same execution summary on the paged read as on the goal snapshot', async () => {
    const { store, call } = seeded(3)
    const inbox = createInbox(store)
    const identity = { userId: user, deviceId: device }
    const taskId = 't_hist_open'
    store.insertTask({ userId: user, goalId, taskId, content: '刚完成的任务' })
    // 一次真实的完成事实：任务转 done，执行投影记 1 次。
    expect(inbox.acceptEvent({ event_id: 'evt_hist_done', schema_version: '1', event_type: 'along.message', kind: 'task.completed',
      goal_id: goalId, task_id: taskId, occurred_at: '2026-11-15T09:00:00+08:00', timezone: 'Asia/Shanghai',
      payload: { event_type: 'along.message', kind: 'task.completed', task_id: taskId, completed_at: '2026-11-15T09:00:00+08:00' } },
    identity).status).toBe('accepted')
    expect(store.taskExecution(user, taskId).count).toBe(1)
    expect(store.goalDetail(user, goalId).tasks.find(task => task.id === taskId)?.execution?.count).toBe(1)

    const paged = await call(new URLSearchParams({ user_id: user, goal_id: goalId, status: 'done', limit: '50' }))
    expect(paged.status).toBe(200)
    const item = (paged.body as { items: { id: string; execution?: { count: number; records: { summary: string }[] } }[] }).items
      .find(task => task.id === taskId)
    // 分页读到的任务与目标快照同一口径：详情据此显示「已记录 1 次执行」与完成反馈。
    expect(item?.execution?.count).toBe(1)
    expect(item?.execution?.records.map(record => record.summary)).toContain('已收到任务完成反馈')
    store.close()
  })

  it('rejects an unknown status and never reads another goal’s tasks', async () => {
    const { store, call } = seeded(3)
    expect((await call(new URLSearchParams({ user_id: user, status: 'unknown' }))).status).toBe(400)
    const other = store.insertGoal({ userId: user, domain: 'custom' })
    store.appendGoalRevision({ userId: user, goalId: other.id, title: '别的目标', status: 'active' })
    const foreign = await call(new URLSearchParams({ user_id: user, goal_id: other.id, status: 'done' }))
    expect(foreign.status).toBe(200)
    expect((foreign.body as { items: unknown[] }).items).toHaveLength(0)
    // 别人的目标：按 not_found 拒绝，不泄露存在性。
    const stolen = await alongSourceRequest(
      { along: new AlongService(store, { inbox: createInbox(store) }), bridgeToken: 'synthetic' } as AlongApiHost,
      { method: 'GET', path: 'tasks', query: new URLSearchParams({ user_id: user, goal_id: 'g_someone_else' }),
        headers: { 'x-along-bridge': '1', 'x-along-bridge-token': 'synthetic', 'x-along-user': user, 'x-along-device': device },
        body: async () => undefined })
    expect(stolen.status).toBe(404)
    store.close()
  })
})
