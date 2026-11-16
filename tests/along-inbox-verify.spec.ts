/**
 * Independent verification of the inbox module (`src/along/envelope.ts` + `src/along/inbox.ts` +
 * `src/along/delivery.ts`) against the acceptance anchors BC-08-01/02/03/11 (docs/business-test-cases.md §BC-08,
 * docs/stage-a-tech-design.md §2.2/§4.1/§4.6). Written from the anchors, not from the implementation's own spec
 * (`tests/along-inbox.spec.ts`): this file probes the edges the anchors name — the failure side of the one
 * transaction (rollback at the last write, not just mid-way), the persistence of the receipt across a restart,
 * a rejected event id retried with *valid* content, dedup that must not repeat work (input version, links),
 * out-of-order `occurred_at` never reordering the conversation, cross-user isolation of the same event id,
 * foreign-task feedback payloads, delivery-lease exclusivity and the one-time failure sync.
 *
 * The case table at the bottom is this review's own two-end static vector set (SD-1/SG-1): the identical
 * `VERIFY_VECTOR_CASES` table runs against the fork zod Schema here and against `web/event-envelope.mjs`
 * `validateEnvelope` in `along/test/event-queue-verify.test.mjs` — both ends must answer the same verdict.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AlongStore } from '../src/along/store.ts'
import { createInbox } from '../src/along/inbox.ts'
import { deliverDueDeliveries, triggerForDelivery } from '../src/along/delivery.ts'
import { EVENT_SCHEMA_VERSION, EventEnvelopeSchema, payloadHash } from '../src/along/envelope.ts'
import type { BoundIdentity, EventEnvelope } from '../src/along/envelope.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'along-inbox-verify-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const USER = 'u_verify001'
const OTHER = 'u_verify002'
const DEVICE = 'd_verify001'
const GOAL = 'g_verify00001'
const OTHER_GOAL = 'g_verify00002'
const TASK = 't_verify00001'
const FOREIGN_TASK = 't_verify09999'
const identity: BoundIdentity = { userId: USER, deviceId: DEVICE }

const path = (): string => join(directory, 'along.sqlite')

function seededStore(dbPath = path()): AlongStore {
  const store = new AlongStore(dbPath)
  store.assertUser(USER, DEVICE)
  store.insertGoal({ userId: USER, domain: 'health', goalId: GOAL })
  store.appendGoalRevision({ goalId: GOAL, userId: USER, title: '每周运动 120 分钟',
    metric: { type: 'workout', target: 120, unit: '分钟', period: 'week' }, status: 'active' })
  store.ensureInputVersion(USER, GOAL)
  return store
}
const count = (dbPath: string, table: string): number =>
  Number(new DatabaseSync(dbPath).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n)

let tick = 0
const userMessage = (overrides: Partial<EventEnvelope> = {}): EventEnvelope => ({
  event_id: `evt-verify-${String(++tick).padStart(3, '0')}`,
  schema_version: EVENT_SCHEMA_VERSION,
  event_type: 'along.user_message',
  occurred_at: '2026-11-15T08:30:00+08:00',
  timezone: 'Asia/Shanghai',
  payload: { event_type: 'along.user_message', text: '帮我把目标改成 180 分钟' },
  ...overrides,
})
const healthEvent = (overrides: Partial<EventEnvelope> = {}): EventEnvelope => userMessage({
  event_type: 'along.health_summary_updated',
  payload: { event_type: 'along.health_summary_updated', summaries: [{ type: 'steps', metric_version: 'mv1',
    timezone: 'Asia/Shanghai', value: 5200, availability: 'ok', summarizer_version: 's1' }] },
  ...overrides,
})
/** A store twin that delegates everything to `store` except the overridden method, which throws. The `depth`
 * seed mirrors `tests/along-inbox.spec.ts`: the private savepoint counter lives on the real instance. */
const failingStore = (store: AlongStore, method: string): AlongStore => {
  const twin = Object.assign(Object.create(store), { [method]: () => { throw new Error(`simulated failure in ${method}`) } })
  ;(twin as unknown as { depth: number }).depth = 0
  return twin as unknown as AlongStore
}

// ---- BC-08-01：一个事务写入 Inbox+业务记录+待投递后才返回持久回执 -----------------------------------------------------

describe('BC-08-01: one transaction, receipt only after it commits', () => {
  it('rolls back everything when the FINAL write (the Inbox row) fails — no receipt, no partial state', () => {
    const dbPath = path()
    const store = seededStore(dbPath)
    const envelope = userMessage({ goal_id: GOAL })
    expect(() => createInbox(failingStore(store, 'saveInboxEvent')).acceptEvent(envelope, identity))
      .toThrow('simulated failure in saveInboxEvent')
    expect(count(dbPath, 'event_inbox')).toBe(0)
    expect(count(dbPath, 'message')).toBe(0)
    expect(count(dbPath, 'delivery')).toBe(0)
    expect(count(dbPath, 'message_goal_link')).toBe(0)
    expect(store.inputVersion(GOAL)).toBe(1) // 输入版本也不推进（半途失败 = 什么都没发生）
    store.close()
  })

  it('rolls back everything when the delivery enqueue fails — the message row does not survive alone', () => {
    const dbPath = path()
    const store = seededStore(dbPath)
    expect(() => createInbox(failingStore(store, 'enqueueDelivery')).acceptEvent(userMessage({ goal_id: GOAL }), identity))
      .toThrow('simulated failure in enqueueDelivery')
    expect(count(dbPath, 'event_inbox')).toBe(0)
    expect(count(dbPath, 'message')).toBe(0)
    expect(count(dbPath, 'delivery')).toBe(0)
    store.close()
  })

  it('rolls back everything when a health-summary write fails mid-branch — no health rows, no Inbox row', () => {
    const dbPath = path()
    const store = seededStore(dbPath)
    expect(() => createInbox(failingStore(store, 'saveHealthSummary')).acceptEvent(healthEvent({ goal_id: GOAL }), identity))
      .toThrow('simulated failure in saveHealthSummary')
    expect(count(dbPath, 'health_summary')).toBe(0)
    expect(count(dbPath, 'event_inbox')).toBe(0)
    expect(count(dbPath, 'delivery')).toBe(0)
    store.close()
  })

  it('the receipt is persistent: rows are readable from a fresh connection after the store is closed (BC-08-01/BC-08-11)', () => {
    const dbPath = path()
    const store = seededStore(dbPath)
    const inbox = createInbox(store)
    const envelope = userMessage({ goal_id: GOAL, payload: { event_type: 'along.user_message', text: '原文 ①：帮我把目标改成 180 分钟 🏃' } })
    const receipt = inbox.acceptEvent(envelope, identity)
    expect(receipt.status).toBe('accepted')
    expect(receipt.received_seq).toBe(1)
    store.close() // 回执已返回 → 数据必须已在磁盘上（WAL+FULL），重启后照常可查

    const reopened = new AlongStore(dbPath)
    const row = reopened.findInboxEvent(USER, envelope.event_id)!
    expect(row.status).toBe('accepted')
    expect(row.triggerId).toBe(`along:${USER}:${envelope.event_id}`)
    const message = reopened.getMessage(USER, `msg:${USER}:${envelope.event_id}`)!
    expect(message.text).toBe('原文 ①：帮我把目标改成 180 分钟 🏃') // 原文逐字保留（BC-08-11）
    expect(message.seq).toBe(1)
    const delivery = reopened.getDelivery(`along:${USER}:${envelope.event_id}`)!
    expect(delivery.status).toBe('pending') // 待投递行留库，重启后由泵续投（至少一次）
    reopened.close()
  })
})

// ---- BC-08-02：失败本地保留、同 event_id 重试、成功才删（服务端侧：同号重试的判定） -------------------------------

describe('BC-08-02: same-id retry answers from the stored row', () => {
  it('a rejected event id retried with VALID content is still rejected with the original reason — never masked as received', () => {
    const dbPath = path()
    const store = seededStore(dbPath)
    const inbox = createInbox(store)
    const broken = { ...userMessage(), schema_version: '2' } // 第一次被拒：invalid_envelope
    expect(inbox.acceptEvent(broken, identity)).toMatchObject({ status: 'rejected', reason: 'invalid_envelope' })
    // 客户端修复内容后用同一个 event_id 重发：仍按存储行的原判定拒绝——被拒事件不得伪装成已接收，
    // 否则客户端按 duplicate/accepted 回执删除本地项就是静默丢失（§2.2.1d）。
    const fixed = userMessage({ event_id: broken.event_id, goal_id: GOAL })
    expect(inbox.acceptEvent(fixed, identity)).toMatchObject({ status: 'rejected', reason: 'invalid_envelope' })
    expect(inbox.acceptEvent(userMessage({ event_id: broken.event_id, payload: { event_type: 'along.user_message', text: '再次换内容' } }), identity))
      .toMatchObject({ status: 'rejected', reason: 'invalid_envelope' })
    expect(count(dbPath, 'event_inbox')).toBe(1) // 不落新行
    expect(count(dbPath, 'message')).toBe(0) // 也没有业务写入
    expect(count(dbPath, 'delivery')).toBe(0)
    store.close()
  })

  it('same id with ONLY occurred_at drifted is a conflict — the hash covers every client-declared field (001 §4.3)', () => {
    const dbPath = path()
    const store = seededStore(dbPath)
    const inbox = createInbox(store)
    const envelope = userMessage({ goal_id: GOAL })
    expect(inbox.acceptEvent(envelope, identity).status).toBe('accepted')
    const clockDrift = userMessage({ event_id: envelope.event_id, goal_id: GOAL, occurred_at: '2026-11-15T09:45:00+08:00' })
    expect(inbox.acceptEvent(clockDrift, identity)).toMatchObject({ status: 'conflict', event_id: envelope.event_id })
    expect(count(dbPath, 'message')).toBe(1) // 冲突不产生任何业务变化
    expect(count(dbPath, 'delivery')).toBe(1)
    expect(payloadHash(envelope)).not.toBe(payloadHash(clockDrift))
    store.close()
  })

  it('the same event id from a DIFFERENT user is an independent event — dedup is per (user_id, event_id)', () => {
    const dbPath = path()
    const store = seededStore(dbPath)
    store.assertUser(OTHER, 'd_verify002')
    store.insertGoal({ userId: OTHER, domain: 'health', goalId: OTHER_GOAL })
    store.ensureInputVersion(OTHER, OTHER_GOAL)
    const inbox = createInbox(store)
    const envelope = userMessage({ event_id: 'evt-shared-0001', goal_id: GOAL })
    expect(inbox.acceptEvent(envelope, identity).status).toBe('accepted')
    const foreignCopy = userMessage({ event_id: 'evt-shared-0001', goal_id: OTHER_GOAL })
    const other: BoundIdentity = { userId: OTHER, deviceId: 'd_verify002' }
    expect(inbox.acceptEvent(foreignCopy, other)).toMatchObject({ status: 'accepted' })
    expect(count(dbPath, 'event_inbox')).toBe(2)
    expect(count(dbPath, 'message')).toBe(2)
    expect(count(dbPath, 'delivery')).toBe(2)
    // 各自只提升自己的目标输入版本
    expect(store.inputVersion(GOAL)).toBe(2)
    expect(store.inputVersion(OTHER_GOAL)).toBe(2)
    store.close()
  })
})

// ---- BC-08-03：重复事件不产生重复工作、返回重复回执 ----------------------------------------------------------------

describe('BC-08-03: a duplicate does no repeated work', () => {
  it('duplicate user_message: no second message/delivery/link, input version NOT raised again, goal revision unchanged', () => {
    const dbPath = path()
    const store = seededStore(dbPath)
    const inbox = createInbox(store)
    const envelope = userMessage({ goal_id: GOAL })
    expect(inbox.acceptEvent(envelope, identity)).toMatchObject({ status: 'accepted', received_seq: 1 })
    const second = inbox.acceptEvent(JSON.parse(JSON.stringify(envelope)), identity)
    expect(second).toEqual({ status: 'duplicate', event_id: envelope.event_id }) // 重复回执不带 received_seq
    expect(count(dbPath, 'message')).toBe(1)
    expect(count(dbPath, 'delivery')).toBe(1)
    expect(count(dbPath, 'message_goal_link')).toBe(1)
    expect(store.inputVersion(GOAL)).toBe(2) // 重复不再提升（001 §7.4：一次新聊天提一次）
    expect(store.getGoal(USER, GOAL)!.currentRevision).toBe(1)
    store.close()
  })

  it('duplicate health event: one row per (user, event, type) — no duplicated summary rows', () => {
    const dbPath = path()
    const store = seededStore(dbPath)
    const inbox = createInbox(store)
    const envelope = healthEvent()
    expect(inbox.acceptEvent(envelope, identity).status).toBe('accepted')
    expect(inbox.acceptEvent(JSON.parse(JSON.stringify(envelope)), identity)).toMatchObject({ status: 'duplicate' })
    expect(count(dbPath, 'health_summary')).toBe(1)
    expect(count(dbPath, 'delivery')).toBe(0)
    store.close()
  })
})

// ---- BC-08-11：用户消息原文先保存；顺序只认服务端 seq（乱序 occurred_at 不改写因果） -------------------------------

describe('BC-08-11: the original text lands first, order is the server seq', () => {
  it('out-of-order occurred_at never reorders the conversation: seq follows receive order (BC-08-07 口径)', () => {
    const dbPath = path()
    const store = seededStore(dbPath)
    const inbox = createInbox(store)
    const first = userMessage({ goal_id: GOAL, occurred_at: '2026-11-15T08:30:00+08:00' }) // 客户端声称更晚
    const second = userMessage({ goal_id: GOAL, occurred_at: '2026-11-14T07:00:00+08:00' }) // 补传的「更早」消息
    const firstReceipt = inbox.acceptEvent(first, identity)
    const secondReceipt = inbox.acceptEvent(second, identity)
    expect(firstReceipt.received_seq).toBe(1)
    expect(secondReceipt.received_seq).toBe(2) // 服务端接收顺序，不看 occurred_at
    const page = store.messagesByGoal(USER, GOAL)
    expect(page.items.map(item => item.seq)).toEqual([1, 2])
    expect(page.items.map(item => item.text)).toEqual(['帮我把目标改成 180 分钟', '帮我把目标改成 180 分钟'])
    // occurred_at 只是展示字段：按客户端声明归一保存，但不参与排序
    expect(page.items[0]!.occurredAt).toBe('2026-11-15T00:30:00.000Z')
    expect(page.items[1]!.occurredAt).toBe('2026-11-13T23:00:00.000Z')
    expect(count(dbPath, 'message')).toBe(2)
    store.close()
  })

  it('an 800-char message (schema ceiling) is stored verbatim', () => {
    const dbPath = path()
    const store = seededStore(dbPath)
    const inbox = createInbox(store)
    const text = '长'.repeat(800)
    const receipt = inbox.acceptEvent(userMessage({ payload: { event_type: 'along.user_message', text } }), identity)
    expect(receipt.status).toBe('accepted')
    expect(store.getMessage(USER, `msg:${USER}:${receipt.event_id}`)!.text).toBe(text)
    store.close()
  })
})

// ---- 越权与归属（BC-07-05 接收侧边界）------------------------------------------------------------------------------

describe('ownership edges at the receive boundary', () => {
  it('feedback whose payload task_id points at a FOREIGN task is refused even when the envelope task_id is own', () => {
    const dbPath = path()
    const store = seededStore(dbPath)
    store.insertTask({ goalId: GOAL, userId: USER, content: '完成 30 分钟快走', taskId: TASK })
    const inbox = createInbox(store)
    const receipt = inbox.acceptEvent(userMessage({ event_id: 'evt-cross-0001', event_type: 'along.message', kind: 'task.completed',
      goal_id: GOAL, task_id: TASK,
      payload: { event_type: 'along.message', kind: 'task.completed', task_id: FOREIGN_TASK } }), identity)
    expect(receipt).toMatchObject({ status: 'rejected', reason: 'not_found' }) // 对外统一 not_found（防存在性泄露）
    expect(store.findInboxEvent(USER, 'evt-cross-0001')!.rejectReason).toBe('ownership') // 内部记精确原因
    expect(count(dbPath, 'message')).toBe(0)
    expect(store.getTask(USER, TASK)!.status).toBe('open') // 越权事件不改变任务状态
    store.close()
  })

  it('authorization.changed referencing a foreign goal is refused as not_found and records nothing else (D15 边界)', () => {
    const dbPath = path()
    const store = seededStore(dbPath)
    store.assertUser(OTHER, 'd_verify002')
    store.insertGoal({ userId: OTHER, domain: 'health', goalId: OTHER_GOAL })
    const inbox = createInbox(store)
    const receipt = inbox.acceptEvent(userMessage({ event_id: 'evt-authf-0001', event_type: 'along.message',
      kind: 'authorization.changed', goal_id: OTHER_GOAL,
      payload: { event_type: 'along.message', kind: 'authorization.changed' } }), identity)
    expect(receipt).toMatchObject({ status: 'rejected', reason: 'not_found' })
    expect(count(dbPath, 'message')).toBe(0)
    expect(count(dbPath, 'delivery')).toBe(0)
    store.close()
  })
})

// ---- 投递泵：租约互斥、失败同步一次、filtered 终态（§2.2.2/§2.2.3）--------------------------------------------------

describe('delivery pump edges', () => {
  it('the 30s claim lease is exclusive: a claimed row is not re-claimed until the lease expires (crashed process resumes)', async () => {
    const store = seededStore()
    const inbox = createInbox(store)
    inbox.acceptEvent(userMessage({ event_id: 'evt-lease-0001' }), identity)
    const now = Date.now()
    expect(store.claimDueDeliveries(now, 10)).toHaveLength(1)
    expect(store.claimDueDeliveries(now + 1_000, 10)).toHaveLength(0) // 租约期内不重复领取
    expect(store.claimDueDeliveries(now + 29_000, 10)).toHaveLength(0)
    const reclaimed = store.claimDueDeliveries(now + 31_000, 10)
    expect(reclaimed).toHaveLength(1) // 租约到期自动重回扫描（至少一次：进程死了行也不丢）
    expect(reclaimed[0]!.status).toBe('pending')
    // 租约重置后再投一次成功收尾
    const deps = { receive: () => 'stored' as const, filteredReason: () => undefined }
    expect(await deliverDueDeliveries(store, deps, now + 62_000)).toBe(1)
    expect(store.getDelivery(`along:${USER}:evt-lease-0001`)!.status).toBe('delivered')
    store.close()
  })

  it('the delivery_failed sync fires exactly once and stays once across continued failures (§2.2.3)', async () => {
    const dbPath = path()
    const store = seededStore()
    const inbox = createInbox(store)
    inbox.acceptEvent(userMessage({ event_id: 'evt-deadv-0001' }), identity)
    const deps = { receive: async () => { throw new Error('down') }, filteredReason: () => undefined }
    let now = Date.now() + 60_000
    for (let attempt = 0; attempt < 14; attempt += 1) {
      await deliverDueDeliveries(store, deps, now)
      now += 700_000
    }
    expect(store.getDelivery(`along:${USER}:evt-deadv-0001`)!.attempts).toBe(14)
    const syncs = new DatabaseSync(dbPath).prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE kind = 'delivery_failed'").get()
    expect(Number(syncs?.n)).toBe(1) // 进入 failed 那次触发一次，之后慢节奏续试不再叠加
    store.close()
  })

  it('a health event never produces a delivery_failed sync, even after 12 failures (sync 是用户消息的答复语义)', async () => {
    const dbPath = path()
    const store = seededStore()
    const inbox = createInbox(store)
    inbox.acceptEvent(healthEvent({ event_id: 'evt-hdead-001' }), identity)
    const deps = { receive: async () => { throw new Error('down') }, filteredReason: () => undefined }
    let now = Date.now() + 60_000
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await deliverDueDeliveries(store, deps, now)
      now += 700_000
    }
    expect(store.getDelivery(`along:${USER}:evt-hdead-001`)).toBeUndefined()
    expect(count(dbPath, 'sync_outbox')).toBe(0)
    store.close()
  })

  it('a filtered user message gets exactly one failure sync and the row is terminal forever (§2.2.2/§2.2.3)', async () => {
    const dbPath = path()
    const store = seededStore()
    const inbox = createInbox(store)
    inbox.acceptEvent(userMessage({ event_id: 'evt-filtv-001' }), identity)
    const deps = { receive: () => 'filtered' as const, filteredReason: () => 'source_disabled' }
    expect(await deliverDueDeliveries(store, deps)).toBe(1)
    expect(await deliverDueDeliveries(store, deps, Date.now() + 3_600_000)).toBe(0) // 终态不再被领取
    expect(store.syncPage(USER, 0, 50).items.filter(item => item.kind === 'delivery_failed')).toHaveLength(1) // 原话另有 message 同步，失败回执仍只有一条
    expect(store.getDelivery(`along:${USER}:evt-filtv-001`)).toMatchObject({ status: 'filtered', lastError: 'source_disabled' })
    store.close()
  })

  it('a task.completed trigger is never human and never addressed (SD-6); meta carries the task', () => {
    const store = seededStore()
    store.insertTask({ goalId: GOAL, userId: USER, content: '完成 30 分钟快走', taskId: TASK })
    const inbox = createInbox(store)
    const envelope = userMessage({ event_id: 'evt-donev-001', event_type: 'along.message', kind: 'task.completed',
      goal_id: GOAL, task_id: TASK,
      payload: { event_type: 'along.message', kind: 'task.completed', task_id: TASK, note: '已完成' } })
    inbox.acceptEvent(envelope, identity)
    const row = store.claimDueDeliveries(Date.now(), 10).find(item => item.eventId === 'evt-donev-001')!
    const trigger = triggerForDelivery(store, row)
    expect(trigger.id).toBe(`along:${USER}:evt-donev-001`)
    expect(trigger.human).toBe(false) // 任务完成反馈是事实，不伪装成人（SD-6/001 §7.1）
    expect(trigger.addressed).toBeUndefined()
    expect(trigger.threads[0]).toEqual({ source: 'along', id: `goal/${GOAL}/request/evt-donev-001` })
    expect(trigger.text).toBe('任务完成反馈：已完成')
    expect(trigger.meta).toMatchObject({ event_type: 'along.message', kind: 'task.completed', task_id: TASK, goal_id: GOAL })
    store.close()
  })
})

// ---- 两端静态向量（SD-1/SG-1 的独立复核）：与 along/test/event-queue-verify.test.mjs 同一张表 -----------------------

const id96 = 'a'.repeat(96)
describe('two-end static vectors (fork side)', () => {
  const base = userMessage({ event_id: 'evt-vecv-0001' })
  const cases: readonly (readonly [string, unknown, boolean])[] = [
    ['最小合法 user_message', base, true],
    ['text 恰 800 字合法', { ...base, event_id: 'evt-vecv-0002', payload: { event_type: 'along.user_message', text: '长'.repeat(800) } }, true],
    ['text 801 字拒绝', { ...base, event_id: 'evt-vecv-0003', payload: { event_type: 'along.user_message', text: '长'.repeat(801) } }, false],
    ['timezone 恰 64 字合法', { ...base, event_id: 'evt-vecv-0004', timezone: 'Z'.repeat(64) }, true],
    ['timezone 65 字拒绝', { ...base, event_id: 'evt-vecv-0005', timezone: 'Z'.repeat(65) }, false],
    ['event_id 恰 96 字合法', { ...base, event_id: id96 }, true],
    ['event_id 97 字拒绝', { ...base, event_id: 'a'.repeat(97) }, false],
    ['event_id 以 - 开头拒绝', { ...base, event_id: '-abc' }, false],
    ['base_revision 0 合法', { ...base, event_id: 'evt-vecv-0006', base_revision: 0 }, true],
    ['base_revision 负数拒绝', { ...base, event_id: 'evt-vecv-0007', base_revision: -1 }, false],
    ['note 恰 500 字合法', { ...base, event_id: 'evt-vecv-0008', event_type: 'along.message', kind: 'task.feedback', task_id: TASK,
      payload: { event_type: 'along.message', kind: 'task.feedback', task_id: TASK, note: '注'.repeat(500) } }, true],
    ['note 501 字拒绝', { ...base, event_id: 'evt-vecv-0009', event_type: 'along.message', kind: 'task.feedback', task_id: TASK,
      payload: { event_type: 'along.message', kind: 'task.feedback', task_id: TASK, note: '注'.repeat(501) } }, false],
    ['20 份摘要合法', { ...base, event_id: 'evt-vecv-0010', event_type: 'along.health_summary_updated',
      payload: { event_type: 'along.health_summary_updated', summaries: Array.from({ length: 20 }, (_, index) => ({
        type: 'steps', metric_version: 'mv1', timezone: 'Asia/Shanghai', availability: 'ok', summarizer_version: 's1', value: index })) } }, true],
    ['21 份摘要拒绝', { ...base, event_id: 'evt-vecv-0011', event_type: 'along.health_summary_updated',
      payload: { event_type: 'along.health_summary_updated', summaries: Array.from({ length: 21 }, (_, index) => ({
        type: 'steps', metric_version: 'mv1', timezone: 'Asia/Shanghai', availability: 'ok', summarizer_version: 's1', value: index })) } }, false],
    ['window 仅 night 合法', { ...base, event_id: 'evt-vecv-0012', event_type: 'along.health_summary_updated',
      payload: { event_type: 'along.health_summary_updated', summaries: [{ type: 'sleep', metric_version: 'mv1',
        window: { night: '2026-11-14T00:00:00+08:00' }, timezone: 'Asia/Shanghai', availability: 'ok', summarizer_version: 's1' }] } }, true],
    ['window 同时带 start/end/night 拒绝', { ...base, event_id: 'evt-vecv-0013', event_type: 'along.health_summary_updated',
      payload: { event_type: 'along.health_summary_updated', summaries: [{ type: 'sleep', metric_version: 'mv1',
        window: { start: '2026-11-14T00:00:00+08:00', end: '2026-11-15T00:00:00+08:00', night: '2026-11-14T00:00:00+08:00' },
        timezone: 'Asia/Shanghai', availability: 'ok', summarizer_version: 's1' }] } }, false],
    ['availability 之外的取值拒绝', { ...base, event_id: 'evt-vecv-0014', event_type: 'along.health_summary_updated',
      payload: { event_type: 'along.health_summary_updated', summaries: [{ type: 'steps', metric_version: 'mv1',
        timezone: 'Asia/Shanghai', availability: 'maybe', summarizer_version: 's1' }] } }, false],
    ['causation_id 非法形状拒绝', { ...base, event_id: 'evt-vecv-0015', causation_id: '带 空 格' }, false],
    ['payload 带多余字段拒绝（strict）', { ...base, event_id: 'evt-vecv-0016',
      payload: { event_type: 'along.user_message', text: 'hello', extra: 1 } }, false],
  ]
  it('fork zod answers the pinned verdict for every case', () => {
    for (const [name, envelope, expected] of cases) {
      expect(EventEnvelopeSchema.safeParse(envelope).success, `向量「${name}」判定失败`).toBe(expected)
    }
  })
  it('the hash does not change when optional fields are absent vs merely shuffled', () => {
    const withOptional = { ...base, task_id: TASK, causation_id: 'causation-0001' }
    const shuffled = { causation_id: 'causation-0001', payload: base.payload, task_id: TASK, occurred_at: base.occurred_at,
      timezone: base.timezone, event_type: base.event_type, schema_version: base.schema_version, event_id: base.event_id }
    expect(payloadHash(withOptional)).toBe(payloadHash(shuffled))
    expect(payloadHash(withOptional)).not.toBe(payloadHash(base))
  })
})
