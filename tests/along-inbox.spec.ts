/**
 * Inbox module tests (`src/along/envelope.ts` + `src/along/inbox.ts` + `src/along/delivery.ts`): the event
 * envelope schema, the receive state machine, and the delivery pump.
 *
 * Acceptance rows covered (design §6): BC-08-01 (Inbox + business record + delivery queue commit in one
 * transaction before the persistent receipt; a mid-transaction failure rolls everything back and sends no
 * receipt), BC-08-02 (a same-id retry answers from the stored row; rejected events stay rejected on retry),
 * BC-08-03 (a duplicate event returns the duplicate receipt and produces no second business/delivery row),
 * BC-08-11 (the user message's original text is saved first), BC-07-04 (identity in the body refused),
 * BC-07-05 (a foreign goal/task is refused without leaking existence) — plus the §4.6 Trigger mapping the
 * pump feeds into DSH intake, the server-derived health `adapter` (§2.2.4) and the D15 `authorization.changed`
 * handling (recorded, never delivered, never a failure).
 *
 * The payloadHash vector below is the Along Agent half of the two-end static case vectors (SD-1/SG-1): the same
 * vector constants and expected hash are pinned in `along/test/event-queue.test.mjs`; either end changing the
 * protocol must change the vectors first.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AlongService } from '../src/along/service.ts'
import { AlongStore } from '../src/along/store.ts'
import { createInbox } from '../src/along/inbox.ts'
import { deliverDueDeliveries, startDeliveryPump, triggerForDelivery } from '../src/along/delivery.ts'
import { EVENT_SCHEMA_VERSION, EventEnvelopeSchema, envelopeForTrigger, payloadHash } from '../src/along/envelope.ts'
import type { BoundIdentity, EventEnvelope } from '../src/along/envelope.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'along-inbox-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const USER = 'u_inbox001'
const OTHER = 'u_other001'
const DEVICE = 'd_inbox001'
const GOAL = 'g_inbox00001'
const TASK = 't_inbox00001'
const identity: BoundIdentity = { userId: USER, deviceId: DEVICE }

function seededStore(path = join(directory, 'along.sqlite')): AlongStore {
  const store = new AlongStore(path)
  store.assertUser(USER, DEVICE)
  store.insertGoal({ userId: USER, domain: 'health', goalId: GOAL })
  store.appendGoalRevision({ goalId: GOAL, userId: USER, title: '每周运动 120 分钟',
    metric: { type: 'workout', target: 120, unit: '分钟', period: 'week' }, status: 'active' })
  store.ensureInputVersion(USER, GOAL)
  return store
}
const count = (path: string, table: string): number =>
  Number(new DatabaseSync(path).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n)

let tick = 0
const userMessage = (overrides: Partial<EventEnvelope> = {}): EventEnvelope => ({
  event_id: `evt-inbox-${String(++tick).padStart(3, '0')}`,
  schema_version: EVENT_SCHEMA_VERSION,
  event_type: 'along.user_message',
  occurred_at: '2026-11-15T08:30:00+08:00',
  timezone: 'Asia/Shanghai',
  payload: { event_type: 'along.user_message', text: '帮我把目标改成 180 分钟' },
  ...overrides,
})

// ---- envelope schema & payloadHash (§4.1, §2.2.8) ---------------------------------------------------------------------

describe('envelope schema and payloadHash', () => {
  // Two-end static vector (SD-1/SG-1): mirrored verbatim in `along/test/event-queue.test.mjs`.
  const VECTOR = {
    event_id: 'evt-vector-0001', schema_version: EVENT_SCHEMA_VERSION, event_type: 'along.user_message' as const,
    goal_id: 'g_vector000001', occurred_at: '2026-11-15T08:30:00+08:00', timezone: 'Asia/Shanghai',
    message_id: 'msg-vector-001', payload: { event_type: 'along.user_message' as const, text: '把目标改成 180 分钟' },
  }
  const EXPECTED_HASH = '7ca682b408b9da20d3c2c38afaabdcc8a7fbe9e4e4ea614c74a6d73dac0e12c2'

  it('hashes the client-declared fields stably, independent of key order and of absent optional fields', () => {
    expect(payloadHash(VECTOR)).toBe(EXPECTED_HASH)
    const shuffled = { payload: VECTOR.payload, timezone: VECTOR.timezone, message_id: VECTOR.message_id,
      occurred_at: VECTOR.occurred_at, goal_id: VECTOR.goal_id, event_type: VECTOR.event_type,
      schema_version: VECTOR.schema_version, event_id: VECTOR.event_id }
    expect(payloadHash(shuffled)).toBe(EXPECTED_HASH)
    // Server-bound fields are out of the coverage: received_at never changes the hash (§2.2.8).
    expect(payloadHash({ ...VECTOR, received_at: '2026-11-15T00:31:00.000Z' } as unknown as EventEnvelope)).toBe(EXPECTED_HASH)
  })

  it('accepts a legal envelope of every event type, kind included only on along.message', () => {
    expect(EventEnvelopeSchema.safeParse(userMessage()).success).toBe(true)
    expect(EventEnvelopeSchema.safeParse(userMessage({ event_id: 'evt-h-1', event_type: 'along.health_summary_updated',
      payload: { event_type: 'along.health_summary_updated', summaries: [{ type: 'steps', metric_version: 'mv1',
        window: { start: '2026-11-14T00:00:00+08:00', end: '2026-11-15T00:00:00+08:00' }, timezone: 'Asia/Shanghai',
        value: 5200, availability: 'ok', summarizer_version: 's1' }] } })).success).toBe(true)
    expect(EventEnvelopeSchema.safeParse(userMessage({ event_id: 'evt-k-1', event_type: 'along.message',
      kind: 'task.completed', goal_id: GOAL, task_id: TASK,
      payload: { event_type: 'along.message', kind: 'task.completed', task_id: TASK, note: '已完成' } })).success).toBe(true)
  })

  it('refuses schema drift: version, types, ranges, whitespace-only text and unknown keys', () => {
    expect(EventEnvelopeSchema.safeParse({ ...userMessage(), schema_version: '2' }).success).toBe(false)
    expect(EventEnvelopeSchema.safeParse({ ...userMessage(), event_type: 'along.goal.updated' }).success).toBe(false)
    expect(EventEnvelopeSchema.safeParse({ ...userMessage(), occurred_at: 'not-a-time' }).success).toBe(false)
    expect(EventEnvelopeSchema.safeParse({ ...userMessage(), timezone: '' }).success).toBe(false)
    expect(EventEnvelopeSchema.safeParse(userMessage({ payload: { event_type: 'along.user_message', text: '   ' } })).success).toBe(false)
    expect(EventEnvelopeSchema.safeParse({ ...userMessage(), extra: 1 }).success).toBe(false)
    const long = userMessage({ payload: { event_type: 'along.user_message', text: '长'.repeat(801) } })
    expect(EventEnvelopeSchema.safeParse(long).success).toBe(false)
  })

  it('enforces the cross-field refines: payload/event_type mismatch and kind placement (§4.1 ①②)', () => {
    const mismatch = { ...userMessage(), event_type: 'along.health_summary_updated' }
    expect(EventEnvelopeSchema.safeParse(mismatch).success).toBe(false)
    const strayKind = { ...userMessage(), kind: 'task.completed' }
    expect(EventEnvelopeSchema.safeParse(strayKind).success).toBe(false)
    const kindDrift = { ...userMessage({ event_id: 'evt-kd-1', event_type: 'along.message', kind: 'task.feedback',
      task_id: TASK, payload: { event_type: 'along.message', kind: 'task.completed', task_id: TASK } }) }
    expect(EventEnvelopeSchema.safeParse(kindDrift).success).toBe(false)
  })

  it('enforces the payload refines: feedback needs task_id, authorization.changed carries no business payload', () => {
    const noTask = { ...userMessage({ event_id: 'evt-nt-1', event_type: 'along.message', kind: 'task.completed',
      payload: { event_type: 'along.message', kind: 'task.completed' } }) }
    expect(EventEnvelopeSchema.safeParse(noTask).success).toBe(false)
    const withPayload = { ...userMessage({ event_id: 'evt-ap-1', event_type: 'along.message', kind: 'authorization.changed',
      payload: { event_type: 'along.message', kind: 'authorization.changed', note: '撤回' } }) }
    expect(EventEnvelopeSchema.safeParse(withPayload).success).toBe(false)
    expect(EventEnvelopeSchema.safeParse({ ...userMessage({ event_id: 'evt-ac-1', event_type: 'along.message',
      kind: 'authorization.changed', payload: { event_type: 'along.message', kind: 'authorization.changed' } }) }).success).toBe(true)
  })

  it('refuses client-claimed adapter and raw sample fields in health summaries (server-derived, §2.2.4)', () => {
    const withAdapter = userMessage({ event_id: 'evt-ad-1', event_type: 'along.health_summary_updated',
      payload: { event_type: 'along.health_summary_updated', summaries: [{ type: 'steps', metric_version: 'mv1',
        timezone: 'Asia/Shanghai', availability: 'ok', summarizer_version: 's1', adapter: 'known' }] } as unknown as EventEnvelope['payload'] })
    expect(EventEnvelopeSchema.safeParse(withAdapter).success).toBe(false)
    const withSamples = userMessage({ event_id: 'evt-rs-1', event_type: 'along.health_summary_updated',
      payload: { event_type: 'along.health_summary_updated', summaries: [{ type: 'steps', metric_version: 'mv1',
        timezone: 'Asia/Shanghai', availability: 'ok', summarizer_version: 's1', samples: [{ at: 'x', value: 1 }] }] } as unknown as EventEnvelope['payload'] })
    expect(EventEnvelopeSchema.safeParse(withSamples).success).toBe(false)
  })
})

// ---- receive state machine (BC-08-01/02/03/11, BC-07-04/05, D15) ------------------------------------------------------

describe('acceptEvent transactional receive', () => {
  it('plugs into the §4.3 facade seam: the Runtime-assembled AlongService accepts the same raw body', () => {
    const store = seededStore()
    const service = new AlongService(store, { inbox: createInbox(store) })
    const envelope = userMessage()
    // The loopback API forwards the raw JSON body; the facade contract (AlongInboxModule) accepts it as-is.
    const receipt = service.acceptEvent(JSON.parse(JSON.stringify(envelope)) as never, identity)
    expect(receipt).toMatchObject({ status: 'accepted', event_id: envelope.event_id })
    expect(service.alongStore.findInboxEvent(USER, envelope.event_id)!.status).toBe('accepted')
    store.close()
  })

  it('commits Inbox + message + delivery together and answers the persistent receipt (BC-08-01/BC-08-11)', () => {
    const path = join(directory, 'along.sqlite')
    const store = seededStore(path)
    const inbox = createInbox(store)
    const envelope = userMessage({ goal_id: GOAL })
    const receipt = inbox.acceptEvent(envelope, identity)
    expect(receipt.status).toBe('accepted')
    expect(receipt.event_id).toBe(envelope.event_id)
    expect(receipt.received_seq).toBe(1)
    expect(count(path, 'event_inbox')).toBe(1)
    expect(count(path, 'message')).toBe(1)
    expect(count(path, 'delivery')).toBe(1)
    const row = store.findInboxEvent(USER, envelope.event_id)!
    expect(row.status).toBe('accepted')
    expect(row.triggerId).toBe(`along:${USER}:${envelope.event_id}`)
    expect(row.payloadHash).toBe(payloadHash(envelope))
    const message = store.getMessage(USER, `msg:${USER}:${envelope.event_id}`)!
    expect(message.text).toBe('帮我把目标改成 180 分钟') // 原文（BC-08-11）
    expect(store.getGoal(USER, GOAL)!.currentRevision).toBe(1)
    expect(store.inputVersion(GOAL)).toBe(2) // 用户新聊天立即提升输入版本（001 §7.4）
    store.close()
  })

  it('saves a goal-less message without linking or raising any input version (不丢弃，无可提升目标)', () => {
    const path = join(directory, 'along.sqlite')
    const store = seededStore(path)
    const inbox = createInbox(store)
    const receipt = inbox.acceptEvent(userMessage(), identity)
    expect(receipt.status).toBe('accepted')
    expect(store.getMessage(USER, `msg:${USER}:${receipt.event_id}`)).toBeDefined()
    expect(store.listGoals(USER).items[0]!.currentRevision).toBe(1)
    expect(store.inputVersion(GOAL)).toBe(1)
    store.close()
  })

  it('rolls the whole transaction back when a business write fails mid-way, and sends no receipt (BC-08-01 失败侧)', () => {
    const path = join(directory, 'along.sqlite')
    const store = seededStore(path)
    const breaking = Object.assign(Object.create(store), {
      raiseInputVersion: () => { throw new Error('simulated failure after the message row') },
    }) as AlongStore
    ;(breaking as unknown as { depth: number }).depth = 0
    expect(() => createInbox(breaking).acceptEvent(userMessage({ goal_id: GOAL }), identity)).toThrow('simulated failure')
    expect(count(path, 'event_inbox')).toBe(0)
    expect(count(path, 'message')).toBe(0)
    expect(count(path, 'delivery')).toBe(0)
    expect(store.inputVersion(GOAL)).toBe(1)
    store.close()
  })

  it('saves health summaries with the server-derived adapter, known seven types vs pending unknowns (§2.2.4)', () => {
    const path = join(directory, 'along.sqlite')
    const store = seededStore(path)
    const inbox = createInbox(store)
    const receipt = inbox.acceptEvent(userMessage({ event_id: 'evt-health-1', event_type: 'along.health_summary_updated',
      payload: { event_type: 'along.health_summary_updated', summaries: [
        { type: 'steps', metric_version: 'mv1', unit: '步', statistic: 'sum', timezone: 'Asia/Shanghai',
          window: { start: '2026-11-14T00:00:00+08:00', end: '2026-11-15T00:00:00+08:00' },
          value: 5200, availability: 'ok', summarizer_version: 'summarizer-7' },
        { type: 'blood_oxygen', metric_version: 'mv1', timezone: 'Asia/Shanghai',
          availability: 'no_permission', summarizer_version: 'summarizer-7' },
      ] } }), identity)
    expect(receipt.status).toBe('accepted')
    expect(receipt.received_seq).toBeUndefined()
    const rows = store.latestHealthSummaries(USER)
    expect(rows.map(row => `${row.type}:${row.adapter}`).sort()).toEqual(['blood_oxygen:pending', 'steps:known'])
    expect(rows.find(row => row.type === 'steps')!.value).toEqual(5200)
    expect(count(path, 'delivery')).toBe(0) // Stage C saves facts first; only per-goal follow-ups enter DSH
    store.close()
  })

  it('applies a completion fact: message row, status done, version advance with a NULL-basis revision (D4, §2.2.6)', () => {
    const path = join(directory, 'along.sqlite')
    const store = seededStore(path)
    store.insertTask({ goalId: GOAL, userId: USER, content: '完成 30 分钟快走', taskId: TASK })
    store.appendTaskRevision({ taskId: TASK, userId: USER, content: '完成 30 分钟快走', basisChangeset: 'cs_seed000001' })
    const inbox = createInbox(store)
    const receipt = inbox.acceptEvent(userMessage({ event_id: 'evt-done-0001', event_type: 'along.message', kind: 'task.completed',
      goal_id: GOAL, task_id: TASK, message_id: 'msg-original-01',
      payload: { event_type: 'along.message', kind: 'task.completed', task_id: TASK, completed_at: '2026-11-15T09:00:00+08:00' } }), identity)
    expect(receipt.status).toBe('accepted')
    expect(receipt.received_seq).toBe(1)
    const task = store.getTask(USER, TASK)!
    expect(task.status).toBe('done')
    expect(task.completedFeedbackEventId).toBe('evt-done-0001')
    expect(task.currentRevision).toBe(2)
    const revision = new DatabaseSync(path).prepare('SELECT basis_changeset, origin_event_id, status FROM task_revision WHERE task_id = ? AND revision = 2').get(TASK)
    expect(revision).toMatchObject({ basis_changeset: null, origin_event_id: 'evt-done-0001', status: 'done' })
    const message = store.getMessage(USER, `msg:${USER}:evt-done-0001`)!
    expect(message.text).toBe('任务完成反馈：完成 30 分钟快走') // 无 note 时服务端兜底生成（§2.2.6）
    expect(message.messageId).toBe('msg-original-01')
    store.close()
  })

  it('emits a goal-scoped task_updated sync row for the completion fact so the phone can learn the task is done', () => {
    const path = join(directory, 'along.sqlite')
    const store = seededStore(path)
    store.insertTask({ goalId: GOAL, userId: USER, content: '完成 30 分钟快走', taskId: TASK })
    const inbox = createInbox(store)
    const receipt = inbox.acceptEvent(userMessage({ event_id: 'evt-done-0002', event_type: 'along.message', kind: 'task.completed',
      goal_id: GOAL, task_id: TASK,
      payload: { event_type: 'along.message', kind: 'task.completed', task_id: TASK, completed_at: '2026-11-15T09:00:00+08:00' } }), identity)
    expect(receipt.status).toBe('accepted')
    const items = store.syncPage(USER, 0, 50).items
    const updated = items.find(item => item.kind === 'task_updated')
    expect(updated).toBeDefined()
    expect(updated!.goalId).toBe(GOAL)
    expect(updated!.taskId).toBe(TASK)
    expect(updated!.payload).toMatchObject({ task_id: TASK, goal_id: GOAL, status: 'done', revision: store.getTask(USER, TASK)!.currentRevision })
    // The phone applies a goal snapshot only for goal-scoped items — without goal_id the client keeps the old state.
    const synced = store.workspaceSync(USER, 0, 50).items.find(item => item.kind === 'task_updated')!
    expect(synced.goalId).toBe(GOAL)
    const snapshot = (synced.payload as { snapshot?: { tasks: { id: string; status: string }[] } }).snapshot!
    expect(snapshot.tasks.find(task => task.id === TASK)!.status).toBe('done')
    store.close()
  })

  it('keeps one done version and one sync row when the same task is completed twice', () => {
    const path = join(directory, 'along.sqlite')
    const store = seededStore(path)
    store.insertTask({ goalId: GOAL, userId: USER, content: '完成 30 分钟快走', taskId: TASK })
    const inbox = createInbox(store)
    const complete = (eventId: string) => inbox.acceptEvent(userMessage({ event_id: eventId, event_type: 'along.message', kind: 'task.completed',
      goal_id: GOAL, task_id: TASK,
      payload: { event_type: 'along.message', kind: 'task.completed', task_id: TASK, completed_at: '2026-11-15T09:00:00+08:00' } }), identity)
    expect(complete('evt-done-0201').status).toBe('accepted')
    // 同一任务的第二条完成事实（手机同步失败时重试）：不再推进版本，不再发第二条同步项。
    expect(complete('evt-done-0202').status).toBe('accepted')
    const task = store.getTask(USER, TASK)!
    expect(task.status).toBe('done')
    expect(task.currentRevision).toBe(1)
    const revisions = new DatabaseSync(path).prepare('SELECT revision, status FROM task_revision WHERE task_id = ? ORDER BY revision').all(TASK)
    expect(revisions).toEqual([{ revision: 1, status: 'done' }])
    const syncRows = store.syncPage(USER, 0, 50).items.filter(item => item.kind === 'task_updated')
    expect(syncRows).toHaveLength(1)
    expect(syncRows[0]!.payload).toMatchObject({ task_id: TASK, goal_id: GOAL, status: 'done', revision: 1 })
    expect(store.taskExecution(USER, TASK).count).toBe(1)
    store.close()
  })

  it('records a task feedback as a message row only — no status change, no version advance', () => {
    const path = join(directory, 'along.sqlite')
    const store = seededStore(path)
    store.insertTask({ goalId: GOAL, userId: USER, content: '完成 30 分钟快走', taskId: TASK })
    const inbox = createInbox(store)
    const receipt = inbox.acceptEvent(userMessage({ event_id: 'evt-fb-00001', event_type: 'along.message', kind: 'task.feedback',
      task_id: TASK, payload: { event_type: 'along.message', kind: 'task.feedback', task_id: TASK, note: '今天只走了 20 分钟' } }), identity)
    expect(receipt.status).toBe('accepted')
    expect(store.getTask(USER, TASK)!.status).toBe('open')
    expect(store.getTask(USER, TASK)!.currentRevision).toBe(0)
    expect(store.getMessage(USER, `msg:${USER}:evt-fb-00001`)!.text).toBe('今天只走了 20 分钟')
    store.close()
  })

  it('records authorization.changed without any business write or delivery, and never as a failure (D15)', () => {
    const path = join(directory, 'along.sqlite')
    const store = seededStore(path)
    const inbox = createInbox(store)
    const receipt = inbox.acceptEvent(userMessage({ event_id: 'evt-auth-0001', event_type: 'along.message',
      kind: 'authorization.changed', payload: { event_type: 'along.message', kind: 'authorization.changed' } }), identity)
    expect(receipt.status).toBe('accepted')
    expect(receipt.received_seq).toBeUndefined()
    expect(store.findInboxEvent(USER, 'evt-auth-0001')!.status).toBe('accepted')
    expect(store.findInboxEvent(USER, 'evt-auth-0001')!.triggerId).toBeUndefined()
    expect(count(path, 'delivery')).toBe(0)
    expect(count(path, 'message')).toBe(0)
    store.close()
  })

  it('answers duplicate for the same id + content with no second row, and conflict for same id different content (BC-08-03)', () => {
    const path = join(directory, 'along.sqlite')
    const store = seededStore(path)
    const inbox = createInbox(store)
    const envelope = userMessage({ goal_id: GOAL })
    expect(inbox.acceptEvent(envelope, identity).status).toBe('accepted')
    expect(inbox.acceptEvent(envelope, identity)).toMatchObject({ status: 'duplicate', event_id: envelope.event_id })
    // A retry re-sends the same serialized envelope (the client queue's rule, §2.2.7) — a JSON round-trip
    // is the same envelope to the hash, so it still answers duplicate.
    expect(inbox.acceptEvent(JSON.parse(JSON.stringify(envelope)), identity)).toMatchObject({ status: 'duplicate' })
    expect(count(path, 'message')).toBe(1)
    expect(count(path, 'delivery')).toBe(1)
    const drifted = { ...envelope, payload: { event_type: 'along.user_message' as const, text: '另一句话' } }
    expect(inbox.acceptEvent(drifted, identity)).toMatchObject({ status: 'conflict', event_id: envelope.event_id })
    expect(count(path, 'message')).toBe(1)
    store.close()
  })

  it('keeps refused events refused on same-id retry — client_goal_mutation, identity_in_body, invalid envelope (BC-08-02)', () => {
    const path = join(directory, 'along.sqlite')
    const store = seededStore(path)
    const inbox = createInbox(store)
    // D4/BC-01-06: goals change only through chat — refused before parsing, row kept for 拒绝原因可查.
    const mutation = { ...userMessage(), event_type: 'along.goal.updated' }
    const firstRefusal = inbox.acceptEvent(mutation, identity)
    expect(firstRefusal).toMatchObject({ status: 'rejected', reason: 'client_goal_mutation' })
    expect(store.findInboxEvent(USER, firstRefusal.event_id)!.rejectReason).toBe('client_goal_mutation')
    expect(inbox.acceptEvent(mutation, identity)).toMatchObject({ status: 'rejected', reason: 'client_goal_mutation' })
    // BC-07-04: a body claiming identity is refused (direct calls fall the row; the API layer refuses earlier).
    const claimed = { ...userMessage(), user_id: OTHER }
    const identityRefusal = inbox.acceptEvent(claimed, identity)
    expect(identityRefusal).toMatchObject({ status: 'rejected', reason: 'identity_in_body' })
    expect(store.findInboxEvent(USER, identityRefusal.event_id)!.rejectReason).toBe('identity_in_body')
    // Schema drift with a legal event id falls a rejected row; without one, 400-shaped refusal and no row.
    const drift = { ...userMessage(), schema_version: '2' }
    expect(inbox.acceptEvent(drift, identity)).toMatchObject({ status: 'rejected', reason: 'invalid_envelope' })
    expect(store.findInboxEvent(USER, drift.event_id)!.rejectReason).toBe('invalid_envelope')
    expect(inbox.acceptEvent({ garbage: true }, identity)).toMatchObject({ status: 'rejected', event_id: '', reason: 'invalid_envelope' })
    expect(count(path, 'event_inbox')).toBe(3)
    expect(inbox.acceptEvent(drift, identity)).toMatchObject({ status: 'rejected', reason: 'invalid_envelope' }) // 重试仍是 rejected
    expect(count(path, 'message')).toBe(0)
    expect(count(path, 'delivery')).toBe(0)
    store.close()
  })

  it('refuses a foreign goal or task as not_found without revealing existence (BC-07-05)', () => {
    const path = join(directory, 'along.sqlite')
    const store = seededStore(path)
    store.assertUser(OTHER, 'd_other001')
    store.insertGoal({ userId: OTHER, domain: 'health', goalId: 'g_other00001' })
    const inbox = createInbox(store)
    const foreign = inbox.acceptEvent(userMessage({ goal_id: 'g_other00001' }), identity)
    expect(foreign).toMatchObject({ status: 'rejected', reason: 'not_found' })
    expect(store.findInboxEvent(USER, foreign.event_id)!.rejectReason).toBe('ownership') // 内部精确原因
    expect(count(path, 'message')).toBe(0)
    const foreignTask = inbox.acceptEvent(userMessage({ event_id: 'evt-ft-0001', event_type: 'along.message',
      kind: 'task.feedback', payload: { event_type: 'along.message', kind: 'task.feedback', task_id: 't_foreign0001' } }), identity)
    expect(foreignTask).toMatchObject({ status: 'rejected', reason: 'not_found' })
    store.close()
  })
})

// ---- delivery pump (§2.2.2, §4.6) --------------------------------------------------------------------------------------

describe('delivery pump', () => {
  it('rebuilds the §4.6 trigger from the stored row: stable id, human/addressed only for chat, meta and inline text', () => {
    const store = seededStore()
    const inbox = createInbox(store)
    const envelope = userMessage({ goal_id: GOAL })
    inbox.acceptEvent(envelope, identity)
    const row = store.claimDueDeliveries(Date.now(), 10)[0]!
    const trigger = triggerForDelivery(store, row)
    expect(trigger.id).toBe(`along:${USER}:${envelope.event_id}`)
    expect(trigger.source).toBe('along')
    expect(trigger.threads[0]).toEqual({ source: 'along', id: `goal/${GOAL}/request/${envelope.event_id}` })
    expect(trigger.actor).toEqual({ source: 'along', id: USER })
    expect(trigger.human).toBe(true)
    expect(trigger.addressed).toBe('direct')
    expect(trigger.text).toBe('帮我把目标改成 180 分钟')
    expect(trigger.meta).toMatchObject({ event_type: 'along.user_message', goal_id: GOAL, schema_version: '1' })
    expect(trigger.at).toBe(store.findInboxEvent(USER, envelope.event_id)!.receivedAt) // at 是服务端接收时刻
    // A health trigger is never human (001 §7.1) and carries the summary inline text.
    inbox.acceptEvent(userMessage({ event_id: 'evt-health-9', event_type: 'along.health_summary_updated',
      payload: { event_type: 'along.health_summary_updated', summaries: [{ type: 'steps', metric_version: 'mv1',
        timezone: 'Asia/Shanghai', value: 5200, availability: 'ok', summarizer_version: 's1' }] } }), identity)
    expect(store.claimDueDeliveries(Date.now(), 10).some(r => r.eventId === 'evt-health-9')).toBe(false)
    const health = store.findInboxEvent(USER, 'evt-health-9')!
    const healthTrigger = envelopeForTrigger({event_id:health.eventId,schema_version:'1',event_type:'along.health_summary_updated',
      occurred_at:health.occurredAt!,received_at:health.receivedAt,timezone:health.timezone!,payload:health.payload as never},identity,`health/${USER}/evt-health-9`)
    expect(healthTrigger.human).toBe(false)
    expect(healthTrigger.addressed).toBeUndefined()
    expect(healthTrigger.threads[0]!.id).toBe(`health/${USER}/evt-health-9`)
    expect(healthTrigger.text).toContain('健康摘要更新')
    expect(healthTrigger.text).toContain('steps')
    // envelopeForTrigger stays a pure mapping (§2.2): the thread id arrives as a parameter.
    const mapped = envelopeForTrigger({ ...envelope, received_at: store.findInboxEvent(USER, envelope.event_id)!.receivedAt },
      identity, 'inbox/x/y')
    expect(mapped.threads[0]).toEqual({ source: 'along', id: 'inbox/x/y' })
    expect(mapped.id).toBe(trigger.id)
    store.close()
  })

  it('rides the reply association onto the live work thread at delivery time (BC-08-06 path ②, §2.5.4)', () => {
    const store = seededStore()
    const inbox = createInbox(store)
    const first = userMessage({ goal_id: GOAL })
    inbox.acceptEvent(first, identity)
    // A work is now open on the goal (as worklink would have mapped after evaluation).
    store.recordWorkLink({ ticketId: 'tk_inbox00001', workId: 'w_inboxwork001', goalId: GOAL,
      eventId: first.event_id, triggerId: `along:${USER}:${first.event_id}`, threadKey: `along:goal/${GOAL}/work/w_inboxwork001`, kind: 'ticket' })
    const reply = userMessage({ goal_id: GOAL, causation_id: first.event_id })
    inbox.acceptEvent(reply, identity)
    const claimed = store.claimDueDeliveries(Date.now(), 10)
    const replyTrigger = triggerForDelivery(store, claimed.find(r => r.eventId === reply.event_id)!)
    expect(replyTrigger.threads[0]!.id).toBe(`goal/${GOAL}/work/w_inboxwork001`)
    // The first event itself still names its own request thread — its trigger was built under the same rule set.
    const firstTrigger = triggerForDelivery(store, claimed.find(r => r.eventId === first.event_id)!)
    expect(firstTrigger.threads[0]!.id).toBe(`goal/${GOAL}/request/${first.event_id}`)
    store.close()
  })

  it('delivers at least once: stored, duplicate and filtered outcomes close the row, failures back off (BC-08-03, §2.2.2/2.2.3)', async () => {
    const store = seededStore()
    const inbox = createInbox(store)
    inbox.acceptEvent(userMessage({ event_id: 'evt-pump-0001' }), identity)
    inbox.acceptEvent(userMessage({ event_id: 'evt-pump-0002' }), identity)
    const seen: string[] = []
    let failFirst = true
    const deps = {
      receive: async (trigger: { id: string }) => {
        seen.push(trigger.id)
        if (trigger.id.endsWith('evt-pump-0001') && failFirst) { failFirst = false; throw new Error('dsh unreachable') }
        return trigger.id.endsWith('evt-pump-0002') ? 'duplicate' as const : 'stored' as const
      },
      filteredReason: () => undefined,
    }
    expect(await deliverDueDeliveries(store, deps, Date.now() + 60_000)).toBe(2) // 首轮全部到期
    const failed = store.getDelivery(`along:${USER}:evt-pump-0001`)!
    expect(failed.attempts).toBe(1)
    expect(failed.status).toBe('pending')
    expect(failed.nextAttemptAt).toBe(Date.parse(failed.lastAttemptAt!) + 1000) // 退避 1s
    expect(store.getDelivery(`along:${USER}:evt-pump-0002`)!.status).toBe('delivered') // duplicate 也算送达
    expect(await deliverDueDeliveries(store, deps, failed.nextAttemptAt - 1)).toBe(0) // 退避未到期（租约语义）
    expect(await deliverDueDeliveries(store, deps, failed.nextAttemptAt + 1)).toBe(1)
    expect(store.getDelivery(`along:${USER}:evt-pump-0001`)!.status).toBe('delivered')
    expect(seen.filter(id => id.endsWith('evt-pump-0001')).length).toBe(2) // 至少一次：失败后重投
    expect(store.syncPage(USER, 0, 50).items.filter(item => item.kind === 'delivery_failed')).toHaveLength(0) // 未达 12 次不产生失败同步；原话同步独立存在
    store.close()
  })

  it('closes a filtered delivery as terminal with the scope reason, and never re-claims it (§2.2.2)', async () => {
    const store = seededStore()
    const inbox = createInbox(store)
    inbox.acceptEvent(userMessage({ event_id: 'evt-filter-01' }), identity)
    let calls = 0
    const deps = {
      receive: () => { calls += 1; return 'filtered' as const },
      filteredReason: () => 'source_disabled',
    }
    expect(await deliverDueDeliveries(store, deps)).toBe(1)
    expect(await deliverDueDeliveries(store, deps)).toBe(0)
    expect(calls).toBe(1)
    const row = store.getDelivery(`along:${USER}:evt-filter-01`)!
    expect(row.status).toBe('filtered')
    expect(row.lastError).toBe('source_disabled')
    store.close()
  })

  it('turns persistently failing user messages into an explicit failure state after 12 attempts (§2.2.3)', async () => {
    const path = join(directory, 'along.sqlite')
    const store = seededStore()
    const inbox = createInbox(store)
    inbox.acceptEvent(userMessage({ event_id: 'evt-dead-0001' }), identity)
    const deps = { receive: async () => { throw new Error('still down') }, filteredReason: () => undefined }
    let now = Date.now() + 60_000 // 首轮到期
    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect(await deliverDueDeliveries(store, deps, now)).toBe(1)
      now += 700_000 // 超过最大退避与失败租约，行到期
    }
    const row = store.getDelivery(`along:${USER}:evt-dead-0001`)!
    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(12)
    const sync = new DatabaseSync(path).prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE kind = 'delivery_failed'").get()
    expect(Number(sync?.n)).toBe(1) // 用户消息得到明确失败状态（001 §4.1），仅一次
    expect(await deliverDueDeliveries(store, deps, now)).toBe(1) // failed 行按慢节奏继续重试
    expect(store.getDelivery(`along:${USER}:evt-dead-0001`)!.attempts).toBe(13)
    store.close()
  })

  it('stops on abort leaving rows queued for the next start (BC-09-04: no data cleared)', () => {
    const store = seededStore()
    const inbox = createInbox(store)
    inbox.acceptEvent(userMessage({ event_id: 'evt-stop-0001' }), identity)
    const controller = new AbortController()
    const stop = startDeliveryPump(store, { receive: () => 'stored' as const, filteredReason: () => undefined }, controller.signal)
    stop()
    const row = store.getDelivery(`along:${USER}:evt-stop-0001`)!
    expect(['pending', 'delivered']).toContain(row.status) // 停机前的一次 tick 可能已送达；否则行留库续投
    store.close()
  })
})
