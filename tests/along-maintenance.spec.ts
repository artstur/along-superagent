/** Scheduled maintenance acceptance through the actual Runtime, Engine, tools and SQLite; only SDK I/O is synthetic. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'
import { Store } from '../src/app/store.ts'
import { AlongStore } from '../src/along/store.ts'
import { HyMemoryBackend } from '../src/along/memory/hy-client.ts'
import { MAINTENANCE_SOURCE, nextMaintenanceAt } from '../src/along/maintenance.ts'
import type { ExtractionInput } from '../src/along/memory/model.ts'
import { MemoryBackendError } from '../src/along/memory/model.ts'
import type { Trigger } from '../src/core/index.ts'
import { policyEffects, settingsPolicy } from '../src/policy.ts'
import { reference } from './fixtures/deployment.ts'
import type { Machine } from '../src/deployment.ts'

const USER = 'u_cccccccc', OTHER = 'u_dddddddd', PAST = '2020-01-01T00:00:00.000Z'
let host: Host | undefined
const directories: string[] = []
afterEach(async () => {
  await host?.stop(); host = undefined
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const seed: Parameters<typeof startRuntime>[0] = store => store.saveSettings({ ...store.settings(),
  policy: { ...store.settings().policy, sources: { along: { allowed: [{ id: USER }, { id: OTHER }], admission: {} } } },
  sources: { along: { enabled: true, config: {} }, github: { enabled: false, config: {} } } })
function sdk() {
  return vi.spyOn(HyMemoryBackend.prototype, 'extract').mockImplementation(async (input: ExtractionInput) => ({ backendIds: ['sdk-node'],
    candidates: input.sources.map(source => ({ quote: source.text, topic: source.id, category: 'preference', assertion: 'explicit',
      sourceMessageIds: [source.id], backendIds: ['sdk-node'], replaces: [], conflictsWith: [] })) }))
}
async function configured(options: { dir?: string; sdk?: boolean; time?: Machine['alongMaintenanceTime'] } = {}) {
  const root = options.dir ?? mkdtempSync(join(tmpdir(), 'along-maintenance-')); if (!options.dir) directories.push(root)
  if (!options.dir) { const db = new Store(join(root, 'orchestrator.sqlite')); seed!(db); db.close() }
  const h = host = await startRuntime(undefined, { dir: root, alongMaintenanceTime: options.time, ...(options.sdk === false ? {} : { alongMemory: {
    python: '/bin/false', dataDir: join(root, 'memory'), envFile: join(root, 'memory.env'),
  } }) })
  h.runtime.along!.service.alongStore.assertUser(USER, 'd_cccccccc')
  return { h, store: h.runtime.along!.service.alongStore, maintenance: h.runtime.along!.maintenance }
}
function message(store: AlongStore, id = 'preference', userId = USER) {
  return store.appendMessage({ userId, eventId: id, role: 'user', direction: 'inbound', text: `长期偏好晚饭前运动 ${id}` })
}
function due(store: AlongStore, userId = USER) {
  store.maintenance.nextDue(userId, PAST); store.maintenance.advance(userId, PAST)
}
async function dispatch(h: Host, userId = USER) {
  await h.runtime.pump(); await h.runtime.idle()
  const ticket = h.runtime.store.tickets.list().find(ticket => ticket.mandate.basis.via === 'scheduled' && ticket.mandate.actor.id === userId)!
  expect(ticket).toBeDefined()
  await vi.waitFor(() => expect(h.tools.has(`worker-${ticket.id}`)).toBe(true), { timeout: 10_000 })
  return { ticket, worker: `worker-${ticket.id}` }
}

it('accepts fixed scheduled work without a router, validates memory and completion, records the run and stays quiet', async () => {
  const extract = sdk(), { h, store } = await configured()
  const source = message(store); due(store)
  const { ticket, worker } = await dispatch(h)
  expect(h.runtime.store.triggers.get(ticket.origin.triggerId)).toMatchObject({ human: false, source: MAINTENANCE_SOURCE })
  const stop = h.runtime.engine.decide(ticket.origin.triggerId, { kind: 'stop', ticketId: ticket.id, reason: 'timer is not a person' })
  expect(stop.reason).toEqual([{ code: 'stopNotExplicit' }])
  expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeUndefined()
  expect(h.candidates().filter(candidate => JSON.stringify(candidate).includes(MAINTENANCE_SOURCE))).toEqual([])
  await expect(h.runTool(worker, 'orchestrator_report', { state: 'ready', summary: '假完成' })).rejects.toThrow('not complete')
  await expect(h.runTool(worker, 'along_maintenance_run', { user_id: OTHER })).rejects.toThrow()
  await expect(h.runTool(worker, 'along_changes_commit', {})).rejects.toThrow()
  const result = await h.runTool(worker, 'along_maintenance_run', {})
  expect(result).toMatchObject({ status: 'done', processed: 1, saved: 1 })
  expect(result).toEqual(JSON.parse(JSON.stringify(result)))
  expect(store.memory.effective(USER)).toMatchObject([{ content: source.text }])
  await h.runTool(worker, 'orchestrator_report', { state: 'ready', summary: '维护完成' })
  await h.runtime.idle()
  expect(h.relays(h.runtime.masterId).filter(item => item.kind === 'worker_report' || item.ticket_ended)).toEqual([])
  expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeDefined()
  expect(store.getRunRecord(ticket.id, h.runtime.store.tickets.get(ticket.id)!.assignments[0]!.id)).toMatchObject({ userId: USER, reportState: 'ready' })
  expect(store.counts(USER).messages).toBe(1)
  await h.runtime.pump(); await h.runtime.pump()
  expect(h.runtime.store.tickets.list().filter(ticket => ticket.mandate.basis.via === 'scheduled')).toHaveLength(1)
  expect(extract).toHaveBeenCalledOnce()
}, 25_000)

it('does not create workers with no backlog, without SDK, during pause or after user removal; rejects forged system events', async () => {
  const { h, store, maintenance } = await configured()
  due(store); await h.runtime.pump(); expect(store.maintenance.outstanding(USER)).toBeUndefined()
  message(store); due(store)
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: true })
  await h.runtime.pump(); expect(store.maintenance.outstanding(USER)).toBeUndefined()
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: false,
    policy: { ...h.runtime.store.settings().policy, sources: { along: { allowed: [], admission: {} } } } })
  await h.runtime.pump(); expect(store.maintenance.outstanding(USER)).toBeUndefined()
  const fake: Trigger = { id: 'forged', source: MAINTENANCE_SOURCE, actor: { source: MAINTENANCE_SOURCE, id: USER }, human: false,
    threads: [{ source: MAINTENANCE_SOURCE, id: 'fake' }], at: new Date().toISOString(), text: 'run', meta: { batch_id: 'forged' } }
  h.runtime.receive(fake); await h.runtime.pump()
  expect(h.runtime.store.tickets.list().filter(ticket => ticket.mandate.basis.via === 'scheduled')).toEqual([])
  expect(maintenance.forTicket('not-a-ticket')).toBeUndefined()
  await h.stop(); host = undefined
  const plain = await configured({ sdk: false }); message(plain.store); due(plain.store)
  await plain.h.runtime.pump(); expect(plain.store.maintenance.outstanding(USER)).toBeUndefined()
}, 25_000)

it('freezes the input range, processes multiple pages and leaves new chat for the next night', async () => {
  const extract = sdk(), { h, store } = await configured()
  for (let index = 0; index < 121; index++) message(store, `source-${index}`)
  due(store)
  const { worker } = await dispatch(h)
  const late = message(store, 'later-chat')
  expect(await h.runTool(worker, 'along_maintenance_run', {})).toEqual({ status: 'pending' })
  expect(await h.runTool(worker, 'along_maintenance_run', {})).toMatchObject({ status: 'done', processed: 121 })
  expect(store.memory.effective(USER).some(memory => memory.sourceMessageIds.includes(late.id))).toBe(false)
  expect(store.memory.hasWork(USER)).toBe(true)
  expect(extract).toHaveBeenCalledTimes(7)
}, 25_000)

it('persists SDK backoff and resumes the same batch and ticket after a restart with many missed days', async () => {
  const extract = sdk().mockRejectedValue(new Error('SDK offline'))
  const first = await configured(); message(first.store); due(first.store)
  const { ticket, worker } = await dispatch(first.h)
  expect(await first.h.runTool(worker, 'along_maintenance_run', {})).toMatchObject({ status: 'pending', retry_at: expect.any(String) })
  const batch = first.store.maintenance.outstanding(USER)!
  await first.h.runTool(worker, 'along_maintenance_run', {})
  expect(extract).toHaveBeenCalledOnce()
  await first.h.runTool(worker, 'orchestrator_report', { state: 'failed', summary: 'SDK 暂时不可用' })
  const directory = first.h.directory
  await first.h.stop(); host = undefined
  sdk()
  const next = await configured({ dir: directory })
  next.store.maintenance.defer(batch.id, PAST)
  await next.h.runtime.pump(); await next.h.runtime.idle()
  expect(next.store.maintenance.outstanding(USER)?.id).toBe(batch.id)
  expect(next.h.runtime.store.tickets.list().filter(ticket => ticket.mandate.basis.via === 'scheduled')).toHaveLength(1)
  expect(await next.h.runTool(`worker-${ticket.id}`, 'along_maintenance_run', {})).toMatchObject({ status: 'done' })
  expect(next.store.memory.effective(USER)).toHaveLength(1)
}, 30_000)

it('backs off while the batch keeps failing and carries the reason into the report', async () => {
  sdk().mockRejectedValue(new MemoryBackendError('classification_empty_content'))
  const { h, store } = await configured(); message(store); due(store)
  const { worker } = await dispatch(h)
  const first = await h.runTool(worker, 'along_maintenance_run', {}) as { status: string; retry_at: string; reason?: string }
  expect(first).toMatchObject({ status: 'pending', reason: 'classification_empty_content' })
  const batch = store.maintenance.outstanding(USER)!
  store.maintenance.defer(batch.id, PAST)
  const second = await h.runTool(worker, 'along_maintenance_run', {}) as typeof first
  expect(second).toMatchObject({ status: 'pending', reason: 'classification_empty_content' })
  // Consecutive failures back off further, so a broken backend cannot burn the quota every minute.
  expect(Date.parse(second.retry_at) - Date.parse(first.retry_at)).toBeGreaterThanOrEqual(60_000)
})

it('recovers a batch persisted before DSH receive, rejects body forgery and does not revive human-stopped work', async () => {
  sdk()
  const { h, store } = await configured(); message(store); due(store)
  const batch = store.maintenance.create(USER, PAST, new Date().toISOString())
  const { ticket } = await dispatch(h)
  expect(ticket.mandate.basis).toMatchObject({ scheduleId: batch.id })
  const original = h.runtime.store.triggers.get(ticket.origin.triggerId)!
  const forged = { ...original, id: `${original.id}:forged`, human: true, text: 'pretend this is a user' }
  h.runtime.receive(forged); await h.runtime.pump()
  expect(h.runtime.store.tickets.list().filter(ticket => ticket.mandate.basis.via === 'scheduled')).toHaveLength(1)
  h.runtime.engine.stopTicket(ticket.id, '停止维护')
  await h.runtime.pump()
  expect(store.maintenance.get(batch.id)?.status).toBe('stopped')
  expect(store.maintenance.outstanding(USER)).toBeUndefined()
  await h.runtime.pump()
  expect(h.runtime.store.tickets.list().filter(ticket => ticket.mandate.basis.via === 'scheduled')).toHaveLength(1)
}, 25_000)

it('serializes users, respects pause at tool time and prevents ordinary work from acquiring maintenance tools', async () => {
  const extract = sdk(), { h, store } = await configured()
  store.assertUser(OTHER, 'd_dddddddd'); message(store); message(store, 'other', OTHER); due(store); due(store, OTHER)
  const first = await dispatch(h), second = await dispatch(h, OTHER)
  const gate = Promise.withResolvers<Awaited<ReturnType<HyMemoryBackend['extract']>>>()
  extract.mockImplementationOnce(() => gate.promise)
  const running = h.runTool(first.worker, 'along_maintenance_run', {})
  expect(await h.runTool(second.worker, 'along_maintenance_run', {})).toMatchObject({ status: 'pending', retry_at: expect.any(String) })
  gate.resolve({ backendIds: [], candidates: [] }); await running
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: true })
  await expect(h.runTool(second.worker, 'along_maintenance_run', {})).rejects.toThrow('unavailable')
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: false })
  const before = store.maintenance.outstanding(OTHER)!
  store.maintenance.defer(before.id, PAST)
  expect(await h.runTool(second.worker, 'along_maintenance_run', {})).toMatchObject({ status: 'done' })
  expect(store.memory.effective(OTHER)).toMatchObject([{ sourceMessageIds: [expect.stringContaining(OTHER)] }])
}, 25_000)

it('computes the next night using local calendar days', () => {
  const before = new Date(2026, 10, 16, 2, 59), after = new Date(2026, 10, 16, 3, 0)
  expect(new Date(nextMaintenanceAt(before)).getDate()).toBe(16)
  expect(new Date(nextMaintenanceAt(after)).getDate()).toBe(17)
  expect(new Date(nextMaintenanceAt(after)).getHours()).toBe(3)
  const custom = new Date(nextMaintenanceAt(new Date(2026, 10, 16, 2, 14), '02:15'))
  expect([custom.getDate(), custom.getHours(), custom.getMinutes()]).toEqual([16, 2, 15])
  expect(new Date(nextMaintenanceAt(custom, '02:15')).getDate()).toBe(17)
  expect(new Date(nextMaintenanceAt(new Date(2026, 11, 31, 23, 59), '00:00')).getFullYear()).toBe(2027)
})

it('replans future schedules from live configuration and preserves the configured time across restart', async () => {
  sdk(); const time = reference('03:00'), first = await configured({ time })
  first.store.maintenance.nextDue(USER, '2099-01-01T00:00:00.000Z')
  await first.h.runtime.pump()
  time.set('23:45'); await first.h.runtime.pump()
  expect((await first.h.api('GET', 'state')).body).toMatchObject({ setup: { machine: { alongMaintenanceTime: '23:45' } } })
  const dueAt = first.store.maintenance.nextDue(USER, PAST), next = new Date(dueAt)
  expect([next.getHours(), next.getMinutes()]).toEqual([23, 45])
  expect(next.getFullYear()).toBeLessThan(2099)
  expect(first.store.maintenance.outstanding(USER)).toBeUndefined()
  const directory = first.h.directory
  await first.h.stop(); host = undefined; sdk()
  const reopened = await configured({ dir: directory, time: reference('23:45') })
  await reopened.h.runtime.pump()
  expect(reopened.store.maintenance.nextDue(USER, PAST)).toBe(dueAt)
}, 30_000)

it('does not skip an overdue batch on time changes and uses the latest time after in-flight work', async () => {
  sdk(); const time = reference('03:00'), { h, store } = await configured({ time })
  message(store); due(store); time.set('22:10')
  const { ticket, worker } = await dispatch(h), batch = store.maintenance.outstanding(USER)!
  expect(batch.dueAt).toBe(PAST)
  time.set('01:25'); await h.runtime.pump()
  expect(store.maintenance.outstanding(USER)?.id).toBe(batch.id)
  expect(h.runtime.store.tickets.list().filter(ticket => ticket.mandate.basis.via === 'scheduled')).toHaveLength(1)
  expect(await h.runTool(worker, 'along_maintenance_run', {})).toMatchObject({ status: 'done' })
  const next = new Date(store.maintenance.nextDue(USER, PAST))
  expect([next.getHours(), next.getMinutes()]).toEqual([1, 25])
  await h.runTool(worker, 'orchestrator_report', { state: 'ready', summary: '维护完成' })
  expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeDefined()
}, 25_000)

it('keeps normal settings changes from revoking a scheduled mandate and does revoke removed users', async () => {
  sdk(); const { h, store, maintenance } = await configured(); message(store); due(store)
  const { ticket } = await dispatch(h), old = h.runtime.store.settings()
  const scope = () => ({ scope: () => ({ listened: true as const, observed: false }) })
  const policyFor: typeof settingsPolicy = (settings, sources) => maintenance.policy(settingsPolicy(settings, sources), settings)
  const changed = { ...old, eval: { ...old.eval, mode: 'off' as const } }
  expect(policyEffects([ticket], old, changed, scope, policyFor).size).toBe(0)
  const removed = { ...old, policy: { ...old.policy, sources: { along: { allowed: [], admission: {} } } } }
  expect(policyEffects([ticket], old, removed, scope, policyFor).get(ticket.id)).toMatchObject({ requesterAllowed: false })
}, 25_000)

it('schedules SDK cleanup without new chat, retains kept evidence and never revives withdrawn memory', async () => {
  sdk(); const clear = vi.spyOn(HyMemoryBackend.prototype, 'clearUser').mockResolvedValue()
  const { h, store } = await configured(); message(store, 'withdraw'); message(store, 'keep')
  await h.runtime.along!.memory.runBatch(USER)
  const [withdrawn] = store.memory.effective(USER)
  h.runtime.along!.memory.forget({ userId: USER }, withdrawn!.id)
  due(store); const { worker } = await dispatch(h)
  expect(await h.runTool(worker, 'along_maintenance_run', {})).toMatchObject({ status: 'done' })
  expect(clear).toHaveBeenCalledOnce()
  expect(store.memory.projectionPending(USER)).toBe(false)
  expect(store.memory.effective(USER)).toHaveLength(1)
  expect(store.memory.effective(USER)[0]!.id).not.toBe(withdrawn!.id)
  expect(store.counts(USER).messages).toBe(2)
}, 25_000)

it('does not complete or reschedule a stopped batch when an in-flight SDK request returns', async () => {
  const extract = sdk(), { h, store } = await configured(); message(store); due(store)
  const { ticket, worker } = await dispatch(h), batch = store.maintenance.outstanding(USER)!
  const gate = Promise.withResolvers<Awaited<ReturnType<HyMemoryBackend['extract']>>>()
  extract.mockImplementationOnce(() => gate.promise)
  const running = h.runTool(worker, 'along_maintenance_run', {})
  h.runtime.engine.stopTicket(ticket.id, '停止本次运行')
  gate.resolve({ backendIds: [], candidates: [] })
  expect(await running).toMatchObject({ status: 'stopped' })
  expect(store.maintenance.get(batch.id)?.status).toBe('stopped')
  await h.runtime.pump()
  expect(h.runtime.store.tickets.list().filter(ticket => ticket.mandate.basis.via === 'scheduled')).toHaveLength(1)
}, 25_000)

it.each(['batch', 'received'] as const)('recovers the same batch across a crash after %s persistence', async phase => {
  sdk(); const first = await configured(); message(first.store); due(first.store)
  first.h.runtime.store.saveSettings({ ...first.h.runtime.store.settings(), paused: true })
  const batch = first.store.maintenance.create(USER, PAST, new Date().toISOString())
  if (phase === 'received') {
    first.h.runtime.store.saveSettings({ ...first.h.runtime.store.settings(), paused: false })
    first.maintenance.tick()
    first.h.runtime.store.saveSettings({ ...first.h.runtime.store.settings(), paused: true })
    expect(first.h.runtime.store.triggers.get(`${MAINTENANCE_SOURCE}:${batch.id}`)).toBeDefined()
    expect(first.h.runtime.store.tickets.list().filter(ticket => ticket.mandate.basis.via === 'scheduled')).toHaveLength(0)
  }
  const directory = first.h.directory
  await first.h.stop(); host = undefined; sdk()
  const next = await configured({ dir: directory })
  next.h.runtime.store.saveSettings({ ...next.h.runtime.store.settings(), paused: false })
  const { ticket, worker } = await dispatch(next.h)
  expect(ticket.mandate.basis).toMatchObject({ scheduleId: batch.id })
  expect(await next.h.runTool(worker, 'along_maintenance_run', {})).toMatchObject({ status: 'done' })
}, 30_000)

it('waits for an in-flight batch during shutdown and resumes it before closing the reopened database', async () => {
  const extract = sdk(), first = await configured(); message(first.store); due(first.store)
  const { worker, ticket } = await dispatch(first.h)
  const gate = Promise.withResolvers<Awaited<ReturnType<HyMemoryBackend['extract']>>>()
  extract.mockImplementationOnce(() => gate.promise)
  vi.spyOn(HyMemoryBackend.prototype, 'close').mockImplementation(async () => {
    expect(first.store.counts(USER).messages).toBe(1)
    gate.resolve({ backendIds: [], candidates: [] })
  })
  const running = first.h.runTool(worker, 'along_maintenance_run', {})
  const batch = first.store.maintenance.outstanding(USER)!, directory = first.h.directory
  await first.h.stop(); host = undefined
  expect(await running).toMatchObject({ status: 'pending' })
  expect(() => first.store.counts(USER)).toThrow()
  sdk(); const next = await configured({ dir: directory })
  next.store.maintenance.defer(batch.id, PAST)
  await next.h.runtime.pump(); await next.h.runtime.idle()
  expect(await next.h.runTool(`worker-${ticket.id}`, 'along_maintenance_run', {})).toMatchObject({ status: 'done' })
}, 30_000)

it('does not expose the maintenance capability to an ordinary conversation worker', async () => {
  sdk(); const { h } = await configured()
  const headers = { 'x-along-bridge': '1', 'x-along-bridge-token': h.runtime.along!.bridgeToken,
    'x-along-user': USER, 'x-along-device': 'd_cccccccc' }
  expect((await h.alongApi('POST', 'events', { event_id: 'ordinary-chat', schema_version: '1', event_type: 'along.user_message',
    occurred_at: new Date().toISOString(), timezone: 'Asia/Shanghai', payload: { event_type: 'along.user_message', text: '安排今天的运动' } }, headers)).body)
    .toMatchObject({ status: 'accepted' })
  const trigger = `along:${USER}:ordinary-chat`
  await vi.waitFor(() => expect(h.runtime.along!.service.alongStore.getDelivery(trigger)?.status).toBe('delivered'), { timeout: 10_000 })
  const accepted = await h.route({ kind: 'accept', trigger_id: trigger, title: '安排运动', worktree_name: 'ordinary-memory', acknowledgement: '收到。' })
  await h.runtime.idle()
  const worker = `worker-${(accepted.ticket as { ticket_id: string }).ticket_id}`
  await expect(h.runTool(worker, 'along_maintenance_run', {})).rejects.toThrow('not registered')
  expect(h.tools.get(worker)?.has('along_memory_search')).toBe(true)
}, 25_000)

it('re-evaluates the same received batch after temporarily losing permission before acceptance', async () => {
  sdk(); const { h, store, maintenance } = await configured(); message(store); due(store)
  maintenance.tick()
  const batch = store.maintenance.outstanding(USER)!, old = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...old, policy: { ...old.policy, sources: { along: { allowed: [], admission: {} } } } })
  await h.runtime.pump()
  expect(h.runtime.store.tickets.list().filter(ticket => ticket.mandate.basis.via === 'scheduled')).toHaveLength(0)
  h.runtime.store.saveSettings(old)
  const { ticket } = await dispatch(h)
  expect(ticket.mandate.basis).toMatchObject({ scheduleId: batch.id })
  await h.runtime.pump()
  expect(h.runtime.store.tickets.list().filter(ticket => ticket.mandate.basis.via === 'scheduled')).toHaveLength(1)
}, 25_000)

it('backfills a committed completed assignment whose business execution record was lost at the cross-store crash boundary', async () => {
  sdk(); const first = await configured(); message(first.store); due(first.store)
  const { ticket, worker } = await dispatch(first.h)
  await first.h.runTool(worker, 'along_maintenance_run', {})
  await first.h.runTool(worker, 'orchestrator_report', { state: 'ready', summary: '已完成记忆维护' })
  const directory = first.h.directory, assignmentId = ticket.assignments[0]!.id
  await first.h.stop(); host = undefined
  const raw = new DatabaseSync(join(directory, 'along-data', 'along.sqlite'))
  raw.prepare('DELETE FROM run_record WHERE ticket_id=?').run(ticket.id); raw.close()
  const next = await configured({ dir: directory, sdk: false })
  await next.h.runtime.pump()
  expect(next.store.getRunRecord(ticket.id, assignmentId)).toMatchObject({ userId: USER, reportState: 'ready', endedAt: expect.any(String) })
  expect(next.h.runtime.store.tickets.list().filter(ticket => ticket.mandate.basis.via === 'scheduled')).toHaveLength(1)
}, 30_000)
