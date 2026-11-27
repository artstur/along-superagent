/**
 * Record module tests (design §2.6, D7): the host registers one execution record per Worker assignment
 * from domain events alone — never a model call. Acceptance row: 003 §2 阶段 A「每次 Worker 结束都有执行
 * 记录且未调用模型」with the §2.6.3 Stage A proxy hard判定 — `controller.create`（会话创建，fixtures
 * host.ts:171 的 vi.fn）计数差 0 加无新增 worker relay / candidate prompt 投递（business-test-cases §1.2
 * 要求的 DSH 真实模型调用计数在阶段 E 复盘接线时换真计数复核）。Also pinned: the BC-05-01 fields
 * (§2.6.2 — assignment, WorkLink reverse lookup, prompt revisions, tool-trace reference, result,
 * ChangeSet link), the `UNIQUE(ticket_id, assignment_id)` idempotency (§3, host restart converges), the
 * system-side execution note (§2.6.2 — BC-08-11's Stage A outbound half), and the §2.6 error path
 * (registration failures never fail the committed DSH transaction).
 *
 * The domain-event dispatch is wired exactly as the integration module will wire the Runtime (§2.7.2):
 * the fixture Engine's `emit` is wrapped so every real event flows through the orchestrator store's
 * `afterCommit` into worklink + runrecord — no runtime.ts change is needed for this module's
 * verification. BC-07-01's「新增登记路径不引入凭证」re-check rides the integration module's red-line
 * probe; this module's path reads only the WorkLink row, the ticket and the prompt-revision KV, and
 * writes business rows — no credential input exists to introduce (design §2.6, logs record no token,
 * 003 §3).
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EngineOptions } from '../src/core/part.ts'
import { KV } from '../src/kv.ts'
import { workerSessionId } from '../src/executor/dsh.ts'
import { AlongStore } from '../src/along/store.ts'
import { createRunRecord } from '../src/along/runrecord.ts'
import { createWorkLink } from '../src/along/worklink.ts'
import { AlongService } from '../src/along/service.ts'
import { createChangeSetModule } from '../src/along/changeset.ts'
import { alongKind } from '../src/sources/along.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const USER = 'u_record01'
const DEVICE = 'd_record01'
const GOAL = 'g_record001'
const METRIC = { type: 'workout', target: 120, unit: '分钟', period: 'week' }

let host: Host | undefined
let alongStore: AlongStore | undefined
let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'along-runrecord-')) })
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
const workThread = (segment: string): string => `goal/${GOAL}/work/${segment}`
/** An Along user-message trigger on one work thread (the inbox module's trigger shape, §4.6). */
function alongEvent(event: string, text: string) {
  return {
    id: `along:${USER}:${event}`, source: 'along' as const,
    threads: [{ source: 'along' as const, id: workThread(event) }],
    actor: { source: 'along', id: USER }, human: true, addressed: 'direct' as const,
    at: new Date(Date.parse('2026-11-15T00:00:00Z') + Number(event.replace(/\D/g, '')) * 1000).toISOString(),
    text, meta: { event_type: 'along.user_message', goal_id: GOAL },
  }
}

/** A Runtime with the Along source installed and one allowed user, plus the worklink and record modules
 * wired through the orchestrator store's afterCommit (§2.7.2) over a fresh along.sqlite next to the DSH
 * state dir; the record module's prompt lookup reads the orchestrator KV (`KV.sessions.prompts`). */
async function startAlongHost() {
  const h = host = await startRuntime(store => store.saveSettings({ ...store.settings(),
    sources: { along: { enabled: true, config: {} }, github: { enabled: false, config: {} } } }))
  h.runtime.sources.register(alongKind)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings,
    sources: { github: { enabled: false, config: {} }, feishu: { enabled: false, config: {} }, along: { enabled: true, config: {} } },
    policy: { ...settings.policy,
      rules: [{ id: 'along-record', name: 'Along health', enabled: true, instruction: 'Maintain the existing plan within its authorized goal.' }],
      sources: { ...settings.policy.sources, along: { allowed: [{ id: USER }], admission: { health: { unlistedUnaddressed: 'inferred' } } } } },
  })
  const store = alongStore = new AlongStore(dbPath())
  store.assertUser(USER, DEVICE)
  const worklink = createWorkLink({ store, repo: h.runtime.store })
  const runrecord = createRunRecord({ store, repo: h.runtime.store,
    prompts: sessionId => h.runtime.store.get(KV.sessions.prompts(sessionId)) })
  const engine = h.runtime.engine as unknown as { options: EngineOptions }
  const previous = engine.options.emit
  engine.options.emit = event => {
    h.runtime.store.afterCommit(() => { worklink.onDomainEvent(event); runrecord.onDomainEvent(event) })
    previous?.(event)
  }
  return { h, store, worklink, runrecord }
}

/** Seeds the goal the work maintains (revision 1, input version 1) — the ChangeSet commit and the note's
 * goal link need it. */
function seedGoal(store: AlongStore) {
  store.insertGoal({ userId: USER, domain: 'health', goalId: GOAL })
  store.appendGoalRevision({ goalId: GOAL, userId: USER, title: '每周运动 120 分钟', metric: METRIC,
    context: ['保持规律运动'], status: 'active' })
  store.ensureInputVersion(USER, GOAL)
}
/** Seeds the inbound user message of the conversation (the inbox module owns the real write, §2.2). */
function seedConversation(store: AlongStore) {
  const inbound = store.appendMessage({ userId: USER, eventId: 'event-1', role: 'user', direction: 'inbound',
    text: '我想每周运动 120 分钟' })
  store.linkMessageToGoals(inbound.id, [GOAL], 'direct')
}

describe('003 §2 阶段 A 验收③：每次 Worker 结束都有执行记录且未调用模型（D7）', () => {
  it('registers one run record per worker assignment — ensured on start, finalized on end, without a model call', async () => {
    const { h, store, worklink } = await startAlongHost()
    const { ticket } = await h.acceptedTicket(alongEvent('event-1', '我想每周运动 120 分钟'))
    seedGoal(store)
    const row = store.getWorkLink(ticket.id)!
    const assignmentId = row.assignmentId!
    // assignment.started 已确保行：登记粒度的前半边（§2.6.1）
    const started = store.getRunRecord(ticket.id, assignmentId)
    expect(started).toMatchObject({ ticketId: ticket.id, assignmentId, goalId: GOAL, triggerEventId: 'event-1' })
    expect(started?.endedAt).toBeUndefined()
    expect(started?.toolTraceRef).toBe(`${workerSessionId(ticket.id)}:${assignmentId}`)

    // 执行期间的工作上下文：prompt 版本（KV 反查）与关联 ChangeSet（work_id 反查，§4.4）
    h.runtime.store.set(KV.sessions.prompts(workerSessionId(ticket.id)), [7, 9])
    const service = new AlongService(store, { changeset: createChangeSetModule(store) })
    const scope = worklink.workScopeForTicket(ticket.id)!
    // 镜像 along_changes_commit 工具（tools.ts）：宿主把绑定 goal 注入输入，模型不可指定（§4.5）
    const applied = service.commitChangeSet({ idempotency_key: 'record-key-1', base_revision: 1, input_version: 1,
      reason: '调整运动目标', goal_id: scope.allowedGoalId,
      ops: [{ op: 'goal.update', fields: { title: '每周运动 150 分钟' } }] }, scope)
    expect(applied.status).toBe('applied')

    // D7 代理口径（§2.6.3）：结束前后 controller.create 计数差 0，且无新增 worker relay / candidate 投递
    const createsBefore = h.controller.create.mock.calls.length
    const workerRelaysBefore = h.relays(workerSessionId(ticket.id)).length
    const candidatesBefore = h.candidates().length
    h.runtime.engine.report(ticket.id, { state: 'ready', summary: '已完成本周运动安排' })
    await h.runtime.idle()
    expect(h.runtime.store.tickets.get(ticket.id)?.ended).toMatchObject({ by: 'executor', outcome: 'completed' })
    expect(h.controller.create.mock.calls.length).toBe(createsBefore) // 会话创建计数差 0
    expect(h.relays(workerSessionId(ticket.id)).length).toBe(workerRelaysBefore) // 无新增 worker 投递
    expect(h.candidates().length).toBe(candidatesBefore) // 无新增 candidate prompt
    // （工单结束给主 Session 的回执通知走 DSH 自己的 Effects 队列，是宿主既有行为、非模型调用，不在代理口径内。）

    // 终结行（report ready → 工单结束 → ticket.ended 终结 latestAssignment，§2.6.1 实现记录①）：BC-05-01 字段齐（§2.6.2）
    const record = store.getRunRecord(ticket.id, assignmentId)!
    expect(record.id).toBe(`rr:${ticket.id}:${assignmentId}`)
    expect(record).toMatchObject({ userId: USER, workId: row.workId, goalId: GOAL, taskId: undefined,
      triggerEventId: 'event-1', reportState: 'ready', reportSummary: '已完成本周运动安排',
      toolTraceRef: `${workerSessionId(ticket.id)}:${assignmentId}`, changesetId: applied.changeset_id })
    expect(record.promptRevisions).toEqual([7, 9]) // 阶段 A 的 Skill 版本占位口径（§2.6.2）
    expect(record.endedAt).toBeDefined()
    expect(sqlCount('SELECT COUNT(*) AS n FROM run_record')).toBe(1)
  })

  it('converges a replayed registration of the same assignment on one row (UNIQUE 幂等, §2.6/§3)', async () => {
    const { h, store } = await startAlongHost()
    const { ticket } = await h.acceptedTicket(alongEvent('event-1', '我想每周运动 120 分钟'))
    seedGoal(store) // 说明落行带 goal 关联（§2.6.2）；缺目标时整条说明原子回滚、错误被包容
    const assignmentId = store.getWorkLink(ticket.id)!.assignmentId!
    h.runtime.engine.report(ticket.id, { state: 'ready', summary: '已完成' })
    await h.runtime.idle()

    // 宿主重启后的并发登记与正常结束落在同一行（§2.6：重放 assignment.ended / ticket.ended 不产生
    // 第二行、第二条说明、第二条 sync）
    const engine = h.runtime.engine as unknown as { options: EngineOptions }
    const emit = engine.options.emit!
    const at = new Date().toISOString()
    emit({ type: 'assignment.ended', at, data: { ticketId: ticket.id, assignmentId, reason: 'completed' } })
    emit({ type: 'assignment.ended', at, data: { ticketId: ticket.id, assignmentId, reason: 'completed' } })
    emit({ type: 'ticket.ended', at, data: { ticketId: ticket.id, by: 'executor' as const, outcome: 'completed' as const } })
    expect(sqlCount('SELECT COUNT(*) AS n FROM run_record')).toBe(1)
    expect(store.getRunRecord(ticket.id, assignmentId)).toMatchObject({ reportState: 'ready', reportSummary: '已完成' })
    expect(sqlCount('SELECT COUNT(*) AS n FROM message')).toBe(1)
    expect(sqlCount("SELECT COUNT(*) AS n FROM sync_outbox WHERE kind = 'message'")).toBe(1)
    expect(store.getRunRecord(ticket.id, assignmentId)?.endedAt).toBeDefined()
  })
})

describe('BC-08-11 阶段 A 口径：执行说明是完整对话的出站半边（§2.6.2）', () => {
  it('lands the outbound execution note, links it to the goal, and syncs it once', async () => {
    const { h, store, runrecord } = await startAlongHost()
    seedGoal(store)
    seedConversation(store)
    const { ticket } = await h.acceptedTicket(alongEvent('event-1', '我想每周运动 120 分钟'))
    const assignmentId = store.getWorkLink(ticket.id)!.assignmentId!
    h.runtime.engine.report(ticket.id, { state: 'ready', summary: '已完成本周运动安排' })
    await h.runtime.idle()
    expect(runrecord.errors()).toEqual([])

    const note = store.getMessage(USER, `msg:${USER}:out:${ticket.id}:${assignmentId}`)!
    expect(note).toMatchObject({ role: 'assistant', direction: 'outbound' })
    expect(note.text).toContain('执行说明')
    expect(note.text).toContain('ready')
    expect(note.text).toContain('已完成本周运动安排')
    // 按目标回环查询完整对话：入站用户消息（direct）+ 出站执行说明（derived）两个半边（BC-08-11）
    const conversation = store.messagesByGoal(USER, GOAL, { limit: 50 }).items
    expect(conversation.map(item => item.direction)).toEqual(['inbound', 'outbound'])
    expect(conversation[1]!.goals).toEqual([{ goalId: GOAL, relation: 'derived' }])
    const sync = store.syncPage(USER, 0, 50).items.filter(item => item.kind === 'message')
    expect(sync).toHaveLength(1)
    expect(sync[0]!.messageId).toBe(note.id)
    expect(sync[0]!.payload).toMatchObject({ message_id: note.id, goal_id: GOAL, direction: 'outbound' })
  })
})

describe('错误路径与边界（§2.6）', () => {
  it('skips assignments of tickets without an Along work link', async () => {
    const { h, store, runrecord } = await startAlongHost()
    const { ticket } = await h.acceptedTicket(alongEvent('event-1', '我想每周运动 120 分钟'))
    // 同一 Host 里未映射的工单（其他 Source 的工单没有可登记的业务对象，§2.6.2）
    const engine = h.runtime.engine as unknown as { options: EngineOptions }
    const emit = engine.options.emit!
    emit({ type: 'assignment.ended', at: new Date().toISOString(),
      data: { ticketId: 'ticket-unmapped', assignmentId: 'assignment-x', reason: 'completed' } })
    expect(store.getRunRecord('ticket-unmapped', 'assignment-x')).toBeUndefined()
    expect(runrecord.errors()).toEqual([])
    expect(sqlCount('SELECT COUNT(*) AS n FROM run_record')).toBe(1) // 只有 Along 工单的那一行
    expect(ticket).toBeDefined()
  })

  it('contains registration failures — never fails the committed DSH transaction (§2.6 错误路径)', async () => {
    const { h } = await startAlongHost()
    const { ticket } = await h.acceptedTicket(alongEvent('event-1', '我想每周运动 120 分钟'))
    const failing = createRunRecord({ store: { getWorkLink: () => { throw new Error('boom') } } as unknown as AlongStore,
      repo: h.runtime.store })
    expect(() => failing.onDomainEvent({ type: 'assignment.ended', at: new Date().toISOString(),
      data: { ticketId: ticket.id, assignmentId: 'assignment-1', reason: 'completed' } })).not.toThrow()
    expect(failing.errors()).toHaveLength(1)
    // 已提交的 DSH 事务不受登记失败影响：工单照常结束
    h.runtime.engine.report(ticket.id, { state: 'ready', summary: '已完成' })
    await h.runtime.idle()
    expect(h.runtime.store.tickets.get(ticket.id)?.ended).toMatchObject({ by: 'executor', outcome: 'completed' })
  })

  it('lands the execution note atomically and rewrites it on the next event (记录写入走存储同一事务)', async () => {
    const { h, store, runrecord } = await startAlongHost()
    const { ticket } = await h.acceptedTicket(alongEvent('event-1', '我想每周运动 120 分钟'))
    // goal_id 在映射行上但 goal 行缺失（悬空引用）：说明的消息/关联/sync 三步整批回滚，错误被包容
    h.runtime.engine.report(ticket.id, { state: 'ready', summary: '已完成' })
    await h.runtime.idle()
    expect(sqlCount('SELECT COUNT(*) AS n FROM message')).toBe(0)
    expect(sqlCount("SELECT COUNT(*) AS n FROM sync_outbox WHERE kind = 'message'")).toBe(0)
    expect(runrecord.errors()).toHaveLength(1)
    // 下一条事件仍会为同一 assignment 重写（§2.6 错误路径）：goal 补上后重放补齐整条说明
    seedGoal(store)
    const engine = h.runtime.engine as unknown as { options: EngineOptions }
    engine.options.emit!({ type: 'assignment.ended', at: new Date().toISOString(),
      data: { ticketId: ticket.id, assignmentId: store.getWorkLink(ticket.id)!.assignmentId!, reason: 'completed' } })
    expect(sqlCount('SELECT COUNT(*) AS n FROM message')).toBe(1)
    expect(sqlCount("SELECT COUNT(*) AS n FROM sync_outbox WHERE kind = 'message'")).toBe(1)
    expect(store.getRunRecord(ticket.id, store.getWorkLink(ticket.id)!.assignmentId!)).toMatchObject({ reportState: 'ready' })
  })
})
