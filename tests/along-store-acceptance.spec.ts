/**
 * Independent acceptance re-verification of the storage module (tests by the tester, not the author):
 * BC-08-07 (server-order causality — cross-user isolation, tampered resend, display-only occurred_at,
 * cursor negatives, delayed links), BC-08-08 (no partial links, single body row, first relation wins),
 * BC-08-11 (counters and rejected rows continue across a real close/reopen), BC-07-02 (isolation-guard
 * boundary traps), BC-09-02 (numbering with skips, reordered keys, changed/appended re-imports,
 * cross-user isolation, hash-coverage boundary), plus schema completeness and migration rollback.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { executionRoot } from '../src/app/execution-environment.ts'
import { SettingsSchema } from '../src/policy.ts'
import { importLegacy } from '../src/along/legacy-import.ts'
import { ALONG_DDL, ALONG_SCHEMA_VERSION } from '../src/along/schema.ts'
import { AlongIsolationError, AlongStore, OwnershipError, assertAlongDataIsolation } from '../src/along/store.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'along-store-verify-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const USER = 'u_verify001'
const USER2 = 'u_verify002'
const GOAL = 'g_verify001'
const GOAL2 = 'g_verify002'

/** Store with one user and one seeded goal (revision 1, input version 1). */
function seededStore(path = join(directory, 'along.sqlite')): AlongStore {
  const store = new AlongStore(path)
  store.assertUser(USER, 'd_verify001')
  store.insertGoal({ userId: USER, domain: 'health', goalId: GOAL })
  store.appendGoalRevision({ goalId: GOAL, userId: USER, title: '每周运动 120 分钟', status: 'active' })
  store.ensureInputVersion(USER, GOAL)
  return store
}
const message = (store: AlongStore, eventId: string, text: string, occurredAt?: string) =>
  store.appendMessage({ userId: USER, eventId, role: 'user', direction: 'inbound', text, occurredAt })
const countOf = (path: string, sql: string): number => {
  const db = new DatabaseSync(path)
  try { return Number(db.prepare(sql).get()?.n) } finally { db.close() }
}

describe('BC-08-07 server-order causality — boundaries beyond the author suite', () => {
  it('keeps seq monotonic per user under interleaved users, and (user_id, seq) unique', () => {
    const store = seededStore()
    const a1 = message(store, 'ea1', 'A1')
    const b1 = store.appendMessage({ userId: USER2, eventId: 'eb1', role: 'user', direction: 'inbound', text: 'B1' })
    const a2 = message(store, 'ea2', 'A2')
    const b2 = store.appendMessage({ userId: USER2, eventId: 'eb2', role: 'user', direction: 'inbound', text: 'B2' })
    expect([a1.seq, a2.seq]).toEqual([1, 2])
    expect([b1.seq, b2.seq]).toEqual([1, 2]) // per-user counters are independent, interleaving does not skip
    const fresh = store.appendMessage({ userId: 'u_fresh0001', eventId: 'ef1', role: 'user', direction: 'inbound', text: 'F1' })
    expect(fresh.seq).toBe(1)
    store.close()
  })

  it('anchors a resent event id to the original row even when the retransmitted text differs', () => {
    const store = seededStore()
    const first = message(store, 'e-same', '原文：每周 120 分钟')
    const resent = message(store, 'e-same', '被篡改的重传内容')
    expect(resent.seq).toBe(first.seq)
    expect(resent.text).toBe('原文：每周 120 分钟') // 已确认内容不被重传改写；冲突判定归 Inbox payload_hash
    expect(store.counts(USER).messages).toBe(1)
    store.close()
  })

  it('normalizes occurred_at for display only and never lets it influence order', () => {
    const store = seededStore()
    const b = message(store, 'e-b', 'B（服务端先收）', '2026-11-15T10:00:00Z')
    const a = message(store, 'e-a', 'A（补传，客户端时间更早且带时区偏移）', '2026-11-14T16:00:00+08:00')
    expect(a.occurredAt).toBe('2026-11-14T08:00:00.000Z') // isoTime 归一为 UTC，仅展示
    expect(a.seq).toBe(b.seq + 1)
    store.linkMessageToGoals(a.id, [GOAL], 'direct')
    store.linkMessageToGoals(b.id, [GOAL], 'direct')
    expect(store.messagesByGoal(USER, GOAL).items.map(item => item.text)).toEqual(['B（服务端先收）', 'A（补传，客户端时间更早且带时区偏移）'])
    store.close()
  })

  it('rejects malformed seq cursors and pages the exact-limit boundary without duplicates', () => {
    const store = seededStore()
    for (const [index, text] of ['一', '二', '三', '四'].entries()) {
      const m = message(store, `e-p${index}`, text)
      store.linkMessageToGoals(m.id, [GOAL], 'direct')
    }
    expect(() => store.messagesByGoal(USER, GOAL, { limit: 2, cursor: 'not-a-seq' })).toThrow('invalid page cursor')
    expect(store.messagesByGoal(USER, GOAL, { limit: 2, beforeSeq: 0 }).items).toEqual([])
    const first = store.messagesByGoal(USER, GOAL, { limit: 2 })
    expect(first.items.map(item => item.text)).toEqual(['三', '四'])
    const second = store.messagesByGoal(USER, GOAL, { limit: 2, beforeSeq: Number(first.nextCursor) })
    expect(second.items.map(item => item.text)).toEqual(['一', '二'])
    // 恰好取尽的页仍给出游标；下一次翻页返回空页而非报错
    const third = store.messagesByGoal(USER, GOAL, { limit: 2, beforeSeq: Number(second.nextCursor) })
    expect(third.items).toEqual([])
    expect(third.nextCursor).toBeUndefined()
    store.close()
  })

  it('keeps the seq position of a message linked to a goal later than its arrival', () => {
    const store = seededStore()
    const early = message(store, 'e-l1', '先到的消息')
    store.linkMessageToGoals(early.id, [GOAL], 'direct')
    message(store, 'e-l2', '未关联任何目标的消息')
    const later = message(store, 'e-l3', '后补关联的消息')
    store.linkMessageToGoals(later.id, [GOAL], 'direct')
    expect(store.messagesByGoal(USER, GOAL).items.map(item => item.text)).toEqual(['先到的消息', '后补关联的消息'])
    // 未关联目标的消息不出现在任何目标对话里，也没有游离 link 行
    expect(countOf(join(directory, 'along.sqlite'), 'SELECT COUNT(*) AS n FROM message_goal_link')).toBe(2)
    expect(countOf(join(directory, 'along.sqlite'), `SELECT COUNT(*) AS n FROM message WHERE user_id = '${USER}'`)).toBe(3)
    store.close()
  })
})

describe('BC-08-08 one message, many goals — authorization and atomicity of links', () => {
  it('refuses foreign or missing goals and leaves no partial link rows', () => {
    const store = seededStore()
    const foreign = store.insertGoal({ userId: USER2, domain: 'custom', goalId: GOAL2 })
    store.appendGoalRevision({ goalId: foreign.id, userId: USER2, title: '别人的目标', status: 'active' })
    const m = message(store, 'e-x', '同时涉及两个目标的消息')
    expect(() => store.linkMessageToGoals(m.id, [GOAL, GOAL2], 'direct')).toThrow(OwnershipError)
    expect(() => store.linkMessageToGoals(m.id, ['g_missing00000'], 'direct')).toThrow(OwnershipError)
    expect(() => store.linkMessageToGoals('msg:missing:nowhere', [GOAL], 'direct')).toThrow(OwnershipError)
    // 第一个合法目标的 link 已在事务内插入，越权抛错必须把整批回滚
    expect(countOf(join(directory, 'along.sqlite'), 'SELECT COUNT(*) AS n FROM message_goal_link')).toBe(0)
    store.close()
  })

  it('stores exactly one body row for two goals and keeps the first relation on re-link', () => {
    const store = seededStore()
    const finance = store.insertGoal({ userId: USER, domain: 'finance', goalId: 'g_verifyfin' })
    store.appendGoalRevision({ goalId: finance.id, userId: USER, title: '应急金', status: 'active' })
    const body = '运动和存款都按新计划执行'
    const m = message(store, 'e-2g', body)
    store.linkMessageToGoals(m.id, [GOAL], 'derived')
    store.linkMessageToGoals(m.id, [GOAL, finance.id], 'direct') // 重链接不改写既有关系
    const path = join(directory, 'along.sqlite')
    expect(countOf(path, `SELECT COUNT(*) AS n FROM message WHERE text = '${body}'`)).toBe(1)
    expect(countOf(path, 'SELECT COUNT(*) AS n FROM message_goal_link')).toBe(2)
    for (const goalId of [GOAL, finance.id]) {
      const page = store.messagesByGoal(USER, goalId)
      expect(page.items).toHaveLength(1)
      expect(page.items[0]!.text).toBe(body)
    }
    expect(store.messagesByGoal(USER, GOAL).items[0]!.goals).toContainEqual({ goalId: GOAL, relation: 'derived' })
    expect(store.messagesByGoal(USER, GOAL).items[0]!.goals).toContainEqual({ goalId: finance.id, relation: 'direct' })
    store.close()
  })
})

describe('BC-08-11 storage side — continuity across a real close/reopen', () => {
  it('continues seq, revision, and input-version counters instead of resetting them', () => {
    const path = join(directory, 'along.sqlite')
    const store = seededStore(path)
    const task = store.insertTask({ goalId: GOAL, userId: USER, content: '周三运动 30 分钟' })
    store.appendTaskRevision({ taskId: task.id, userId: USER, basisChangeset: 'cs_a' })
    message(store, 'e-r1', '第一条')
    message(store, 'e-r2', '第二条')
    store.raiseInputVersion(USER, GOAL, 'e-r2')
    store.close()
    const reopened = new AlongStore(path)
    expect(message(reopened, 'e-r3', '重启后的补传消息').seq).toBe(3)
    expect(reopened.raiseInputVersion(USER, GOAL, 'e-r3')).toBe(3)
    expect(reopened.appendTaskRevision({ taskId: task.id, userId: USER, content: '改到周四' })).toBe(2)
    expect(reopened.appendGoalRevision({ goalId: GOAL, userId: USER, title: '每周运动 150 分钟', status: 'active' })).toBe(2)
    expect(reopened.currentRevision('goal', GOAL)).toBe(2)
    expect(reopened.getTask(USER, task.id)!.completedFeedbackEventId).toBeUndefined()
    reopened.appendTaskRevision({ taskId: task.id, userId: USER, status: 'done', completedFeedbackEventId: 'e-done' })
    reopened.close()
    const again = new AlongStore(path)
    expect(again.getTask(USER, task.id)!.completedFeedbackEventId).toBe('e-done') // 完成反馈字段跨重启保留
    again.close()
  })

  it('persists rejected inbox rows, sync ack state, and pagination cursors across restart', () => {
    const path = join(directory, 'along.sqlite')
    const store = seededStore(path)
    store.saveInboxEvent({ userId: USER, eventId: 'e-rej', schemaVersion: '1', eventType: 'along.user_message', deviceId: 'd_verify001',
      receivedAt: new Date().toISOString(), payload: {}, payloadHash: 'h', status: 'rejected', rejectReason: 'invalid_envelope' })
    for (const [index, text] of ['一', '二', '三', '四'].entries()) {
      const m = message(store, `e-c${index}`, text)
      store.linkMessageToGoals(m.id, [GOAL], 'direct')
    }
    const firstPage = store.messagesByGoal(USER, GOAL, { limit: 2 })
    const seq1 = store.appendSync({ userId: USER, kind: 'message', payload: { text: '一' } })
    const seq2 = store.appendSync({ userId: USER, kind: 'goal_updated', payload: {} })
    store.markSynced(USER, [seq1])
    store.close()
    const reopened = new AlongStore(path)
    expect(reopened.findInboxEvent(USER, 'e-rej')).toMatchObject({ status: 'rejected', rejectReason: 'invalid_envelope' })
    const acked = reopened.syncPage(USER, 0, 10).items
    expect(acked.find(item => item.seq === seq1)!.deliveredAt).toBeDefined()
    expect(acked.find(item => item.seq === seq2)!.deliveredAt).toBeUndefined()
    // 重启前拿到的消息游标重启后仍有效
    const rest = reopened.messagesByGoal(USER, GOAL, { limit: 2, beforeSeq: Number(firstPage.nextCursor) })
    expect(rest.items.map(item => item.text)).toEqual(['一', '二'])
    reopened.close()
  })
})

describe('BC-07-02 isolation guard — boundary traps', () => {
  const root = (): string => directory

  it('does not confuse sibling prefixes and resolves traversal before comparing', () => {
    const base = root()
    // 前缀陷阱：along-data 与 along-data2 互不包含
    expect(() => assertAlongDataIsolation(join(base, 'along-data'), join(base, 'along-data2'))).not.toThrow()
    // `..` 穿越后逃出 worker 根：合法
    expect(() => assertAlongDataIsolation(join(base, 'work', '..', 'along-data'), join(base, 'work'))).not.toThrow()
    // `..`/`.` 折叠后正好等于 worker 根：拒绝
    expect(() => assertAlongDataIsolation(join(base, 'work', '.', 'sub', '..'), join(base, 'work'))).toThrow(AlongIsolationError)
    // 折叠后落进 worker 根：拒绝
    expect(() => assertAlongDataIsolation(join(base, 'work', 'x', '..', 'along-data'), join(base, 'work'))).toThrow(AlongIsolationError)
    // 尾斜杠归一后相等：拒绝
    expect(() => assertAlongDataIsolation(join(base, 'along-data') + '/', join(base, 'along-data'))).toThrow(AlongIsolationError)
  })

  it('treats dot-prefixed directory names as children in either containment direction', () => {
    const base = root()
    const workRoot = join(base, 'work')
    const dataRoot = join(base, 'along-data')
    // A directory named `..private` is not the parent traversal segment `..`.
    for (const name of ['..private', '...']) {
      expect(() => assertAlongDataIsolation(join(workRoot, name), workRoot)).toThrow(AlongIsolationError)
      expect(() => assertAlongDataIsolation(dataRoot, join(dataRoot, name))).toThrow(AlongIsolationError)
    }
    expect(() => assertAlongDataIsolation(join(base, '..private'), workRoot)).not.toThrow()
  })

  it('enforces exactly the executionRoot contract against the real default root', () => {
    const base = root()
    const stateDir = join(base, 'state')
    const workRoot = executionRoot(SettingsSchema.parse({}), stateDir)
    expect(workRoot).toBe(join(stateDir, 'work'))
    // 兄弟目录（含位于 stateDir 下但不在 executionRoot 内）通过守卫——守卫契约只有 executionRoot；
    // SD-5 要求整体在 stateDir 之外由调用方（Runtime 装配）保证
    expect(() => assertAlongDataIsolation(join(base, 'along-data'), workRoot)).not.toThrow()
    expect(() => assertAlongDataIsolation(join(stateDir, 'along-data'), workRoot)).not.toThrow()
    expect(() => assertAlongDataIsolation(join(stateDir, 'work', 'inner'), workRoot)).toThrow(AlongIsolationError)
    // executor.directory 显式指到数据目录自身：拒绝
    const explicit = executionRoot(SettingsSchema.parse({ executor: { directory: join(base, 'along-data') } }), stateDir)
    expect(() => assertAlongDataIsolation(join(base, 'along-data'), explicit)).toThrow(AlongIsolationError)
  })
})

describe('BC-09-02 legacy import — numbering, ordering, and re-import boundaries', () => {
  it('lets skipped entries occupy their number so ids are a pure function of export shape', () => {
    const store = seededStore()
    const report = importLegacy(store, USER, {
      goals: { health: { title: '每周运动 120 分钟' } },
      conversations: { health: [
        { role: 'user', text: '第一条' },
        { role: 'assistant', text: '只在本地', localOnly: true },
        { text: '缺 role' },
        { role: 'user', text: '   ' },
        { role: 'user', text: '第二条' },
      ] },
    })
    expect(report.messages).toEqual({ seen: 5, imported: 2, existing: 0, skipped: 3 })
    const path = join(directory, 'along.sqlite')
    expect(countOf(path, `SELECT COUNT(*) AS n FROM message WHERE id = 'msg:${USER}:import:1'`)).toBe(1)
    expect(countOf(path, `SELECT COUNT(*) AS n FROM message WHERE id = 'msg:${USER}:import:2'`)).toBe(0)
    expect(countOf(path, `SELECT COUNT(*) AS n FROM message WHERE id = 'msg:${USER}:import:4'`)).toBe(0)
    expect(countOf(path, `SELECT COUNT(*) AS n FROM message WHERE id = 'msg:${USER}:import:5'`)).toBe(1)
    store.close()
  })

  it('produces identical ids and hashes regardless of export key order', () => {
    const goals = { health: { title: '每周运动 120 分钟' }, finance: { title: '应急金' }, custom: { title: '读书' } }
    const conversations = { health: [{ role: 'user', text: 'H1' }, { role: 'user', text: 'H2' }], finance: [{ role: 'user', text: 'F1' }], custom: [{ role: 'user', text: 'C1' }] }
    const canonical = importLegacy(new AlongStore(join(directory, 'a.sqlite')), USER, { goals, conversations })
    const reversed = importLegacy(new AlongStore(join(directory, 'b.sqlite')), USER,
      { goals: { custom: goals.custom, finance: goals.finance, health: goals.health },
        conversations: { custom: conversations.custom, finance: conversations.finance, health: conversations.health } })
    expect(reversed.contentHash).toEqual(canonical.contentHash)
    expect(reversed.counts).toEqual(canonical.counts)
    expect(reversed.counts).toEqual({ goals: 3, tasks: 0, messages: 4 })
  })

  it('does not overwrite confirmed content when a changed export is re-imported, and imports only appended positions', () => {
    const store = seededStore()
    const base = { goals: { health: { title: '每周运动 120 分钟' } }, conversations: { health: [{ role: 'user', text: '原始第一句' }] } }
    importLegacy(store, USER, base)
    const tampered = importLegacy(store, USER, {
      goals: base.goals, conversations: { health: [{ role: 'user', text: '被篡改的第一句' }] } })
    expect(tampered.messages).toEqual({ seen: 1, imported: 0, existing: 1, skipped: 0 })
    expect(store.messagesByGoal(USER, 'g_health').items[0]!.text).toBe('原始第一句')
    // 追加条目只新增尾部位置，老位置报告 existing
    const extended = importLegacy(store, USER, {
      goals: base.goals,
      conversations: { health: [{ role: 'user', text: '原始第一句' }, { role: 'user', text: '追加第二句' }, { role: 'user', text: '追加第三句' }] } })
    expect(extended.messages).toEqual({ seen: 3, imported: 2, existing: 1, skipped: 0 })
    expect(store.messagesByGoal(USER, 'g_health').items.map(item => item.text)).toEqual(['原始第一句', '追加第二句', '追加第三句'])
    store.close()
  })

  it('documents that the fixed import ids are global: a second user importing the same export fails the constraint', () => {
    // 已知边界（D1 本地单用户）：g_health/g_finance/g_custom 是全局固定 id，goal.id 又是主键，
    // 因此同一 Mac 上第二个 user_id 导入同一导出会以原生 UNIQUE 约束错误失败并整体回滚。
    // 生产路径（配对换机 user_id 不变，001 §2.4.1）不会触发；在此锁定现状防止静默改变。
    const store = seededStore()
    const exported = { goals: { health: { title: '每周运动 120 分钟' } }, conversations: { health: [{ role: 'user', text: '用户甲的对话' }] } }
    importLegacy(store, USER, exported)
    expect(() => importLegacy(store, USER2, exported)).toThrow(/UNIQUE constraint failed: goal\.id/)
    expect(store.counts(USER2)).toEqual({ goals: 0, tasks: 0, messages: 0 }) // 第二个用户的导入整体回滚，无残留
    expect(store.getMessage(USER2, `msg:${USER2}:import:1`)).toBeUndefined()
    store.close()
  })

  it('never lets one user read or ack another user\u2019s import rows', () => {
    const store = seededStore()
    const exported = { goals: { health: { title: '每周运动 120 分钟' } }, conversations: { health: [{ role: 'user', text: '用户甲的对话' }] } }
    importLegacy(store, USER, exported)
    expect(store.getGoal(USER2, 'g_health')).toBeUndefined() // B 查 A 的固定 id 目标：不可见（BC-07-05 存储侧）
    expect(store.getMessage(USER2, `msg:${USER}:import:1`)).toBeUndefined() // B 查不到 A 的消息行
    expect(() => store.messagesByGoal(USER2, 'g_health')).toThrow(OwnershipError)
    store.close()
  })

  it('imports conversations of uncreated goals unlinked, outside the message content hash', () => {
    // 已知边界（实现说明 6）：custom 目标不导入，其对话仍占号导入但不建 link——计数可见、
    // 目标对话查询不可见；contentHash.messages 只覆盖已链接到三个固定目标的消息。
    const store = seededStore()
    const make = (customText: string) => ({
      goals: { health: { title: '每周运动 120 分钟' } },
      conversations: { health: [{ role: 'user', text: '健康原文' }], custom: [{ role: 'user', text: customText }] },
    })
    const first = importLegacy(store, USER, make('自定义甲'))
    expect(first.counts.messages).toBe(2)
    const reimport = importLegacy(store, USER, make('自定义甲'))
    expect(reimport.messages).toEqual({ seen: 2, imported: 0, existing: 2, skipped: 0 }) // 重导入幂等
    const path = join(directory, 'along.sqlite')
    expect(countOf(path, `SELECT COUNT(*) AS n FROM message_goal_link WHERE message_id = 'msg:${USER}:import:2'`)).toBe(0)
    const other = new AlongStore(join(directory, 'other.sqlite'))
    const second = importLegacy(other, USER, make('自定义乙')) // 仅 custom 对话文本不同
    expect(second.counts.messages).toBe(first.counts.messages)
    expect(second.contentHash.messages).toBe(first.contentHash.messages) // 核对 hash 不覆盖未链接消息（已登记的边界）
    expect(second.contentHash.goals).toBe(first.contentHash.goals)
    other.close()
    store.close()
  })
})

describe('schema completeness and migration rollback', () => {
  it('creates every table and index named in the DDL and stamps the schema version', () => {
    const path = join(directory, 'along.sqlite')
    const store = new AlongStore(path)
    const db = new DatabaseSync(path)
    const present = new Set(db.prepare("SELECT name FROM sqlite_master").all().map(row => String(row.name)))
    db.close()
    for (const match of ALONG_DDL.matchAll(/CREATE (?:TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS (\w+)/g)) {
      expect(present.has(match[1]!)).toBe(true)
    }
    expect(present.has('goal_user_status')).toBe(true)
    expect(present.has('message_user_seq')).toBe(true)
    store.close()
  })

  it('rolls a failed baseline migration back so the file keeps exactly its prior content', () => {
    const path = join(directory, 'broken.sqlite')
    const planted = new DatabaseSync(path)
    planted.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)') // 无版本行 → 视为待迁移
    planted.exec('CREATE TABLE message_user_seq (stub TEXT)') // 与 DDL 的索引名冲突，使事务中途失败
    planted.close()
    expect(() => new AlongStore(path)).toThrow(/message_user_seq/)
    const after = new DatabaseSync(path)
    const names = after.prepare('SELECT name, type FROM sqlite_master ORDER BY name').all()
      .map(row => `${row.type}:${row.name}`)
    after.close()
    expect(names).toContain('table:message_user_seq')
    expect(names).toContain('table:meta')
    expect(names).not.toContain('table:goal') // ROLLBACK 后无半套 DDL
    expect(names).not.toContain('index:message_user_seq')
    // 句柄已关闭：文件可再次打开并同样失败
    expect(() => new AlongStore(path)).toThrow(/message_user_seq/)
  })

  it('treats a non-numeric schema version as absent and re-stamps it idempotently', () => {
    const path = join(directory, 'garbage.sqlite')
    const planted = new DatabaseSync(path)
    planted.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    planted.prepare('INSERT INTO meta VALUES (?, ?)').run('schema_version', 'not-a-number')
    planted.close()
    const store = new AlongStore(path)
    const db = new DatabaseSync(path)
    expect(String(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value)).toBe(String(ALONG_SCHEMA_VERSION))
    db.close()
    store.close()
  })
})

describe('contract guardrails other modules build on', () => {
  it('replays a ChangeSet idempotency key as the first row, never a second row', () => {
    const store = seededStore()
    const first = { id: 'cs_first', userId: USER, goalId: GOAL, status: 'applied' as const, baseRevision: 1, inputVersion: 1,
      appliedRevision: 2, idempotencyKey: 'k1', reason: '第一次提交', ops: [{ op: 'task.create', content: 'A' }] }
    expect(store.saveChangeSet(first)).toBe(true)
    expect(store.saveChangeSet({ ...first, id: 'cs_second', status: 'conflicted' as const })).toBe(false)
    const replay = store.changeSetByIdempotencyKey(USER, 'k1')
    expect(replay?.id).toBe('cs_first')
    expect(replay?.status).toBe('applied')
    expect(countOf(join(directory, 'along.sqlite'), "SELECT COUNT(*) AS n FROM changeset WHERE idempotency_key = 'k1'")).toBe(1)
    store.close()
  })

  it('scopes sync acknowledgement to the owning user', () => {
    const store = seededStore()
    store.assertUser(USER2, 'd_verify002')
    const seqA = store.appendSync({ userId: USER, kind: 'message', payload: {} })
    const seqB = store.appendSync({ userId: USER2, kind: 'message', payload: {} })
    store.markSynced(USER, [seqB]) // A 用 B 的 seq ack：不得跨用户生效
    expect(store.syncPage(USER2, 0, 10).items[0]!.deliveredAt).toBeUndefined()
    expect(store.syncPage(USER, 0, 10).items[0]!.seq).toBe(seqA)
    store.markSynced(USER2, [seqB])
    expect(store.syncPage(USER2, 0, 10).items[0]!.deliveredAt).toBeDefined()
    store.close()
  })

  it('queues one delivery per trigger id and claims due rows in seq order', () => {
    const store = seededStore()
    store.enqueueDelivery(USER, 'e1', 'along:u:e1')
    store.enqueueDelivery(USER, 'e1', 'along:u:e1') // 同 trigger 幂等
    store.enqueueDelivery(USER, 'e1', 'e1::g/goal::replan') // D9 派生编号是不同 trigger，允许成行
    const claimed = store.claimDueDeliveries(Date.now(), 10)
    expect(claimed).toHaveLength(2)
    expect(claimed.map(row => row.triggerId)).toEqual(['along:u:e1', 'e1::g/goal::replan'])
    expect(store.claimDueDeliveries(Date.now() + 1000, 10)).toEqual([]) // 30s 租约内不再领取
    store.close()
  })

  it('keeps the first health summary row for a resent event even if availability changes', () => {
    const store = seededStore()
    const summary = { type: 'steps', metricVersion: 'mv1', availability: 'ok' as const, value: { value: 5300 }, summarizerVersion: 's1' }
    store.saveHealthSummary(USER, { eventId: 'he1', payload: { summaries: [summary] } }, 'known')
    store.saveHealthSummary(USER, { eventId: 'he1', payload: { summaries: [{ ...summary, availability: 'no_permission' as const, value: undefined }] } }, 'known')
    const rows = store.latestHealthSummaries(USER)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ availability: 'ok', id: `hs:${USER}:he1:steps` })
    expect(rows[0]!.value).toEqual({ value: 5300 })
    store.close()
  })

  it('clamps page limits to the 1..200 contract', () => {
    const store = seededStore()
    for (let index = 0; index < 205; index++) {
      const goalId = `g_bulk${String(index).padStart(7, '0')}`
      store.insertGoal({ userId: USER, domain: 'custom', goalId })
      store.appendGoalRevision({ goalId, userId: USER, title: `批量 ${index}`, status: 'active' })
    }
    expect(store.listGoals(USER, { limit: 0 }).items).toHaveLength(1)
    expect(store.listGoals(USER, { limit: 5000 }).items).toHaveLength(200)
    expect(store.listGoals(USER, { limit: -3 }).items).toHaveLength(1)
    store.close()
  })

  it('rebinds the paired device on request and keeps it when no device is given; absent input version reads 0', () => {
    const path = join(directory, 'pairing.sqlite')
    const deviceOf = (): string | undefined => {
      const db = new DatabaseSync(path)
      try { return db.prepare('SELECT device_id FROM user WHERE id = ?').get(USER)?.device_id as string | undefined } finally { db.close() }
    }
    const store = new AlongStore(path)
    store.assertUser(USER, 'd_first001')
    expect(deviceOf()).toBe('d_first001')
    store.assertUser(USER) // 配对重试未带 device：不改动绑定
    expect(deviceOf()).toBe('d_first001')
    store.assertUser(USER, 'd_second001') // 换机重绑（001 §2.4.1：user_id 不变）
    expect(deviceOf()).toBe('d_second001')
    // 不存在的目标读版本：goal revision 与 input version 一致为 0，旧基准永远匹配不上
    expect(store.currentRevision('goal', 'g_absent0001')).toBe(0)
    expect(store.inputVersion('g_absent0001')).toBe(0)
    store.close()
  })
})
