/** The registered calculation tool keeps the work-scope guard: a scope released after registration must refuse, not calculate.
 * Synthetic store and host doubles only; no model, network or device. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AlongStore } from '../src/along/store.ts'
import { AlongService } from '../src/along/service.ts'
import { createInbox } from '../src/along/inbox.ts'
import { alongTools } from '../src/along/tools.ts'
import type { HealthFollowup } from '../src/along/health.ts'

const user = 'u_calc_scope', device = 'd_calc_scope', ticketId = 'ticket_calc_scope'
const dirs: string[] = [], stores: AlongStore[] = []
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const calculation = { quantities: [{ name: 'count', value: '3', unit: '1' }, { name: 'duration', value: '25', unit: 'minute' }],
  steps: [{ id: 'total', op: 'multiply', inputs: ['count', 'duration'] }, { id: 'minutes', op: 'convert', inputs: ['total'], unit: 'minute' }], result_step: 'minutes' }

/** A worker whose work scope is live at registration and released afterwards. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'along-calculation-scope-')); dirs.push(dir)
  const store = new AlongStore(join(dir, 'along.sqlite')); stores.push(store)
  store.assertUser(user, device)
  const goal = store.insertGoal({ userId: user, domain: 'custom' })
  store.appendGoalRevision({ userId: user, goalId: goal.id, title: '合成核算目标', status: 'active' })
  const task = store.insertTask({ userId: user, goalId: goal.id, content: '核算差额' })
  store.appendTaskRevision({ userId: user, taskId: task.id, content: '核算差额' })
  store.triggers.put(store.assertTaskOwner(user, task.id), { kind: 'immediate', actor: 'agent', capability: 'calculation' }, store.inputVersion(goal.id))
  const service = new AlongService(store, { inbox: createInbox(store) })
  let released = false
  const scopeFor = () => released ? undefined : { userId: user, allowedGoalId: goal.id, triggerEventId: 'evt_calc_scope' }
  const dispatch = { eventId: 'dispatch_calc_scope', userId: user, goalId: goal.id, inputVersion: store.inputVersion(goal.id), snapshot: [], createdAt: new Date().toISOString(),
    due: { taskId: task.id, revision: 1, dueAt: new Date().toISOString() } }
  let calculationScopes = 0
  const healthFollowup = {
    forTicket: () => dispatch,
    assertActive: () => {},
    tools: () => [],
    calculationScope: () => {
      calculationScopes += 1
      return { userId: user, goalId: goal.id, taskId: task.id, taskRevision: 1, taskContent: '核算差额',
        inputVersion: store.inputVersion(goal.id), ticketId, executionKey: 'occurrence_calc_scope' }
    },
  } as unknown as HealthFollowup
  return { store, goal, task, service, scopeFor, healthFollowup, release: () => { released = true }, calculationScopes: () => calculationScopes }
}

it('a calculation whose work scope was released after registration refuses instead of calculating', async () => {
  const f = fixture()
  const calculate = alongTools({ service: f.service, scopeFor: f.scopeFor, healthFollowup: f.healthFollowup }, ticketId).find(tool => tool.name === 'along_calculate')
  expect(calculate, '注册时范围有效，along_calculate 必须在工具清单里').toBeDefined()
  f.release()
  await expect(calculate!.execute({ calculation }, new AbortController().signal)).rejects.toThrow('has no Along work scope')
  // The guard runs before the occurrence is resolved: no calculation scope was ever taken and no receipt was written.
  expect(f.calculationScopes()).toBe(0)
  expect(f.store.taskExecution(user, f.task.id).count).toBe(0)
})
