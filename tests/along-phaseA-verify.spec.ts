/**
 * Independent verification of the stage-A integration anchors (docs/business-test-cases.md,
 * docs/stage-a-tech-design.md §2.7/§6) — written from the anchors, not from the implementation's own
 * specs (`tests/along-phaseA.spec.ts`, `tests/along-inbox.spec.ts`). Two edges the anchors name that the
 * existing suite does not pin end to end:
 *
 * ① BC-09-04 (003 §4): a rollback must keep the database *and* recover by itself — a delivery that went
 *    `failed` (12 attempts, 10-minute slow cadence) survives a runtime restart and is delivered by a fresh
 *    pump over the same reopened database, with no manual clearing and exactly one `delivery_failed` sync.
 * ② BC-00-05 (001 §4.3): the offline phone's reconnect — several changes land while nothing pulls; the sync
 *    pull pages forward by cursor, a partial ack settles only its seqs, a repeated ack is a no-op, and the
 *    rows (delivered or not) stay pullable for a re-pull from 0.
 *
 * Store-level on purpose: `deliverDueDeliveries` drives the real pump pass without timers, and the store
 * file reopened through a second `AlongStore` is the restart's persistence proof.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AlongStore } from '../src/along/store.ts'
import { createInbox } from '../src/along/inbox.ts'
import { deliverDueDeliveries } from '../src/along/delivery.ts'
import type { DeliveryDeps } from '../src/along/delivery.ts'
import type { EventEnvelope } from '../src/along/envelope.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'along-phasea-verify-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const USER = 'u_paverify1'
const DEVICE = 'd_paverify1'

function freshStore(): AlongStore {
  const store = new AlongStore(join(directory, 'along.sqlite'))
  store.assertUser(USER, DEVICE)
  return store
}
/** An accepted inbox event with its queued delivery, through the real receive state machine (BC-08-01). */
function seededEvent(store: AlongStore, eventId: string, text: string): string {
  const envelope: EventEnvelope = {
    event_id: eventId, schema_version: '1', event_type: 'along.user_message',
    occurred_at: '2026-11-15T09:00:00+08:00', timezone: 'Asia/Shanghai',
    payload: { event_type: 'along.user_message', text },
  }
  const receipt = createInbox(store).acceptEvent(envelope, { userId: USER, deviceId: DEVICE })
  expect(receipt.status).toBe('accepted')
  return `along:${USER}:${eventId}`
}
const deliverDeps = (results: ('stored' | 'duplicate' | 'filtered' | Error)[]): DeliveryDeps => {
  let next = 0
  return { receive: async () => { const r = results[next++] ?? 'stored'; if (r instanceof Error) throw r; return r },
    filteredReason: () => 'source_disabled' }
}

describe('stage A anchors, independently: a failed delivery recovers across a restart (BC-09-04) and the offline sync pull is cursor/partial-ack exact (BC-00-05)', () => {
  it('keeps a failed delivery on disk, re-delivers it from a reopened store at the slow-retry time, and never adds a second failure sync', async () => {
    const first = freshStore()
    const triggerId = seededEvent(first, 'evt-restore-1', '我想每周运动 120 分钟')
    // 12 failed attempts → `failed` with the 10-minute slow cadence, and exactly one user-visible failure sync.
    let outcome: { attempts: number; status: 'pending' | 'failed' } | undefined
    for (let attempt = 1; attempt <= 12; attempt++) {
      outcome = first.recordDeliveryFailure(triggerId, new Date(Date.UTC(2026, 10, 15, 9, 0, attempt)).toISOString(), `attempt ${attempt} down`)
    }
    expect(outcome).toMatchObject({ attempts: 12, status: 'failed' })
    const failed = first.getDelivery(triggerId)!
    expect(failed.status).toBe('failed')
    const retryAt = Date.parse(new Date(Date.UTC(2026, 10, 15, 9, 0, 12)).toISOString()) + 600_000
    expect(failed.nextAttemptAt).toBe(retryAt)
    expect(first.syncPage(USER, 0, 10).items.filter(item => item.kind === 'delivery_failed')).toHaveLength(1)
    // No manual clearing: the row is still queued before its retry time (a fresh pump claims nothing).
    expect(await deliverDueDeliveries(first, deliverDeps(['stored']), retryAt - 1)).toBe(0)
    expect(first.getDelivery(triggerId)!.status).toBe('failed')
    first.close()

    // The restart reopens the same database file with a fresh pump: the failed row is scanned again and,
    // once its slow retry is due, delivered without any operator action.
    const restarted = freshStore()
    const row = restarted.getDelivery(triggerId)!
    expect(row.status).toBe('failed') // nothing cleared by stopping and reopening
    expect(await deliverDueDeliveries(restarted, deliverDeps(['stored']), retryAt)).toBe(1)
    const delivered = restarted.getDelivery(triggerId)!
    expect(delivered.status).toBe('delivered')
    expect(delivered.attempts).toBe(12) // the history survives the recovery
    expect(restarted.syncPage(USER, 0, 10).items.filter(item => item.kind === 'delivery_failed')).toHaveLength(1) // still exactly one
    restarted.close()
  })

  it('pages the offline sync forward by cursor, settles only acked seqs, and answers a repeated ack without changing anything (BC-00-05)', () => {
    const store = freshStore()
    // Three changes land while the phone is offline: a goal change, its note, and an execution message.
    const seqs = [
      store.appendSync({ userId: USER, kind: 'goal_updated', payload: { goal_id: 'g_offline001', title: '每周运动 150 分钟' } }),
      store.appendSync({ userId: USER, kind: 'changeset_note', payload: { changeset_id: 'cs_offline001', reason: '用户把目标调整到 150 分钟' } }),
      store.appendSync({ userId: USER, kind: 'message', payload: { message_id: 'msg:u_paverify1:evt-1', direction: 'outbound', text: '执行说明（ready）：目标已调整。' } }),
    ]
    expect(seqs).toEqual([1, 2, 3])
    // First pull after reconnect: one page of two, cursor continues into the third.
    const page1 = store.syncPage(USER, 0, 2)
    expect(page1.items.map(item => item.kind)).toEqual(['goal_updated', 'changeset_note'])
    expect(page1.items.every(item => item.deliveredAt === undefined)).toBe(true)
    expect(page1.nextCursor).toBe('2')
    const page2 = store.syncPage(USER, Number(page1.nextCursor), 2)
    expect(page2.items.map(item => item.kind)).toEqual(['message'])
    expect(page2.nextCursor).toBeUndefined()
    // The phone acks only the first page: exactly those settle, the rest stays pending for the next pull.
    store.markSynced(USER, page1.items.map(item => item.seq))
    const settled = store.syncPage(USER, 0, 10).items
    expect(settled.find(item => item.seq === seqs[0])?.deliveredAt).toBeDefined()
    expect(settled.find(item => item.seq === seqs[1])?.deliveredAt).toBeDefined()
    expect(settled.find(item => item.seq === seqs[2])?.deliveredAt).toBeUndefined()
    // A re-pull from 0 still answers all three rows (the reconnect may re-fetch; delivery is marked, not erased).
    expect(store.syncPage(USER, 0, 10).items).toHaveLength(3)
    // A repeated ack of already-settled seqs is a no-op: no error, no new row, no delivered_at drift.
    const firstDeliveredAt = store.syncPage(USER, 0, 10).items.find(item => item.seq === seqs[0])!.deliveredAt
    store.markSynced(USER, [seqs[0]!, seqs[2]!]) // one already settled, one new
    const after = store.syncPage(USER, 0, 10).items
    expect(after.find(item => item.seq === seqs[0])!.deliveredAt).toBe(firstDeliveredAt)
    expect(after.find(item => item.seq === seqs[2])!.deliveredAt).toBeDefined()
    expect(after).toHaveLength(3)
    store.close()
  })
})
