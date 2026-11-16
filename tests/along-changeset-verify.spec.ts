/**
 * Independent verification of the version module (BC-08-04/05/09, BC-07-03/04) — boundary and negative
 * cases beyond tests/along-changeset.spec.ts, written from the acceptance anchors and design §4.4, not from
 * the implementation. Pins the refusal codes' precedence, the rollback of a mid-apply crash, the
 * task-only-commit write-qualification boundary (dev note 2 / design §2.3.2), the BC-02-04 replay
 * asymmetry on a schema-invalid retry body, and the「改回去」snapshot constraints.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createChangeSetModule, type ChangeSetInput, type CommitScope } from '../src/along/changeset.ts'
import { AlongService } from '../src/along/service.ts'
import { alongTools, type AlongToolsHost } from '../src/along/tools.ts'
import { AlongStore } from '../src/along/store.ts'

let directory: string
let dbPath: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'along-verify-')); dbPath = join(directory, 'along.sqlite') })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const USER = 'u_verify_u01'
const OTHER = 'u_verify_o02'
const GOAL = 'g_verify_g001'
const OTHER_GOAL = 'g_verify_g002'
const METRIC = { type: 'workout', target: 120, unit: '分钟', period: 'week' }

function seededStore(): AlongStore {
  const store = new AlongStore(dbPath)
  store.assertUser(USER, 'd_verify_001')
  store.insertGoal({ userId: USER, domain: 'health', goalId: GOAL })
  store.appendGoalRevision({ goalId: GOAL, userId: USER, title: '每周运动 120 分钟', metric: METRIC,
    context: ['保持规律运动'], status: 'active' })
  store.ensureInputVersion(USER, GOAL)
  return store
}

let store: AlongStore
let service: AlongService
beforeEach(() => { store = seededStore(); service = new AlongService(store, { changeset: createChangeSetModule(store) }) })

let keys = 0
const scope = (over: Partial<CommitScope> = {}): CommitScope =>
  ({ userId: USER, allowedGoalId: GOAL, ticketId: 'ticket-v', assignmentId: 'as-v', workId: 'w_verifyw0001', ...over })
const input = (over: Partial<ChangeSetInput> = {}, goalId?: string): ChangeSetInput =>
  ({ idempotency_key: `vkey-${++keys}`, base_revision: 1, input_version: 1, reason: '验证用变更',
    ...(goalId !== undefined ? { goal_id: goalId } : {}), ops: [], ...over })
const commit = (over: Partial<ChangeSetInput> = {}, commitScope: CommitScope = scope()) =>
  service.commitChangeSet(input(over, commitScope.allowedGoalId), commitScope)
/** Commit with an explicit key so the test can look the audit row up afterwards. */
const commitWithKey = (key: string, over: Partial<ChangeSetInput> = {}, commitScope: CommitScope = scope()) =>
  service.commitChangeSet(input({ idempotency_key: key, ...over }, commitScope.allowedGoalId), commitScope)

const goalContent = () => {
  const revision = store.currentGoalRevision(GOAL)
  return { title: revision?.title, target: (revision?.metric as { target?: number } | undefined)?.target, status: revision?.status }
}
const businessRowCounts = () => {
  const raw = new DatabaseSync(dbPath)
  try {
    const count = (table: string): number =>
      Number(raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n)
    return { goalRevisions: count('goal_revision'), tasks: count('user_task'), taskRevisions: count('task_revision'),
      sync: count('sync_outbox'), changesets: count('changeset') }
  } finally { raw.close() }
}

describe('BC-08-04 boundary: every stale-version shape refuses and leaves the state untouched', () => {
  it('refuses a task.create commit claiming a stale goal base_revision and writes nothing', () => {
    const stale = commitWithKey('vkey-stale-task', { base_revision: 0, ops: [{ op: 'task.create', content: '周日晨跑 40 分钟' }] })
    expect(stale).toEqual({ status: 'conflicted', reason: 'conflicted_revision' })
    expect(store.currentRevision('goal', GOAL)).toBe(1)
    expect(store.listTasks(USER, { goalId: GOAL }).items).toHaveLength(0)
    const row = store.changeSetByIdempotencyKey(USER, 'vkey-stale-task')
    expect(row).toMatchObject({ status: 'conflicted', goalId: GOAL, baseRevision: 0, inputVersion: 1 })
    expect(businessRowCounts().sync).toBe(0) // conflicted 不产生同步载荷
  })

  it('refuses a task.cancel against an outdated task revision; the task stays open', () => {
    const created = commit({ ops: [{ op: 'task.create', content: '周日晨跑 40 分钟' }] })
    const taskId = (store.getChangeSet(USER, created.changeset_id!)?.result as { tasks: { task_id: string }[] }).tasks[0]!.task_id
    expect(store.appendTaskRevision({ taskId, userId: USER, status: 'done' })).toBe(2)
    const stale = commit({ ops: [{ op: 'task.cancel', task_id: taskId, base_revision: 1 }] })
    expect(stale).toEqual({ status: 'conflicted', reason: 'conflicted_revision' })
    expect(store.getTask(USER, taskId)).toMatchObject({ status: 'done', currentRevision: 2 }) // 未被取消
    expect(store.goalRevisions(GOAL)).toHaveLength(1) // 拒绝的提交不落任何版本行
  })

  it('refuses with conflicted_input first when both the input version and the base revision are stale (design §4.4 order)', () => {
    const applied = commit({ ops: [{ op: 'goal.update', fields: { title: '每周运动 150 分钟' } }] })
    expect(applied).toMatchObject({ status: 'applied', goal_revision: 2 })
    store.raiseInputVersion(USER, GOAL, 'e-newer-chat')
    const both = commit({ base_revision: 1, input_version: 1,
      ops: [{ op: 'goal.update', fields: { title: '每周运动 999 分钟' } }] })
    expect(both).toEqual({ status: 'conflicted', reason: 'conflicted_input' }) // 输入版本层先于业务版本层
    expect(goalContent()).toMatchObject({ title: '每周运动 150 分钟' })
  })

  it('marks a goal.create with a nonzero base_revision conflicted and records no goal_id on the audit row', () => {
    const refused = commitWithKey('vkey-stale-create', { base_revision: 3,
      ops: [{ op: 'goal.create', domain: 'health', title: '每天步行 8000 步',
        metric: { type: 'steps', target: 8000, unit: '步', period: 'day' }, context: null }] }, scope({ allowedGoalId: undefined }))
    expect(refused).toEqual({ status: 'conflicted', reason: 'conflicted_revision' })
    const row = store.changeSetByIdempotencyKey(USER, 'vkey-stale-create')
    expect(row).toMatchObject({ status: 'conflicted', goalId: undefined }) // 未应用无目标可回填
    expect(store.listGoals(USER).items).toHaveLength(1)
  })

  it('refuses a commit when the goal row exists but no input_version row was ever created', () => {
    store.insertGoal({ userId: USER, domain: 'finance', goalId: OTHER_GOAL })
    store.appendGoalRevision({ goalId: OTHER_GOAL, userId: USER, title: '每月存款', metric: METRIC, status: 'active' })
    // 无 ensureInputVersion：inputVersion() = 0，任何声称的版本都不匹配，不得静默放行
    const orphan = commit({ goal_id: OTHER_GOAL, base_revision: 1, ops: [{ op: 'goal.update', fields: { title: '每月存款计划' } }] },
      scope({ allowedGoalId: OTHER_GOAL }))
    expect(orphan).toEqual({ status: 'conflicted', reason: 'conflicted_input' })
    expect(store.currentRevision('goal', OTHER_GOAL)).toBe(1)
  })
})

describe('BC-08-09 boundary: which concurrent second submissions actually lose the version check', () => {
  it('rejects a task.create second commit after a goal.update advanced the goal revision', () => {
    const first = commit({ ops: [{ op: 'goal.update', fields: { title: '每周运动 150 分钟' } }] })
    expect(first).toMatchObject({ status: 'applied', goal_revision: 2 })
    const concurrent = commit({ base_revision: 1, ops: [{ op: 'task.create', content: '周日晨跑 40 分钟' }] })
    expect(concurrent).toEqual({ status: 'conflicted', reason: 'conflicted_revision' })
    expect(store.listTasks(USER, { goalId: GOAL }).items).toHaveLength(0)
  })

  it('two task.create-only commits with the same claimed versions BOTH apply (documented boundary, design §2.3.2 gap)', () => {
    // 特征化记录：task.create 不推进 goal.current_revision（changeset.ts 的应用循环只在 goal.* op 时
    // appendGoalRevision），故两个纯 task.create 提交都能通过 base_revision 比较——BC-08-09 的
    // 「同一目标同一时刻只有一个写入资格」在纯建任务提交之间不由版本检查保证（开发说明第 2 条已披露）。
    const first = commit({ ops: [{ op: 'task.create', content: '周日晨跑 40 分钟' }] })
    const second = commit({ ops: [{ op: 'task.create', content: '周三力量 30 分钟' }] })
    expect(first).toMatchObject({ status: 'applied' })
    expect(second).toMatchObject({ status: 'applied' }) // 第二个提交未被拒——按当前实现的检查面如实断言
    expect(store.listTasks(USER, { goalId: GOAL }).items).toHaveLength(2)
    expect(store.currentRevision('goal', GOAL)).toBe(1) // 版本计数未动
    const result = store.getChangeSet(USER, second.changeset_id!)?.result as { basis: string; goal_revision: number; tasks: unknown[] }
    expect(result).toMatchObject({ basis: 'no_message', goal_revision: 1 })
  })

  it('serializes two commits through the atomic block: the second loses even with identical claims', () => {
    const ops: ChangeSetInput['ops'] = [{ op: 'goal.update', fields: { metric: { type: 'workout', target: 150, unit: '分钟', period: 'week' } } }]
    const first = commit({ ops })
    const second = commit({ ops }) // 不同幂等键、完全相同的声称版本与内容
    expect(first).toMatchObject({ status: 'applied', goal_revision: 2 })
    expect(second).toEqual({ status: 'conflicted', reason: 'conflicted_revision' })
    expect(store.currentRevision('goal', GOAL)).toBe(2)
  })
})

describe('BC-02-04 boundary: replay semantics on the schema-parse failure path', () => {
  it('an applied key retried with a schema-invalid body returns invalid_schema instead of the original result', () => {
    const applied = commitWithKey('vkey-applied-once', { ops: [{ op: 'goal.update', fields: { title: '每周运动 150 分钟' } }] })
    expect(applied).toMatchObject({ status: 'applied' })
    // 与 applied 相同的幂等键、但解析都过不了的请求体（ops 少于一个）
    const garbage = service.commitChangeSet(
      { idempotency_key: 'vkey-applied-once', base_revision: 1, input_version: 1, reason: '重试', ops: [] }, scope())
    expect(garbage).toEqual({ status: 'invalid', reason: 'invalid_schema' }) // 未回放原 applied 结果（开发说明第 4 条「无条件」在该路径不成立）
    expect(store.currentRevision('goal', GOAL)).toBe(2) // 审计行 ON CONFLICT DO NOTHING，未覆盖原行
    expect(store.changeSetByIdempotencyKey(USER, 'vkey-applied-once')).toMatchObject({ status: 'applied' })
  })

  it('a key first refused as invalid_schema stays occupied: a later valid body replays the invalid result', () => {
    expect(service.commitChangeSet({ idempotency_key: 'vkey-occupied', base_revision: 1, input_version: 1, reason: '坏数据', ops: [] }, scope()))
      .toEqual({ status: 'invalid', reason: 'invalid_schema' })
    expect(service.commitChangeSet({ idempotency_key: 'vkey-occupied', base_revision: 1, input_version: 1, reason: '修好了',
      ops: [{ op: 'goal.update', fields: { title: '每周运动 150 分钟' } }] }, scope()))
      .toEqual({ status: 'invalid', reason: 'invalid_schema' }) // 同键一律回放原结果，Worker 必须换新键
    expect(store.currentRevision('goal', GOAL)).toBe(1)
    expect(store.changeSetByIdempotencyKey(USER, 'vkey-occupied')).toMatchObject({ status: 'invalid' })
  })

  it('the same idempotency key under a different user applies independently (per-user uniqueness)', () => {
    store.assertUser(OTHER, 'd_verify_002')
    store.insertGoal({ userId: OTHER, domain: 'health', goalId: OTHER_GOAL })
    store.appendGoalRevision({ goalId: OTHER_GOAL, userId: OTHER, title: '每周运动 100 分钟', metric: METRIC, status: 'active' })
    store.ensureInputVersion(OTHER, OTHER_GOAL)
    const key = 'vkey-shared-0001'
    const mine = service.commitChangeSet({ idempotency_key: key, base_revision: 1, input_version: 1, reason: '我的调整',
      goal_id: GOAL, ops: [{ op: 'goal.update', fields: { title: '每周运动 150 分钟' } }] }, scope())
    const theirs = service.commitChangeSet({ idempotency_key: key, base_revision: 1, input_version: 1, reason: '别人的调整',
      goal_id: OTHER_GOAL, ops: [{ op: 'goal.update', fields: { title: '每周运动 180 分钟' } }] }, scope({ userId: OTHER, allowedGoalId: OTHER_GOAL }))
    expect(mine).toMatchObject({ status: 'applied' })
    expect(theirs).toMatchObject({ status: 'applied' }) // (user_id, idempotency_key) 唯一，跨用户互不占用
    expect(store.changeSetByIdempotencyKey(USER, key)).toMatchObject({ status: 'applied', userId: USER })
    expect(store.changeSetByIdempotencyKey(OTHER, key)).toMatchObject({ status: 'applied', userId: OTHER })
  })
})

describe('BC-02-01 mechanism: a crash mid-apply rolls back the whole changeset including its own row', () => {
  it('an appendSync failure leaves no changeset, no business rows and no sync items', () => {
    store.appendSync = () => { throw new Error('sync pipe broken') }
    expect(() => commit({ ops: [{ op: 'goal.update', fields: { title: '每周运动 150 分钟' } },
      { op: 'task.create', content: '周日晨跑 40 分钟' }] })).toThrow('sync pipe broken')
    delete (store as unknown as { appendSync?: unknown }).appendSync // 恢复原型方法
    expect(businessRowCounts()).toMatchObject({ goalRevisions: 1, tasks: 0, taskRevisions: 0, sync: 0, changesets: 0 })
    expect(store.currentRevision('goal', GOAL)).toBe(1)
    expect(goalContent()).toMatchObject({ title: '每周运动 120 分钟' })
    // 回滚后服务可用，正常提交照常生效
    expect(commit({ ops: [{ op: 'goal.update', fields: { title: '每周运动 160 分钟' } }] })).toMatchObject({ status: 'applied', goal_revision: 2 })
  })
})

describe('「改回去」boundaries: the restore reference is checked, not trusted', () => {
  it('refuses a restore referencing another goal\'s applied changeset', () => {
    store.insertGoal({ userId: USER, domain: 'finance', goalId: OTHER_GOAL })
    store.appendGoalRevision({ goalId: OTHER_GOAL, userId: USER, title: '每月存款', metric: METRIC, status: 'active' })
    store.ensureInputVersion(USER, OTHER_GOAL)
    const foreign = commit({ goal_id: OTHER_GOAL, ops: [{ op: 'goal.update', fields: { title: '每月存款计划' } }] },
      scope({ allowedGoalId: OTHER_GOAL }))
    expect(foreign).toMatchObject({ status: 'applied' })
    const restore = commit({ derived_from_changeset: foreign.changeset_id, ops: [{ op: 'goal.update', fields: {} }] })
    expect(restore).toEqual({ status: 'invalid', reason: 'invalid_relation' }) // derived.goalId ≠ 当前 goal
    expect(store.currentRevision('goal', GOAL)).toBe(1)
  })

  it('refuses a restore referencing a conflicted (never-applied) changeset and a missing one', () => {
    commitWithKey('vkey-never-applied', { base_revision: 0, ops: [{ op: 'task.create', content: 'x' }] }) // conflicted，无 applied_revision
    expect(store.changeSetByIdempotencyKey(USER, 'vkey-never-applied')).toMatchObject({ status: 'conflicted' })
    const applied = commit({ ops: [{ op: 'goal.update', fields: { title: '每周运动 150 分钟' } }] })
    expect(applied).toMatchObject({ status: 'applied', goal_revision: 2 })
    const conflictedRef = commit({ base_revision: 2,
      derived_from_changeset: store.changeSetByIdempotencyKey(USER, 'vkey-never-applied')!.id,
      ops: [{ op: 'goal.update', fields: {} }] })
    expect(conflictedRef).toEqual({ status: 'invalid', reason: 'invalid_relation' }) // derived.status ≠ applied
    expect(commit({ base_revision: 2, derived_from_changeset: 'cs_missing0000', ops: [{ op: 'goal.update', fields: {} }] }))
      .toEqual({ status: 'invalid', reason: 'invalid_relation' })
    expect(store.currentRevision('goal', GOAL)).toBe(2)
  })

  it('refuses a restore whose referenced snapshot is the archive revision (cannot resurrect via restore)', () => {
    const archived = commit({ ops: [{ op: 'goal.archive' }] })
    expect(archived).toMatchObject({ status: 'applied', goal_revision: 2 })
    expect(store.getChangeSet(USER, archived.changeset_id!)).toMatchObject({ appliedRevision: 2 })
    const restore = commit({ base_revision: 2, derived_from_changeset: archived.changeset_id, ops: [{ op: 'goal.update', fields: {} }] })
    expect(restore).toEqual({ status: 'invalid', reason: 'invalid_relation' }) // 快照 status ≠ active
    expect(store.getGoal(USER, GOAL)).toMatchObject({ status: 'archived' })
  })
})

describe('target_mismatch boundaries: no false positives, no false negatives', () => {
  it('refuses a goal.create claiming a different target than the message assigned; no goal row is created', () => {
    store.saveInboxEvent({ userId: USER, eventId: 'e-v-assign', schemaVersion: '1', eventType: 'along.user_message',
      deviceId: 'd_verify_001', goalId: GOAL, receivedAt: new Date().toISOString(), timezone: 'Asia/Shanghai',
      payload: { event_type: 'along.user_message', text: '把目标改成 150 分钟' }, payloadHash: 'hash-v-assign', status: 'accepted' })
    store.appendMessage({ userId: USER, eventId: 'e-v-assign', role: 'user', direction: 'inbound', text: '把目标改成 150 分钟' })
    const refused = commit({ base_revision: 0,
      ops: [{ op: 'goal.create', domain: 'health', title: '每周运动 120 分钟',
        metric: { type: 'workout', target: 120, unit: '分钟', period: 'week' }, context: null }] },
      scope({ allowedGoalId: undefined, triggerEventId: 'e-v-assign' }))
    expect(refused).toEqual({ status: 'invalid', reason: 'target_mismatch' })
    expect(store.listGoals(USER).items).toHaveLength(1) // 拒绝的 create 不落 goal 行
    const accepted = commit({ base_revision: 0,
      ops: [{ op: 'goal.create', domain: 'health', title: '每周运动 150 分钟',
        metric: { type: 'workout', target: 150, unit: '分钟', period: 'week' }, context: null }] },
      scope({ allowedGoalId: undefined, triggerEventId: 'e-v-assign' }))
    expect(accepted).toMatchObject({ status: 'applied', goal_revision: 1 })
  })

  it('does not block a commit when the message states a fact without assigning a target', () => {
    store.saveInboxEvent({ userId: USER, eventId: 'e-v-fact', schemaVersion: '1', eventType: 'along.user_message',
      deviceId: 'd_verify_001', goalId: GOAL, receivedAt: new Date().toISOString(), timezone: 'Asia/Shanghai',
      payload: { event_type: 'along.user_message', text: '今天运动量改成 150 分钟' }, payloadHash: 'hash-v-fact', status: 'accepted' })
    store.appendMessage({ userId: USER, eventId: 'e-v-fact', role: 'user', direction: 'inbound', text: '今天运动量改成 150 分钟' })
    const applied = commit({ ops: [{ op: 'goal.update', fields: { metric: { type: 'workout', target: 300, unit: '分钟', period: 'week' } } }] },
      scope({ triggerEventId: 'e-v-fact' }))
    expect(applied).toMatchObject({ status: 'applied', goal_revision: 2 }) // 事实陈述没有指派，不得误杀
    expect(store.getChangeSet(USER, applied.changeset_id!)?.result).toMatchObject({ basis: 'message' })
  })

  it('refuses a goal.update target outside the health range even without a trigger message', () => {
    const refused = commit({ ops: [{ op: 'goal.update', fields: { metric: { type: 'workout', target: 10081, unit: '分钟', period: 'week' } } }] })
    expect(refused).toEqual({ status: 'invalid', reason: 'invalid_schema' })
    expect(store.currentRevision('goal', GOAL)).toBe(1)
  })

  it('a missing goal with a mismatching target refuses as invalid_relation (relation layer runs first, dev note 1)', () => {
    store.saveInboxEvent({ userId: USER, eventId: 'e-v-fm', schemaVersion: '1', eventType: 'along.user_message',
      deviceId: 'd_verify_001', goalId: GOAL, receivedAt: new Date().toISOString(), timezone: 'Asia/Shanghai',
      payload: { event_type: 'along.user_message', text: '把目标改成 150 分钟' }, payloadHash: 'hash-v-fm', status: 'accepted' })
    store.appendMessage({ userId: USER, eventId: 'e-v-fm', role: 'user', direction: 'inbound', text: '把目标改成 150 分钟' })
    const refused = commit({ goal_id: 'g_verify_missing', base_revision: 1,
      ops: [{ op: 'goal.update', fields: { metric: { type: 'workout', target: 999, unit: '分钟', period: 'week' } } }] },
      scope({ triggerEventId: 'e-v-fm' }))
    expect(refused).toEqual({ status: 'invalid', reason: 'invalid_relation' }) // 非 target_mismatch：顺序按实现处理
  })
})

describe('schema boundaries the first spec does not pin', () => {
  it.each([
    ['idempotency_key too long (129)', { idempotency_key: 'k'.repeat(129) }],
    ['negative base_revision', { base_revision: -1 }],
    ['input_version zero', { input_version: 0 }],
    ['whitespace reason', { reason: '   ' }],
    ['unknown op type', { ops: [{ op: 'goal.delete' }] }],
    ['task.update without base_revision', { ops: [{ op: 'task.update', task_id: 't_x', fields: { content: 'c' } }] }],
    ['bad scheduled_at', { ops: [{ op: 'task.create', content: 'c', scheduled_at: 'not-a-date' }] }],
    ['goal_id wrong charset', { goal_id: 'g_bad space' }],
  ])('refuses %s as invalid_schema', (_label, over) => {
    expect(commit(over as Partial<ChangeSetInput>)).toMatchObject({ status: 'invalid', reason: 'invalid_schema' })
    expect(businessRowCounts().tasks).toBe(0) // 无论审计行与否，无业务行
  })

  it('a 129-char idempotency key cannot occupy a key (no audit row); a shorter refused body still occupies its key', () => {
    expect(commit({ idempotency_key: 'k'.repeat(129) })).toMatchObject({ status: 'invalid', reason: 'invalid_schema' })
    expect(businessRowCounts().changesets).toBe(0) // 键超长不可提取 → 不落审计行
    expect(commitWithKey('vkey-short-bad', { base_revision: -1 })).toMatchObject({ status: 'invalid', reason: 'invalid_schema' })
    expect(store.changeSetByIdempotencyKey(USER, 'vkey-short-bad')).toMatchObject({ status: 'invalid' }) // 键可用即占用
  })

  it('accepts a 128-char idempotency key and applies', () => {
    const applied = commit({ idempotency_key: 'k'.repeat(128), ops: [{ op: 'goal.update', fields: { title: '每周运动 130 分钟' } }] })
    expect(applied).toMatchObject({ status: 'applied' })
  })

  it('a task-only commit appends task_updated + changeset_note but no goal_updated sync', () => {
    const applied = commit({ ops: [{ op: 'task.create', content: '周日晨跑 40 分钟' }] })
    expect(applied).toMatchObject({ status: 'applied' })
    const syncs = store.syncPage(USER, 0, 20).items
    expect(syncs.map(item => item.kind)).toEqual(['task_updated', 'changeset_note'])
  })
})

describe('tool boundaries: reads never leak and pending health stays withheld', () => {
  const call = async (name: string, args: Record<string, unknown> = {}, hostOver: Partial<CommitScope> = {}) => {
    const host: AlongToolsHost = { service, scopeFor: () => scope(hostOver) }
    const tool = alongTools(host, 'ticket-v').find(item => item.name === name)!
    return tool.execute(tool.schema.parse(args), new AbortController().signal)
  }

  it('an unbound ticket reading a foreign user\'s goal fails with the generic ownership error, no content in the message', async () => {
    const foreign = new AlongStore(dbPath)
    foreign.assertUser(OTHER, 'd_verify_002')
    foreign.insertGoal({ userId: OTHER, domain: 'health', goalId: OTHER_GOAL })
    foreign.appendGoalRevision({ goalId: OTHER_GOAL, userId: OTHER, title: '别人的目标', metric: METRIC, status: 'active' })
    foreign.ensureInputVersion(OTHER, OTHER_GOAL)
    foreign.close()
    await expect(call('along_goal_read', { goal_id: OTHER_GOAL }, { allowedGoalId: undefined }))
      .rejects.toThrow('along resource not found for this user')
    await expect(call('along_goal_read', { goal_id: 'g_verify_missing' }, { allowedGoalId: undefined }))
      .rejects.toThrow('along resource not found for this user') // 不存在与不属于同码，无存在性泄露
  })

  it('along_health_read reports no_permission availability instead of hiding it, and withholds pending types even on request', async () => {
    store.saveHealthSummary(USER, { eventId: 'h-v-steps', payload: { summaries: [{ type: 'steps', metricVersion: 'mv',
      availability: 'no_permission', summarizerVersion: 'sv', value: null, timezone: 'Asia/Shanghai' }] } }, 'known')
    store.saveHealthSummary(USER, { eventId: 'h-v-weight', payload: { summaries: [{ type: 'weight', metricVersion: 'mv',
      availability: 'ok', summarizerVersion: 'sv', value: 70 }] } }, 'pending') // 服务端派生 pending，即使类型在七类内
    const read = await call('along_health_read') as { summaries: { type: string; availability: string }[] }
    expect(read.summaries).toEqual([expect.objectContaining({ type: 'steps', availability: 'no_permission' })])
    expect((await call('along_health_read', { type: 'weight' }) as { summaries: unknown[] }).summaries).toHaveLength(0)
  })

  it('along_task_list on an unbound ticket still lists only that user\'s tasks and never another user\'s', async () => {
    store.assertUser(OTHER, 'd_verify_002')
    store.insertGoal({ userId: OTHER, domain: 'health', goalId: OTHER_GOAL })
    store.insertTask({ goalId: OTHER_GOAL, userId: OTHER, content: '别人的任务' })
    const read = await call('along_task_list', {}, { allowedGoalId: undefined }) as { tasks: { content: string }[] }
    expect(read.tasks).toEqual([]) // USER 名下无任务，OTHER 的任务不可见
  })
})
