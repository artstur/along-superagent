/** Stage C acceptance: actual Runtime/Engine/SQLite and registered Worker tools; only model decisions are driven by the fixture. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'
import { alongKind } from '../src/sources/along.ts'
import { EventEnvelopeSchema } from '../src/along/envelope.ts'

const USER = 'u_health',
  DEVICE = 'd_health'
let host: Host | undefined
const directories: string[] = []
const summaries = (
  value = 1000,
  type = 'steps',
  revision = '2026-11-16T04:00:00.000Z',
  window = { start: '2026-11-15T16:00:00.000Z', end: '2026-11-16T16:00:00.000Z' }
) => [
  {
    type,
    metric_version: revision,
    unit: (
      {
        steps: 'count',
        workout: 'min',
        sleep: 'min',
        weight: 'kg',
        active_energy: 'kcal',
        resting_heart_rate: 'bpm',
        wrist_temperature: 'degC'
      } as Record<string, string>
    )[type],
    statistic: 'sum',
    window,
    timezone: 'Asia/Shanghai',
    value,
    availability: 'ok',
    summarizer_version: 'along-health-v1'
  }
]
// The synthetic current-day summaries below belong to this fixed clock, not the developer’s wall clock.
beforeEach(() => { vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-16T04:00:00Z')) })
afterEach(async () => {
  await host?.stop()
  host = undefined
  vi.useRealTimers()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})
async function setup() {
  const h = (host = await startRuntime((s) =>
    s.saveSettings({
      ...s.settings(),
      sources: { along: { enabled: true, config: {} }, github: { enabled: false, config: {} } },
      policy: { ...s.settings().policy, sources: { along: { allowed: [{ id: USER }], admission: {} } } }
    })
  ))
  h.runtime.sources.register(alongKind)
  h.runtime.store.saveSettings({
    ...h.runtime.store.settings(),
    sources: { along: { enabled: true, config: {} }, github: { enabled: false, config: {} } },
    policy: { ...h.runtime.store.settings().policy, sources: { along: { allowed: [{ id: USER }], admission: {} } } }
  })
  const along = h.runtime.along!,
    store = along.service.alongStore
  store.assertUser(USER, DEVICE)
  const goal = store.insertGoal({ userId: USER, domain: 'custom' })
  store.appendGoalRevision({ userId: USER, goalId: goal.id, title: '每天多走路', status: 'active' })
  store.ensureInputVersion(USER, goal.id)
  const task = store.insertTask({ userId: USER, goalId: goal.id, content: '晚饭后走 20 分钟' })
  const event = (id: string, rows = summaries()) =>
    along.service.acceptEvent(
      {
        event_id: id,
        schema_version: '1',
        event_type: 'along.health_summary_updated',
        occurred_at: '2026-11-16T04:00:00Z',
        timezone: 'Asia/Shanghai',
        payload: { event_type: 'along.health_summary_updated', summaries: rows }
      },
      { userId: USER, deviceId: DEVICE }
    )
  const dispatch = async () => {
    await h.runtime.pump()
    await h.runtime.idle()
    const ticket = h.runtime.store.tickets.list().find((t) => t.mandate.basis.via === 'health' && !t.ended)!
    expect(ticket).toBeDefined()
    await vi.waitFor(() => expect(h.tools.has(`worker-${ticket.id}`)).toBe(true), { timeout: 10_000 })
    return { ticket, worker: `worker-${ticket.id}` }
  }
  return { h, store, goal, task, event, dispatch }
}
it('automatically creates non-human work and applies a task update without any new chat, with durable result and sync', async () => {
  const { h, store, goal, task, event, dispatch } = await setup()
  expect(event('health_first')).toMatchObject({ status: 'accepted' })
  const { ticket, worker } = await dispatch()
  expect(h.runtime.store.triggers.get(ticket.origin.triggerId)).toMatchObject({
    human: false,
    meta: { goal_id: goal.id }
  })
  expect(store.counts(USER).messages).toBe(0)
  expect(h.candidates()).toHaveLength(0)
  await expect(h.runTool(worker, 'orchestrator_report', { state: 'ready', summary: '假完成' })).rejects.toThrow(
    'not complete'
  )
  await expect(
    h.runTool(worker, 'along_health_followup', { outcome: 'keep', types: ['steps'], reason: '无需改动' })
  ).rejects.toThrow('read along_health_read')
  const read = (await h.runTool(worker, 'along_goal_read', {})) as {
    goal: { current_revision: number; input_version: number }
  }
  expect(await h.runTool(worker, 'along_health_read', {})).toMatchObject({
    summaries: [{ type: 'steps', value: 1000 }]
  })
  const commit = {
    idempotency_key: 'health_adjust',
    base_revision: read.goal.current_revision,
    input_version: read.goal.input_version,
    reason: '根据今日步数调整任务',
    ops: [
      {
        op: 'task.update',
        task_id: task.id,
        base_revision: task.currentRevision,
        fields: { content: '今天再走 10 分钟' }
      }
    ]
  }
  expect(await h.runTool(worker, 'along_changes_commit', commit)).toMatchObject({ status: 'applied' })
  expect(
    await h.runTool(worker, 'along_health_followup', {
      outcome: 'update',
      types: ['steps'],
      reason: '已调整剩余活动',
      text: '已按今天的活动量调整散步安排。'
    })
  ).toMatchObject({ status: 'recorded' })
  await h.runTool(worker, 'orchestrator_report', { state: 'ready', summary: '已完成跟进' })
  await h.runtime.idle()
  expect(store.getTask(USER, task.id)?.content).toBe('今天再走 10 分钟')
  expect(store.health.state(goal.id)).toMatchObject({ types: ['steps'], baseline: [{ value: 1000 }] })
  expect(store.syncPage(USER, 0, 100).items.length).toBeGreaterThan(0)
  expect(event('health_first')).toMatchObject({ status: 'duplicate' })
  await h.runtime.pump()
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
}, 25_000)
it('accumulates small changes against the evaluated baseline, coalesces in-flight updates and keeps unknown separate from zero', async () => {
  const { h, store, goal, event, dispatch } = await setup()
  event('baseline')
  const first = await dispatch()
  await h.runTool(first.worker, 'along_health_read', {})
  // Arrives after the read: must not be accidentally marked evaluated by finishing the older read.
  event('next', summaries(1300, 'steps', '2026-11-16T04:10:00.000Z'))
  await h.runtime.pump()
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
  await h.runTool(first.worker, 'along_health_followup', { outcome: 'keep', types: ['steps'], reason: '当前安排足够' })
  await h.runTool(first.worker, 'orchestrator_report', { state: 'ready', summary: '保持' })
  await h.runtime.idle()
  expect(store.health.state(goal.id)?.baseline[0]?.value).toBe(1000)
  await h.runtime.pump()
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
  event('threshold', summaries(1550, 'steps', '2026-11-16T04:20:00.000Z'))
  const second = await dispatch()
  expect(second.ticket.id).not.toBe(first.ticket.id)
  expect(await h.runTool(second.worker, 'along_health_read', {})).toMatchObject({ summaries: [{ value: 1550 }] })
}, 25_000)
it('blocks old health work after a chat correction even if it copies the new version, and refuses goal mutation', async () => {
  const { h, store, goal, event, dispatch } = await setup()
  event('start')
  const { worker } = await dispatch()
  await h.runTool(worker, 'along_health_read', {})
  const state = (await h.runTool(worker, 'along_goal_read', {})) as {
    goal: { current_revision: number; input_version: number }
  }
  expect(
    await h.runTool(worker, 'along_changes_commit', {
      idempotency_key: 'illegal_goal',
      base_revision: state.goal.current_revision,
      input_version: state.goal.input_version,
      reason: '健康事件不能改目标',
      ops: [{ op: 'goal.update', fields: { title: '擅自改变目标' } }]
    })
  ).toMatchObject({ status: 'invalid', reason: 'health_goal_mutation' })
  h.runtime.along!.service.acceptEvent(
    {
      event_id: 'correction',
      schema_version: '1',
      event_type: 'along.user_message',
      goal_id: goal.id,
      occurred_at: '2026-11-16T04:30:00Z',
      timezone: 'Asia/Shanghai',
      payload: { event_type: 'along.user_message', text: '今天休息，不要增加运动' }
    },
    { userId: USER, deviceId: DEVICE }
  )
  expect(
    await h.runTool(worker, 'along_changes_commit', {
      idempotency_key: 'old_health',
      base_revision: state.goal.current_revision,
      input_version: store.inputVersion(goal.id),
      reason: '不能抄新版本',
      ops: [{ op: 'task.create', content: '不该出现的运动' }]
    })
  ).toMatchObject({ status: 'conflicted', reason: 'conflicted_input' })
  expect(
    await h.runTool(worker, 'along_health_followup', { outcome: 'keep', types: ['steps'], reason: '过时' })
  ).toMatchObject({ status: 'conflicted' })
}, 25_000)
it('records late old windows and revisions without replacing current facts; rejects non-scalar aggregates and incorrect production units', async () => {
  const { store, event } = await setup()
  event('fresh', summaries(1500))
  event('late', summaries(900, 'steps', '2026-11-16T03:00:00.000Z'))
  event(
    'old_day',
    summaries(5000, 'steps', '2026-11-16T05:00:00.000Z', {
      start: '2026-11-14T16:00:00.000Z',
      end: '2026-11-15T16:00:00.000Z'
    })
  )
  expect(store.latestHealthSummaries(USER)).toMatchObject([{ value: 1500, eventId: 'fresh' }])
  const base = {
    event_id: 'bad',
    schema_version: '1',
    event_type: 'along.health_summary_updated',
    occurred_at: '2026-11-16T04:00:00Z',
    timezone: 'Asia/Shanghai'
  }
  for (const row of [
    { ...summaries()[0], value: [{ sample: 'raw' }] },
    { ...summaries()[0], unit: 'kg' },
    { ...summaries()[0], availability: 'unavailable', value: 0 }
  ])
    expect(
      EventEnvelopeSchema.safeParse({
        ...base,
        payload: { event_type: 'along.health_summary_updated', summaries: [row] }
      }).success
    ).toBe(false)
})
it('stays silent for no targets, finance, paused or disallowed users, and rejects forged health dispatches', async () => {
  const { h, store, goal, event } = await setup()
  store.appendGoalRevision({ userId: USER, goalId: goal.id, title: '已归档', status: 'archived' })
  const finance = store.insertGoal({ userId: USER, domain: 'finance' })
  store.appendGoalRevision({ userId: USER, goalId: finance.id, title: '演示储蓄', status: 'active' })
  event('silent')
  await h.runtime.pump()
  expect(h.runtime.store.tickets.list()).toHaveLength(0)
  store.appendGoalRevision({ userId: USER, goalId: goal.id, title: '恢复目标', status: 'active' })
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: true })
  await h.runtime.pump()
  expect(h.runtime.store.tickets.list()).toHaveLength(0)
  h.runtime.store.saveSettings({
    ...h.runtime.store.settings(),
    paused: false,
    policy: { ...h.runtime.store.settings().policy, sources: { along: { allowed: [], admission: {} } } }
  })
  await h.runtime.pump()
  expect(h.runtime.store.tickets.list()).toHaveLength(0)
  const t = {
    id: 'forged-health',
    source: 'along',
    actor: { source: 'along', id: USER },
    human: false,
    at: new Date().toISOString(),
    threads: [{ source: 'along', id: 'forged' }],
    text: 'pretend',
    meta: { event_type: 'along.health_summary_updated', health_dispatch: 'not-real', goal_id: goal.id }
  }
  h.runtime.receive(t)
  await h.runtime.pump()
  expect(h.runtime.store.tickets.list()).toHaveLength(0)
})

it('splits one summary across two goals, allows read-only coordination, and contains a chat conflict to its own goal', async () => {
  const { h, store, goal, event } = await setup()
  const other = store.insertGoal({ userId: USER, domain: 'custom' })
  store.appendGoalRevision({ userId: USER, goalId: other.id, title: '改善睡眠', status: 'active' })
  store.ensureInputVersion(USER, other.id)
  event('two_goals')
  await h.runtime.pump()
  await h.runtime.idle()
  const tickets = h.runtime.store.tickets.list().filter((t) => t.mandate.basis.via === 'health')
  expect(tickets).toHaveLength(2)
  const first = tickets.find((t) => store.getWorkLink(t.id)?.goalId === goal.id)!,
    second = tickets.find((t) => t.id !== first.id)!
  for (const t of tickets) await vi.waitFor(() => expect(h.tools.has(`worker-${t.id}`)).toBe(true), { timeout: 10_000 })
  const a = `worker-${first.id}`,
    b = `worker-${second.id}`
  expect(await h.runTool(a, 'along_goal_overview', {})).toMatchObject({
    goals: expect.arrayContaining([{ goal_id: other.id, title: '改善睡眠', status: 'active', tasks: [] }])
  })
  await expect(h.runTool(a, 'along_goal_read', { goal_id: other.id })).rejects.toThrow('outside this work')
  await h.runTool(a, 'along_health_read', {})
  await h.runTool(b, 'along_health_read', {})
  store.raiseInputVersion(USER, goal.id, 'a-new-chat')
  expect(
    await h.runTool(a, 'along_health_followup', { outcome: 'keep', types: ['steps'], reason: '旧输入' })
  ).toMatchObject({ status: 'conflicted' })
  expect(
    await h.runTool(b, 'along_health_followup', { outcome: 'keep', types: [], reason: '步数与当前睡眠安排无关' })
  ).toMatchObject({ status: 'recorded' })
  await h.runTool(b, 'orchestrator_report', { state: 'ready', summary: '保持睡眠安排' })
  expect(store.health.state(other.id)?.types).toEqual([])
  expect(store.health.state(goal.id)).toBeUndefined()
}, 25_000)
it('does not repeatedly wake an unrelated goal, relearns after changed chat, and respects user stop and lost authorization', async () => {
  const { h, store, goal, event, dispatch } = await setup()
  event('unrelated')
  const first = await dispatch()
  await h.runTool(first.worker, 'along_health_read', {})
  await h.runTool(first.worker, 'along_health_followup', {
    outcome: 'keep',
    types: [],
    reason: '当前目标不依赖健康数据'
  })
  await h.runTool(first.worker, 'orchestrator_report', { state: 'ready', summary: '保持' })
  await h.runtime.idle()
  event('unrelated_changed', summaries(6000, 'steps', '2026-11-16T05:00:00.000Z'))
  await h.runtime.pump()
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
  store.raiseInputVersion(USER, goal.id, 'new-goal-intent')
  const second = await dispatch()
  expect(second.ticket.id).not.toBe(first.ticket.id)
  h.runtime.engine.stopTicket(second.ticket.id)
  await h.runtime.idle()
  await expect(h.runTool(second.worker, 'along_health_read', {})).rejects.toThrow('capability unavailable')
  await h.runtime.pump()
  expect(h.runtime.store.tickets.list()).toHaveLength(2)
  // A subsequent actual health change may create a new work, never resume the stopped ticket.
  event('later_change', summaries(7000, 'steps', '2026-11-16T06:00:00.000Z'))
  const third = await dispatch()
  expect(third.ticket.id).not.toBe(second.ticket.id)
  h.runtime.store.saveSettings({
    ...h.runtime.store.settings(),
    policy: { ...h.runtime.store.settings().policy, sources: { along: { allowed: [], admission: {} } } }
  })
  await expect(h.runTool(third.worker, 'along_health_read', {})).rejects.toThrow('capability unavailable')
}, 25_000)

it('recovers the durable health dispatch across restart without duplicate tickets or losing evaluated baselines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'along-health-restart-'))
  directories.push(dir)
  const db = new Store(join(dir, 'orchestrator.sqlite'))
  db.saveSettings({
    ...db.settings(),
    eval: { ...db.settings().eval, mode: 'auto' },
    sources: { along: { enabled: true, config: {} }, github: { enabled: false, config: {} } },
    policy: { ...db.settings().policy, sources: { along: { allowed: [{ id: USER }], admission: {} } } }
  })
  db.close()
  let h = (host = await startRuntime(undefined, { dir }))
  let store = h.runtime.along!.service.alongStore
  store.assertUser(USER, DEVICE)
  const goal = store.insertGoal({ userId: USER, domain: 'custom' })
  store.appendGoalRevision({ userId: USER, goalId: goal.id, title: '长期散步', status: 'active' })
  store.ensureInputVersion(USER, goal.id)
  const envelope = {
    event_id: 'restart_health',
    schema_version: '1',
    event_type: 'along.health_summary_updated',
    occurred_at: '2026-11-16T04:00:00Z',
    timezone: 'Asia/Shanghai',
    payload: { event_type: 'along.health_summary_updated', summaries: summaries() }
  }
  h.runtime.along!.service.acceptEvent(envelope, { userId: USER, deviceId: DEVICE })
  h.runtime.along!.healthFollowup.tick()
  const pending = store.health.pending()
  expect(pending).toHaveLength(1)
  await h.stop()
  host = undefined
  h = host = await startRuntime(undefined, { dir })
  store = h.runtime.along!.service.alongStore
  await h.runtime.pump()
  await h.runtime.idle()
  const tickets = h.runtime.store.tickets.list().filter((t) => t.mandate.basis.via === 'health')
  expect(tickets).toHaveLength(1)
  const ticket = tickets[0]!,
    worker = `worker-${ticket.id}`
  await vi.waitFor(() => expect(h.tools.has(worker)).toBe(true), { timeout: 10_000 })
  expect(h.runtime.along!.healthFollowup.forTicket(ticket.id)?.eventId).toBe(pending[0]!.eventId)
  await h.runTool(worker, 'along_health_read', {})
  await h.runTool(worker, 'along_health_followup', { outcome: 'keep', types: ['steps'], reason: '计划仍合适' })
  await h.runTool(worker, 'orchestrator_report', { state: 'ready', summary: '完成' })
  await h.runtime.idle()
  await h.stop()
  host = undefined
  h = host = await startRuntime(undefined, { dir })
  store = h.runtime.along!.service.alongStore
  expect(h.runtime.along!.service.acceptEvent(envelope, { userId: USER, deviceId: DEVICE })).toMatchObject({
    status: 'duplicate'
  })
  await h.runtime.pump()
  await h.runtime.idle()
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
  expect(store.health.state(goal.id)).toMatchObject({ types: ['steps'], baseline: [{ value: 1000 }] })
}, 30_000)
it('distinguishes a real zero, unavailable data and a new cumulative window; availability recovery can contain an older observation date', async () => {
  const { store, event } = await setup()
  const first = summaries(0)
  expect(event('zero', first)).toMatchObject({ status: 'accepted' })
  expect(store.latestHealthSummaries(USER)[0]).toMatchObject({ availability: 'ok', value: 0 })
  const unavailable = [
    { ...first[0]!, value: null, availability: 'unavailable', metric_version: '2026-11-16T05:00:00.000Z' }
  ]
  expect(event('unknown', unavailable as never)).toMatchObject({ status: 'accepted' })
  expect(store.latestHealthSummaries(USER)[0]).toMatchObject({ availability: 'unavailable', value: null })
  const missing = summaries(60, 'resting_heart_rate')
  missing[0]!.statistic = 'latest'
  event('heart_missing', [{ ...missing[0]!, availability: 'unavailable', value: null }] as never)
  const recovered = summaries(60, 'resting_heart_rate', '2026-11-16T05:00:00.000Z', {
    start: '2026-11-14T04:00:00.000Z',
    end: '2026-11-14T04:00:00.000Z'
  })
  recovered[0]!.statistic = 'latest'
  event('heart_recovered', recovered)
  expect(store.latestHealthSummaries(USER).find((s) => s.type === 'resting_heart_rate')).toMatchObject({
    availability: 'ok',
    value: 60
  })
})

it('retries failed health work with persistent report-time backoff and the same ticket', async () => {
  const { h, event, dispatch } = await setup()
  event('retry_health')
  const { ticket, worker } = await dispatch()
  await h.runTool(worker, 'orchestrator_report', { state: 'failed', summary: 'Temporary model/tool failure' })
  await h.runtime.pump()
  expect(h.runtime.store.tickets.get(ticket.id)?.assignments).toHaveLength(1)
  const saved = h.runtime.store.tickets.get(ticket.id)!
  saved.assignments.at(-1)!.report!.at = '2020-01-01T00:00:00.000Z'
  h.runtime.store.tickets.save(saved)
  await h.runtime.pump()
  await h.runtime.idle()
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
  expect(h.runtime.store.tickets.get(ticket.id)?.assignments).toHaveLength(2)
}, 25000)
it('does not let a settled conversation question block automatic health follow-up indefinitely', async () => {
  const { h, store, goal, event, dispatch } = await setup()
  h.runtime.along!.service.acceptEvent(
    {
      event_id: 'waiting_chat',
      schema_version: '1',
      event_type: 'along.user_message',
      goal_id: goal.id,
      occurred_at: '2026-11-16T04:00:00Z',
      timezone: 'Asia/Shanghai',
      payload: { event_type: 'along.user_message', text: '帮我安排散步' }
    },
    { userId: USER, deviceId: DEVICE }
  )
  await vi.waitFor(() => expect(store.getDelivery(`along:${USER}:waiting_chat`)?.status).toBe('delivered'), {
    timeout: 10000
  })
  await h.runtime.idle()
  const accepted = await h.route({
    kind: 'accept',
    trigger_id: `along:${USER}:waiting_chat`,
    title: '安排散步',
    worktree_name: 'waiting-chat',
    acknowledgement: '收到'
  })
  const chat = (accepted.ticket as { ticket_id: string }).ticket_id
  await h.runtime.idle()
  await h.runTool(`worker-${chat}`, 'orchestrator_report', {
    state: 'blocked',
    summary: '等待可用时段',
    human_action: '通常几点有空？'
  })
  event('health_while_waiting')
  const health = await dispatch()
  expect(health.ticket.id).not.toBe(chat)
  expect(h.runtime.store.tickets.get(chat)?.assignments).toHaveLength(1)
  expect(h.runtime.store.tickets.get(chat)?.ended).toBeUndefined()
}, 25000)

it('recovers a completed evaluation when the worker went idle before reporting ready', async () => {
  const { h, event, dispatch } = await setup()
  event('committed_before_crash')
  const { ticket, worker } = await dispatch()
  await h.runTool(worker, 'along_health_read', {})
  await h.runTool(worker, 'along_health_followup', { outcome: 'keep', types: ['steps'], reason: '当前安排足够' })
  // The Executor, rather than a model tool, records idle turns as waiting.
  h.runtime.engine.report(ticket.id, { state: 'waiting', summary: 'Idle turn after persisted business result' })
  const saved = h.runtime.store.tickets.get(ticket.id)!
  const a = saved.assignments.at(-1)!
  a.report!.at = '2020-01-01T00:00:00.000Z'
  a.deliveredAt = undefined
  h.runtime.store.tickets.save(saved)
  await h.runtime.pump()
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
}, 25000)

it('evaluates a typed goal reaching its target even when the change is below the ordinary noise threshold', async () => {
  const { h, store, goal, event, dispatch } = await setup()
  store.appendGoalRevision({ userId: USER, goalId: goal.id, title: '旧目标', status: 'archived' })
  const target = store.insertGoal({ userId: USER, domain: 'health' })
  store.appendGoalRevision({
    userId: USER,
    goalId: target.id,
    title: '每天8000步',
    status: 'active',
    metric: { type: 'steps', target: 8000, unit: '步', period: 'day' }
  })
  store.ensureInputVersion(USER, target.id)
  event('almost_target', summaries(7900))
  const first = await dispatch()
  await h.runTool(first.worker, 'along_health_read', {})
  await h.runTool(first.worker, 'along_health_followup', {
    outcome: 'keep',
    types: ['steps'],
    reason: '尚未达标，保留安排'
  })
  await h.runTool(first.worker, 'orchestrator_report', { state: 'ready', summary: '保持' })
  await h.runtime.idle()
  event('reached_target', summaries(8000, 'steps', '2026-11-16T05:00:00.000Z'))
  const second = await dispatch()
  expect(second.ticket.id).not.toBe(first.ticket.id)
}, 25000)

it('reconsiders relevance when a newly connected health type arrives without requiring a new chat', async () => {
  const { h, event, dispatch } = await setup()
  event('only_steps')
  const first = await dispatch()
  await h.runTool(first.worker, 'along_health_read', {})
  await h.runTool(first.worker, 'along_health_followup', { outcome: 'keep', types: [], reason: '目前步数不会改变安排' })
  await h.runTool(first.worker, 'orchestrator_report', { state: 'ready', summary: '保持' })
  await h.runtime.idle()
  const sleep = summaries(420, 'sleep', '2026-11-16T05:00:00.000Z')
  sleep[0]!.statistic = 'night_sum'
  event('connected_sleep', sleep)
  const second = await dispatch()
  expect(second.ticket.id).not.toBe(first.ticket.id)
}, 25000)

it('dispatches one clock event per occurrence without a phone read, serializes work and renews only the cited daily mandate', async () => {
  const { h, store, goal, task } = await setup()
  const dueAt = new Date(Date.now() - 3 * 86400_000).toISOString()
  store.appendTaskRevision({ userId: USER, taskId: task.id, scheduledAt: dueAt, originEventId:'daily_mandate' })
  const once = store.insertTask({ userId: USER, goalId: goal.id, content: '只提醒一次', scheduledAt: new Date(Date.parse(dueAt)+1000).toISOString() })
  const msg = store.appendMessage({ userId: USER, eventId: 'daily_mandate', role: 'user', direction: 'inbound',
    text: '请每天这个时间提醒我散步。', timezone: 'Asia/Shanghai' })
  store.linkMessageToGoals(msg.id, [goal.id], 'direct')
  const active = async () => {
    await h.runtime.pump(); await h.runtime.idle()
    const due = h.runtime.store.tickets.list().filter(t => t.mandate.basis.via === 'task_due' && !t.ended)
    expect(due).toHaveLength(1)
    const ticket = due[0]!, worker = 'worker-' + ticket.id
    await vi.waitFor(() => expect(h.tools.has(worker)).toBe(true))
    return { ticket, worker }
  }
  const first = await active()
  expect(h.runtime.store.triggers.get(first.ticket.origin.triggerId)).toMatchObject({ human:false, meta:{event_type:'along.task_due',task_id:task.id} })
  expect(await h.runTool(first.worker,'along_health_read',{})).toMatchObject({ summaries:[],review:{taskId:task.id,dueAt} })
  const finish = { outcome:'keep', types:[], reason:'保留已委托的每日安排', renew_daily_from_event:'daily_mandate' }
  await expect(h.runTool(first.worker,'along_health_followup',{...finish,renew_daily_from_event:'unrelated'})).rejects.toThrow('no bound daily')
  expect(await h.runTool(first.worker,'along_health_followup',finish)).toMatchObject({reused:false})
  expect(await h.runTool(first.worker,'along_health_followup',finish)).toMatchObject({reused:true})
  expect(store.health.state(goal.id)).toBeUndefined()
  const next = Date.parse(store.getTask(USER,task.id)!.scheduledAt!)
  expect(next).toBeGreaterThan(Date.now())
  expect(next).toBeLessThanOrEqual(Date.now()+86400_000)
  expect(store.workspaceSync(USER,0,200).items.filter(i=>i.kind==='task_updated' && i.taskId===task.id)).toHaveLength(1)
  await h.runTool(first.worker,'orchestrator_report',{state:'ready',summary:'续排完成'})
  const second = await active()
  expect(await h.runTool(second.worker,'along_health_read',{})).toMatchObject({review:{taskId:once.id}})
  await expect(h.runTool(second.worker,'along_health_followup',finish)).rejects.toThrow('for this task')
  await h.runTool(second.worker,'along_health_followup',{outcome:'ask',types:[],reason:'需要反馈',text:'这次安排完成了吗？'})
  await h.runTool(second.worker,'orchestrator_report',{state:'ready',summary:'已补问'})
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.runtime.store.tickets.list()).toHaveLength(2)
  const notices=store.workspaceSync(USER,0,200).items.filter(i=>(i.payload as {notification?:unknown}).notification)
  expect(notices).toHaveLength(1)
  expect(notices[0]).toMatchObject({kind:'message',goalId:goal.id,taskId:once.id,payload:{notification:{kind:'task_result',event_id:expect.any(String)}}})
},30000)

it('rejects an outdated task review after rescheduling, cancellation, or replacing the mandate while a worker is running', async () => {
  const { h, store, goal, task } = await setup()
  const dueAt=new Date(Date.now()-60000).toISOString()
  store.appendTaskRevision({userId:USER,taskId:task.id,scheduledAt:dueAt})
  await h.runtime.pump();await h.runtime.idle()
  const ticket=h.runtime.store.tickets.list().find(t=>t.mandate.basis.via==='task_due')!, worker='worker-'+ticket.id
  await vi.waitFor(()=>expect(h.tools.has(worker)).toBe(true))
  await h.runTool(worker,'along_health_read',{})
  store.appendTaskRevision({userId:USER,taskId:task.id,status:'cancelled'})
  expect(await h.runTool(worker,'along_health_followup',{outcome:'keep',types:[],reason:'滞后'})).toMatchObject({status:'conflicted'})
  expect(await h.runTool(worker,'along_changes_commit',{idempotency_key:'stale',base_revision:1,input_version:store.inputVersion(goal.id),
    reason:'改回去',ops:[{op:'task.update',task_id:task.id,base_revision:2,fields:{status:'open'}}]})).toMatchObject({status:'conflicted'})
  await h.runtime.pump();await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('dropped')
  expect(store.getTask(USER,task.id)?.status).toBe('cancelled')
},25000)

it('persists distinct due notices even when a goal is busy, and catches up one review after restart without resending', async () => {
  const dir=mkdtempSync(join(tmpdir(),'along-due-restart-'))
  directories.push(dir)
  const initialDb = new Store(join(dir,'orchestrator.sqlite')), settings = initialDb.settings()
  initialDb.saveSettings({...settings,eval:{...settings.eval,mode:'auto'},
    sources:{along:{enabled:true,config:{}},github:{enabled:false,config:{}}},
    policy:{...settings.policy,sources:{along:{allowed:[{id:USER}],admission:{}}}}})
  initialDb.close()
  let h=host=await startRuntime(undefined,{dir})
  let store=h.runtime.along!.service.alongStore
  store.assertUser(USER,DEVICE)
  const goal=store.insertGoal({userId:USER,domain:'finance'})
  store.appendGoalRevision({userId:USER,goalId:goal.id,status:'active',title:'整理演示预算'})
  store.ensureInputVersion(USER,goal.id)
  const dueAt=new Date(Date.now()-60000).toISOString()
  for(const label of ['第一项','第二项']) store.insertTask({goalId:goal.id,userId:USER,content:label,scheduledAt:dueAt})
  // Already recorded phone observations must remain out of a financial due worker.
  const [fresh]=summaries(123,'steps',new Date().toISOString(),{start:dueAt,end:new Date(Date.now()+6*3600000).toISOString()})
  h.runtime.along!.service.acceptEvent({event_id:'private_steps',schema_version:'1',event_type:'along.health_summary_updated',
    occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',payload:{event_type:'along.health_summary_updated',summaries:[fresh]}},{userId:USER,deviceId:DEVICE})
  expect(store.latestHealthSummaries(USER)).toHaveLength(1)
  h.runtime.along!.healthFollowup.tick()
  const noticeIds=()=>store.workspaceSync(USER,0,200).items.flatMap(i=>{
    const p=i.payload as {notification?:{kind:string,event_id:string,scheduled_at:string}}
    return p.notification?.kind==='reminder_due' ? [p.notification.event_id] : []
  })
  const initial=noticeIds()
  expect(new Set(initial).size).toBe(2)
  expect(store.health.pending()).toHaveLength(1)
  const eventId=store.health.pending()[0]!.eventId
  expect(store.health.pending()[0]!.snapshot).toEqual([])
  await h.stop();host=undefined
  h=host=await startRuntime(undefined,{dir})
  store=h.runtime.along!.service.alongStore
  await h.runtime.pump();await h.runtime.idle()
  const only=h.runtime.store.tickets.list().find(t=>t.mandate.basis.via==='task_due'&&!t.ended)!
  expect(h.runtime.along!.healthFollowup.forTicket(only.id)?.eventId).toBe(eventId)
  const worker='worker-'+only.id
  await vi.waitFor(()=>expect(h.tools.has(worker)).toBe(true))
  expect(await h.runTool(worker,'along_health_read',{})).toMatchObject({summaries:[]})
  await h.runTool(worker,'orchestrator_report',{state:'failed',summary:'Temporary model connectivity loss.'})
  const ticket=h.runtime.store.tickets.get(only.id)!
  ticket.assignments.at(-1)!.report!.at='2020-01-01T00:00:00.000Z'
  h.runtime.store.tickets.save(ticket)
  await h.runtime.pump();await h.runtime.idle()
  expect(h.runtime.store.tickets.get(only.id)?.assignments).toHaveLength(2)
  expect(noticeIds()).toEqual(initial)
},30000)

it('retains the prior task-bound daily mandate on keep despite a cancellation of another task, then honors explicit once', async()=>{
  const {h,store,task,goal}=await setup()
  const msg=store.appendMessage({userId:USER,eventId:'daily_walk',role:'user',direction:'inbound',text:'请每天提醒我散步。',timezone:'Asia/Shanghai'})
  store.linkMessageToGoals(msg.id,[goal.id],'direct')
  const dueAt=new Date(Date.now()-120000).toISOString()
  store.appendTaskRevision({userId:USER,taskId:task.id,scheduledAt:dueAt,originEventId:msg.eventId})
  store.health.setDaily(task.id,{eventId:msg.eventId,zone:'Asia/Shanghai',wallTime:dueAt})
  const correction=store.appendMessage({userId:USER,eventId:'cancel_other',role:'user',direction:'inbound',text:'取消快递提醒',timezone:'Asia/Shanghai'})
  store.linkMessageToGoals(correction.id,[goal.id],'direct')
  await h.runtime.pump();await h.runtime.idle()
  const ticket=h.runtime.store.tickets.list().find(t=>t.mandate.basis.via==='task_due')!,worker='worker-'+ticket.id
  await vi.waitFor(()=>expect(h.tools.has(worker)).toBe(true))
  await h.runTool(worker,'along_health_read',{})
  await h.runTool(worker,'along_health_followup',{outcome:'keep',types:[],reason:'保留既有散步安排'})
  expect(Date.parse(store.getTask(USER,task.id)!.scheduledAt!)).toBeGreaterThan(Date.now())
  expect(store.health.daily(task.id)?.evidence).toBe('daily_walk')
  expect(store.goalDetail(USER,goal.id).tasks.find(t=>t.id===task.id)?.previousDailyOccurrence).toBe(dueAt)
  store.appendTaskRevision({userId:USER,taskId:task.id,scheduledAt:new Date(Date.now()+3600000).toISOString(),originEventId:'user_moved'})
  expect(store.goalDetail(USER,goal.id).tasks.find(t=>t.id===task.id)?.previousDailyOccurrence).toBeUndefined()
  store.health.setDaily(task.id)
  expect(store.health.soleTaskFromMandate(task.id,goal.id,'daily_walk')).toBe(false)
},25000)
