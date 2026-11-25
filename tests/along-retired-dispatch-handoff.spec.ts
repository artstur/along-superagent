/** Synthetic temporary databases only; no production payload, device, model or network. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AlongStore } from '../src/along/store.ts'
import { handoffSHA256, type HandoffExportInput } from '../src/along/handoff.ts'

const USER = 'u_aabb1122', DEVICE = 'd_aabb1122', GOAL = 'g_retired_history', TASK = 't_retired_history'
const NOW = '2026-11-25T04:00:00.000Z', FUTURE = '2030-11-26T04:00:00.000Z'
const INPUT: HandoffExportInput = { migrationId: 'retired_review_synthetic', sourceUserId: USER, sourceDeviceId: DEVICE,
  goalIds: [GOAL], targetOrigin: 'https://along.example.com', createdAt: NOW,
  activationPermitSHA256: handoffSHA256('synthetic-permit'), hostCompanionSHA256: handoffSHA256('synthetic-companion') }
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'along-retired-dispatch-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function fixture(): AlongStore {
  const store = new AlongStore(join(dir, 'source', 'along.sqlite'))
  store.assertUser(USER, DEVICE)
  store.insertGoal({ userId: USER, domain: 'health', goalId: GOAL })
  store.appendGoalRevision({ userId: USER, goalId: GOAL, title: 'Synthetic historical goal', status: 'active' })
  store.ensureInputVersion(USER, GOAL)
  store.insertTask({ userId: USER, goalId: GOAL, taskId: TASK, content: 'Synthetic preserved task', scheduledAt: FUTURE })
  store.appendTaskRevision({ userId: USER, taskId: TASK, content: 'Synthetic preserved task', status: 'open', scheduledAt: FUTURE })
  return store
}

it('exports explicitly retired NULL-result due history when the real Runtime pending query is empty', () => {
  const source = fixture()
  try {
    const dispatch = source.health.dispatchDue(USER, GOAL, 1, { taskId: TASK, revision: 1, dueAt: NOW }, [])
    source.health.retireDue(dispatch.eventId)
    expect(source.health.get(dispatch.eventId)?.result).toBeUndefined()
    expect(source.health.pending()).toEqual([])
    const packet = source.exportPersonalHandoff(INPUT)
    expect(packet.data.health_dispatch).toHaveLength(1)
    expect(packet.data.health_dispatch[0]?.result).toBeNull()
    expect(packet.data.task_review[0]?.retired).toBe(1)
  } finally { source.close() }
})
