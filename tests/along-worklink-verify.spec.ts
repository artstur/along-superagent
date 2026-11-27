/**
 * Independent verification of the worklink module (BC-08-03 / BC-08-06, 001 §4.3/§7, 003 §2 阶段 A/§3),
 * covering boundaries the primary spec does not: the UNIQUE 兜底 when a second ticket reaches for an
 * already-mapped thread key (the last layer of "重复事件不产生重复工作"), out-of-order assignment facts
 * against an ended row, the non-Along-source boundary, a goal-less health ticket, re-delivering the same
 * reply sentence, open-work selection after the latest one ends, bounded trace/errors, and the
 * `alongThreads` naming contract the inbox module consumes.
 * Wiring follows §2.5.1 exactly as `tests/along-worklink.spec.ts`: Engine emit wrapped in the orchestrator
 * store's afterCommit into `onDomainEvent`.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import type { EngineOptions } from '../src/core/part.ts'
import { AlongStore } from '../src/along/store.ts'
import { createWorkLink, threadFor, type ThreadNamingEvent } from '../src/along/worklink.ts'
import { alongKind, alongThreads } from '../src/sources/along.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const USER = 'u_verifywk1'
const DEVICE = 'd_verifywk1'
const GOAL = 'g_verifywk01'

let host: Host | undefined
let alongStore: AlongStore | undefined
let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'along-worklink-verify-')) })
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
/** An Along event trigger (the envelopeForTrigger product, §4.6): stable id `along:<user>:<event>`,
 * one thread, goal bound in meta, health events never human. */
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
const messageEvent = (event: string, threadId: string, opts: { causationId?: string } = {}) =>
  alongEvent(event, '这条消息用于边界验证', { human: true, goalId: GOAL, threadId, causationId: opts.causationId })

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
      rules: [{ id: 'along-verify', name: 'Along health', enabled: true, instruction: 'Maintain the existing plan within its authorized goal.' }],
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

/** Seeds the Inbox row acceptEvent would have written for an accepted user message (the association
 * `threadFor` routes on; the inbox module owns the real write, design §2.2). */
function seedInboxEvent(store: AlongStore, eventId: string, goalId: string): void {
  store.saveInboxEvent({ userId: USER, eventId, schemaVersion: '1', eventType: 'along.user_message', deviceId: DEVICE,
    goalId, receivedAt: new Date().toISOString(), payload: { event_type: 'along.user_message', text: 'seeded' },
    payloadHash: 'seeded', status: 'accepted', triggerId: `along:${USER}:${eventId}` })
}

describe('Along worklink verify: the WorkLink unique-mapping backstop of BC-08-03 (001 §4.3, §3 UNIQUE)', () => {
  it('mints a fresh thread for a second ticket reaching for an already-mapped thread key (UNIQUE 兜底)', async () => {
    const { h, store } = await startAlongHost()
    // 工单 A 采用 origin 线程 seg-shared 作为 thread_key
    const first = (await h.acceptedTicket(messageEvent('event-1', workThread('seg-shared')))).ticket
    expect(store.getWorkLink(first.id)?.threadKey).toBe(`along:${workThread('seg-shared')}`)
    // 人工停止 A：Mandate 撤回，同线程再来的消息不再投给 A（intake.ts human-stopped 语义）
    h.runtime.engine.stopTicket(first.id, '用户喊停')
    await h.runtime.idle()
    expect(store.getWorkLink(first.id)?.endedAt).toBeDefined()

    // 第二个工单的 origin 触发器带着同一线程 id：UNIQUE(thread_key) 命中 A 的行 → 回退铸造新线程
    const second = (await h.acceptedTicket(messageEvent('event-2', workThread('seg-shared')))).ticket
    const secondRow = store.getWorkLink(second.id)
    expect(secondRow).toBeDefined()
    expect(secondRow?.threadKey).not.toBe(`along:${workThread('seg-shared')}`)
    expect(secondRow?.threadKey).toBe(`along:goal/${GOAL}/work/${secondRow?.workId}`) // 铸造形态 goal/<goal>/work/<work_id>
    expect(secondRow?.workId).toMatch(/^w_[0-9a-f]{12}$/)
    // 两条行互不覆盖：A 保留采用键，work_id 各自唯一（BC-08-03 的 WorkLink 唯一映射层）
    expect(store.getWorkLink(first.id)?.threadKey).toBe(`along:${workThread('seg-shared')}`)
    expect(store.getWorkLink(first.id)?.workId).not.toBe(secondRow?.workId)
    expect(sqlCount('SELECT COUNT(*) AS n FROM work_link')).toBe(2)
    // 在途集合只含 B：A 已结束，不再计入 openWorksForGoal
    expect(store.workLinksForGoal(GOAL).map(item => item.ticketId)).toEqual([second.id])
  })

  it('never rewrites an ended row nor re-fills a same assignment id (out-of-order dispatch)', async () => {
    const { h, store } = await startAlongHost()
    const { ticket } = await h.acceptedTicket(messageEvent('event-1', workThread('seg-1')))
    const row = store.getWorkLink(ticket.id)!
    const assignmentId = row.assignmentId!

    // 同一 assignment 的事实重放（乱序/重复）：no-op
    const engine = h.runtime.engine as unknown as { options: EngineOptions }
    const emit = engine.options.emit!
    const at = new Date().toISOString()
    emit({ type: 'assignment.started', at, data: { ticketId: ticket.id, assignmentId } })
    const replayed = store.getWorkLink(ticket.id)!
    expect(replayed).toMatchObject({ assignmentId, endedAt: undefined, workId: row.workId })

    // 人工停止后，迟到/重放的 assignment 事实不得改写已结束的行
    h.runtime.engine.stopTicket(ticket.id, '用户喊停')
    expect(store.getWorkLink(ticket.id)?.endedAt).toBeDefined()
    emit({ type: 'assignment.started', at, data: { ticketId: ticket.id, assignmentId: 'asgn-late-1' } })
    emit({ type: 'assignment.ended', at, data: { ticketId: ticket.id, assignmentId: 'asgn-late-1', reason: 'late fact' } })
    const after = store.getWorkLink(ticket.id)!
    expect(after.endedAt).toBeDefined()
    expect(after.assignmentId).toBe(assignmentId)
    expect(after.workId).toBe(row.workId)

    // 幽灵工单的事件不建行也不抛错
    emit({ type: 'ticket.ended', at, data: { ticketId: 'ticket-ghost', by: 'human', outcome: 'stopped' } })
    emit({ type: 'assignment.started', at, data: { ticketId: 'ticket-ghost', assignmentId: 'asgn-ghost' } })
    expect(store.getWorkLink('ticket-ghost')).toBeUndefined()
    expect(sqlCount('SELECT COUNT(*) AS n FROM work_link')).toBe(1)
  })

  it('maps only Along-originated tickets and mints the goal-less thread for a goal-less health ticket', async () => {
    const { h, store, worklink } = await startAlongHost()
    // 非 Along 来源的 ticket.created 不建行（unit 边界：其它 Source 没有 goal/thread 词表）
    const foreign = createWorkLink({ store, repo: {
      tickets: { get: () => ({ id: 'ticket-gh', origin: { triggerId: 'github:acme/widgets:12' } } as never), save: () => {}, list: () => [], open: () => [], active: () => [] },
      triggers: { get: () => ({ id: 'github:acme/widgets:12', source: 'github', threads: [{ source: 'github', id: 'pr/12' }],
        actor: { source: 'github', id: 'alice' }, human: false, at: new Date().toISOString(), text: 'bot', meta: {} } as never),
        save: () => {}, disposition: () => undefined, saveDisposition: () => {} } } })
    foreign.onDomainEvent({ type: 'ticket.created', at: new Date().toISOString(),
      data: { ticketId: 'ticket-gh', decisionId: 'decision-gh', strength: 'explicit' } })
    expect(store.getWorkLink('ticket-gh')).toBeUndefined()
    expect(foreign.errors()).toHaveLength(0)

    // goal-less 健康事件成单：行 goal_id 为空，线程是无目标铸造形态 work/<work_id>，不进该目标的在途集合
    const health = alongEvent('event-healthless', '授权健康摘要更新', { human: false, threadId: `health/${USER}/event-healthless`,
      eventType: 'along.health_summary_updated' })
    h.runtime.receive(health)
    await h.runtime.idle()
    expect(h.candidates()).toContain(health.id)
    // 主动候选经 eval 决策成单（phase0 探针的流程，非显式 route accept）
    await h.runTool(h.runtime.masterId, 'orchestrator_eval', { trigger_id: health.id })
    await h.runTool(h.runtime.masterId, 'orchestrator_eval_decide', {
      trigger_id: health.id, decision: 'accept', title: '调整健康安排', worktree_name: 'along-health-work',
      scope: '按已有目标调整任务', reason: 'authorized goal has changed progress', intent_evidence: 'existing authorized exercise goal',
      acknowledgement: '按授权更新健康安排。',
      rule_assessments: [{ rule_id: 'along-verify', matched: true, reason: 'existing exercise goal' }],
      direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'existing authorized exercise goal' },
    })
    await h.runtime.idle()
    const healthTicket = h.runtime.store.tickets.list().find(item => item.origin.triggerId === health.id)!
    const row = store.getWorkLink(healthTicket.id)!
    expect(row.goalId).toBeUndefined()
    expect(row.eventId).toBe('event-healthless')
    expect(row.threadKey).toMatch(/^along:work\/w_[0-9a-f]{12}$/)
    expect(worklink.openWorksForGoal(GOAL)).toEqual([]) // 不混入 GOAL 的在途集合（BC-08-06 路由参考的边界）
  })
})

describe('Along worklink verify: BC-08-06 boundaries around the one-sentence-one-work rule (003 §3)', () => {
  it('keeps a re-delivered reply sentence (same event id) at exactly one input on one work', async () => {
    const { h, store, worklink } = await startAlongHost()
    await h.acceptedTicket(messageEvent('event-1', workThread('seg-1')))
    await wait(3) // 行的 created_at 有序，最新在途工作可判定
    const secondEvent = messageEvent('event-2', workThread('seg-2'))
    await h.acceptedTicket(secondEvent)
    seedInboxEvent(store, 'event-2', GOAL)

    const replyEvent: ThreadNamingEvent = { event_id: 'event-reply', event_type: 'along.user_message', goal_id: GOAL, causation_id: 'event-2' }
    const reply = messageEvent('event-reply', workThread(worklink.threadFor(replyEvent, USER).split('/').pop()!), { causationId: 'event-2' })
    expect(h.runtime.receive(reply)).toBe('stored')
    await h.runtime.idle()
    const disposition = h.runtime.store.triggers.disposition(reply.id)!
    expect(disposition.fanout).toHaveLength(1)

    // 同一句话同号重投：intake duplicate，不产生第二次输入、第二个工作或第二行映射
    expect(h.runtime.receive(reply)).toBe('duplicate')
    await h.runtime.idle()
    const reachedId = disposition.fanout[0]!
    const reached = h.runtime.store.tickets.get(reachedId)!
    expect(reached.inputs.filter(input => input.kind === 'trigger' && input.triggerId === reply.id)).toHaveLength(1)
    expect(h.runtime.store.tickets.list()).toHaveLength(2)
    expect(sqlCount('SELECT COUNT(*) AS n FROM work_link')).toBe(2)
    expect(store.counts(USER).tasks).toBe(0)
    expect(sqlCount('SELECT COUNT(*) AS n FROM changeset')).toBe(0)
  })

  it('routes an association to the earlier open work thread after the latest one ends', async () => {
    const { h, store, worklink } = await startAlongHost()
    await h.acceptedTicket(messageEvent('event-1', workThread('seg-1')))
    await wait(3)
    const latest = (await h.acceptedTicket(messageEvent('event-2', workThread('seg-2')))).ticket
    // 两个在途时按 created_at 升序，最新在最后（path ② 取 .at(-1) 的依据）
    expect(store.workLinksForGoal(GOAL).map(item => item.ticketId)).toHaveLength(2)

    seedInboxEvent(store, 'event-2', GOAL)
    h.runtime.engine.stopTicket(latest.id, '用户喊停')
    await h.runtime.idle()
    expect(store.workLinksForGoal(GOAL).map(item => item.ticketId)).toHaveLength(1)
    const reply: ThreadNamingEvent = { event_id: 'event-reply', event_type: 'along.user_message', causation_id: 'event-2' }
    // 最新在途已结束：关联回退到仍开放的更早工作线程，不强行恢复（003 §3 的不重复处理）
    expect(worklink.threadFor(reply, USER)).toBe(workThread('seg-1'))
    expect(worklink.openWorksForGoal(GOAL)[0]?.threadKey).toBe(`along:${workThread('seg-1')}`)
  })
})

describe('Along worklink verify: bounded trace and contained errors (§2.5 错误路径)', () => {
  it('caps decision.trace at 100 entries and drops the oldest', async () => {
    const { worklink } = await startAlongHost()
    const at = new Date().toISOString()
    for (let index = 0; index < 105; index++) {
      worklink.onDomainEvent({ type: 'decision.recorded', at, data: { decisionId: `decision-${index}`, kind: 'ignore', threadKey: 'along:x' } })
    }
    expect(worklink.trace()).toHaveLength(100)
    expect(worklink.trace()[0]).toContain('decision-5') // 最早的 5 条被挤出
    expect(worklink.trace().at(-1)).toContain('decision-104')
  })

  it('caps errors at 100 and survives a report sink that itself throws', async () => {
    await startAlongHost()
    const sinkErrors: unknown[] = []
    // repo 替身让 ticket.created 能解析出 Along 触发器并走到 recordWorkLink（那里抛错）
    const failing = createWorkLink({ store: { recordWorkLink: () => { throw new Error('boom') } } as unknown as AlongStore,
      repo: {
        tickets: { get: (id: string) => ({ id, origin: { triggerId: `along:${USER}:e0` } }) as never, save: () => {}, list: () => [], open: () => [], active: () => [] },
        triggers: { get: () => ({ id: `along:${USER}:e0`, source: 'along', threads: [{ source: 'along', id: `goal/${GOAL}/work/x` }],
          actor: { source: 'along', id: USER }, human: true, at: new Date().toISOString(), text: 'x',
          meta: { event_type: 'along.user_message', goal_id: GOAL } }) as never,
          save: () => {}, disposition: () => undefined, saveDisposition: () => {} } },
      report: error => { sinkErrors.push(error); throw new Error('sink broke') } })
    const at = new Date().toISOString()
    for (let index = 0; index < 105; index++) {
      expect(() => failing.onDomainEvent({ type: 'ticket.created', at,
        data: { ticketId: `ticket-${index}`, decisionId: `decision-${index}`, strength: 'explicit' } })).not.toThrow()
    }
    expect(failing.errors()).toHaveLength(100)
    expect(sinkErrors).toHaveLength(105) // 有界的是 errors()；sink 每次失败都被通知，且 sink 抛错不反噬分发
  })
})

describe('Along worklink verify: the naming contract the inbox module consumes (§2.2/§2.5.4)', () => {
  it('wraps threadFor into one along ThreadRef for every naming form', () => {
    const health: ThreadNamingEvent = { event_id: 'eh', event_type: 'along.health_summary_updated' }
    expect(alongThreads(health, USER)).toEqual([{ source: 'along', id: `health/${USER}/eh` }])
    expect(alongThreads({ event_id: 'er', event_type: 'along.user_message', goal_id: GOAL }, USER))
      .toEqual([{ source: 'along', id: `goal/${GOAL}/request/er` }])
    expect(alongThreads({ event_id: 'en', event_type: 'along.user_message' }, USER))
      .toEqual([{ source: 'along', id: `inbox/${USER}/en` }])
    expect(alongThreads({ event_id: 'em', event_type: 'along.message', kind: 'task.feedback', goal_id: GOAL }, USER))
      .toEqual([{ source: 'along', id: `goal/${GOAL}/request/em` }])
  })

  it('never crosses into a work thread without a resolvable association (pure threadFor)', () => {
    // 纯调用（无 store context）：带 causation_id 也解析不了关联 → 请求线程，绝不进任何工作线程
    const attached = { event_id: 'ec', event_type: 'along.user_message', goal_id: GOAL, causation_id: 'event-any' }
    expect(threadFor(attached, USER)).toBe(`goal/${GOAL}/request/ec`)
    expect(threadFor({ event_id: 'ec2', event_type: 'along.user_message', causation_id: 'event-any' }, USER)).toBe(`inbox/${USER}/ec2`)
    // context 里关联指向未知事件：同样回退请求线程
    const worklink = createWorkLink({ store: { findInboxEvent: () => undefined, workLinksForGoal: () => [] } as unknown as AlongStore,
      repo: { tickets: { get: () => undefined, save: () => {}, list: () => [], open: () => [], active: () => [] },
        triggers: { get: () => undefined, save: () => {}, disposition: () => undefined, saveDisposition: () => {} } } })
    expect(worklink.threadFor({ event_id: 'ec3', event_type: 'along.user_message', causation_id: 'event-unknown' }, USER))
      .toBe(`inbox/${USER}/ec3`)
    // 无开放工作（openWorks 空）：关联解析到目标也落请求线程
    const withGoal = createWorkLink({ store: { findInboxEvent: () => ({ goalId: GOAL }), workLinksForGoal: () => [] } as unknown as AlongStore,
      repo: { tickets: { get: () => undefined, save: () => {}, list: () => [], open: () => [], active: () => [] },
        triggers: { get: () => undefined, save: () => {}, disposition: () => undefined, saveDisposition: () => {} } } })
    expect(withGoal.threadFor({ event_id: 'ec4', event_type: 'along.user_message', causation_id: 'event-2' }, USER))
      .toBe(`goal/${GOAL}/request/ec4`)
  })

  it('re-points a mapped row on a non-Along resume trigger and ignores one without a row (dispatch boundary)', async () => {
    const { h, store } = await startAlongHost()
    const { ticket } = await h.acceptedTicket(messageEvent('event-1', workThread('seg-1')))
    const original = store.getWorkLink(ticket.id)!
    // 模块直接分发：非 Along 的 resume 触发器（repo 中查到的是 github 触发器）
    const worklink = createWorkLink({ store, repo: {
      tickets: { get: () => h.runtime.store.tickets.get(ticket.id), save: () => {}, list: () => [], open: () => [], active: () => [] },
      triggers: { get: () => ({ id: 'github:acme/widgets:77', source: 'github', threads: [{ source: 'github', id: 'pr/77' }],
        actor: { source: 'github', id: 'alice' }, human: false, at: new Date().toISOString(), text: 'bot', meta: {} } as never),
        save: () => {}, disposition: () => undefined, saveDisposition: () => {} } } })
    worklink.onDomainEvent({ type: 'ticket.resumed', at: new Date().toISOString(), data: { ticketId: ticket.id, triggerId: 'github:acme/widgets:77' } })
    const repointed = store.getWorkLink(ticket.id)!
    expect(repointed.kind).toBe('resume')
    expect(repointed.workId).not.toBe(original.workId) // resume 换新 work
    expect(repointed.threadKey).toBe(`along:goal/${GOAL}/work/${repointed.workId}`) // 非 Along 线程不可采用 → 铸造
    expect(repointed.goalId).toBe(GOAL) // 行的映射保留
    expect(repointed.eventId).toBe(original.eventId) // 非 Along 触发器没有事件号 → 保留旧值（COALESCE）
    expect(repointed.triggerId).toBe(original.triggerId)
    expect(repointed.assignmentId).toBe(original.assignmentId) // resume 不抹掉已回填的 assignment 事实（COALESCE）
    expect(repointed.endedAt).toBeUndefined() // resume 清 ended 标记

    // 无行 + 非 Along resume：不建行
    worklink.onDomainEvent({ type: 'ticket.resumed', at: new Date().toISOString(), data: { ticketId: 'ticket-ghost', triggerId: 'github:acme/widgets:77' } })
    expect(store.getWorkLink('ticket-ghost')).toBeUndefined()
    expect(worklink.errors()).toHaveLength(0)
  })

  it('returns no scope when the mapping row exists but the ticket left the repo (orphan boundary)', async () => {
    const { store } = await startAlongHost()
    const worklink = createWorkLink({ store, repo: { tickets: { get: () => undefined, save: () => {}, list: () => [], open: () => [], active: () => [] },
      triggers: { get: () => undefined, save: () => {}, disposition: () => undefined, saveDisposition: () => {} } } })
    store.recordWorkLink({ ticketId: 'ticket-orphan', workId: 'w_orphanwork01', goalId: GOAL, threadKey: `along:${workThread('w-orphan')}`, kind: 'ticket' })
    expect(worklink.workScopeForTicket('ticket-orphan')).toBeUndefined() // 无 mandate actor → 无 scope，Along 工具不可用（§4.5）
  })
})
