/**
 * Storage module tests (`along.sqlite`, schema migration, service-layer primitives).
 * Covers the storage-module acceptance rows: BC-08-07 (server-order causality), BC-08-08 (multi-goal links without
 * copied bodies), BC-08-11 (survives restart, version primitives), BC-07-02 (business directory outside the worker
 * execution root), BC-09-02 (stable-ID idempotent legacy import) — plus the transaction and ownership guarantees the
 * other Along modules build on.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { executionRoot } from '../src/app/execution-environment.ts'
import { SettingsSchema } from '../src/policy.ts'
import { AlongService } from '../src/along/service.ts'
import { importLegacy } from '../src/along/legacy-import.ts'
import { ALONG_SCHEMA_VERSION } from '../src/along/schema.ts'
import { AlongIsolationError, AlongStore, OwnershipError, assertAlongDataIsolation } from '../src/along/store.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'along-store-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const USER = 'u_test1234'
const GOAL = 'g_test000001'
const at = (): string => new Date().toISOString()

/** A store with one paired user and one active goal (revision 1, input version 1). */
function seededStore(path = join(directory, 'along.sqlite')): AlongStore {
  const store = new AlongStore(path)
  store.assertUser(USER, 'd_test1234')
  store.insertGoal({ userId: USER, domain: 'health', goalId: GOAL })
  store.appendGoalRevision({ goalId: GOAL, userId: USER, title: '每周运动 120 分钟',
    metric: { type: 'workout', target: 120, unit: '分钟', period: 'week' }, status: 'active' })
  store.ensureInputVersion(USER, GOAL)
  return store
}
const count = (path: string, table: string): number =>
  Number(new DatabaseSync(path).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n)

describe('along.sqlite open, migrate, and durability', () => {
  it('creates the schema at 0600 under WAL, and refuses newer or too-old databases', () => {
    const path = join(directory, 'along.sqlite')
    const store = seededStore(path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const raw = new DatabaseSync(path)
    expect(String(raw.prepare('PRAGMA journal_mode').get()?.journal_mode)).toBe('wal')
    expect(Number(raw.prepare('SELECT value FROM meta WHERE key = \'schema_version\'').get()?.value)).toBe(ALONG_SCHEMA_VERSION)
    raw.close()
    store.close()
    const bump = new DatabaseSync(path)
    bump.prepare('UPDATE meta SET value = ? WHERE key = \'schema_version\'').run(String(ALONG_SCHEMA_VERSION + 1))
    bump.close()
    expect(() => new AlongStore(path)).toThrow(`Unsupported along.sqlite schema version ${ALONG_SCHEMA_VERSION + 1}`)
    const drop = new DatabaseSync(path)
    drop.prepare('UPDATE meta SET value = ? WHERE key = \'schema_version\'').run('0')
    drop.close()
    expect(() => new AlongStore(path)).toThrow(/restore a backup/)
  })

  it('rolls a failed atomic flow back completely — Inbox, business rows, and deliveries commit or vanish together', () => {
    const store = seededStore()
    expect(() => store.atomic(() => {
      store.appendMessage({ userId: USER, eventId: 'e1', role: 'user', direction: 'inbound', text: '这条不该留下来' })
      store.appendSync({ userId: USER, kind: 'message', messageId: 'msg:x', payload: {} })
      store.enqueueDelivery(USER, 'e1', 'along:u:e1')
      throw new Error('boom')
    })).toThrow('boom')
    expect(store.counts(USER)).toEqual({ goals: 1, tasks: 0, messages: 0 })
    expect(store.syncPage(USER, 0, 10).items).toEqual([])
    expect(store.claimDueDeliveries(Date.now(), 10)).toEqual([])
    // Nested savepoints: the outer flow survives an inner caught failure.
    store.atomic(() => {
      try { store.atomic(() => { store.appendMessage({ userId: USER, eventId: 'e2', role: 'user', direction: 'inbound', text: '内层' }); throw new Error('inner') }) }
      catch { /* the caller absorbs and continues */ }
      store.appendMessage({ userId: USER, eventId: 'e3', role: 'user', direction: 'inbound', text: '外层' })
    })
    expect(store.counts(USER).messages).toBe(1)
    store.close()
  })
})

describe('BC-08-07 causality follows the server order, never the client clock', () => {
  it('keeps seq monotonic per user, re-anchoring a resent event to its original row', () => {
    const store = seededStore()
    const b = store.appendMessage({ userId: USER, eventId: 'e-b', role: 'user', direction: 'inbound', text: 'B：今天完成了 40 分钟',
      occurredAt: '2026-11-15T10:00:00Z' })
    const a = store.appendMessage({ userId: USER, eventId: 'e-a', role: 'user', direction: 'inbound', text: 'A：我想每周运动 120 分钟',
      occurredAt: '2026-11-14T08:00:00.000Z' }) // 补传：客户端声明的时间更早，但服务端晚收到
    expect(b.seq).toBe(1)
    expect(a.seq).toBe(b.seq + 1)
    expect(a.occurredAt).toBe('2026-11-14T08:00:00.000Z') // 展示字段原样归一保留，不参与排序
    // 同号重传：锚定同一行，不新落行、不新分配 seq
    const resent = store.appendMessage({ userId: USER, eventId: 'e-a', role: 'user', direction: 'inbound', text: 'A：我想每周运动 120 分钟',
      occurredAt: '2026-11-14T08:00:00.000Z' })
    expect(resent.seq).toBe(a.seq)
    expect(store.counts(USER).messages).toBe(2)
    store.close()
  })

  it('pages the goal conversation chronologically by seq with beforeSeq cursors', () => {
    const store = seededStore()
    const linked: string[] = []
    for (const [index, text] of ['一', '二', '三'].entries()) {
      const message = store.appendMessage({ userId: USER, eventId: `e-${index}`, role: 'user', direction: 'inbound', text })
      store.linkMessageToGoals(message.id, [GOAL], 'direct')
      linked.push(text)
    }
    const first = store.messagesByGoal(USER, GOAL, { limit: 2 })
    expect(first.items.map(message => message.text)).toEqual(['二', '三']) // 最新一页在前，页内按 seq 升序
    expect(first.nextCursor).toBe(String(first.items[0]!.seq))
    const second = store.messagesByGoal(USER, GOAL, { beforeSeq: Number(first.nextCursor), limit: 2 })
    expect(second.items.map(message => message.text)).toEqual(['一'])
    expect(second.nextCursor).toBeUndefined()
    // 补传一条 occurred_at 更早的消息后，页面顺序仍按 seq
    const late = store.appendMessage({ userId: USER, eventId: 'e-late', role: 'user', direction: 'inbound', text: '补传', occurredAt: '2020-01-01T00:00:00Z' })
    store.linkMessageToGoals(late.id, [GOAL], 'direct')
    expect(store.messagesByGoal(USER, GOAL, { limit: 10 }).items.map(message => message.text)).toEqual([...linked, '补传'])
    store.close()
  })
})

describe('BC-08-08 one message, many goals, no copied bodies', () => {
  it('links a message to several goals and keeps one row', () => {
    const store = seededStore()
    const finance = store.insertGoal({ userId: USER, domain: 'finance', goalId: 'g_finance0001' })
    store.appendGoalRevision({ goalId: finance.id, userId: USER, title: '三个月存下 ¥10,000 应急金', metric: { target: 10000 }, status: 'active' })
    const message = store.appendMessage({ userId: USER, eventId: 'e-multi', role: 'user', direction: 'inbound', text: '运动和存款目标都更新一下' })
    store.linkMessageToGoals(message.id, [GOAL, finance.id], 'direct')
    const path = join(directory, 'along.sqlite')
    expect(count(path, 'message')).toBe(1)
    expect(count(path, 'message_goal_link')).toBe(2)
    for (const goalId of [GOAL, finance.id]) {
      const page = store.messagesByGoal(USER, goalId)
      expect(page.items).toHaveLength(1)
      expect(page.items[0]!.text).toBe('运动和存款目标都更新一下')
      expect(page.items[0]!.goals.map(link => link.goalId).sort()).toEqual([GOAL, finance.id].sort())
    }
    // 重复链接与派生链接不复制、不覆盖已有关系
    store.linkMessageToGoals(message.id, [GOAL], 'derived')
    store.linkMessageToGoals(message.id, [GOAL, finance.id], 'direct')
    expect(count(path, 'message_goal_link')).toBe(2)
    expect(store.messagesByGoal(USER, GOAL).items[0]!.goals.map(link => `${link.goalId}:${link.relation}`).sort())
      .toEqual([GOAL, finance.id].map(goalId => `${goalId}:direct`).sort())
    store.close()
  })
})

describe('ownership checks (BC-07-05 storage side)', () => {
  it('answers missing and foreign resources with the same error and no content', () => {
    const store = seededStore()
    const task = store.insertTask({ goalId: GOAL, userId: USER, content: '周三运动 30 分钟' })
    store.appendTaskRevision({ taskId: task.id, userId: USER, basisChangeset: 'cs_x', originEventId: 'e1' })
    const stranger = 'u_stranger'
    expect(store.getGoal(stranger, GOAL)).toBeUndefined()
    expect(() => store.assertGoalOwner(stranger, GOAL)).toThrow(OwnershipError)
    expect(store.getTask(stranger, task.id)).toBeUndefined()
    expect(() => store.assertTaskOwner(stranger, task.id)).toThrow(OwnershipError)
    expect(store.getMessage(stranger, `msg:${USER}:e1`)).toBeUndefined()
    expect(() => store.messagesByGoal(stranger, GOAL)).toThrow(OwnershipError)
    expect(() => store.goalDetail(stranger, GOAL)).toThrow(OwnershipError)
    expect(() => store.listTasks(stranger, { goalId: GOAL })).toThrow(OwnershipError)
    expect(() => store.changeSetsByGoal(stranger, GOAL)).toThrow(OwnershipError)
    expect(() => store.raiseInputVersion(stranger, GOAL, 'e9')).toThrow(OwnershipError)
    expect(store.getChangeSet(stranger, 'cs_x')).toBeUndefined()
    store.close()
  })
})

describe('version primitives', () => {
  it('advances object revisions and input versions monotonically', () => {
    const store = seededStore()
    expect(store.currentRevision('goal', GOAL)).toBe(1)
    expect(store.currentRevision('goal', 'g_missing0000')).toBe(0)
    expect(store.inputVersion(GOAL)).toBe(1)
    expect(store.raiseInputVersion(USER, GOAL, 'e-chat-1')).toBe(2)
    expect(store.inputVersion(GOAL)).toBe(2)
    // 未知目标不可提升
    expect(() => store.raiseInputVersion(USER, 'g_missing0000', 'e')).toThrow(OwnershipError)
    // ensureInputVersion 不覆盖已有版本（导入/建目标路径）
    expect(store.ensureInputVersion(USER, GOAL)).toBe(2)
    // 任务版本：内容同步当前行，完成反馈字段一旦写入不被后续修订清除
    const task = store.insertTask({ goalId: GOAL, userId: USER, content: '周三运动 30 分钟' })
    expect(store.currentRevision('task', task.id)).toBe(0)
    expect(store.appendTaskRevision({ taskId: task.id, userId: USER, basisChangeset: 'cs_1', originEventId: 'e2' })).toBe(1)
    expect(store.appendTaskRevision({ taskId: task.id, userId: USER, status: 'done', originEventId: 'e3', completedFeedbackEventId: 'e3' })).toBe(2)
    const done = store.getTask(USER, task.id)!
    expect(done.status).toBe('done')
    expect(done.completedFeedbackEventId).toBe('e3')
    expect(store.appendTaskRevision({ taskId: task.id, userId: USER, content: '改到周四', scheduledAt: null, basisChangeset: 'cs_2' })).toBe(3)
    const edited = store.getTask(USER, task.id)!
    expect(edited.content).toBe('改到周四')
    expect(edited.completedFeedbackEventId).toBe('e3')
    expect(edited.scheduledAt).toBeUndefined()
    // 目标修订历史可读
    expect(store.goalRevisions(GOAL).map(revision => revision.revision)).toEqual([1])
    store.close()
  })
})

describe('BC-08-11 full conversation, goals, tasks, and change sets survive a restart', () => {
  it('reopens the same file and reads back identical business rows', () => {
    const path = join(directory, 'along.sqlite')
    const store = seededStore(path)
    const task = store.insertTask({ goalId: GOAL, userId: USER, content: '周三运动 30 分钟', scheduledAt: '2026-11-18T07:00:00.000Z' })
    const message = store.appendMessage({ userId: USER, eventId: 'e-open', role: 'user', direction: 'inbound', text: '帮我安排周三的运动',
      timezone: 'Asia/Shanghai', messageId: 'client-1' })
    store.linkMessageToGoals(message.id, [GOAL], 'direct')
    store.saveChangeSet({ id: 'cs_abc', userId: USER, goalId: GOAL, status: 'applied', baseRevision: 1, inputVersion: 2,
      appliedRevision: 2, idempotencyKey: 'idem-1', triggerEventId: 'e-open', workId: 'w_1', ticketId: 'tk_1', assignmentId: 'as_1',
      reason: '按你的要求新增任务', ops: [{ op: 'task.create', content: '周三运动 30 分钟' }] })
    const before = {
      goals: store.listGoals(USER), detail: store.goalDetail(USER, GOAL), tasks: store.listTasks(USER),
      messages: store.messagesByGoal(USER, GOAL), changesets: store.changeSetsByGoal(USER, GOAL),
      revision: store.currentRevision('goal', GOAL), input: store.inputVersion(GOAL),
    }
    store.close()
    const reopened = new AlongStore(path)
    expect(reopened.listGoals(USER)).toEqual(before.goals)
    expect(reopened.goalDetail(USER, GOAL)).toEqual(before.detail)
    expect(reopened.listTasks(USER)).toEqual(before.tasks)
    expect(reopened.messagesByGoal(USER, GOAL)).toEqual(before.messages)
    expect(reopened.changeSetsByGoal(USER, GOAL)).toEqual(before.changesets)
    expect(reopened.currentRevision('goal', GOAL)).toBe(before.revision)
    expect(reopened.inputVersion(GOAL)).toBe(before.input)
    expect(reopened.getTask(USER, task.id)?.scheduledAt).toBe('2026-11-18T07:00:00.000Z')
    expect(reopened.changeSetByIdempotencyKey(USER, 'idem-1')?.ops).toEqual([{ op: 'task.create', content: '周三运动 30 分钟' }])
    // 对话里没有模型隐藏推理字段：行字段只有声明的那些
    expect(Object.keys(reopened.messagesByGoal(USER, GOAL).items[0]!).sort()).toEqual(['causationId', 'createdAt', 'direction', 'eventId', 'goals',
      'id', 'messageId', 'occurredAt', 'receivedAt', 'replyToMessageId', 'role', 'seq', 'text', 'timezone', 'userId'].sort())
    reopened.close()
  })

  it('pages goals, tasks, and change sets across cursors', () => {
    const store = seededStore()
    for (let index = 0; index < 5; index++) {
      const goalId = `g_page${String(index).padStart(7, '0')}`
      store.insertGoal({ userId: USER, domain: 'custom', goalId })
      store.appendGoalRevision({ goalId, userId: USER, title: `目标 ${index}`, status: 'active' })
      store.appendGoalRevision({ goalId, userId: USER, title: `目标 ${index} 修订`, status: 'active' })
    }
    const page1 = store.listGoals(USER, { limit: 3 })
    expect(page1.items).toHaveLength(3)
    const page2 = store.listGoals(USER, { limit: 3, cursor: page1.nextCursor })
    expect(page2.items).toHaveLength(3)
    expect([...page1.items, ...page2.items].map(goal => goal.id)).toEqual(store.listGoals(USER, { limit: 20 }).items.map(goal => goal.id))
    const revised = page1.items[0]!
    expect(revised.currentRevision).toBe(2)
    expect(store.changeSetsByGoal(USER, GOAL).items).toEqual([])
    store.close()
  })
})

describe('BC-07-02 the business data directory stays outside the worker execution root', () => {
  it('passes for sibling directories and fails when either contains the other', () => {
    const root = directory
    const workRoot = executionRoot(SettingsSchema.parse({ executor: { directory: join(root, 'work') } }), join(root, 'state'))
    expect(workRoot).toBe(join(root, 'work'))
    expect(() => assertAlongDataIsolation(join(root, 'along-data'), workRoot)).not.toThrow()
    // 默认执行根（<stateDir>/work）同样不与独立数据目录重叠
    const defaultRoot = executionRoot(SettingsSchema.parse({}), join(root, 'state'))
    expect(defaultRoot).toBe(join(root, 'state', 'work'))
    expect(() => assertAlongDataIsolation(join(root, 'along-data'), defaultRoot)).not.toThrow()
    // 反转：executor.directory 直接指到 along-data → executionRoot 就是它自己 → 启动守卫抛错
    const insideRoot = executionRoot(SettingsSchema.parse({ executor: { directory: join(root, 'along-data') } }), join(root, 'along-data'))
    expect(insideRoot).toBe(join(root, 'along-data'))
    expect(() => assertAlongDataIsolation(join(root, 'along-data'), insideRoot)).toThrow(AlongIsolationError)
    // alongStateDir 落在默认执行根（<stateDir>/work）之内同样抛错
    expect(() => assertAlongDataIsolation(join(root, 'state', 'work', 'along-data'), defaultRoot)).toThrow(AlongIsolationError)
    // Worker 根落在数据目录之内同样拒绝
    expect(() => assertAlongDataIsolation(root, join(root, 'along-data', 'work'))).toThrow(AlongIsolationError)
    expect(() => assertAlongDataIsolation(join(root, 'along-data'), join(root, 'along-data'))).toThrow(AlongIsolationError)
  })
})

describe('BC-09-02 stable-ID idempotent legacy import', () => {
  const exported = {
    goals: {
      health: { title: '每周运动 120 分钟', target: 120, intent: '保持锻炼习惯' },
      finance: { title: '三个月存下 ¥10,000 应急金', target: 10000 },
      custom: null,
      'custom:reading': { title: '每月读两本书' },
    },
    conversations: {
      health: [
        { role: 'user', text: '我想每周运动 120 分钟' },
        { role: 'assistant', text: '好的，已记录你的目标。' },
        { role: 'assistant', text: '这条只在本地，从未发出过', localOnly: true },
        { role: 'user', text: '   ' },
      ],
      finance: [{ role: 'user', text: '帮我记一下存款目标' }],
      custom: [],
    },
  }

  it('imports once, keeps counts and hashes stable on re-import, and reports unmapped keys', () => {
    const store = seededStore()
    const first = importLegacy(store, USER, exported)
    expect(first.goals).toEqual({ seen: 2, imported: 2, existing: 0, unmappedKeys: ['custom:reading'] }) // custom 为 null 不计入 seen
    expect(first.messages).toEqual({ seen: 5, imported: 3, existing: 0, skipped: 2 }) // localOnly 与空白文本跳过但占号
    expect(first.tasks).toEqual({ imported: 0 })
    expect(first.counts).toEqual({ goals: 3, tasks: 0, messages: 3 }) // seeded goal + 2 imported
    // 稳定 ID 与内容
    expect(store.getGoal(USER, 'g_health')?.currentRevision).toBe(1)
    expect(store.currentGoalRevision('g_health')?.metric).toEqual({ target: 120 })
    expect(store.currentGoalRevision('g_health')?.context).toEqual(['保持锻炼习惯'])
    const health = store.messagesByGoal(USER, 'g_health')
    expect(health.items.map(message => message.text)).toEqual(['我想每周运动 120 分钟', '好的，已记录你的目标。'])
    expect(health.items.every(message => message.id.startsWith(`msg:${USER}:import:`))).toBe(true)
    expect(store.inputVersion('g_finance')).toBe(1)
    const second = importLegacy(store, USER, exported)
    expect(second.goals).toEqual({ seen: 2, imported: 0, existing: 2, unmappedKeys: ['custom:reading'] })
    expect(second.messages).toEqual({ seen: 5, imported: 0, existing: 3, skipped: 2 })
    expect(second.counts).toEqual(first.counts)
    expect(second.contentHash).toEqual(first.contentHash)
    expect(second.contentHash.goals).toMatch(/^[0-9a-f]{64}$/)
    expect(second.contentHash.messages).toMatch(/^[0-9a-f]{64}$/)
    // 已删除且无备份的旧消息不会被推测恢复：导出里没有的内容不会出现
    expect(store.counts(USER).messages).toBe(3)
    store.close()
  })

  it('imports into an empty store with the fixed goal ids', () => {
    const store = new AlongStore(join(directory, 'along.sqlite'))
    const report = importLegacy(store, USER, exported)
    expect(report.counts).toEqual({ goals: 2, tasks: 0, messages: 3 }) // custom 为 null：不建 g_custom 行
    for (const goalId of ['g_health', 'g_finance'] as const) {
      const goal = store.getGoal(USER, goalId)
      expect(goal?.status).toBe('active')
      expect(store.currentRevision('goal', goalId)).toBe(1)
      expect(store.currentGoalRevision(goalId)?.basisChangeset).toBeUndefined()
    }
    expect(store.getGoal(USER, 'g_custom')).toBeUndefined()
    expect(report.contentHash.goals).toMatch(/^[0-9a-f]{64}$/)
    store.close()
  })
})

describe('delivery queue semantics for the pump', () => {
  it('claims with a lease, marks delivered, backs off, turns failed with one sync, and keeps filtered terminal', () => {
    const store = seededStore()
    // 用户消息事件进入 Inbox，失败同步才有落点
    store.saveInboxEvent({ userId: USER, eventId: 'e-fail', schemaVersion: '1', eventType: 'along.user_message', deviceId: 'd_test1234',
      receivedAt: at(), payload: { event_type: 'along.user_message', text: 'hi' }, payloadHash: 'hash', status: 'accepted', triggerId: 'along:u:e-fail' })
    store.appendMessage({ userId: USER, eventId: 'e-fail', role: 'user', direction: 'inbound', text: 'hi' })
    store.enqueueDelivery(USER, 'e-ok', 'along:u:e-ok')
    store.enqueueDelivery(USER, 'e-fail', 'along:u:e-fail')
    store.enqueueDelivery(USER, 'e-ok', 'along:u:e-ok') // trigger_id 幂等
    const now = Date.now()
    const claimed = store.claimDueDeliveries(now, 10)
    expect(claimed.map(row => row.triggerId).sort()).toEqual(['along:u:e-fail', 'along:u:e-ok'])
    expect(store.claimDueDeliveries(now + 1000, 10)).toEqual([]) // 30s 租约内不再领取
    expect(store.claimDueDeliveries(now + 31_000, 10)).toHaveLength(2) // 租约到期重回扫描
    store.markDelivered('along:u:e-ok', at())
    expect(store.getDelivery('along:u:e-ok')?.status).toBe('delivered')
    // 失败退避 1s、2s…上限 60s；第 12 次转 failed 并发一次 delivery_failed 同步
    const t0 = '2026-11-15T00:00:00.000Z'
    let result = store.recordDeliveryFailure('along:u:e-fail', t0, 'boom')
    expect(result).toEqual({ attempts: 1, status: 'pending' })
    expect(store.getDelivery('along:u:e-fail')?.nextAttemptAt).toBe(Date.parse(t0) + 1000)
    for (let attempt = 2; attempt <= 11; attempt++) result = store.recordDeliveryFailure('along:u:e-fail', t0, 'boom')
    expect(result).toEqual({ attempts: 11, status: 'pending' })
    expect(store.getDelivery('along:u:e-fail')?.nextAttemptAt).toBe(Date.parse(t0) + 60_000)
    result = store.recordDeliveryFailure('along:u:e-fail', t0, 'boom')
    expect(result).toEqual({ attempts: 12, status: 'failed' })
    expect(store.getDelivery('along:u:e-fail')?.nextAttemptAt).toBe(Date.parse(t0) + 600_000) // 慢节奏续试
    const syncs = store.syncPage(USER, 0, 50).items.filter(item => item.kind === 'delivery_failed')
    expect(syncs).toHaveLength(1)
    expect(syncs[0]!.messageId).toBe(`msg:${USER}:e-fail`)
    store.recordDeliveryFailure('along:u:e-fail', t0, 'boom again')
    expect(store.syncPage(USER, 0, 50).items.filter(item => item.kind === 'delivery_failed')).toHaveLength(1)
    // filtered 终态：不再重试，用户消息同样收到一次失败同步；recordDeliveryFailure 不复活它
    store.saveInboxEvent({ userId: USER, eventId: 'e-filtered', schemaVersion: '1', eventType: 'along.user_message', deviceId: 'd_test1234',
      receivedAt: at(), payload: { event_type: 'along.user_message', text: 'hello' }, payloadHash: 'hash-f', status: 'accepted', triggerId: 'along:u:e-filtered' })
    store.appendMessage({ userId: USER, eventId: 'e-filtered', role: 'user', direction: 'inbound', text: 'hello' })
    store.enqueueDelivery(USER, 'e-filtered', 'along:u:e-filtered')
    store.markDeliveryFiltered('along:u:e-filtered', t0, 'source_uninstalled')
    expect(store.getDelivery('along:u:e-filtered')?.status).toBe('filtered')
    expect(store.syncPage(USER, 0, 50).items.filter(item => item.kind === 'delivery_failed')).toHaveLength(2)
    // 只用显式时刻断言到期扫描，避免墙钟依赖：e-fail 的慢节奏重试时间在 t0 + 600s
    expect(store.claimDueDeliveries(Date.parse(t0) + 600_001, 10).map(row => row.triggerId)).toEqual(['along:u:e-fail'])
    store.recordDeliveryFailure('along:u:e-filtered', t0, 'late failure')
    expect(store.getDelivery('along:u:e-filtered')?.status).toBe('filtered')
    expect(store.syncPage(USER, 0, 50).items.filter(item => item.kind === 'delivery_failed')).toHaveLength(2)
    store.close()
  })
})

describe('health summaries, work links, run records, inbox rows, sync outbox', () => {
  it('stores health summaries idempotently with the server-derived adapter', () => {
    const store = seededStore()
    const summaries = [
      { type: 'steps', metricVersion: 'mv1', unit: 'count', statistic: 'sum', window: { start: '2026-11-14', end: '2026-11-14' },
        value: { value: 5300 }, availability: 'ok' as const, summarizerVersion: 's1' },
      { type: 'sleep', metricVersion: 'mv1', window: { night: '2026-11-14' }, availability: 'not_synced' as const, summarizerVersion: 's1' },
    ]
    store.saveHealthSummary(USER, { eventId: 'he1', timezone: 'Asia/Shanghai', payload: { summaries } }, 'known')
    store.saveHealthSummary(USER, { eventId: 'he1', timezone: 'Asia/Shanghai', payload: { summaries } }, 'known') // 同事件同类型幂等
    expect(store.latestHealthSummaries(USER)).toHaveLength(2)
    const steps = store.latestHealthSummaries(USER).find(row => row.type === 'steps')!
    expect(steps).toMatchObject({ id: `hs:${USER}:he1:steps`, adapter: 'known', windowStart: '2026-11-14', windowEnd: '2026-11-14' })
    expect(steps.value).toEqual({ value: 5300 })
    const sleep = store.latestHealthSummaries(USER).find(row => row.type === 'sleep')!
    expect(sleep).toMatchObject({ availability: 'not_synced', windowStart: '2026-11-14' })
    // 未知类型由接收层判 pending，照存不进上下文
    store.saveHealthSummary(USER, { eventId: 'he2', payload: { summaries: [{ type: 'unknown_metric', metricVersion: 'mv1', availability: 'ok', summarizerVersion: 's1' }] } }, 'pending')
    expect(store.latestHealthSummaries(USER).find(row => row.type === 'unknown_metric')?.adapter).toBe('pending')
    // 四态之外拒绝
    expect(() => store.saveHealthSummary(USER, { eventId: 'he3', payload: { summaries: [{ type: 'steps', metricVersion: 'mv1', availability: 'zero' as never, summarizerVersion: 's1' }] } }, 'known')).toThrow('availability')
    store.close()
  })

  it('keeps one work-link row per ticket across create, assignment update, end, and resume', () => {
    const store = seededStore()
    store.recordWorkLink({ ticketId: 'tk1', workId: 'w_111111111111', goalId: GOAL, eventId: 'e1', triggerId: 'along:u:e1',
      threadKey: 'along:goal/g/work/w_111111111111', kind: 'ticket' })
    expect(store.getWorkLink('tk1')).toMatchObject({ workId: 'w_111111111111', goalId: GOAL, endedAt: undefined })
    expect(store.workLinksForGoal(GOAL)).toHaveLength(1)
    store.recordWorkLink({ ticketId: 'tk1', workId: 'w_111111111111', assignmentId: 'as1', threadKey: 'along:goal/g/work/w_111111111111', kind: 'ticket' })
    expect(store.getWorkLink('tk1')?.assignmentId).toBe('as1')
    expect(store.getWorkLink('tk1')?.goalId).toBe(GOAL) // assignment 更新不清掉目标映射
    store.markWorkLinkEnded('tk1', at())
    expect(store.workLinksForGoal(GOAL)).toHaveLength(0)
    store.recordWorkLink({ ticketId: 'tk1', workId: 'w_222222222222', threadKey: 'along:goal/g/work/w_222222222222', kind: 'resume', eventId: 'e2' })
    expect(store.getWorkLink('tk1')).toMatchObject({ workId: 'w_222222222222', endedAt: undefined, goalId: GOAL })
    expect(store.workLinksForGoal(GOAL)).toHaveLength(1)
    store.close()
  })

  it('converges run-record writes for one assignment and records the tracking links', () => {
    const store = seededStore()
    store.recordRunRecord({ ticketId: 'tk1', assignmentId: 'as1', userId: USER, workId: 'w_1', goalId: GOAL, toolTraceRef: 'session-1:as1', promptRevisions: [3] })
    store.recordRunRecord({ ticketId: 'tk1', assignmentId: 'as1', reportState: 'completed', reportSummary: '任务已完成', changesetId: 'cs_1', endedAt: at() })
    const record = store.getRunRecord('tk1', 'as1')!
    expect(record.id).toBe('rr:tk1:as1')
    expect(record).toMatchObject({ userId: USER, workId: 'w_1', goalId: GOAL, toolTraceRef: 'session-1:as1', reportState: 'completed', changesetId: 'cs_1' })
    expect(record.promptRevisions).toEqual([3])
    expect(record.endedAt).toBeDefined()
    expect(store.changeSetsByWork('w_1')).toEqual([])
    store.close()
  })

  it('stores inbox rows idempotently and sync items with ack state', () => {
    const store = seededStore()
    const base = { userId: USER, eventId: 'e1', schemaVersion: '1', eventType: 'along.user_message', deviceId: 'd_test1234',
      receivedAt: at(), payload: { event_type: 'along.user_message', text: 'hi' }, payloadHash: 'hash-1' }
    expect(store.saveInboxEvent({ ...base, status: 'accepted', triggerId: 'along:u:e1' })).toBe(true)
    expect(store.saveInboxEvent({ ...base, status: 'accepted', triggerId: 'along:u:e1' })).toBe(false)
    expect(store.findInboxEvent(USER, 'e1')?.status).toBe('accepted')
    expect(store.saveInboxEvent({ ...base, eventId: 'e2', status: 'rejected', rejectReason: 'invalid_envelope' })).toBe(true)
    expect(store.findInboxEvent(USER, 'e2')).toMatchObject({ status: 'rejected', rejectReason: 'invalid_envelope' })
    expect(store.findInboxEvent('u_other0000', 'e1')).toBeUndefined()
    const seq1 = store.appendSync({ userId: USER, kind: 'message', messageId: `msg:${USER}:e1`, payload: { text: 'hi' } })
    const seq2 = store.appendSync({ userId: USER, kind: 'goal_updated', goalId: GOAL, payload: {} })
    const page = store.syncPage(USER, 0, 10)
    expect(page.items.map(item => item.seq)).toEqual([seq1, seq2])
    store.markSynced(USER, [seq1])
    const after = store.syncPage(USER, 0, 10)
    expect(after.items[0]!.deliveredAt).toBeDefined()
    expect(after.items[1]!.deliveredAt).toBeUndefined()
    store.markSynced(USER, [])
    store.close()
  })
})

describe('service facade', () => {
  it('delegates to the injected modules and refuses to serve without them', () => {
    const store = seededStore()
    const bare = new AlongService(store)
    const identity = { userId: USER, deviceId: 'd_test1234' }
    expect(() => bare.acceptEvent({ event_id: 'e1' } as never, identity)).toThrow('inbox module is not installed')
    expect(() => bare.commitChangeSet({ idempotency_key: 'k', base_revision: 0, input_version: 1, reason: 'r', ops: [] }, { userId: USER })).toThrow('changeset module is not installed')
    const receipt = { status: 'accepted' as const, event_id: 'e1', received_seq: 1 }
    const result = { status: 'applied' as const, changeset_id: 'cs_1', goal_revision: 2, reused: false }
    const service = new AlongService(store, {
      inbox: { acceptEvent: () => receipt },
      changeset: { commitChangeSet: () => result },
    })
    expect(service.acceptEvent({ event_id: 'e1', schema_version: '1', event_type: 'along.user_message', occurred_at: at(), timezone: 'UTC',
      payload: { event_type: 'along.user_message', text: 'hi' } }, identity)).toEqual(receipt)
    expect(service.commitChangeSet({ idempotency_key: 'k', base_revision: 0, input_version: 1, reason: 'r', ops: [] }, { userId: USER })).toEqual(result)
    expect(service.alongStore.counts(USER).goals).toBe(1)
    store.close()
  })
})
