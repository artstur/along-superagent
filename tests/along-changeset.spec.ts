/**
 * Version module tests: ChangeSet four-layer validation, atomic auto-commit, idempotent replay, write
 * qualification (design §2.3/§4.4/§4.5). Acceptance rows: BC-08-04 (stale base_revision → conflicted, state
 * unchanged), BC-08-05 (raised input version blocks the old input's result — not via prompts), BC-08-09 (one
 * write qualification per goal — the version check is the hard guarantee), BC-07-04 (the model cannot name
 * user or goal), BC-02-04 (replay returns the original result), plus the assignment-consistency port whose
 * static vectors are pinned against the `along/web/goal-agent-core.mjs` baseline (SD-1, checks only tightened).
 * BC-07-03's end-to-end "the business state only changes through Along tools" lands in the Stage A E2E
 * (`tests/along-phaseA.spec.ts`, integration module); here the tool-side half is locked: only
 * `along_changes_commit` writes, and invalid/conflicted commits write no business rows.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope, scopeParentOf } from '@deepseek-ai/dsh-scope'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { Ticket } from '../src/core/index.ts'
import { createChangeSetModule, numberLikeTarget, requestedTargetFromMessage, ALONG_CHANGE_SET_INPUT_SCHEMA,
  type ChangeSetInput, type CommitScope, type GoalDomain } from '../src/along/changeset.ts'
import { AlongService } from '../src/along/service.ts'
import { alongTools, type AlongToolsHost } from '../src/along/tools.ts'
import { AlongStore } from '../src/along/store.ts'
import { executorTools, type ExecutorToolsHost } from '../src/app/tools/executor.ts'
import { WORK_TOOLS } from '../src/app/sessions.ts'
import type { SourceContext } from '../src/sources/host.ts'

let directory: string
let dbPath: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'along-changeset-')); dbPath = join(directory, 'along.sqlite') })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const USER = 'u_cs_worker1'
const OTHER = 'u_cs_other01'
const GOAL = 'g_cs_goal001'
const OTHER_GOAL = 'g_cs_goal002'
const METRIC = { type: 'workout', target: 120, unit: '分钟', period: 'week' }

/** Store with one paired user and one active health goal (revision 1, input version 1). */
function seededStore(): AlongStore {
  const store = new AlongStore(dbPath)
  store.assertUser(USER, 'd_cs_00001')
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
  ({ userId: USER, allowedGoalId: GOAL, ticketId: 'ticket-1', assignmentId: 'as-1', workId: 'w_cswork0001', ...over })
/** Mirrors the along_changes_commit tool: the goal comes from the host binding, never from the caller's imagination. */
const input = (over: Partial<ChangeSetInput> = {}, goalId?: string): ChangeSetInput =>
  ({ idempotency_key: `key-${++keys}`, base_revision: 1, input_version: 1, reason: '调整运动目标',
    ...(goalId !== undefined ? { goal_id: goalId } : {}), ops: [], ...over })
const commit = (over: Partial<ChangeSetInput> = {}, commitScope: CommitScope = scope()) =>
  service.commitChangeSet(input(over, commitScope.allowedGoalId), commitScope)

/** Seeds the Inbox row + original message of an assigned user chat (the target_mismatch source text). */
function seedAssignment(text: string, eventId = 'e-assign', goalId: string | null = GOAL): void {
  store.saveInboxEvent({ userId: USER, eventId, schemaVersion: '1', eventType: 'along.user_message', deviceId: 'd_cs_00001',
    goalId: goalId ?? undefined, receivedAt: new Date().toISOString(), timezone: 'Asia/Shanghai',
    payload: { event_type: 'along.user_message', text }, payloadHash: `hash-${eventId}`, status: 'accepted' })
  const message = store.appendMessage({ userId: USER, eventId, role: 'user', direction: 'inbound', text })
  if (goalId !== null) store.linkMessageToGoals(message.id, [goalId], 'direct')
}

const goalContent = () => {
  const revision = store.currentGoalRevision(GOAL)
  return { title: revision?.title, target: (revision?.metric as { target?: number } | undefined)?.target,
    context: revision?.context, status: revision?.status }
}

describe('BC-08-04 a stale base_revision is refused and marked conflicted, current state unchanged', () => {
  it('refuses a goal commit against an outdated revision and writes no business rows', () => {
    const applied = commit({ ops: [{ op: 'goal.update', fields: { title: '每周运动 150 分钟' } }] })
    expect(applied).toMatchObject({ status: 'applied', goal_revision: 2 })
    const stale = commit({ base_revision: 1, ops: [{ op: 'goal.update', fields: { title: '每周运动 999 分钟' } }] })
    expect(stale).toEqual({ status: 'conflicted', reason: 'conflicted_revision' })
    expect(store.currentRevision('goal', GOAL)).toBe(2) // 只推进过一次
    expect(goalContent()).toMatchObject({ title: '每周运动 150 分钟' })
    expect(store.goalRevisions(GOAL)).toHaveLength(2) // 拒绝的提交没有落 goal_revision
    const row = store.changeSetByIdempotencyKey(USER, `key-${keys}`)
    expect(row).toMatchObject({ status: 'conflicted', goalId: GOAL, baseRevision: 1, inputVersion: 1 })
    expect(row?.result).toMatchObject({ reason: 'conflicted_revision' })
    expect(store.syncPage(USER, 0, 50).items).toHaveLength(2) // 只有第一次提交的 goal_updated + 变更说明
  })

  it('refuses a task commit against an outdated task revision', () => {
    const created = commit({ ops: [{ op: 'task.create', content: '周日晨跑 40 分钟' }] })
    expect(created).toMatchObject({ status: 'applied' })
    const taskId = (store.getChangeSet(USER, created.changeset_id!)?.result as { tasks: { task_id: string }[] }).tasks[0]!.task_id
    expect(store.appendTaskRevision({ taskId, userId: USER, status: 'done' })).toBe(2) // 事实反馈推进任务版本
    const stale = commit({ ops: [{ op: 'task.update', task_id: taskId, base_revision: 1, fields: { content: '改到周一' } }] })
    expect(stale).toEqual({ status: 'conflicted', reason: 'conflicted_revision' })
    expect(store.getTask(USER, taskId)).toMatchObject({ content: '周日晨跑 40 分钟', currentRevision: 2 })
  })
})

describe('BC-08-05 a new chat raises the input version, the old input\'s result cannot commit', () => {
  it('refuses conflicted_input on a stale input_version without touching state — pure service-layer guarantee', () => {
    const applied = commit({ ops: [{ op: 'goal.update', fields: { title: '每周运动 150 分钟' } }] })
    expect(applied).toMatchObject({ status: 'applied' })
    expect(store.raiseInputVersion(USER, GOAL, 'e-new-chat')).toBe(2) // 用户新聊天，立即提升
    const stale = commit({ base_revision: 2, input_version: 1,
      ops: [{ op: 'goal.update', fields: { title: '每周运动 999 分钟' } }] })
    expect(stale).toEqual({ status: 'conflicted', reason: 'conflicted_input' })
    expect(store.currentRevision('goal', GOAL)).toBe(2)
    expect(goalContent()).toMatchObject({ title: '每周运动 150 分钟' })
    const fresh = commit({ base_revision: 2, input_version: 2,
      ops: [{ op: 'goal.update', fields: { title: '每周运动 160 分钟' } }] })
    expect(fresh).toMatchObject({ status: 'applied', goal_revision: 3 })
  })

  it('goal.create skips the comparison and records input_version 1 with base_revision 0', () => {
    expect(commit({ base_revision: 0, input_version: 5,
      ops: [{ op: 'goal.create', domain: 'health', title: '每天步行 8000 步',
        metric: { type: 'steps', target: 8000, unit: '步', period: 'day' }, context: null }] },
      scope({ allowedGoalId: undefined }))).toMatchObject({ status: 'applied', goal_revision: 1 })
    const row = store.changeSetByIdempotencyKey(USER, `key-${keys}`)
    expect(row).toMatchObject({ inputVersion: 1 }) // input_version 忽略并记 1
    const created = store.listGoals(USER).items.find(goal => goal.id !== GOAL)!
    expect(store.inputVersion(created.id)).toBe(1)
    const raw = new DatabaseSync(dbPath)
    try { expect(raw.prepare('SELECT raised_by FROM input_version WHERE goal_id = ?').get(created.id)).toMatchObject({ raised_by: null }) }
    finally { raw.close() }
  })

  it('refuses a goal.create claiming a nonzero base_revision', () => {
    expect(commit({ base_revision: 5, ops: [{ op: 'goal.create', domain: 'health', title: '每天步行 8000 步',
      metric: { type: 'steps', target: 8000, unit: '步', period: 'day' }, context: null }] },
      scope({ allowedGoalId: undefined }))).toEqual({ status: 'conflicted', reason: 'conflicted_revision' })
    expect(store.listGoals(USER).items).toHaveLength(1) // 不写入
  })
})

describe('BC-08-09 one write qualification per goal — the second concurrent commit loses the version check', () => {
  it('rejects the second of two commits claiming the same versions; the version counts one step only', () => {
    const first = commit({ ops: [{ op: 'goal.update', fields: { title: '每周运动 150 分钟' } }] })
    expect(first).toMatchObject({ status: 'applied', goal_revision: 2 })
    const second = commit({ ops: [{ op: 'goal.update', fields: { title: '每周运动 160 分钟' } }] })
    expect(second).toEqual({ status: 'conflicted', reason: 'conflicted_revision' }) // 并发第二次写入因版本不符被拒
    expect(store.currentRevision('goal', GOAL)).toBe(2) // 版本计数只 +1
    expect(goalContent()).toMatchObject({ title: '每周运动 150 分钟' })
    // 新一轮资格：以最新版本重新提交即成功，同一时刻仍只有一个写入者
    const third = commit({ base_revision: 2, ops: [{ op: 'goal.update', fields: { title: '每周运动 160 分钟' } }] })
    expect(third).toMatchObject({ status: 'applied', goal_revision: 3 })
    expect(store.currentRevision('goal', GOAL)).toBe(3)
  })
})

describe('BC-02-04 the same idempotency key returns the original result, ops are never replayed', () => {
  it('replays an applied commit with reused: true and no extra rows', () => {
    const first = commit({ ops: [{ op: 'goal.update', fields: { title: '每周运动 150 分钟' } }] })
    expect(first).toMatchObject({ status: 'applied', reused: false })
    const replay = commit({ idempotency_key: `key-${keys}`,
      ops: [{ op: 'goal.update', fields: { title: '每周运动 999 分钟' } }] })
    expect(replay).toEqual({ status: 'applied', changeset_id: first.changeset_id, reused: true })
    expect(store.currentRevision('goal', GOAL)).toBe(2)
    expect(goalContent()).toMatchObject({ title: '每周运动 150 分钟' }) // 重放的 ops 没有再应用
    expect(store.syncPage(USER, 0, 50).items).toHaveLength(2)
  })

  it('replays a conflicted result without re-evaluating against the meanwhile-advanced state', () => {
    commit({ ops: [{ op: 'goal.update', fields: { title: '每周运动 150 分钟' } }] })
    const staleKey = `key-${keys + 1}`
    expect(commit({ idempotency_key: staleKey, base_revision: 1,
      ops: [{ op: 'goal.update', fields: { title: '每周运动 888 分钟' } }] }))
      .toEqual({ status: 'conflicted', reason: 'conflicted_revision' })
    expect(commit({ idempotency_key: staleKey, base_revision: 2, input_version: 1,
      ops: [{ op: 'goal.update', fields: { title: '每周运动 888 分钟' } }] }))
      .toEqual({ status: 'conflicted', reason: 'conflicted_revision' }) // 原结果，而非按新状态重判
  })
})

describe('BC-07-04 the model cannot name the user or the goal — host binding enforced', () => {
  it('refuses goal_id different from the bound goal with invalid_relation', () => {
    store.insertGoal({ userId: USER, domain: 'finance', goalId: OTHER_GOAL })
    expect(commit({ goal_id: OTHER_GOAL, ops: [{ op: 'goal.update', fields: { title: '存款计划' } }] }))
      .toEqual({ status: 'invalid', reason: 'invalid_relation' })
    expect(store.currentRevision('goal', OTHER_GOAL)).toBe(0)
  })

  it('refuses a foreign user\'s goal with the same shape as a missing one — no existence leak', () => {
    const foreign = new AlongStore(dbPath)
    foreign.assertUser(OTHER, 'd_cs_other1')
    foreign.insertGoal({ userId: OTHER, domain: 'health', goalId: OTHER_GOAL })
    foreign.close()
    expect(commit({ goal_id: OTHER_GOAL, ops: [{ op: 'goal.update', fields: { title: '每周运动 130 分钟' } }] },
      scope({ allowedGoalId: undefined }))).toEqual({ status: 'invalid', reason: 'invalid_relation' })
    expect(store.currentRevision('goal', OTHER_GOAL)).toBe(0)
  })

  it('refuses a bound ticket minting a goal, and a goal.create carrying goal_id', () => {
    expect(commit({ ops: [{ op: 'goal.create', domain: 'health', title: '每天步行 8000 步',
      metric: { type: 'steps', target: 8000, unit: '步', period: 'day' }, context: null }] }))
      .toEqual({ status: 'invalid', reason: 'invalid_relation' })
    expect(commit({ goal_id: GOAL, base_revision: 0, ops: [{ op: 'goal.create', domain: 'health', title: '每天步行 8000 步',
      metric: { type: 'steps', target: 8000, unit: '步', period: 'day' }, context: null }] },
      scope({ allowedGoalId: undefined }))).toEqual({ status: 'invalid', reason: 'invalid_relation' })
    expect(store.listGoals(USER).items).toHaveLength(1)
  })

  it('the commit tool schema declares no goal_id or user_id and strict-parses', () => {
    const commitTool = alongTools(alongHost(), 'ticket-1').find(tool => tool.name === 'along_changes_commit')!
    expect('goal_id' in (commitTool.schema as unknown as { shape: Record<string, unknown> }).shape).toBe(false)
    expect('user_id' in (commitTool.schema as unknown as { shape: Record<string, unknown> }).shape).toBe(false)
    expect(() => commitTool.schema.parse({ user_id: 'u_sneaky', idempotency_key: 'k', base_revision: 1, input_version: 1,
      reason: 'r', ops: [{ op: 'goal.archive' }] })).toThrow()
  })

  it('refuses a non-create commit without a goal, and one whose task belongs to another goal', () => {
    expect(commit({ ops: [{ op: 'task.create', content: '周日晨跑 40 分钟' }] }, scope({ allowedGoalId: undefined })))
      .toEqual({ status: 'invalid', reason: 'invalid_relation' })
    store.insertGoal({ userId: USER, domain: 'finance', goalId: OTHER_GOAL })
    const task = store.insertTask({ goalId: OTHER_GOAL, userId: USER, content: '记账 10 分钟' })
    expect(commit({ ops: [{ op: 'task.update', task_id: task.id, base_revision: 0, fields: { content: '记账 15 分钟' } }] }))
      .toEqual({ status: 'invalid', reason: 'invalid_relation' }) // task 不属该 goal
  })
})

describe('schema layer: validateGoalReply-aligned limits, ranges, and the custom rule', () => {
  it('keeps title ≤80, task content ≤120, reason ≤300, and requires at least one op', () => {
    expect(commit({ reason: '长'.repeat(301) })).toMatchObject({ status: 'invalid', reason: 'invalid_schema' })
    expect(commit({ ops: [{ op: 'goal.update', fields: { title: '长'.repeat(81) } }] }))
      .toMatchObject({ status: 'invalid', reason: 'invalid_schema' })
    expect(commit({ ops: [{ op: 'task.create', content: '长'.repeat(121) }] }))
      .toMatchObject({ status: 'invalid', reason: 'invalid_schema' })
    expect(commit({ ops: [] })).toMatchObject({ status: 'invalid', reason: 'invalid_schema' })
  })

  it('enforces the custom metric rule and per-domain target ranges (goal-agent-core.mjs:158-159)', () => {
    expect(commit({ base_revision: 0, ops: [{ op: 'goal.create', domain: 'custom', title: '少刷手机',
      metric: { type: 'screen', target: 120, unit: '分钟', period: 'day' }, context: null }] },
      scope({ allowedGoalId: undefined }))).toMatchObject({ status: 'invalid', reason: 'invalid_schema' })
    expect(commit({ base_revision: 0, ops: [{ op: 'goal.create', domain: 'health', title: '每天步行 8000 步', metric: null, context: null }] },
      scope({ allowedGoalId: undefined }))).toMatchObject({ status: 'invalid', reason: 'invalid_schema' })
    expect(commit({ base_revision: 0, ops: [{ op: 'goal.create', domain: 'health', title: '每天步行 8000 步',
      metric: { type: 'steps', target: 10081, unit: '步', period: 'day' }, context: null }] },
      scope({ allowedGoalId: undefined }))).toMatchObject({ status: 'invalid', reason: 'invalid_schema' })
    expect(commit({ base_revision: 0, ops: [{ op: 'goal.create', domain: 'finance', title: '每月存款',
      metric: { type: 'savings', target: 10000001, unit: '元', period: 'month' }, context: null }] },
      scope({ allowedGoalId: undefined }))).toMatchObject({ status: 'invalid', reason: 'invalid_schema' })
    expect(commit({ ops: [{ op: 'goal.update', fields: { metric: { type: 'workout', target: 120.5, unit: '分钟', period: 'week' } } }] }))
      .toMatchObject({ status: 'invalid', reason: 'invalid_schema' })
  })

  it('normalizes number-like targets like the old chain (numberLikeTarget) before applying', () => {
    const applied = commit({ base_revision: 0, ops: [{ op: 'goal.create', domain: 'finance', title: '每月存款',
      metric: { type: 'savings', target: '10,000', unit: '元', period: 'month' }, context: null }] },
      scope({ allowedGoalId: undefined }))
    expect(applied).toMatchObject({ status: 'applied' })
    const created = store.listGoals(USER).items.find(goal => goal.id !== GOAL)!
    expect((store.currentGoalRevision(created.id)?.metric as { target: number }).target).toBe(10000)
  })

  it('records an invalid audit row when the idempotency key is usable', () => {
    const key = `key-${++keys}`
    expect(service.commitChangeSet(input({ idempotency_key: key, ops: [{ op: 'goal.update', fields: { title: '' } }] }), scope()))
      .toEqual({ status: 'invalid', reason: 'invalid_schema' })
    expect(store.changeSetByIdempotencyKey(USER, key)).toMatchObject({ status: 'invalid' })
    expect(store.listTasks(USER, { goalId: GOAL }).items).toHaveLength(0) // 无业务行
  })
})

describe('assignment consistency: the committed target must match the message the user assigned (target_mismatch)', () => {
  it('refuses a mismatching target and accepts the assigned one — same strength as the old chain', () => {
    seedAssignment('把目标改成 150 分钟')
    expect(commit({ ops: [{ op: 'goal.update', fields: { metric: { type: 'workout', target: 120, unit: '分钟', period: 'week' } } }] },
      scope({ triggerEventId: 'e-assign' }))).toEqual({ status: 'invalid', reason: 'target_mismatch' })
    expect(store.currentRevision('goal', GOAL)).toBe(1)
    expect(commit({ ops: [{ op: 'goal.update', fields: { metric: { type: 'workout', target: 150, unit: '分钟', period: 'week' } } }] },
      scope({ triggerEventId: 'e-assign' }))).toMatchObject({ status: 'applied', goal_revision: 2 })
  })

  it('normalizes number-like and hour forms exactly like requestedTargetFromMessage', () => {
    seedAssignment('把目标改成 2 小时', 'e-hours')
    expect(commit({ ops: [{ op: 'goal.update', fields: { metric: { type: 'workout', target: '150', unit: '分钟', period: 'week' } } }] },
      scope({ triggerEventId: 'e-hours' }))).toEqual({ status: 'invalid', reason: 'target_mismatch' }) // "150" 归一为 150 ≠ 120
    expect(commit({ ops: [{ op: 'goal.update', fields: { metric: { type: 'workout', target: '120', unit: '分钟', period: 'week' } } }] },
      scope({ triggerEventId: 'e-hours' }))).toMatchObject({ status: 'applied' })
  })

  it('skips the check and records basis no_message when the scope carries no trigger message', () => {
    const applied = commit({ ops: [{ op: 'goal.update', fields: { metric: { type: 'workout', target: 130, unit: '分钟', period: 'week' } } }] })
    expect(applied).toMatchObject({ status: 'applied' })
    expect(store.getChangeSet(USER, applied.changeset_id!)?.result).toMatchObject({ basis: 'no_message' })
    seedAssignment('把目标改成 150 分钟')
    const withTrigger = commit({ base_revision: 2,
      ops: [{ op: 'task.create', content: '周日晨跑 40 分钟' }] }, scope({ triggerEventId: 'e-assign' }))
    expect(withTrigger).toMatchObject({ status: 'applied' }) // 未声称目标值，不触发比较
    expect(store.getChangeSet(USER, withTrigger.changeset_id!)?.result).toMatchObject({ basis: 'message' })
  })
})

describe('application: one transaction advances versions, evidence, links and sync records', () => {
  it('goal.create with tasks lands goal, input version, message link, task revisions, sync and result', () => {
    seedAssignment('我想每天步行 8000 步', 'e-create', null)
    const applied = commit({ base_revision: 0,
      ops: [
        { op: 'goal.create', domain: 'health', title: '每天步行 8000 步',
          metric: { type: 'steps', target: 8000, unit: '步', period: 'day' }, context: ['下班后快走'] },
        { op: 'task.create', content: '晚饭后散步 40 分钟', task_client_id: 'client-walk' },
        { op: 'task.create', content: '午休快走 20 分钟' },
      ] }, scope({ allowedGoalId: undefined, triggerEventId: 'e-create' }))
    expect(applied).toMatchObject({ status: 'applied', goal_revision: 1, reused: false })
    const row = store.getChangeSet(USER, applied.changeset_id!)!
    expect(row).toMatchObject({ status: 'applied', baseRevision: 0, triggerEventId: 'e-create', workId: 'w_cswork0001',
      ticketId: 'ticket-1', assignmentId: 'as-1' })
    const created = row.goalId!
    expect(store.getGoal(USER, created)).toMatchObject({ domain: 'health', status: 'active', currentRevision: 1, originEventId: 'e-create' })
    expect(store.currentGoalRevision(created)).toMatchObject({ title: '每天步行 8000 步', basisChangeset: applied.changeset_id })
    expect((store.currentGoalRevision(created)?.metric as { target: number }).target).toBe(8000)
    expect(store.inputVersion(created)).toBe(1)
    const raw = new DatabaseSync(dbPath)
    try { expect(raw.prepare('SELECT raised_by FROM input_version WHERE goal_id = ?').get(created)).toMatchObject({ raised_by: 'e-create' }) }
    finally { raw.close() }
    // 来源 user_message 回填 direct 关联（接收时还没有 goal）
    expect(store.messagesByGoal(USER, created).items.map(message => message.text)).toEqual(['我想每天步行 8000 步'])
    const tasks = store.listTasks(USER, { goalId: created }, { limit: 10 }).items
    expect(tasks).toHaveLength(2)
    expect(tasks.every(task => task.currentRevision === 1)).toBe(true)
    expect(row.result).toMatchObject({ basis: 'message', goal_revision: 1 })
    expect((row.result as { tasks: { task_client_id?: string }[] }).tasks[0]?.task_client_id).toBe('client-walk')
    const syncs = store.syncPage(USER, 0, 20).items
    expect(syncs.map(item => item.kind)).toEqual(['message', 'goal_updated', 'task_updated', 'task_updated', 'changeset_note'])
    expect(syncs.at(-1)?.payload).toMatchObject({ changeset_id: applied.changeset_id, reason: '调整运动目标' })
  })

  it('goal.update merges fields onto the current revision; goal.archive freezes the goal', () => {
    const updated = commit({ ops: [{ op: 'goal.update', fields: { title: '每周运动 150 分钟' } }] })
    expect(updated).toMatchObject({ status: 'applied', goal_revision: 2 })
    expect(goalContent()).toMatchObject({ title: '每周运动 150 分钟', target: 120, context: ['保持规律运动'], status: 'active' })
    expect(store.appendGoalRevision({ goalId: GOAL, userId: USER, title: '事实行', status: 'active' })).toBe(3) // 事件侧推进到 3
    const archived = commit({ base_revision: 3, ops: [{ op: 'goal.archive' }] })
    expect(archived).toMatchObject({ status: 'applied', goal_revision: 4 })
    expect(store.getGoal(USER, GOAL)).toMatchObject({ status: 'archived' })
    expect(commit({ base_revision: 4, ops: [{ op: 'goal.update', fields: { title: '再改' } }] }))
      .toEqual({ status: 'invalid', reason: 'invalid_relation' }) // archive 后再更新
    expect(store.currentRevision('goal', GOAL)).toBe(4)
  })

  it('task.update clears scheduled_at with null, may mark done, and never drops the completion feedback fact', () => {
    const created = commit({ ops: [{ op: 'task.create', content: '周日晨跑 40 分钟', scheduled_at: '2026-11-16T07:00:00Z' }] })
    const taskId = (store.getChangeSet(USER, created.changeset_id!)?.result as { tasks: { task_id: string }[] }).tasks[0]!.task_id
    store.appendTaskRevision({ taskId, userId: USER, status: 'done', completedFeedbackEventId: 'e-fact' }) // 事实反馈（D4）推进任务版本到 2
    const updated = commit({ base_revision: 1,
      ops: [{ op: 'task.update', task_id: taskId, base_revision: 2, fields: { content: '周日晨跑 45 分钟', scheduled_at: null } }] })
    expect(updated).toMatchObject({ status: 'applied' })
    const task = store.getTask(USER, taskId)!
    expect(task).toMatchObject({ content: '周日晨跑 45 分钟', status: 'done', currentRevision: 3 })
    expect(task.scheduledAt).toBeUndefined() // null 清空计划时间
    expect(task.completedFeedbackEventId).toBe('e-fact') // BC-02-07：完成反馈不被覆盖
  })

  it('「改回去」restores the referenced snapshot content; provided fields must match it', () => {
    const first = commit({ ops: [{ op: 'goal.update', fields: { title: '每周运动 150 分钟',
      metric: { type: 'workout', target: 150, unit: '分钟', period: 'week' } } }] })
    expect(first).toMatchObject({ status: 'applied', goal_revision: 2 })
    commit({ base_revision: 2, ops: [{ op: 'goal.update', fields: { title: '每周运动 200 分钟' } }] })
    const restore = commit({ base_revision: 3, derived_from_changeset: first.changeset_id,
      ops: [{ op: 'goal.update', fields: {} }] })
    expect(restore).toMatchObject({ status: 'applied', goal_revision: 4 })
    expect(goalContent()).toMatchObject({ title: '每周运动 150 分钟', target: 150, status: 'active' })
    expect(store.getChangeSet(USER, restore.changeset_id!)).toMatchObject({ derivedFromChangeset: first.changeset_id })
    // 恢复内容必须来自快照，模型不能借恢复夹带新内容
    expect(commit({ base_revision: 4, derived_from_changeset: first.changeset_id,
      ops: [{ op: 'goal.update', fields: { title: '每周运动 999 分钟' } }] })).toEqual({ status: 'invalid', reason: 'invalid_relation' })
    expect(commit({ base_revision: 4, derived_from_changeset: 'cs_missing0000', ops: [{ op: 'goal.update', fields: {} }] }))
      .toEqual({ status: 'invalid', reason: 'invalid_relation' })
  })
})

describe('Along tools: host-bound reads and the single write channel', () => {
  const tools = () => alongTools(alongHost(), 'ticket-1')
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools().find(item => item.name === name)!
    return tool.execute(tool.schema.parse(args), new AbortController().signal)
  }

  it('executorTools registers the five Along tools beside the untouched DSH tools (D8 keeps the tool set)', () => {
    const withAlong = executorTools(executorHost(alongHost()), { id: 'ticket-1' } as Ticket).map(tool => tool.name)
    const without = executorTools(executorHost(), { id: 'ticket-1' } as Ticket).map(tool => tool.name)
    for (const name of ['orchestrator_read', 'orchestrator_ack', 'orchestrator_thread_unrelated', 'orchestrator_thread_follow',
      'orchestrator_trigger_handback', 'orchestrator_report']) {
      expect(without).toContain(name)
      expect(withAlong).toContain(name)
    }
    expect(without.some(name => name.startsWith('along_'))).toBe(false)
    for (const name of ['along_goal_read', 'along_conversation_read', 'along_task_list', 'along_health_read', 'along_changes_commit']) {
      expect(withAlong).toContain(name)
    }
    // WORK_TOOLS keeps every legacy name and gains the five Along names (sessions.ts 003 §1 extension point)
    for (const name of ['read', 'write', 'edit', 'bash', 'web_search', 'skill', 'todo_write', 'subagent', 'interrupt_agent']) {
      expect(WORK_TOOLS).toContain(name)
    }
    for (const name of ['along_goal_read', 'along_conversation_read', 'along_task_list', 'along_health_read', 'along_changes_commit']) {
      expect(WORK_TOOLS).toContain(name)
    }
    expect(WORK_TOOLS).toHaveLength(26)
    expect(withAlong).toContain('along_chat_reply')
  })

  it('along_goal_read binds the dispatch scope and returns the version primitives a commit needs', async () => {
    const read = await call('along_goal_read') as { goal: { goal_id: string; current_revision: number; input_version: number; title: string }; tasks: unknown[] }
    expect(read.goal).toMatchObject({ goal_id: GOAL, current_revision: 1, input_version: 1, title: '每周运动 120 分钟' })
    expect(read.tasks).toEqual([])
    await expect(call('along_goal_read', { goal_id: OTHER_GOAL })).rejects.toThrow(/dispatch scope/)
    expect(await call('along_goal_read', { goal_id: GOAL })).toMatchObject({ goal: { goal_id: GOAL } })
    const unbound = alongTools({ service, scopeFor: () => scope({ allowedGoalId: undefined }) }, 'ticket-1')
      .find(tool => tool.name === 'along_goal_read')!
    await expect(unbound.execute(unbound.schema.parse({}), new AbortController().signal)).rejects.toThrow(/pass goal_id/)
  })

  it('along_conversation_read pages by seq over the bound goal and refuses unbound tickets', async () => {
    for (const [index, text] of ['一', '二', '三'].entries()) {
      const message = store.appendMessage({ userId: USER, eventId: `e-c${index}`, role: 'user', direction: 'inbound', text })
      store.linkMessageToGoals(message.id, [GOAL], 'direct')
    }
    const page = await call('along_conversation_read', { limit: 2 }) as { messages: { seq: number; text: string }[]; next_before_seq?: number }
    expect(page.messages.map(message => message.text)).toEqual(['二', '三'])
    expect(page.next_before_seq).toBe(page.messages[0]!.seq)
    const older = await call('along_conversation_read', { before_seq: page.next_before_seq }) as { messages: { text: string }[] }
    expect(older.messages.map(message => message.text)).toEqual(['一'])
    const unbound = alongTools({ service, scopeFor: () => scope({ allowedGoalId: undefined }) }, 'ticket-1')
      .find(tool => tool.name === 'along_conversation_read')!
    await expect(unbound.execute(unbound.schema.parse({}), new AbortController().signal)).rejects.toThrow(/no conversation is bound/)
  })

  it('along_task_list returns stable ids and revisions, filtered by status and scoped to the bound goal', async () => {
    commit({ ops: [{ op: 'task.create', content: '周日晨跑 40 分钟' }] })
    store.insertGoal({ userId: USER, domain: 'finance', goalId: OTHER_GOAL })
    store.insertTask({ goalId: OTHER_GOAL, userId: USER, content: '记账 10 分钟' })
    const open = await call('along_task_list', { status: 'open' }) as { tasks: { task_id: string; revision: number; goal_id: string }[] }
    expect(open.tasks).toHaveLength(1) // 只看绑定目标
    expect(open.tasks[0]).toMatchObject({ revision: 1, goal_id: GOAL })
    expect((await call('along_task_list') as { tasks: unknown[] }).tasks).toHaveLength(1) // 绑定范围内只有一个任务
    const unbound = alongTools({ service, scopeFor: () => scope({ allowedGoalId: undefined }) }, 'ticket-1')
      .find(tool => tool.name === 'along_task_list')!
    expect((await unbound.execute(unbound.schema.parse({}), new AbortController().signal) as { tasks: unknown[] }).tasks).toHaveLength(2)
  })

  it('along_health_read withholds unadapted types and reports availability instead of empty values', async () => {
    store.saveHealthSummary(USER, { eventId: 'h-steps', payload: { summaries: [{ type: 'steps', metricVersion: 'mv-1',
      availability: 'ok', summarizerVersion: 'sv-1', value: { total: 6000 },
      window: { start: '2026-11-14T00:00:00Z', end: '2026-11-15T00:00:00Z' }, timezone: 'Asia/Shanghai', unit: '步', statistic: 'sum' }] } }, 'known')
    store.saveHealthSummary(USER, { eventId: 'h-oxygen', payload: { summaries: [{ type: 'oxygen', metricVersion: 'mv-1',
      availability: 'ok', summarizerVersion: 'sv-1', value: 97 }] } }, 'pending') // 未知类型：保存但不进上下文
    const read = await call('along_health_read') as { summaries: { type: string; window?: { start: string; end: string }; availability: string }[] }
    expect(read.summaries).toHaveLength(1)
    expect(read.summaries[0]).toMatchObject({ type: 'steps', availability: 'ok', window: { start: '2026-11-14T00:00:00Z', end: '2026-11-15T00:00:00Z' } })
    expect((await call('along_health_read', { type: 'weight' }) as { summaries: unknown[] }).summaries).toHaveLength(0)
    const tool = tools().find(item => item.name === 'along_health_read')!
    expect(() => tool.schema.parse({ type: 'oxygen' })).toThrow() // 非 D5 七类不是模型可请求的类型
  })

  it('along_changes_commit injects the bound goal, goes through the facade, and passes conflicts through', async () => {
    const applied = await call('along_changes_commit', input({ ops: [{ op: 'goal.update', fields: { title: '每周运动 150 分钟' } }] })) as { status: string; changeset_id: string }
    expect(applied).toMatchObject({ status: 'applied', goal_revision: 2 })
    expect(store.getChangeSet(USER, applied.changeset_id!)).toMatchObject({ ticketId: 'ticket-1', workId: 'w_cswork0001' })
    const conflicted = await call('along_changes_commit', input({ base_revision: 1,
      ops: [{ op: 'goal.update', fields: { title: '每周运动 999 分钟' } }] })) as { status: string; reason: string }
    expect(conflicted).toEqual({ status: 'conflicted', reason: 'conflicted_revision' })
    const unbound = alongTools({ service, scopeFor: () => scope({ allowedGoalId: undefined }) }, 'ticket-1')
      .find(tool => tool.name === 'along_changes_commit')!
    await expect(unbound.execute(unbound.schema.parse(input({ ops: [{ op: 'task.create', content: 'x' }] })), new AbortController().signal))
      .rejects.toThrow(/goal.create/)
  })

  it('every tool schema converts to the JSON schema DSH registers (strict shapes survive)', () => {
    expect(() => z.toJSONSchema(ALONG_CHANGE_SET_INPUT_SCHEMA)).not.toThrow()
    for (const tool of tools()) expect(() => z.toJSONSchema(tool.schema)).not.toThrow()
  })
})

describe('the real DSH registry keeps Along tools beside the work tools with restrict and the end guard', () => {
  it('executes the batch API for Along reads and a commit, masks foreign tools, and refuses after the ticket ends', async () => {
    const ctx = new Context()
    ctx.reflect.provide('systemPrompt', { tools: () => () => {} })
    const registry = new ToolRuntime(ctx)
    const definition = (name: string) => ({ name, description: name, parameters: { type: 'object' as const, properties: {} },
      output: { schema: { type: 'object' as const, properties: { ok: { type: 'boolean' as const } }, required: ['ok'] },
        render: () => [{ type: 'text' as const, text: 'ok' }] }, execute: async () => ({ ok: true }) })
    for (const name of ['read', 'bash', 'skill', 'foreign_tool']) registry.register(definition(name))
    const agent = { id: 'along-changeset-worker' } as Agent
    const agentScope = createScope(ctx, agent)
    Object.assign(agent, { ctx: agentScope.ctx })
    try {
      for (const along of alongTools(alongHost(), 'ticket-probe')) {
        agentScope.ctx.tools.register({ name: along.name, description: along.description, parameters: z.toJSONSchema(along.schema),
          output: { schema: { type: 'object' as const, additionalProperties: true }, render: () => [{ type: 'text' as const, text: 'ok' }] },
          execute: (args, execution) => along.execute(along.schema.parse(args), execution.signal) })
      }
      // Mirror Sessions.workOnly exactly: the allow-list filters WORK_TOOLS through the parent scope's view —
      // agent-local tools (the Along registrations) stay exempt from the restriction and visible.
      const parent = scopeParentOf(agent)
      agentScope.ctx.tools.restrict({ allow: WORK_TOOLS.filter(name => agentScope.ctx.tools.get(name, parent)) })
      let ended = false
      agentScope.ctx.tools.guard(() => ended ? 'Ticket ended; new work needs a new authorized ticket' : undefined)
      const call = (name: string, args: Record<string, unknown> = {}) =>
        registry.execute({ callId: name as never, name, arguments: args, agent, signal: new AbortController().signal })
      for (const name of ['read', 'bash', 'skill', 'along_goal_read', 'along_conversation_read', 'along_task_list', 'along_health_read']) {
        expect(await call(name)).toMatchObject({ isError: false })
      }
      expect(await call('along_changes_commit', input({ ops: [{ op: 'goal.update', fields: { title: '每周运动 125 分钟' } }] })))
        .toMatchObject({ isError: false })
      expect(store.currentRevision('goal', GOAL)).toBe(2)
      expect(await call('foreign_tool')).toMatchObject({ isError: true }) // restrict 名单之外
      ended = true
      expect(await call('along_goal_read')).toMatchObject({ isError: true }) // 工单结束后既有 guard 拒绝
    } finally { await agentScope.dispose() }
  })
})

describe('static vectors: the assignment port equals the goal-agent-core.mjs baseline (SD-1)', () => {
  // Expected values produced by the original implementation (along/web/goal-agent-core.mjs:76) on 2026-11-15.
  const VECTORS: readonly (readonly [string, GoalDomain, number | null])[] = [
    ['目标改成 150 分钟', 'health', 150],
    ['每周运动目标提高到 150 分钟', 'health', 150],
    ['把目标改成 2 小时 30 分钟', 'health', 150],
    ['目标改成 150 分钟，目标改成 180 分钟', 'health', 180],
    ['今天运动量改成 150 分钟', 'health', null],
    ['不要把目标改成 150 分钟', 'health', null],
    ['下次改成 200 分钟', 'health', null],
    ['每天 30 分钟', 'health', null],
    ['目标改成 150 分钟以内', 'health', null],
    ['如果目标改成 150 分钟就好了', 'health', null],
    ['目标 120 分钟', 'health', 120],
    ['别忘了把目标改成 150 分钟', 'health', 150],
    ['达到 150 分钟', 'health', null],
    ['目标达到 150 分钟', 'health', 150],
    ['我想每周运动 120 分钟', 'health', null],
    ['睡眠目标改成 8 小时', 'health', 480],
    ['每月房租设为 2500 元', 'finance', null],
    ['目标改成 ¥30,000', 'finance', 30000],
    ['攒钱目标改成 2.5 万元', 'finance', 25000],
    ['目标改成 2500 元', 'finance', 2500],
    ['目标改成 10000001 元', 'finance', null],
    ['攒够 3 万元', 'finance', null],
    ['预算改成 500 元', 'finance', null],
    ['目标改成 2 万元', 'finance', 20000],
  ]
  it('extracts the same assigned target as the old chain for every vector', () => {
    for (const [message, domain, expected] of VECTORS) expect(requestedTargetFromMessage(message, domain)).toBe(expected)
  })
  it('normalizes number-like targets exactly like numberLikeTarget', () => {
    expect(numberLikeTarget('120')).toBe(120)
    expect(numberLikeTarget('10,000')).toBe(10000)
    expect(numberLikeTarget('abc')).toBe('abc')
    expect(numberLikeTarget(120.5)).toBe(120.5)
    expect(numberLikeTarget('1,00')).toBe('1,00')
  })
})

// ---- test scaffolding ---------------------------------------------------------------------------------------------------

/** Along tools host over the current store/service; the scopeFor stand-in mirrors worklink's workScopeForTicket. */
function alongHost(scopeOver: Partial<CommitScope> = {}): AlongToolsHost {
  return { service, scopeFor: () => scope(scopeOver) }
}

/** Minimal ExecutorToolsHost: only `github.deployment.github` is evaluated at registration time. */
function executorHost(along?: AlongToolsHost): ExecutorToolsHost {
  return { engine: {}, store: {}, sessions: {}, resources: {},
    github: { deployment: {} } as unknown as SourceContext,
    sendReplies: async () => undefined, ...(along === undefined ? {} : { along }) } as unknown as ExecutorToolsHost
}
