/**
 * Worklink module tests (design §2.5/§4.6): business object ↔ Ticket/Assignment mapping and thread naming.
 * Acceptance rows: BC-08-03 (重复事件不产生重复工作 — Inbox/Trigger-id 去重 + WorkLink 唯一映射, 001 §4.3/003 §2
 * 阶段 A), BC-08-06 (同一目标的两个工作不重复处理同一句话 — 全新消息走独立请求线程 fanout=0 由 Eval 单判、
 * 关联回复进在途工作线程仅该工作处理, 003 §3), and the 003 §3 regression「健康事件不恢复被人工停止的工单、
 * 不解除暂停」locked under Along events (intake.ts human-stopped semantics, D15/SD-6 non-human health events).
 * Also pinned: D9 derived event numbers (001 §7.4), the §2.5.4 thread-naming matrix (001 §7.2), the §2.3.6
 * host-bound commit scope reverse lookup, and the §2.5 error path (write failures never fail the committed
 * DSH transaction; the §2.5.1 afterCommit dispatch discards on rollback).
 *
 * The domain-event dispatch is wired exactly as the integration module will wire the Runtime (§2.5.1): the
 * fixture Engine's `emit` is wrapped so every real event flows through the orchestrator store's
 * `afterCommit` into `onDomainEvent` — no runtime.ts change is needed for this module's verification.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import type { EngineOptions } from '../src/core/part.ts'
import { AlongStore } from '../src/along/store.ts'
import { createWorkLink, deriveTrigger, eventIdFromTriggerId, threadFor, threadIdFromKey, workThreadId,
  workThreadKey, type ThreadNamingEvent } from '../src/along/worklink.ts'
import { alongKind } from '../src/sources/along.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const USER = 'u_worklink1'
const DEVICE = 'd_worklink1'
const GOAL = 'g_worklink01'

let host: Host | undefined
let alongStore: AlongStore | undefined
let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'along-worklink-')) })
afterEach(async () => {
  alongStore?.close()
  alongStore = undefined
  await host?.stop()
  host = undefined
})

const dbPath = () => join(directory, 'along-data', 'along.sqlite')
const sqlCount = (sql: string): number => {
  const db = new DatabaseSync(dbPath())
  try { return Number(db.prepare(sql).get()?.n) } finally { db.close() }
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let tick = 0
/** An Along event trigger (the envelopeForTrigger product, §4.6): stable id `along:<user>:<event>`, one
 * thread from the §2.5.4 naming, goal bound in meta, health events never human. */
function alongEvent(event: string, text: string, opts: { human: boolean; threadId: string; goalId?: string
  eventType?: string; causationId?: string }): Trigger {
  return {
    id: `along:${USER}:${event}`,
    source: 'along',
    threads: [{ source: 'along', id: opts.threadId }],
    actor: { source: 'along', id: opts.human ? USER : '' },
    human: opts.human,
    ...(opts.human ? { addressed: 'direct' as const } : {}),
    at: new Date(Date.parse('2026-11-15T00:00:00Z') + (tick++) * 1000).toISOString(),
    text,
    meta: { event_type: opts.eventType ?? 'along.user_message', ...(opts.goalId !== undefined ? { goal_id: opts.goalId } : {}),
      ...(opts.causationId !== undefined ? { causation_id: opts.causationId } : {}) },
  }
}
const workThread = (segment: string, goalId = GOAL): string => `goal/${goalId}/work/${segment}`
/** A brand-new sentence: no work_id yet, so the §2.5.4 naming sends it to an independent request thread. */
const requestTrigger = (event: string, text: string, goalId?: string) =>
  alongEvent(event, text, { human: true, goalId,
    threadId: goalId === undefined ? `inbox/${USER}/${event}` : `goal/${goalId}/request/${event}` })
/** A non-human health event (D15/SD-6): never human, never addressed — its thread is the §2.5.4 health form
 * unless the test places it on a work thread (the Stage C「合并进在途工作线程」case the regression locks). */
const healthEvent = (event: string, threadId = `health/${USER}/${event}`) =>
  alongEvent(event, '授权运动摘要更新，按已有目标调整剩余安排',
    { human: false, goalId: GOAL, threadId, eventType: 'along.health_summary_updated' })

/** A Runtime with the Along source installed and one allowed user, plus the worklink module wired through
 * the orchestrator store's afterCommit (§2.5.1) over a fresh along.sqlite next to the DSH state dir. */
async function startAlongHost() {
  const h = host = await startRuntime(store => store.saveSettings({ ...store.settings(),
    sources: { along: { enabled: true, config: {} }, github: { enabled: false, config: {} } } }))
  h.runtime.sources.register(alongKind)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings,
    sources: { github: { enabled: false, config: {} }, feishu: { enabled: false, config: {} }, along: { enabled: true, config: {} } },
    policy: { ...settings.policy,
      rules: [{ id: 'along-worklink', name: 'Along health', enabled: true, instruction: 'Maintain the existing plan within its authorized goal.' }],
      sources: { ...settings.policy.sources, along: { allowed: [{ id: USER }], admission: { health: { unlistedUnaddressed: 'inferred' } } } } },
  })
  const store = alongStore = new AlongStore(dbPath())
  store.assertUser(USER, DEVICE)
  const worklink = createWorkLink({ store, repo: h.runtime.store })
  const engine = h.runtime.engine as unknown as { options: EngineOptions }
  const previous = engine.options.emit
  engine.options.emit = event => { h.runtime.store.afterCommit(() => worklink.onDomainEvent(event)); previous?.(event) }
  return { h, store, worklink }
}

/** Seeds the Inbox row acceptEvent would have written for an accepted user message (the server-recorded
 * association `threadFor` routes on; the inbox module owns the real write, design §2.2). */
function seedInboxEvent(store: AlongStore, eventId: string, goalId: string): void {
  store.saveInboxEvent({ userId: USER, eventId, schemaVersion: '1', eventType: 'along.user_message', deviceId: DEVICE,
    goalId, receivedAt: new Date().toISOString(), payload: { event_type: 'along.user_message', text: 'seeded' },
    payloadHash: 'seeded', status: 'accepted', triggerId: `along:${USER}:${eventId}` })
}

describe('Along worklink: one mapping row per ticket (BC-08-03, 001 §4.3)', () => {
  it('maps one accepted Along ticket into exactly one WorkLink row and keeps a repeated event at one row', async () => {
    const { h, store, worklink } = await startAlongHost()
    const e1 = alongEvent('event-1', '我想每周运动 120 分钟', { human: true, goalId: GOAL, threadId: workThread('seg-1') })
    const { ticket } = await h.acceptedTicket(e1)
    const row = store.getWorkLink(ticket.id)
    expect(row).toMatchObject({ ticketId: ticket.id, goalId: GOAL, eventId: 'event-1', triggerId: e1.id,
      threadKey: `along:${workThread('seg-1')}`, kind: 'ticket' })
    expect(row?.workId).toMatch(/^w_[0-9a-f]{12}$/) // 服务端生成 w_ + 12 hex（§3）
    expect(row?.assignmentId).toBeDefined() // assignment.started 已回填
    expect(row?.endedAt).toBeUndefined()
    expect(worklink.openWorksForGoal(GOAL).map(item => item.ticketId)).toEqual([ticket.id])

    // DSH Trigger id 去重（intake.ts stable duplicate）：同号重投不产生第二个 Ticket，也不产生第二行映射
    expect(h.runtime.receive(e1)).toBe('duplicate')
    await h.runtime.idle()
    expect(h.runtime.store.tickets.list()).toHaveLength(1)
    expect(sqlCount('SELECT COUNT(*) AS n FROM work_link')).toBe(1)

    // 第二个事件在自己的工作线程上：独立一行，work_id 与 thread_key 均不冲突（§3 UNIQUE）
    const e2 = alongEvent('event-2', '把目标改成 150 分钟', { human: true, goalId: GOAL, threadId: workThread('seg-2') })
    const second = await h.acceptedTicket(e2)
    expect(sqlCount('SELECT COUNT(*) AS n FROM work_link')).toBe(2)
    expect(store.getWorkLink(second.ticket.id)).toMatchObject({ goalId: GOAL, eventId: 'event-2', kind: 'ticket',
      threadKey: `along:${workThread('seg-2')}` })
    expect(store.getWorkLink(second.ticket.id)?.workId).not.toBe(row?.workId)
    // decision.recorded 只进追踪日志，不建行（§2.5.2）
    expect(worklink.trace().some(line => line.includes('decision.recorded'))).toBe(true)
    expect(sqlCount('SELECT COUNT(*) AS n FROM work_link')).toBe(2)
  })

  it('discards the mapping of a rolled-back Engine transaction and lands it on commit (§2.5.1 afterCommit)', async () => {
    const { h, store } = await startAlongHost()
    const { ticket } = await h.acceptedTicket(alongEvent('event-1', '我想每周运动 120 分钟', { human: true, goalId: GOAL, threadId: workThread('seg-1') }))
    const engine = h.runtime.engine as unknown as { options: EngineOptions }
    const emit = engine.options.emit!
    const fakeEnd = { type: 'ticket.ended' as const, at: new Date().toISOString(),
      data: { ticketId: ticket.id, by: 'human' as const, outcome: 'stopped' as const } }
    // 回滚的 Engine 事务：afterCommit 队列被丢弃，along.sqlite 不留脏行
    expect(() => h.runtime.store.atomic(() => { emit(fakeEnd); throw new Error('rollback') })).toThrow('rollback')
    expect(store.getWorkLink(ticket.id)?.endedAt).toBeUndefined()
    // 已提交的分发（事务外立即执行）照常落行
    emit(fakeEnd)
    expect(store.getWorkLink(ticket.id)?.endedAt).toBeDefined()
  })

  it('re-points the row on resume, fills assignment ids, and ends it with the ticket (§2.5.2)', async () => {
    const { h, store } = await startAlongHost()
    const e1 = alongEvent('event-1', '我想每周运动 120 分钟', { human: true, goalId: GOAL, threadId: workThread('seg-1') })
    const { ticket } = await h.acceptedTicket(e1)
    const workId = store.getWorkLink(ticket.id)!.workId
    // Worker 报 ready → 工单以 executor 结束，行的在途标记被清除
    h.runtime.engine.report(ticket.id, { state: 'ready', summary: '已完成' })
    await h.runtime.idle()
    expect(h.runtime.store.tickets.get(ticket.id)?.ended).toMatchObject({ by: 'executor', outcome: 'completed' })
    expect(store.getWorkLink(ticket.id)?.endedAt).toBeDefined()

    // 该工作线程上的人工消息恢复工单：同一行 kind=resume、ended 标记清空、eventId 更新为恢复事件
    const e2 = alongEvent('event-2', '继续，把周三那次也补上', { human: true, goalId: GOAL, threadId: workThread('seg-1') })
    h.runtime.receive(e2)
    await h.runtime.idle()
    const resumed = h.runtime.store.tickets.get(ticket.id)!
    expect(resumed.ended).toBeUndefined()
    expect(resumed.assignments).toHaveLength(2)
    const row = store.getWorkLink(ticket.id)!
    expect(row.kind).toBe('resume')
    expect(row.endedAt).toBeUndefined()
    expect(row.eventId).toBe('event-2')
    expect(row.threadKey).toBe(`along:${workThread('seg-1')}`) // 恢复对话仍在原工作线程上
    expect(row.workId).not.toBe(workId) // resume 更新 work_id（§2.5.2）
    expect(row.assignmentId).toBeDefined() // 新 assignment.started 已回填

    // 人工停止：工单与行一起结束，后续 assignment 事实不再改写已结束的行
    h.runtime.engine.stopTicket(ticket.id, '用户喊停')
    expect(h.runtime.store.tickets.get(ticket.id)?.ended).toMatchObject({ by: 'human' })
    expect(store.getWorkLink(ticket.id)?.endedAt).toBeDefined()
  })
})

describe('Along worklink: two works of one goal never both process one sentence (BC-08-06, 003 §3)', () => {
  it('routes a brand-new sentence on a request thread to nobody and decides it once (path ①)', async () => {
    const { h, store } = await startAlongHost()
    const first = (await h.acceptedTicket(alongEvent('event-1', '我想每周运动 120 分钟', { human: true, goalId: GOAL, threadId: workThread('seg-1') }))).ticket
    await wait(3) // 行的 created_at 有序，最新在途工作可判定
    const second = (await h.acceptedTicket(alongEvent('event-2', '把目标改成 150 分钟', { human: true, goalId: GOAL, threadId: workThread('seg-2') }))).ticket
    const shape = [first, second].map(ticket => {
      const current = h.runtime.store.tickets.get(ticket.id)!
      return { inputs: current.inputs.length, assignments: current.assignments.length }
    })
    const tasksBefore = store.counts(USER).tasks
    const changesetsBefore = sqlCount('SELECT COUNT(*) AS n FROM changeset')

    // 全新消息走独立请求线程：无订阅者 → fanout=0 → Eval 单判（intake.ts:49-58）
    const fresh = requestTrigger('event-fresh', '再增加一个睡眠目标', GOAL)
    h.runtime.receive(fresh)
    await h.runtime.idle()
    expect(h.runtime.store.triggers.disposition(fresh.id)?.fanout).toEqual([])
    expect(h.candidates()).toContain(fresh.id)
    await h.route({ kind: 'accept', trigger_id: fresh.id, title: '新增睡眠目标', worktree_name: 'sleep-goal', acknowledgement: '收到。' })
    await h.runtime.idle()

    // 只产生一个新 Ticket / 一条 Decision→Ticket 链；既有两个工作都不处理该句
    expect(h.runtime.store.tickets.list()).toHaveLength(3)
    expect(h.runtime.store.decisions.byThread(`along:goal/${GOAL}/request/event-fresh`)).toHaveLength(1)
    for (const [index, ticket] of [first, second].entries()) {
      const current = h.runtime.store.tickets.get(ticket.id)!
      expect(current.inputs).toHaveLength(shape[index]!.inputs)
      expect(current.assignments).toHaveLength(shape[index]!.assignments)
      expect(current.inputs.some(input => input.kind === 'trigger' && input.triggerId === fresh.id)).toBe(false)
    }
    // 该目标的业务状态不变（任务数与 ChangeSet 数均不变，§6）
    expect(store.counts(USER).tasks).toBe(tasksBefore)
    expect(sqlCount('SELECT COUNT(*) AS n FROM changeset')).toBe(changesetsBefore)
  })

  it('routes an associated reply into the open work thread and only that work takes it (path ②)', async () => {
    const { h, store, worklink } = await startAlongHost()
    const first = (await h.acceptedTicket(alongEvent('event-1', '我想每周运动 120 分钟', { human: true, goalId: GOAL, threadId: workThread('seg-1') }))).ticket
    await wait(3)
    const secondEvent = alongEvent('event-2', '把目标改成 150 分钟', { human: true, goalId: GOAL, threadId: workThread('seg-2') })
    const second = (await h.acceptedTicket(secondEvent)).ticket
    seedInboxEvent(store, 'event-2', GOAL) // acceptEvent 在生产中写入的关联记录（§2.2）

    // 回复按服务端关联进入所属工作线程：线程名由本模块的命名函数给出（§2.5.4）
    const replyEvent: ThreadNamingEvent = { event_id: 'event-reply', event_type: 'along.user_message', goal_id: GOAL, causation_id: 'event-2' }
    const replyThreadId = worklink.threadFor(replyEvent, USER)
    expect(replyThreadId).toBe(workThread('seg-2')) // 最新在途工作的实际线程
    const reply = alongEvent('event-reply', '这个调整可以，周三也加上', { human: true, goalId: GOAL, threadId: replyThreadId, causationId: 'event-2' })
    h.runtime.receive(reply)
    await h.runtime.idle()

    const disposition = h.runtime.store.triggers.disposition(reply.id)
    expect(disposition?.fanout).toHaveLength(1) // 仅该工作处理（fanout=1）
    const reachedId = disposition!.fanout[0]!
    expect([first.id, second.id]).toContain(reachedId)
    const reached = h.runtime.store.tickets.get(reachedId)!
    expect(reached.inputs.some(input => input.kind === 'trigger' && input.triggerId === reply.id)).toBe(true)
    const other = reachedId === first.id ? second : first
    expect(h.runtime.store.tickets.get(other.id)!.inputs.some(input => input.kind === 'trigger' && input.triggerId === reply.id)).toBe(false)
    // 在途工作的 worker 决定它：不进 Eval（followupOwners，model.ts）
    expect(h.candidates()).not.toContain(reply.id)
    // 命名与实际接句的工作一致；该目标的业务状态不变
    expect(`along:${replyThreadId}`).toBe(store.getWorkLink(reachedId)!.threadKey)
    expect(store.counts(USER).tasks).toBe(0)
    expect(sqlCount('SELECT COUNT(*) AS n FROM changeset')).toBe(0)
  })
})

describe('Along worklink: health events never resume a human-stopped ticket nor lift a pause (003 §3 regression)', () => {
  it('keeps a human-stopped ticket stopped and the pause held under Along health events', async () => {
    const { h, store } = await startAlongHost()
    const { ticket } = await h.acceptedTicket(alongEvent('event-1', '我想每周运动 120 分钟', { human: true, goalId: GOAL, threadId: workThread('seg-1') }))
    h.runtime.engine.stopTicket(ticket.id, '用户喊停')
    const assignments = h.runtime.store.tickets.get(ticket.id)!.assignments.length
    h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: true })

    // 暂停中：健康事件即使落在该工单的工作线程上（阶段 C「合并进在途工作」形态），也照常记录（intake 存储
    // 触发器），但人工停止的工单收不到它（intake.ts:31）、不恢复、不解除暂停
    h.runtime.receive(healthEvent('event-health', workThread('seg-1')))
    await h.runtime.idle()
    expect(h.runtime.store.settings().paused).toBe(true)
    expect(h.runtime.store.tickets.get(ticket.id)!.ended).toMatchObject({ by: 'human' })
    expect(h.runtime.store.tickets.get(ticket.id)!.assignments).toHaveLength(assignments)
    expect(store.getWorkLink(ticket.id)?.endedAt).toBeDefined()
    expect(h.runtime.store.triggers.disposition(`along:${USER}:event-health`)?.fanout).toEqual([])

    // 解除暂停后依旧不恢复：健康事件 human=false 永不恢复工单（intake.ts:42 仅人工消息可恢复）
    h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: false })
    h.runtime.receive(healthEvent('event-health-2'))
    await h.runtime.idle()
    expect(h.runtime.store.tickets.get(ticket.id)!.ended).toMatchObject({ by: 'human' })
    expect(h.runtime.store.tickets.get(ticket.id)!.assignments).toHaveLength(assignments)
    expect(store.getWorkLink(ticket.id)?.endedAt).toBeDefined()
    expect(h.runtime.store.triggers.disposition(`along:${USER}:event-health-2`)?.fanout).toEqual([])
    expect(h.runtime.store.triggers.get(`along:${USER}:event-health`)?.human).toBe(false) // 001 §7.1：健康事件不标人工
  })
})

describe('Along worklink: host-bound commit scope (§2.3.6) and the Along-actor boundary', () => {
  it('binds the scope from the mapping row and the ticket mandate, with triggerEventId as the Inbox event id', async () => {
    const { h, store, worklink } = await startAlongHost()
    const { ticket } = await h.acceptedTicket(alongEvent('event-1', '我想每周运动 120 分钟', { human: true, goalId: GOAL, threadId: workThread('seg-1') }))
    const scope = worklink.workScopeForTicket(ticket.id)
    expect(scope).toMatchObject({ userId: USER, allowedGoalId: GOAL, ticketId: ticket.id, triggerEventId: 'event-1' })
    expect(scope?.workId).toMatch(/^w_[0-9a-f]{12}$/)
    expect(scope?.assignmentId).toBeDefined()
    expect(scope?.triggerEventId).not.toContain(':') // Inbox 事件号，不是带前缀的 Trigger id（§2.3）

    expect(worklink.workScopeForTicket('ticket-unknown')).toBeUndefined()
    // 非 Along 请求者的工单没有 scope（即有一行映射）：Along 工具对它不可用（§4.5）
    h.runtime.store.tickets.save({ ...h.runtime.store.tickets.get(ticket.id)!, id: 'ticket-foreign',
      mandate: { ...h.runtime.store.tickets.get(ticket.id)!.mandate, actor: { source: 'github', id: 'alice' } } })
    store.recordWorkLink({ ticketId: 'ticket-foreign', workId: 'w_foreignwork1', goalId: GOAL, threadKey: `along:${workThread('w-foreign')}`, kind: 'ticket' })
    expect(worklink.workScopeForTicket('ticket-foreign')).toBeUndefined()
  })
})

describe('Along worklink: D9 derived event numbers (001 §7.4) and thread naming (§2.5.4)', () => {
  it('numbers derived events per goal and purpose and never disguises a health event as human', () => {
    const health = healthEvent('event-health')
    for (const purpose of ['replan', 'notify', 'fact'] as const) {
      const derived = deriveTrigger(health, 'g_other00001', purpose)
      expect(derived.id).toBe(`along:${USER}:event-health::g/g_other00001::${purpose}`)
      expect(derived.human).toBe(false) // 001 §7.1：健康更新不能伪装 human=true
      expect(derived.threads).toEqual(health.threads) // 逐目标拆分在阶段 C，阶段 A 落编号约定
      expect(derived.meta).toMatchObject({ goal_id: 'g_other00001', derive_purpose: purpose })
    }
    const human = alongEvent('event-9', '把目标改成 180 分钟', { human: true, goalId: GOAL, threadId: `goal/${GOAL}/request/event-9` })
    expect(deriveTrigger(human, GOAL, 'replan').human).toBe(true)
    expect(deriveTrigger(human, GOAL, 'replan').actor).toEqual(human.actor)
  })

  it('names request, inbox, health and association threads per §2.5.4', () => {
    expect(threadFor({ event_type: 'along.health_summary_updated', event_id: 'eh' }, USER)).toBe(`health/${USER}/eh`)
    expect(threadFor({ event_type: 'along.user_message', event_id: 'er', goal_id: GOAL }, USER)).toBe(`goal/${GOAL}/request/er`)
    expect(threadFor({ event_type: 'along.message', event_id: 'em', kind: 'task.completed', goal_id: GOAL }, USER)).toBe(`goal/${GOAL}/request/em`)
    expect(threadFor({ event_type: 'along.user_message', event_id: 'en' }, USER)).toBe(`inbox/${USER}/en`)

    const store = alongStore = new AlongStore(dbPath())
    store.assertUser(USER, DEVICE)
    store.recordWorkLink({ ticketId: 'ticket-open', workId: 'w_assocwork01', goalId: GOAL, threadKey: `along:${workThread('seg-2')}`, kind: 'ticket' })
    seedInboxEvent(store, 'event-2', GOAL)
    const worklink = createWorkLink({ store, repo: { tickets: { get: () => undefined, save: () => {}, list: () => [], open: () => [], active: () => [] },
      triggers: { get: () => undefined, save: () => {}, disposition: () => undefined, saveDisposition: () => {} } } })
    // 关联 + 在途工作：进入该工作的实际线程（最新在途）
    expect(worklink.threadFor({ event_type: 'along.user_message', event_id: 'ec', goal_id: GOAL, causation_id: 'event-2' }, USER)).toBe(workThread('seg-2'))
    expect(worklink.threadFor({ event_type: 'along.user_message', event_id: 'ec2' }, USER)).toBe(`inbox/${USER}/ec2`) // 信封未带 goal、关联缺失 → inbox 线程
    // 关联指向的目标与信封目标不一致：信封目标胜出，不跨线程（001 §7.2）
    expect(worklink.threadFor({ event_type: 'along.user_message', event_id: 'ec3', goal_id: 'g_other00002', causation_id: 'event-2' }, USER)).toBe('goal/g_other00002/request/ec3')
    // 在途工作结束后：关联只落到该目标的请求线程，不强行恢复
    store.markWorkLinkEnded('ticket-open', new Date().toISOString())
    expect(worklink.threadFor({ event_type: 'along.user_message', event_id: 'ec4', causation_id: 'event-2' }, USER)).toBe(`goal/${GOAL}/request/ec4`)
  })

  it('parses Inbox event ids from Trigger ids and keeps the thread vocabulary forms', () => {
    expect(eventIdFromTriggerId(`along:${USER}:event-1`)).toBe('event-1')
    expect(eventIdFromTriggerId('along:u_x:e')).toBe('e')
    expect(eventIdFromTriggerId('along:u_x')).toBeUndefined()
    expect(eventIdFromTriggerId('github:acme/widgets:12')).toBeUndefined()
    expect(eventIdFromTriggerId('along:u_x:bad/id')).toBeUndefined()
    expect(workThreadId('w_abc')).toBe('work/w_abc')
    expect(workThreadId('w_abc', GOAL)).toBe(`goal/${GOAL}/work/w_abc`)
    expect(workThreadKey('w_abc', GOAL)).toBe(`along:goal/${GOAL}/work/w_abc`)
    expect(threadIdFromKey(`along:goal/${GOAL}/work/w_abc`)).toBe(`goal/${GOAL}/work/w_abc`)
    expect(threadIdFromKey('goal/x/work/y')).toBe('goal/x/work/y')
  })
})

describe('Along worklink: error path (§2.5) — mapping failures never fail the committed transaction', () => {
  it('keeps decision.recorded trace-only and contains mapping write failures', async () => {
    const { h, worklink } = await startAlongHost()
    const { ticket } = await h.acceptedTicket(alongEvent('event-1', '我想每周运动 120 分钟', { human: true, goalId: GOAL, threadId: workThread('seg-1') }))
    expect(worklink.trace().some(line => line.includes('decision.recorded'))).toBe(true)
    expect(sqlCount('SELECT COUNT(*) AS n FROM work_link')).toBe(1) // decision 不建行

    const failing = createWorkLink({ store: { recordWorkLink: () => { throw new Error('boom') } } as unknown as AlongStore, repo: h.runtime.store })
    expect(() => failing.onDomainEvent({ type: 'ticket.created', at: new Date().toISOString(),
      data: { ticketId: ticket.id, decisionId: 'decision-x', strength: 'explicit' } })).not.toThrow()
    expect(failing.errors()).toHaveLength(1)
  })
})
