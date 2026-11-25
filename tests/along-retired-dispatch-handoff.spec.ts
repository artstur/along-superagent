/** Synthetic temporary databases only; no production payload, device, model or network. */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AlongStore } from '../src/along/store.ts'
import { canonicalHandoffJSON, HANDOFF_CHECKPOINT_KEY, HANDOFF_FENCE, HANDOFF_TABLES, assertHandoffStartupAllowed,
  handoffSHA256, readHandoffStatus, readPersonalHandoff, validatePersonalHandoff, type PersonalHandoff, type HandoffExportInput } from '../src/along/handoff.ts'

import { Store } from '../src/app/store.ts'
import { runHandoffCLI } from '../src/along-handoff.ts'
import { startRuntime } from './fixtures/host.ts'

const USER = 'u_aabb1122', DEVICE = 'd_aabb1122', GOAL = 'g_retired_history', TASK = 't_retired_history'
const NOW = '2026-11-25T04:00:00.000Z', FUTURE = '2030-11-26T04:00:00.000Z'
const INPUT: HandoffExportInput = { migrationId: 'retired_review_synthetic', sourceUserId: USER, sourceDeviceId: DEVICE,
  goalIds: [GOAL], targetOrigin: 'https://along.example.com', createdAt: NOW,
  activationPermitSHA256: handoffSHA256('synthetic-permit'), hostCompanionSHA256: handoffSHA256('synthetic-companion') }
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'along-retired-dispatch-')) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })

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

type ReviewKind = 'due' | 'repair' | 'source'
function dispatchFor(store: AlongStore, kind: ReviewKind, retired = true): string {
  let eventId: string
  if (kind === 'due') {
    eventId = store.health.dispatchDue(USER, GOAL, 1, { taskId: TASK, revision: 1, dueAt: NOW }, []).eventId
    if (retired) store.health.retireDue(eventId)
  } else if (kind === 'repair') {
    eventId = store.health.requestTaskReview({ userId: USER, deviceId: DEVICE, goalId: GOAL, taskId: TASK,
      revision: 1, inputVersion: 1, evidenceEventId: 'synthetic_task_evidence', scheduledAt: FUTURE,
      content: 'Synthetic preserved task', reason: 'Synthetic superseded repair' }).dispatch.eventId
    if (retired) store.health.retireRepair(eventId)
  } else {
    store.replaceGoalDataSources(USER, GOAL, [{ provider: 'okx', reason: 'Synthetic authorized metadata' }])
    expect(store.sources.acceptEvent({ userId: USER, deviceId: DEVICE }, { event_id: 'synthetic_source_ready', goal_id: GOAL,
      provider: 'okx', generation: 1, revision: 1, state: 'ready', capabilities: ['trading_account_summary'],
      occurred_at: NOW, reference: 'synthetic-source-reference' }).status).toBe('accepted')
    eventId = store.health.requestSourceReview({ userId: USER, deviceId: DEVICE, goalId: GOAL, inputVersion: 1,
      provider: 'okx', sourceEventId: 'synthetic_source_ready', generation: 1, revision: 1,
      reference: 'synthetic-source-reference', capabilities: ['trading_account_summary'],
      legacyTasks: [], originalTaskIds: [TASK] }).dispatch.eventId
    if (retired) store.health.retireSourceReview(eventId)
    // Later disconnection is a real metadata transition; reopening must not bootstrap a new review.
    expect(store.sources.acceptEvent({ userId: USER, deviceId: DEVICE }, { event_id: 'synthetic_source_disconnected', goal_id: GOAL,
      provider: 'okx', generation: 1, revision: 2, state: 'disconnected', capabilities: [],
      occurred_at: NOW, reference: 'synthetic-disconnected-reference' }).status).toBe('accepted')
  }
  return eventId
}
function raw<T>(side: string, work: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(dir, side, 'along.sqlite'))
  try { return work(db) } finally { db.close() }
}
function portableRows(side: string) {
  return raw(side, db => Object.fromEntries(HANDOFF_TABLES.map(table => [table,
    db.prepare(`SELECT * FROM "${table}"`).all().map(row => ({ ...row }))
      .filter(row => table !== 'meta' || row.key !== HANDOFF_CHECKPOINT_KEY)
      .sort((a, b) => canonicalHandoffJSON(a) < canonicalHandoffJSON(b) ? -1 : canonicalHandoffJSON(a) > canonicalHandoffJSON(b) ? 1 : 0)])))
}
function dsh(side: string): string {
  const path = join(dir, side)
  mkdirSync(path)
  const store = new Store(join(path, 'orchestrator.sqlite'))
  const settings = store.settings()
  store.saveSettings({ ...settings, eval: { ...settings.eval, mode: 'auto' },
    sources: { along: { enabled: true, config: {} }, github: { enabled: false, config: {} } },
    policy: { ...settings.policy, sources: { along: { allowed: [{ id: USER }], admission: {} } } } })
  store.close()
  return path
}
const flags = (data: string, state: string) => ['--data-dir', data, '--state-dir', state]
const sourceFlags = () => ['--user', USER, '--device', DEVICE, '--goals', GOAL, '--target-origin', INPUT.targetOrigin,
  '--migration-id', INPUT.migrationId, '--host-companion-sha256', INPUT.hostCompanionSHA256]

it.each(['due', 'repair', 'source'] as const)('preserves retired %s NULL history through cold CLI handoff, repeated stage and actual Runtime reopen', async kind => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW))
  const source = fixture(), eventId = dispatchFor(source, kind)
  expect(source.health.pending()).toEqual([])
  const original = portableRows('source'), snapshot = source.exportPersonalHandoff(INPUT)
  source.close()
  const sourceDir = join(dir, 'source'), targetDir = join(dir, 'target')
  const sourceState = dsh('source-dsh'), targetState = dsh('target-dsh')
  mkdirSync(targetDir)
  const file = join(dir, 'packet.json'), permit = join(dir, 'permit.json')
  expect(runHandoffCLI(['inspect', ...flags(sourceDir, sourceState), ...sourceFlags()])).toMatchObject({ phase: 'inspected' })
  runHandoffCLI(['freeze-source', ...flags(sourceDir, sourceState), ...sourceFlags(), '--package', file])
  const packet = readPersonalHandoff(file)
  expect(packet.data).toEqual(snapshot.data)
  expect(packet.manifest.tables).toEqual(snapshot.manifest.tables)
  expect(packet.manifest.snapshotSHA256).toBe(snapshot.manifest.snapshotSHA256)
  expect(validatePersonalHandoff(packet)).toEqual(packet)
  const stage = () => runHandoffCLI(['stage-target', ...flags(targetDir, targetState), '--package', file])
  expect(stage()).toMatchObject({ phase: 'target_staged', reused: false })
  expect(portableRows('target')).toEqual(original)
  expect(stage()).toMatchObject({ phase: 'target_staged', reused: true })
  expect(portableRows('target')).toEqual(original)
  expect(() => assertHandoffStartupAllowed(sourceDir)).toThrow('handoff_runtime_fenced')
  expect(() => assertHandoffStartupAllowed(targetDir)).toThrow('handoff_runtime_fenced')
  runHandoffCLI(['retire-source', ...flags(sourceDir, sourceState), '--migration-id', INPUT.migrationId, '--permit-file', permit])
  const activate = () => runHandoffCLI(['activate-target', ...flags(targetDir, targetState), '--migration-id', INPUT.migrationId,
    '--package', file, '--permit-file', permit])
  expect(activate()).toMatchObject({ phase: 'target_active' })
  expect(activate()).toMatchObject({ phase: 'target_active', reused: true })
  expect(portableRows('source')).toEqual(original)
  expect(portableRows('target')).toEqual(original)
  const host = await startRuntime(undefined, { dir: targetState, alongStateDir: targetDir })
  try {
    const store = host.runtime.along!.service.alongStore
    expect(store.health.pending()).toEqual([])
    expect(store.health.get(eventId)?.result).toBeUndefined()
    for (let pass = 0; pass < 3; pass++) { await host.runtime.pump(); await host.runtime.idle() }
    expect(host.runtime.store.tickets.list()).toEqual([])
    expect(host.deliveries).not.toHaveBeenCalled()
    expect(store.syncPage(USER, 0, 200).items.some(item => !!(item.payload as { notification?: unknown }).notification)).toBe(false)
    expect(store.workspaceHandoffStatus({ userId: USER, deviceId: DEVICE })).toMatchObject({
      phase: 'target_active', snapshotSHA256: packet.manifest.snapshotSHA256,
      hostCompanionSHA256: INPUT.hostCompanionSHA256, sourceHolds: [] })
    expect(store.exportPersonalHandoff(INPUT).manifest.tables).toEqual(packet.manifest.tables)
    expect(portableRows('target')).toEqual(original)
  } finally { await host.stop() }
}, 15000)

it.each(['due', 'repair', 'source', 'unassociated'] as const)('refuses a truly pending %s NULL dispatch without touching source rows or creating a fence', kind => {
  const source = fixture()
  try {
    const eventId = dispatchFor(source, kind === 'unassociated' ? 'due' : kind, false)
    if (kind === 'unassociated') raw('source', db => db.prepare('DELETE FROM task_review WHERE event_id=?').run(eventId))
    expect(source.health.pending().map(row => row.eventId)).toEqual([eventId])
    const before = portableRows('source')
    expect(() => source.exportPersonalHandoff(INPUT)).toThrow('handoff_business_not_drained')
    expect(portableRows('source')).toEqual(before)
    expect(existsSync(join(dir, 'source', HANDOFF_FENCE))).toBe(false)
  } finally { source.close() }
})

it('does not let retired history hide another active dispatch', () => {
  const source = fixture()
  try {
    dispatchFor(source, 'due')
    const pending = dispatchFor(source, 'repair', false)
    expect(source.health.pending().map(row => row.eventId)).toEqual([pending])
    expect(() => source.exportPersonalHandoff(INPUT)).toThrow('handoff_business_not_drained')
    source.health.retireRepair(pending)
    expect(source.health.pending()).toEqual([])
    expect(source.exportPersonalHandoff(INPUT).data.health_dispatch).toHaveLength(2)
  } finally { source.close() }
})

function rehash(packet: PersonalHandoff): PersonalHandoff {
  for (const table of HANDOFF_TABLES) if (table !== 'source_state_read') packet.data[table].sort((a, b) =>
    canonicalHandoffJSON(a) < canonicalHandoffJSON(b) ? -1 : canonicalHandoffJSON(a) > canonicalHandoffJSON(b) ? 1 : 0)
  packet.manifest.snapshotSHA256 = handoffSHA256(packet.data)
  packet.manifest.tables = HANDOFF_TABLES.map(name => ({ name, rowCount: packet.data[name].length, sha256: handoffSHA256(packet.data[name]) }))
  return packet
}
it.each(['due', 'repair', 'source'] as const)('validates %s retirement again before package import and rolls back a late broken FK', kind => {
  const source = fixture(), target = new AlongStore(join(dir, 'target', 'along.sqlite'))
  try {
    dispatchFor(source, kind)
    const valid = source.exportPersonalHandoff(INPUT), packet = structuredClone(valid)
    const table = kind === 'due' ? 'task_review' : kind === 'repair' ? 'task_trigger_review' : 'source_goal_review'
    packet.data[table][0]!.retired = 0
    rehash(packet)
    expect(() => validatePersonalHandoff(packet)).toThrow('handoff_business_not_drained')
    expect(() => target.importPersonalHandoff(packet)).toThrow('handoff_business_not_drained')
    expect(target.counts(USER)).toEqual({ goals: 0, tasks: 0, messages: 0 })
    // Digest-valid input passes retirement qualification, but SQL FK validation still rolls back all INSERTs.
    const broken = structuredClone(valid)
    broken.data.research_reply.push({ message_id: 'missing_synthetic_message', input: '{}', recommendation: null, notification: null })
    rehash(broken)
    expect(() => target.importPersonalHandoff(broken)).toThrow('handoff_broken_foreign_key')
    expect(target.counts(USER)).toEqual({ goals: 0, tasks: 0, messages: 0 })
    expect(raw('target', db => db.prepare('SELECT * FROM health_dispatch').all())).toEqual([])
    expect(raw('target', db => db.prepare('SELECT * FROM meta').all()).map(row => row.key)).toEqual(['schema_version'])
    target.importPersonalHandoff(valid)
    expect(target.health.pending()).toEqual([])
  } finally { source.close(); target.close() }
})

it.each(Array.from({ length: 8 }, (_, mask) => mask))('matches actual Runtime pending semantics for multi-associated review retirement mask %i', mask => {
  const source = fixture()
  try {
    const due = dispatchFor(source, 'due', false), repair = dispatchFor(source, 'repair', false), review = dispatchFor(source, 'source', false)
    for (const eventId of [repair, review]) source.health.finish(source.health.get(eventId)!, { outcome: 'keep', types: [], reason: 'Synthetic completed sibling' })
    raw('source', db => {
      db.prepare('UPDATE task_trigger_review SET event_id=? WHERE event_id=?').run(due, repair)
      db.prepare('UPDATE source_goal_review SET event_id=? WHERE event_id=?').run(due, review)
      for (const [index, table] of ['task_review', 'task_trigger_review', 'source_goal_review'].entries())
        db.prepare(`UPDATE ${table} SET retired=? WHERE event_id=?`).run((mask >> index) & 1, due)
    })
    if (mask === 0) {
      expect(source.health.pending().map(row => row.eventId)).toEqual([due])
      expect(() => source.exportPersonalHandoff(INPUT)).toThrow('handoff_business_not_drained')
    } else {
      expect(source.health.pending()).toEqual([])
      const before = portableRows('source'), packet = source.exportPersonalHandoff(INPUT)
      expect(validatePersonalHandoff(packet)).toEqual(packet)
      const target = new AlongStore(join(dir, 'target', 'along.sqlite'))
      try {
        target.importPersonalHandoff(packet)
        expect(target.health.pending()).toEqual([])
        expect(portableRows('target')).toEqual(before)
      } finally { target.close() }
    }
  } finally { source.close() }
})

it.each(['due', 'repair', 'source'] as const)('refuses missing or cross-goal %s review references even with an explicit retirement', kind => {
  const source = fixture(), target = new AlongStore(join(dir, 'target', 'along.sqlite'))
  try {
    dispatchFor(source, kind)
    source.insertGoal({ userId: USER, goalId: 'g_other_synthetic', domain: 'custom' })
    source.insertTask({ userId: USER, goalId: 'g_other_synthetic', taskId: 't_other_synthetic', content: 'Other synthetic task' })
    const input = { ...INPUT, goalIds: [GOAL, 'g_other_synthetic'] }, valid = source.exportPersonalHandoff(input)
    const table = kind === 'due' ? 'task_review' : kind === 'repair' ? 'task_trigger_review' : 'source_goal_review'
    for (const missing of [false, true]) {
      const packet = structuredClone(valid), row = packet.data[table][0]!
      if (kind === 'source') {
        if (missing) row.source_event_id = 'missing_synthetic_event'
        else packet.data.source_state_event.find(event => event.event_id === row.source_event_id)!.goal_id = 'g_other_synthetic'
      } else row.task_id = missing ? 'missing_synthetic_task' : 't_other_synthetic'
      rehash(packet)
      const reason = kind !== 'source' && missing ? 'handoff_orphan_task' : 'handoff_business_not_drained'
      expect(() => validatePersonalHandoff(packet)).toThrow(reason)
      expect(() => target.importPersonalHandoff(packet)).toThrow(reason)
      expect(target.counts(USER)).toEqual({ goals: 0, tasks: 0, messages: 0 })
    }
  } finally { source.close(); target.close() }
})

it('requires explicit retirement and cannot borrow it from a different dispatch', () => {
  const source = fixture()
  try {
    dispatchFor(source, 'due')
    dispatchFor(source, 'repair')
    const packet = source.exportPersonalHandoff(INPUT)
    packet.data.task_review[0]!.retired = 2
    rehash(packet)
    expect(() => validatePersonalHandoff(packet)).toThrow('handoff_business_not_drained')
  } finally { source.close() }
})

it('restores source startup only on a pre-retirement abort and preserves all retired NULL rows', () => {
  const source = fixture(), sourceDir = join(dir, 'source'), targetDir = join(dir, 'target')
  dispatchFor(source, 'due')
  const original = portableRows('source')
  source.close()
  const sourceState = dsh('source-dsh'), targetState = dsh('target-dsh'), file = join(dir, 'packet.json')
  mkdirSync(targetDir)
  runHandoffCLI(['freeze-source', ...flags(sourceDir, sourceState), ...sourceFlags(), '--package', file])
  runHandoffCLI(['stage-target', ...flags(targetDir, targetState), '--package', file])
  runHandoffCLI(['abort', ...flags(sourceDir, sourceState), '--migration-id', INPUT.migrationId])
  runHandoffCLI(['abort', ...flags(targetDir, targetState), '--migration-id', INPUT.migrationId])
  expect(() => assertHandoffStartupAllowed(sourceDir)).not.toThrow()
  expect(() => assertHandoffStartupAllowed(targetDir)).toThrow('handoff_runtime_fenced')
  expect(portableRows('source')).toEqual(original)
  expect(portableRows('target')).toEqual(original)
})

it.each(['due', 'repair', 'source'] as const)('refuses newly pending %s history again at activation without promoting the staged target', kind => {
  const source = fixture()
  dispatchFor(source, kind); source.close()
  const sourceDir = join(dir, 'source'), targetDir = join(dir, 'target'), sourceState = dsh('source-dsh'), targetState = dsh('target-dsh')
  mkdirSync(targetDir)
  const file = join(dir, 'packet.json'), permit = join(dir, 'permit.json')
  runHandoffCLI(['freeze-source', ...flags(sourceDir, sourceState), ...sourceFlags(), '--package', file])
  runHandoffCLI(['stage-target', ...flags(targetDir, targetState), '--package', file])
  runHandoffCLI(['retire-source', ...flags(sourceDir, sourceState), '--migration-id', INPUT.migrationId, '--permit-file', permit])
  const table = kind === 'due' ? 'task_review' : kind === 'repair' ? 'task_trigger_review' : 'source_goal_review'
  raw('target', db => db.prepare(`UPDATE ${table} SET retired=0`).run())
  const changed = portableRows('target')
  expect(() => runHandoffCLI(['activate-target', ...flags(targetDir, targetState), '--migration-id', INPUT.migrationId,
    '--package', file, '--permit-file', permit])).toThrow('handoff_business_not_drained')
  expect(readHandoffStatus(targetDir)?.phase).toBe('target_staged')
  expect(() => assertHandoffStartupAllowed(targetDir)).toThrow('handoff_runtime_fenced')
  expect(portableRows('target')).toEqual(changed)
})

it.each(['due', 'repair', 'source'] as const)('refuses invalid event identities for %s retirement even when SQLite FK checks pass', kind => {
  const source = fixture(), target = new AlongStore(join(dir, 'target', 'along.sqlite'))
  try {
    const eventId = dispatchFor(source, kind), valid = source.exportPersonalHandoff(INPUT)
    const table = kind === 'due' ? 'task_review' : kind === 'repair' ? 'task_trigger_review' : 'source_goal_review'
    raw('source', db => {
      db.exec('BEGIN; PRAGMA defer_foreign_keys=ON')
      db.prepare('UPDATE health_dispatch SET event_id=NULL WHERE event_id=?').run(eventId)
      db.prepare(`UPDATE ${table} SET event_id=NULL WHERE event_id=?`).run(eventId)
      db.exec('COMMIT')
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    })
    // TEXT PRIMARY KEY permits NULL; SQL equality does not join two NULLs, while Map would.
    expect(source.health.pending()).toHaveLength(1)
    const before = portableRows('source')
    expect(() => source.exportPersonalHandoff(INPUT)).toThrow('handoff_business_not_drained')
    expect(portableRows('source')).toEqual(before)
    for (const invalidId of [null, '', ' ', 17]) {
      const packet = structuredClone(valid)
      packet.data.health_dispatch[0]!.event_id = invalidId
      packet.data[table][0]!.event_id = invalidId
      rehash(packet)
      expect(() => validatePersonalHandoff(packet)).toThrow('handoff_business_not_drained')
      expect(() => target.importPersonalHandoff(packet)).toThrow('handoff_business_not_drained')
      expect(target.counts(USER)).toEqual({ goals: 0, tasks: 0, messages: 0 })
      expect(raw('target', db => db.prepare('SELECT * FROM health_dispatch').all())).toEqual([])
    }
  } finally { source.close(); target.close() }
})
