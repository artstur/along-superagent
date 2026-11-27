/**
 * Independent verification of the record module (003 §2 阶段 A 验收③「每次 Worker 结束都有执行记录且未调用模型」D7,
 * business-test-cases §1.2 计数口径 / BC-05-01 / BC-07-01), covering boundaries the primary spec does not:
 * the failure end (BC-05-01「成功或失败各一次」), the report-less human stop, the retry path's replaced
 * assignment (multi-assignment, one row each), the out-of-order replay (an ensure arriving after the
 * finalize must not unfinalize the row), the never-registered row at `ticket.ended`, and the BC-07-01
 * no-credential access surface at module scale (the end-to-end env/cwd/prompt probe stays with the
 * integration module, §2.7.5). Wiring follows §2.7.2 exactly as tests/along-runrecord.spec.ts: Engine
 * emit wrapped in the orchestrator store's afterCommit into worklink + runrecord.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KV } from '../src/kv.ts'
import { workerSessionId } from '../src/executor/dsh.ts'
import { AlongStore } from '../src/along/store.ts'
import { createRunRecord, type RunRecordDeps } from '../src/along/runrecord.ts'
import { createWorkLink } from '../src/along/worklink.ts'
import { alongKind } from '../src/sources/along.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const USER = 'u_recverify1'
const DEVICE = 'd_recverify1'
const GOAL = 'g_recverify01'
const METRIC = { type: 'workout', target: 120, unit: '分钟', period: 'week' }

let host: Host | undefined
let alongStore: AlongStore | undefined
let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'along-runrecord-verify-')) })
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
let tick = 0
function alongEvent(text: string) {
  tick += 1
  const event = `event-${tick}`
  return {
    id: `along:${USER}:${event}`, source: 'along' as const,
    threads: [{ source: 'along' as const, id: workThread(event) }],
    actor: { source: 'along', id: USER }, human: true, addressed: 'direct' as const,
    at: new Date(Date.parse('2026-11-15T00:00:00Z') + tick * 1000).toISOString(),
    text, meta: { event_type: 'along.user_message', goal_id: GOAL },
  }
}

async function startAlongHost() {
  const h = host = await startRuntime(store => store.saveSettings({ ...store.settings(),
    sources: { along: { enabled: true, config: {} }, github: { enabled: false, config: {} } } }))
  h.runtime.sources.register(alongKind)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings,
    sources: { github: { enabled: false, config: {} }, feishu: { enabled: false, config: {} }, along: { enabled: true, config: {} } },
    policy: { ...settings.policy,
      rules: [{ id: 'along-record-verify', name: 'Along health', enabled: true, instruction: 'Maintain the existing plan within its authorized goal.' }],
      sources: { ...settings.policy.sources, along: { allowed: [{ id: USER }], admission: { health: { unlistedUnaddressed: 'inferred' } } } } },
  })
  const store = alongStore = new AlongStore(dbPath())
  store.assertUser(USER, DEVICE)
  const worklink = createWorkLink({ store, repo: h.runtime.store })
  const runrecord = createRunRecord({ store, repo: h.runtime.store,
    prompts: sessionId => h.runtime.store.get(KV.sessions.prompts(sessionId)) })
  const engine = h.runtime.engine as unknown as { options: { emit?: (event: never) => void } }
  const previous = engine.options.emit
  engine.options.emit = event => {
    h.runtime.store.afterCommit(() => { worklink.onDomainEvent(event); runrecord.onDomainEvent(event) })
    previous?.(event)
  }
  return { h, store, worklink, runrecord }
}

function seedGoal(store: AlongStore) {
  store.insertGoal({ userId: USER, domain: 'health', goalId: GOAL })
  store.appendGoalRevision({ goalId: GOAL, userId: USER, title: '每周运动 120 分钟', metric: METRIC,
    context: ['保持规律运动'], status: 'active' })
  store.ensureInputVersion(USER, GOAL)
}

/** The Stage A proxy of 「未调用模型」(§2.6.3): session creation is the model-call surface, and an end
 * delivers no worker relay nor candidate prompt. Asserted as hard diffs across each end window. */
function assertNoModelCall(h: Host, before: { creates: number; workerRelays: number; candidates: number }, ticketId: string) {
  expect(h.controller.create.mock.calls.length).toBe(before.creates)
  expect(h.relays(workerSessionId(ticketId)).length).toBe(before.workerRelays)
  expect(h.candidates().length).toBe(before.candidates)
}
const modelCallCounters = (h: Host, ticketId: string) => ({ creates: h.controller.create.mock.calls.length,
  workerRelays: h.relays(workerSessionId(ticketId)).length, candidates: h.candidates().length })

describe('003 §2 验收③（D7）+ BC-05-01：每次 Worker 结束都有执行记录且未调用模型', () => {
  it('成功与失败各结束一次：各登记一行、各落一条说明，两次结束的模型调用计数差均为 0', async () => {
    const { h, store } = await startAlongHost()
    seedGoal(store)

    // 第一次结束：成功（report ready → ticket.ended，tickets.ts:358-361）
    const t1 = (await h.acceptedTicket(alongEvent('我想每周运动 120 分钟'))).ticket
    const a1 = store.getWorkLink(t1.id)!.assignmentId!
    const before1 = modelCallCounters(h, t1.id)
    expect(before1.creates).toBeGreaterThan(0) // 计数面非空对照：worker Session 建立时 create 确实被计过
    const masterBefore = h.relays(h.runtime.masterId).length
    h.runtime.engine.report(t1.id, { state: 'ready', summary: '已完成本周运动安排' })
    await h.runtime.idle()
    assertNoModelCall(h, before1, t1.id)
    const row1 = store.getRunRecord(t1.id, a1)!
    expect(row1).toMatchObject({ userId: USER, goalId: GOAL, taskId: undefined, triggerEventId: `event-1` })
    expect(row1.reportState).toBe('ready')
    expect(row1.endedAt).toBeDefined()
    expect(row1.toolTraceRef).toBe(`${workerSessionId(t1.id)}:${a1}`)
    expect(row1.promptRevisions).toBeUndefined() // prompts 依赖在缺 KV 值时不落占位（旧值不清空）
    expect(store.getMessage(USER, `msg:${USER}:out:${t1.id}:${a1}`)?.text).toContain('已完成本周运动安排')

    // 第二次结束：失败（report dropped → outcome dropped，assignments.ts:131）
    const t2 = (await h.acceptedTicket(alongEvent('把目标改成 150 分钟'))).ticket
    const a2 = store.getWorkLink(t2.id)!.assignmentId!
    const before2 = modelCallCounters(h, t2.id)
    h.runtime.engine.report(t2.id, { state: 'dropped', summary: '目标已不适用' })
    await h.runtime.idle()
    assertNoModelCall(h, before2, t2.id)
    const row2 = store.getRunRecord(t2.id, a2)!
    expect(row2.reportState).toBe('dropped')
    expect(row2.endedAt).toBeDefined()
    expect(store.getMessage(USER, `msg:${USER}:out:${t2.id}:${a2}`)?.text).toContain('dropped')

    // 每次结束都有且只有一行；两行互不覆盖（BC-05-01：登记粒度是 Assignment）
    expect(sqlCount('SELECT COUNT(*) AS n FROM run_record')).toBe(2)
    expect(row1.id).not.toBe(row2.id)
    // 活性对照：结束期间宿主 Effects 管道照常给主 Session 发回执（计数面是活的，0 差不是死系统）
    expect(h.relays(h.runtime.masterId).length).toBeGreaterThan(masterBefore)
  })

  it('人工停止（无 report 的结束）仍终结一行，说明走兜底文案，结束不调模型', async () => {
    const { h, store } = await startAlongHost()
    seedGoal(store)
    const { ticket } = await h.acceptedTicket(alongEvent('我想每周运动 120 分钟'))
    const assignmentId = store.getWorkLink(ticket.id)!.assignmentId!
    expect(store.getRunRecord(ticket.id, assignmentId)).toBeDefined() // started 已确保行
    const before = modelCallCounters(h, ticket.id)
    h.runtime.engine.stopTicket(ticket.id, '用户喊停')
    await h.runtime.idle()
    assertNoModelCall(h, before, ticket.id)
    const row = store.getRunRecord(ticket.id, assignmentId)!
    expect(row.endedAt).toBeDefined()
    expect(row.reportState).toBeUndefined() // 无 report 的结束：结果字段留空
    const note = store.getMessage(USER, `msg:${USER}:out:${ticket.id}:${assignmentId}`)!
    expect(note.role).toBe('assistant')
    expect(note.direction).toBe('outbound')
    expect(note.text).toContain('用户喊停')
    expect(sqlCount('SELECT COUNT(*) AS n FROM run_record')).toBe(1)
  })

  it('retry 路径：被替换的 Assignment 由 assignment.ended 终结，每个 Assignment 各一行（tickets.ts:172→389）', async () => {
    const { h, store } = await startAlongHost()
    seedGoal(store)
    const { ticket } = await h.acceptedTicket(alongEvent('我想每周运动 120 分钟'))
    const a1 = store.getWorkLink(ticket.id)!.assignmentId!
    h.runtime.engine.report(ticket.id, { state: 'failed', summary: '执行失败' })
    await h.runtime.idle()
    expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeUndefined() // failed 不结束工单

    const beforeRetry = h.controller.create.mock.calls.length
    h.runtime.engine.retryTicket(ticket.id) // endAssignment(a1,'retried') → assignment.ended + 新 Assignment
    const rowA = store.getRunRecord(ticket.id, a1)!
    expect(rowA.endedAt).toBeDefined()
    expect(rowA.reportState).toBe('failed')
    expect(h.controller.create.mock.calls.length).toBe(beforeRetry) // retry 复用同一 worker Session，不建新会话
    await h.runtime.idle() // 新 Assignment 启动
    const a2 = store.getWorkLink(ticket.id)!.assignmentId!
    expect(store.getRunRecord(ticket.id, a2)).toBeDefined() // 新 Assignment 的行已确保
    expect(store.getRunRecord(ticket.id, a2)!.endedAt).toBeUndefined()

    const before = modelCallCounters(h, ticket.id)
    h.runtime.engine.report(ticket.id, { state: 'ready', summary: '重试后完成' })
    await h.runtime.idle()
    assertNoModelCall(h, before, ticket.id)
    expect(sqlCount('SELECT COUNT(*) AS n FROM run_record')).toBe(2)
    expect(store.getRunRecord(ticket.id, a2)).toMatchObject({ reportState: 'ready', reportSummary: '重试后完成' })
    expect(store.getRunRecord(ticket.id, a2)!.endedAt).toBeDefined()
    // 每个 Assignment 各落一条说明（确定性 id 按Assignment 区分）
    expect(store.getMessage(USER, `msg:${USER}:out:${ticket.id}:${a1}`)?.text).toContain('执行失败')
    expect(store.getMessage(USER, `msg:${USER}:out:${ticket.id}:${a2}`)?.text).toContain('重试后完成')
    expect(sqlCount("SELECT COUNT(*) AS n FROM message WHERE text LIKE '执行说明%'")).toBe(2)
  })
})

describe('乱序与缺登记边界（重放收敛）', () => {
  it('乱序重放：终结后补到的 assignment.started 不回退终结（store.ts COALESCE upsert 不清空已终结字段）', async () => {
    const { h, store, runrecord } = await startAlongHost()
    seedGoal(store)
    const { ticket } = await h.acceptedTicket(alongEvent('我想每周运动 120 分钟'))
    const assignmentId = store.getWorkLink(ticket.id)!.assignmentId!
    h.runtime.engine.report(ticket.id, { state: 'ready', summary: '已完成' })
    await h.runtime.idle()
    const final = store.getRunRecord(ticket.id, assignmentId)!
    expect(final.endedAt).toBeDefined()

    runrecord.onDomainEvent({ type: 'assignment.started', at: new Date().toISOString(),
      data: { ticketId: ticket.id, assignmentId } } as never) // 乱序：终结后重放 started（ensure）
    const after = store.getRunRecord(ticket.id, assignmentId)!
    expect(after.endedAt).toBe(final.endedAt)
    expect(after.reportState).toBe('ready')
    expect(after.reportSummary).toBe('已完成')
    expect(sqlCount('SELECT COUNT(*) AS n FROM run_record')).toBe(1)
    expect(sqlCount('SELECT COUNT(*) AS n FROM message')).toBe(1)
    expect(runrecord.errors()).toEqual([])
  })

  it('ticket.ended 遇未登记行（ensure 一次失败后）：当前实现静默跳过，正常结束路径无后续事件补齐——收敛缺口', async () => {
    const { h, store, runrecord } = await startAlongHost()
    seedGoal(store)
    const { ticket } = await h.acceptedTicket(alongEvent('我想每周运动 120 分钟'))
    const assignmentId = store.getWorkLink(ticket.id)!.assignmentId!
    // 确保行存在后删除，模拟 assignment.started 时的登记失败（错误被包容、无行）
    const db = new DatabaseSync(dbPath())
    try { db.prepare('DELETE FROM run_record').run() } finally { db.close() }
    expect(store.getRunRecord(ticket.id, assignmentId)).toBeUndefined()
    const startedAt = (h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1) as { startedAt?: string }).startedAt
    expect(startedAt).toBeDefined() // Assignment 自身带着「已启动」事实（assignments.ts:38）

    runrecord.onDomainEvent({ type: 'ticket.ended', at: new Date().toISOString(),
      data: { ticketId: ticket.id, by: 'executor' as const, outcome: 'completed' as const } } as never)
    // 当前行为：行缺失 → 跳过且不记错误；正常结束路径只有 ticket.ended，之后无事件补齐 → 记录永久缺失
    expect(store.getRunRecord(ticket.id, assignmentId)).toBeUndefined()
    expect(runrecord.errors()).toEqual([])
    expect(sqlCount('SELECT COUNT(*) AS n FROM message')).toBe(0)
  })
})

describe('BC-07-01（模块口径）：新增登记路径不引入凭证', () => {
  const ALLOWED_STORE = new Set(['getWorkLink', 'recordRunRecord', 'getRunRecord', 'changeSetsByWork', 'atomic',
    'getMessage', 'appendMessage', 'linkMessageToGoals', 'appendSync'])
  const FAKE = { KIMI_API_TOKEN: 'kimi-fake-token-123', ALONG_BRIDGE_TOKEN: 'bridge-fake-token-456', DSH_ADMIN_TOKEN: 'dsh-fake-token-789' }

  it('登记全生命周期的依赖访问面收敛在声明范围内，合成凭证不入行不入说明', async () => {
    const saved = new Map(Object.entries(FAKE).map(([k]) => [k, process.env[k]]))
    for (const [k, v] of Object.entries(FAKE)) process.env[k] = v
    try {
      const { h, store } = await startAlongHost()
      seedGoal(store)
      const storeAccess: string[] = [], repoAccess: string[] = []
      const logged = <T extends object>(log: string[]) => ({ get: (target: T, prop: PropertyKey, receiver?: unknown): unknown => {
        const value = Reflect.get(target, prop, receiver)
        if (typeof prop === 'string' && prop !== 'then') log.push(prop)
        // 方法绑定到真实 receiver：只记录顶层 API 访问，store 内部自调用不计入访问面
        return typeof value === 'function' ? (value as (...args: never[]) => unknown).bind(target) : value
      } })
      const realRepo = h.runtime.store
      const proxiedStore = new Proxy(store, logged(storeAccess))
      const proxiedRepo = new Proxy(realRepo, logged(repoAccess))
      const runrecord = createRunRecord({ store: proxiedStore, repo: proxiedRepo as RunRecordDeps['repo'],
        prompts: sessionId => realRepo.get(KV.sessions.prompts(sessionId)) })
      const engine = h.runtime.engine as unknown as { options: { emit?: (event: never) => void } }
      const previous = engine.options.emit
      engine.options.emit = event => {
        realRepo.afterCommit(() => runrecord.onDomainEvent(event))
        previous?.(event)
      }
      const { ticket } = await h.acceptedTicket(alongEvent('我想每周运动 120 分钟'))
      const assignmentId = (store as AlongStore).getWorkLink(ticket.id)!.assignmentId!
      h.runtime.engine.report(ticket.id, { state: 'ready', summary: '已完成' })
      await h.runtime.idle()

      // 访问面收敛：store 方法 ⊆ 允许清单（无任何 env/token/credential 形态的依赖被触达）
      const unique = (list: string[]) => [...new Set(list)]
      for (const key of unique(storeAccess)) expect(ALLOWED_STORE, `登记路径触达了未声明的 store 依赖: ${key}`).toContain(key)
      for (const key of unique(repoAccess)) expect(key, `登记路径触达了未声明的 repo 依赖: ${key}`).toBe('tickets')
      // 合成凭证不入行：登记行与执行说明全文不含三类合成凭证值
      const row = (store as AlongStore).getRunRecord(ticket.id, assignmentId)!
      expect(row).toBeDefined()
      const note = (store as AlongStore).getMessage(USER, `msg:${USER}:out:${ticket.id}:${assignmentId}`)?.text ?? ''
      const surfaces = [JSON.stringify(row), note]
      for (const value of Object.values(FAKE)) for (const surface of surfaces) expect(surface).not.toContain(value)
    } finally {
      for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    }
  })

  it('静态面：runrecord.ts 不引入 Node 内建模块、不读 process.env（登记路径无凭证输入）', () => {
    const source = readFileSync(new URL('../src/along/runrecord.ts', import.meta.url), 'utf8')
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map(match => match[1]!)
    expect(imports.length).toBeGreaterThan(0)
    for (const specifier of imports) expect(specifier.startsWith('node:'), `登记模块引入了 Node 内建模块: ${specifier}`).toBe(false)
    expect(source).not.toContain('process.env')
    expect(source).not.toContain('child_process')
  })
})
