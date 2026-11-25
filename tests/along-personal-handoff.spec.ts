/** Synthetic personal workspace only. Never opens a developer's actual Along data/profile or a phone. */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { lockSync } from 'proper-lockfile'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AlongStore } from '../src/along/store.ts'
import { Store } from '../src/app/store.ts'
import { Runtime } from '../src/app/runtime.ts'
import { MemoryService } from '../src/along/memory/service.ts'
import { AlongService } from '../src/along/service.ts'
import { alongSourceRequest, type AlongApiHost } from '../src/along/api.ts'
import { testMachine } from './fixtures/deployment.ts'
import { runHandoffCLI } from '../src/along-handoff.ts'
import { abortHandoff, activateHandoffTarget, assertHandoffOrchestratorDrained, assertHandoffStartupAllowed,
  canonicalHandoffJSON, expectedHandoffTarget, freezeHandoffSource, HANDOFF_FENCE, HANDOFF_TABLES, handoffSHA256,
  readHandoffStatus, retireHandoffSource, stageHandoffTarget, validatePersonalHandoff, withColdHandoffLocks,
  type HandoffExportInput, type PersonalHandoff } from '../src/along/handoff.ts'

const USER = 'u_11223344', DEVICE = 'd_11223344', GOAL = 'g_original', TASK = 't_original'
const NOW = '2026-11-24T12:00:00.000Z', FUTURE = '2026-11-27T12:00:00.000Z'
const PERMIT = 'a'.repeat(64), sha = (text: string) => createHash('sha256').update(text).digest('hex')
const INPUT: HandoffExportInput = { migrationId: 'migration_synthetic_01', sourceUserId: USER, sourceDeviceId: DEVICE,
  targetOrigin: 'https://along.example.com', goalIds: [GOAL], createdAt: NOW, activationPermitSHA256: sha(PERMIT), hostCompanionSHA256: sha('synthetic-host-companion') }
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'along-personal-handoff-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function fixture(path = join(dir, 'source', 'along.sqlite')): AlongStore {
  const store = new AlongStore(path)
  store.assertUser(USER, DEVICE)
  store.insertGoal({ userId: USER, domain: 'health', goalId: GOAL })
  store.appendGoalRevision({ userId: USER, goalId: GOAL, title: '原有健康目标', status: 'active' })
  store.ensureInputVersion(USER, GOAL)
  store.insertTask({ userId: USER, goalId: GOAL, taskId: TASK, content: '保留原来的预约任务', scheduledAt: FUTURE })
  store.appendTaskRevision({ userId: USER, taskId: TASK, content: '保留原来的预约任务', status: 'open', scheduledAt: FUTURE })
  const direct = store.appendMessage({ userId: USER, eventId: 'e_direct', text: '用户原话', role: 'user', direction: 'inbound' })
  const background = store.appendMessage({ userId: USER, eventId: 'e_background', text: '任务结果', role: 'assistant', direction: 'outbound', audience: 'background' })
  store.appendSync({ userId: USER, goalId: GOAL, taskId: TASK, kind: 'task_updated', payload: { fixture: true } })
  const db = new DatabaseSync(path)
  const seed = (table: string, overrides: Record<string, string | number | null>) => {
    const info = db.prepare(`PRAGMA table_info("${table}")`).all()
    const row = Object.fromEntries(info.map(column => [String(column.name), overrides[String(column.name)] ??
      (Object.hasOwn(overrides, String(column.name)) ? null : Number(column.notnull) === 1 ? String(column.type).includes('INT') || String(column.type) === 'REAL' ? 1 : 'synthetic' : null)]))
    const names = Object.keys(row)
    db.prepare(`INSERT INTO "${table}" (${names.map(name => '"'+name+'"').join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...Object.values(row))
  }
  const common = { user_id: USER, goal_id: GOAL, task_id: TASK }
  seed('message_goal_link', { message_id: direct.id, goal_id: GOAL, user_id: USER, relation: 'about' })
  seed('message_audience_audit', { message_id: background.id, user_id: USER, source_event_id: 'e_background', previous_audience: 'conversation' })
  seed('changeset', { ...common, id: 'cs_old', status: 'applied', idempotency_key: 'idem_old', ops: '[]', result: '{}' })
  seed('health_summary', { id: 'health_old', user_id: USER, type: 'sleep', metric_version: NOW, value: '420', availability: 'ok', event_id: 'health_event', superseded: 0, context: '{}' })
  seed('health_followup', { ...common, types: '["sleep"]', baseline: '[]' })
  seed('health_dispatch', { ...common, event_id: 'dispatch_old', snapshot: '[]', read_snapshot: '[]', result: '{"outcome":"keep"}' })
  seed('health_daily_review', { event_id: 'dispatch_old', timezone: 'Asia/Shanghai', local_date: '2026-11-24', scheduled_at: NOW })
  seed('health_review_schedule', { ...common, timezone: 'Asia/Shanghai', next_at: FUTURE })
  seed('task_review', { event_id: 'dispatch_old', task_id: TASK, due_at: NOW, retired: 1 })
  seed('task_trigger_review', { event_id: 'dispatch_old', task_id: TASK, device_id: DEVICE, retired: 1 })
  seed('source_goal_review', { event_id: 'dispatch_old', provider: 'okx', legacy_tasks: '[]', original_task_ids: '["t_original"]', capabilities: '["trading_account_summary"]', retired: 1 })
  seed('due_notice', { task_id: TASK, due_at: Date.parse(NOW) })
  seed('task_once', { task_id: TASK })
  seed('task_daily', { task_id: TASK, evidence_event_id: 'e_direct', timezone: 'Asia/Shanghai', wall_time: NOW, weekday: 4 })
  seed('task_reminder_plan', { task_id: TASK, plan: '{"state":"scheduled","repeat":"weekly","timezone":"Asia/Shanghai"}' })
  seed('goal_data_sources', { user_id: USER, goal_id: GOAL, sources: '[{"provider":"apple-health","reason":"原授权"}]' })
  seed('task_trigger', { ...common, task_revision: 1, definition: '{"kind":"time","actor":"user","capability":"reminder"}', state: 'scheduled', capability_missing: 0 })
  seed('task_trigger_occurrence', { ...common, id: 'occurrence_old', occurrence_key: 'week_original', state: 'settled', dispatch_event_id: 'dispatch_old', completed_at: NOW })
  seed('event_inbox', { ...common, event_id: 'health_event', device_id: DEVICE, event_type: 'along.health_summary_updated', schema_version: '1', payload: '{}', payload_hash: sha('{}'), status: 'accepted' })
  seed('delivery', { user_id: USER, event_id: 'health_event', trigger_id: 'along:'+USER+':old', status: 'delivered', seq: 7 })
  seed('work_link', { ...common, ticket_id: 'ticket_old', assignment_id: 'assignment_old', work_id: 'work_old', thread_key: 'along:original', kind: 'task', ended_at: NOW })
  seed('run_record', { ...common, id: 'run_old', ticket_id: 'ticket_old', assignment_id: 'assignment_old', work_id: 'work_old', changeset_id: 'cs_old', ended_at: NOW })
  seed('research_source', { id: 'source_old', user_id: USER, goal_id: GOAL, ticket_id: 'ticket_old', purpose: 'route', content: '公开路线', metadata: '{}' })
  seed('research_request', { id: 3, user_id: USER, goal_id: GOAL, ticket_id: 'ticket_old', operation: 'fetch', status: 'done' })
  seed('research_reply', { message_id: background.id, input: '{}', recommendation: '{}', notification: '{}' })
  seed('source_state_event', { user_id: USER, goal_id: GOAL, event_id: 'source_event', provider: 'okx', payload_hash: sha('{}'), state: 'disconnected', capabilities: '[]', status: 'accepted' })
  seed('source_state_current', { user_id: USER, goal_id: GOAL, provider: 'okx', event_id: 'source_event', state: 'disconnected', capabilities: '[]', fact_hash: sha('{}') })
  seed('source_state_read', { ...common, id: 'read_old', ticket_id: 'ticket_old', execution_key: 'exec_old', provider: 'okx', capability: 'trading_account_summary', state: 'unavailable', data: null })
  seed('task_calculation', { ...common, id: 'calc_old', ticket_id: 'ticket_old', execution_key: 'exec_old', input_digest: sha('{}'), calculation: '{}' })
  seed('task_calculation_source', { receipt_id: 'calc_old', request_id: 'read_old', bindings: '[]' })
  seed('memory', { user_id: USER, id: 'memory_old', status: 'active', scope: GOAL, evidence_message_id: direct.id })
  seed('memory_revision', { memory_id: 'memory_old', revision: 1, content: '明确偏好', status: 'active' })
  seed('memory_detail', { memory_id: 'memory_old', goal_id: GOAL, source_ids: JSON.stringify([direct.id]), backend_ids: '["mac_index_id"]' })
  seed('memory_operation', { user_id: USER, id: 'memory_op', source_ids: JSON.stringify([direct.id]), status: 'done', finished_at: NOW })
  seed('memory_attempt', { id: 'memory_attempt', operation_id: 'memory_op', status: 'done', backend_ids: '["mac_index_id"]', finished_at: NOW })
  seed('memory_processed', { user_id: USER, message_id: direct.id, operation_id: 'memory_op' })
  seed('memory_suppression', { user_id: USER, memory_id: 'memory_old' })
  seed('memory_blocked_source', { user_id: USER, message_id: direct.id })
  seed('memory_cleanup', { user_id: USER })
  seed('maintenance_schedule', { user_id: USER, next_due_at: FUTURE })
  seed('maintenance_batch', { user_id: USER, id: 'batch_old', status: 'done', finished_at: NOW })
  db.prepare("UPDATE sqlite_sequence SET seq=99 WHERE name='sync_outbox'").run()
  db.close()
  return store
}
function withRaw<T>(path: string, work: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path)
  try { return work(db) } finally { db.close() }
}
function rehash(packet: PersonalHandoff): PersonalHandoff {
  packet.manifest.snapshotSHA256 = handoffSHA256(packet.data)
  packet.manifest.syncPrefixSHA256 = handoffSHA256([...packet.data.sync_outbox].sort((a, b) => Number(a.seq) - Number(b.seq))
    .map(({ delivered_at: _receipt, ...row }) => row))
  packet.manifest.tables = HANDOFF_TABLES.map(name => ({ name, rowCount: packet.data[name].length, sha256: handoffSHA256(packet.data[name]) }))
  return packet
}

describe('personal schema-18 data continuity', () => {
  it('preserves every table, original identities, chat classification, cadence, receipts and sequence high water', () => {
    const source = fixture(), target = new AlongStore(join(dir, 'target', 'along.sqlite'))
    try {
      const packet = source.exportPersonalHandoff(INPUT)
      expect(packet.manifest.tables).toHaveLength(50)
      expect(packet.manifest.tables.every(table => table.rowCount > 0)).toBe(true)
      expect(packet.manifest.syncHighWaterMark).toBe(99)
      expect(JSON.stringify(packet)).not.toContain('mac_index_id')
      expect(target.importPersonalHandoff(packet)).toEqual(packet.manifest)
      expect(target.exportPersonalHandoff(INPUT)).toEqual(packet)
      expect(target.goalDetail(USER, GOAL).tasks[0]?.id).toBe(TASK)
      const next = target.appendSync({ userId: USER, kind: 'goal_updated', goalId: GOAL, payload: {} })
      expect(next).toBe(100)
    } finally { source.close(); target.close() }
  })

  it('keeps the data-only package independent of profile, Host, secrets and external memory directories', () => {
    const source = fixture()
    try {
      writeFileSync(join(dir, 'source', 'bridge-token'), 'do-not-copy-bridge-secret')
      writeFileSync(join(dir, 'source', 'pairing.json'), '{"token":"do-not-copy-pair-secret"}')
      const packet = source.exportPersonalHandoff(INPUT), text = canonicalHandoffJSON(packet)
      expect(text).not.toContain('do-not-copy')
      expect(Object.keys(packet)).toEqual(['manifest', 'data'])
      expect(packet.data.memory[0]?.evidence_message_id).toBeTruthy()
      expect(packet.data.memory_detail[0]?.backend_ids).toBe('[]')
      expect(packet.data.message.map(row => row.audience).sort()).toEqual(['background', 'conversation'])
    } finally { source.close() }
  })

  it('refuses an unrelated user or an unexpected goal instead of exporting the whole database', () => {
    const source = fixture()
    try {
      expect(() => source.exportPersonalHandoff({ ...INPUT, goalIds: ['g_missing'] })).toThrow('handoff_goal_scope_mismatch')
      source.assertUser('u_55667788', 'd_55667788')
      expect(() => source.exportPersonalHandoff(INPUT)).toThrow('handoff_not_dedicated_user')
    } finally { source.close() }
  })

  it('refuses cross-owner rows even when the only registered user is the intended user', () => {
    const source = fixture()
    try {
      withRaw(join(dir, 'source', 'along.sqlite'), db => db.prepare('UPDATE user_task SET user_id=?').run('u_55667788'))
      expect(() => source.exportPersonalHandoff(INPUT)).toThrow('handoff_cross_user_row')
    } finally { source.close() }
  })

  for (const [name, sql, reason] of [
    ['future schema', "UPDATE meta SET value='19' WHERE key='schema_version'", 'handoff_unsupported_schema'],
    ['unknown table', 'CREATE TABLE secret_stash(value TEXT)', 'handoff_unsupported_tables'],
    ['unknown column', 'ALTER TABLE goal ADD COLUMN secret TEXT', 'handoff_unsupported_columns'],
    ['unknown meta', "INSERT INTO meta VALUES('secret','private')", 'handoff_unknown_meta_key'],
    ['active work', 'UPDATE work_link SET ended_at=NULL', 'handoff_business_not_drained'],
    ['pending dispatch', 'UPDATE health_dispatch SET result=NULL; UPDATE task_review SET retired=0; UPDATE task_trigger_review SET retired=0; UPDATE source_goal_review SET retired=0', 'handoff_business_not_drained'],
    ['pending delivery', "UPDATE delivery SET status='pending'", 'handoff_business_not_drained'],
    ['running occurrence', "UPDATE task_trigger_occurrence SET state='dispatched'", 'handoff_business_not_drained'],
  ]) it('refuses '+name, () => {
    const source = fixture()
    try {
      withRaw(join(dir, 'source', 'along.sqlite'), db => db.exec(sql!))
      expect(() => source.exportPersonalHandoff(INPUT)).toThrow(reason)
    } finally { source.close() }
  })

  it('rejects tampering and unrecognized package fields before import', () => {
    const source = fixture()
    try {
      const packet = source.exportPersonalHandoff(INPUT)
      packet.data.user_task[0]!.content = 'silently changed'
      expect(() => validatePersonalHandoff(packet)).toThrow('handoff_digest_mismatch')
      expect(() => validatePersonalHandoff({ ...packet, credentials: {} })).toThrow('handoff_invalid_package')
    } finally { source.close() }
  })

  it('refuses nonempty destination without replacing original records', () => {
    const source = fixture(), target = fixture(join(dir, 'target', 'along.sqlite'))
    try {
      const packet = source.exportPersonalHandoff(INPUT), before = target.exportPersonalHandoff(INPUT)
      expect(() => target.importPersonalHandoff(packet)).toThrow('handoff_destination_not_empty')
      expect(target.exportPersonalHandoff(INPUT)).toEqual(before)
    } finally { source.close(); target.close() }
  })

  it('rolls back the entire import if a late forward-reference is broken', () => {
    const source = fixture(), target = new AlongStore(join(dir, 'target', 'along.sqlite'))
    try {
      const packet = source.exportPersonalHandoff(INPUT)
      packet.data.research_reply[0]!.message_id = 'message_missing'
      rehash(packet)
      expect(() => target.importPersonalHandoff(packet)).toThrow('handoff_broken_foreign_key')
      expect(target.counts(USER)).toEqual({ goals: 0, tasks: 0, messages: 0 })
      expect(target.syncPage(USER, 0, 10).items).toEqual([])
    } finally { source.close(); target.close() }
  })

  it('preserves source-read causal tie ordering used by the existing rowid lookup', () => {
    const source = fixture(), target = new AlongStore(join(dir, 'target', 'along.sqlite'))
    try {
      withRaw(join(dir, 'source', 'along.sqlite'), db => {
        const row = db.prepare('SELECT * FROM source_state_read LIMIT 1').get()!
        for (const id of ['z_first', 'a_second']) {
          const fields = { ...row, id }, names = Object.keys(fields)
          db.prepare(`INSERT INTO source_state_read (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...Object.values(fields))
        }
      })
      const packet = source.exportPersonalHandoff(INPUT)
      expect(packet.data.source_state_read.map(row => row.id)).toEqual(['read_old', 'z_first', 'a_second'])
      target.importPersonalHandoff(packet)
      expect(withRaw(join(dir, 'target', 'along.sqlite'), db => db.prepare('SELECT id FROM source_state_read ORDER BY created_at DESC,rowid DESC LIMIT 1').get()?.id)).toBe('a_second')
    } finally { source.close(); target.close() }
  })

  it('uses deterministic Unicode ordering and refuses unsupported number/value coercions', () => {
    expect(canonicalHandoffJSON({ z: 1, a: { y: '中文🙂', b: 2 } })).toBe('{"a":{"b":2,"y":"中文🙂"},"z":1}')
    for (const bad of [undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, new Uint8Array([1])])
      expect(() => canonicalHandoffJSON(bad)).toThrow()
  })

  it('keeps original explicit preferences available without querying Mac index IDs or widening ownership', async () => {
    const source = new AlongStore(join(dir, 'source', 'along.sqlite')), target = new AlongStore(join(dir, 'target', 'along.sqlite'))
    source.assertUser(USER, DEVICE); source.insertGoal({ userId: USER, goalId: GOAL, domain: 'health' })
    source.appendGoalRevision({ userId: USER, goalId: GOAL, title: '原目标', status: 'active' }); source.ensureInputVersion(USER, GOAL)
    const message = source.appendMessage({ userId: USER, eventId: 'e_preference', text: '以后只做低冲击训练', role: 'user', direction: 'inbound' })
    source.linkMessageToGoals(message.id, [GOAL], 'direct')
    source.memory.save(USER, { quote: message.text, topic: '训练偏好', category: 'preference', assertion: 'explicit',
      goalId: GOAL, sourceMessageIds: [message.id], replaces: [], conflictsWith: [], backendIds: ['mac_index'] }, message.seq, ['mac_index'], 'active')
    target.importPersonalHandoff(source.exportPersonalHandoff(INPUT))
    const backend = { search: vi.fn(async () => []), extract: vi.fn(async () => ({ candidates: [], backendIds: [] })), clearUser: vi.fn(async () => {}), close: vi.fn(async () => {}) }
    const service = new MemoryService(target, backend)
    try {
      const read = await service.search({ userId: USER, goalId: GOAL }, '训练')
      expect(read.degraded).toBe(true); expect(read.memories.map(memory => memory.content)).toEqual([message.text])
      expect(backend.search).not.toHaveBeenCalled(); expect(backend.extract).not.toHaveBeenCalled()
      await expect(service.search({ userId: 'u_55667788', goalId: GOAL }, '训练')).rejects.toThrow()
      service.forget({ userId: USER, goalId: GOAL }, read.memories[0]!.id)
      expect((await service.search({ userId: USER, goalId: GOAL }, '训练')).memories).toEqual([])
    } finally { await service.close(); source.close(); target.close() }
  })

  it('appends a genuine compatibility hold before cloud activation while preserving original source history and sync prefix', () => {
    const source = fixture(), target = new AlongStore(join(dir, 'target', 'along.sqlite'))
    try {
      source.replaceGoalDataSources(USER, GOAL, [{ provider: 'okx', reason: '原目标需要历史报告' }])
      const original = { event_id: 'original:history:ready', goal_id: GOAL, provider: 'okx', generation: 2, revision: 1,
        state: 'ready', capabilities: ['trading_account_summary', 'trading_history'], occurred_at: NOW, reference: 'synthetic-host-history' }
      expect(source.sources.acceptEvent({ userId: USER, deviceId: DEVICE }, original)).toMatchObject({ status: 'accepted', applied: true })
      const packet = source.exportPersonalHandoff(INPUT), expected = expectedHandoffTarget(packet)
      expect(packet.manifest.sourceHolds).toEqual([{ provider: 'okx', goalId: GOAL, reason: 'cloud_history_unsupported',
        sourceEventId: original.event_id, sourceGeneration: 2, sourceRevision: 1 }])
      target.importPersonalHandoff(packet)
      stageHandoffTarget(join(dir, 'target'), packet.manifest)
      expect(() => activateHandoffTarget(join(dir, 'target'), INPUT.migrationId, PERMIT)).toThrow('handoff_target_changed')
      const receipt = target.applyPersonalHandoffSourceHolds(packet.manifest)
      expect(receipt).toEqual(expected)
      expect(target.applyPersonalHandoffSourceHolds(packet.manifest)).toEqual(receipt)
      expect(target.sources.queryCurrent(USER, GOAL, 'okx')).toMatchObject({ generation: 2, revision: 2, state: 'unavailable', capabilities: [] })
      const after = target.exportPersonalHandoff(INPUT)
      expect(after.data.source_state_event).toContainEqual(packet.data.source_state_event.find(row => row.event_id === original.event_id))
      expect(after.data.sync_outbox.filter(row => Number(row.seq) <= packet.manifest.syncHighWaterMark)).toEqual(packet.data.sync_outbox)
      expect(receipt.syncHighWaterMark).toBe(packet.manifest.syncHighWaterMark + 1)
      expect(after.data.message).toEqual(packet.data.message)
      expect(after.data.user_task).toEqual(packet.data.user_task)
      expect(after.data.task_calculation).toEqual(packet.data.task_calculation)
      stageHandoffTarget(join(dir, 'target'), packet.manifest, receipt)
      target.activatePersonalHandoffCheckpoint(packet.manifest, PERMIT)
      activateHandoffTarget(join(dir, 'target'), INPUT.migrationId, PERMIT)
      expect(readHandoffStatus(join(dir, 'target'))).toMatchObject({ phase: 'target_active', targetReceipt: { sourceHolds: [{ reason: 'cloud_history_unsupported', state: 'unavailable' }] } })
      const tampered = structuredClone(packet); tampered.manifest.sourceHolds = []
      expect(() => validatePersonalHandoff(tampered)).toThrow('handoff_source_hold_mismatch')
    } finally { source.close(); target.close() }
  })

  it('keeps the shared synthetic proof header on the complete manifest contract', () => {
    const header = JSON.parse(readFileSync(new URL('./fixtures/personal-handoff-manifest.json', import.meta.url), 'utf8')) as PersonalHandoff['manifest']
    const source = fixture()
    try {
      expect(Object.keys(header).sort()).toEqual(Object.keys(source.exportPersonalHandoff(INPUT).manifest).sort())
      expect(header.format).toBe('along-personal-handoff/v1')
      expect(header.activationPermitSHA256).toBe(sha(PERMIT))
      expect(header.hostCompanionSHA256).toBe(INPUT.hostCompanionSHA256)
      expect(header.tables.map(table => table.name)).toEqual([...HANDOFF_TABLES])
      const held = JSON.parse(readFileSync(new URL('./fixtures/personal-handoff-history-receipt.json', import.meta.url), 'utf8')) as {
        manifest: PersonalHandoff['manifest']; targetReceipt: ReturnType<typeof expectedHandoffTarget> }
      expect(Object.keys(held.manifest).sort()).toEqual(Object.keys(header).sort())
      expect(held.manifest.sourceHolds).toHaveLength(1)
      expect(held.targetReceipt.sourceHolds[0]).toMatchObject({ provider: 'okx', reason: 'cloud_history_unsupported', state: 'unavailable', revision: 2 })
      expect(held.targetReceipt.syncHighWaterMark).toBe(held.manifest.syncHighWaterMark + 1)
    } finally { source.close() }
  })
})

describe('cold single-writer handoff', () => {
  it('the actual Runtime startup refuses a frozen source and releases both directory locks', () => {
    const source = fixture(), sourceDir = join(dir, 'source'), stateDir = join(dir, 'runtime')
    const packet = source.exportPersonalHandoff(INPUT); source.close()
    freezeHandoffSource(sourceDir, packet, PERMIT)
    const orchestrator = new Store(join(stateDir, 'orchestrator.sqlite'))
    orchestrator.saveSettings({ ...orchestrator.settings(), sources: { along: { enabled: true, config: {} }, github: { enabled: false, config: {} } } })
    orchestrator.close()
    expect(() => new Runtime(new Context(), testMachine({ stateDir, alongStateDir: sourceDir, alongBridgeTokenFile: join(sourceDir, 'bridge-token') }), () => {}))
      .toThrow('handoff_runtime_fenced')
    expect(existsSync(sourceDir+'.lock')).toBe(false)
    expect(existsSync(stateDir+'.lock')).toBe(false)
  })

  it('blocks both staged writers, retires source before activation, and never aborts after permit release', () => {
    const source = fixture(), sourceDir = join(dir, 'source'), targetDir = join(dir, 'target')
    try {
      const packet = source.exportPersonalHandoff(INPUT)
      freezeHandoffSource(sourceDir, packet, PERMIT)
      const target = new AlongStore(join(targetDir, 'along.sqlite'))
      target.importPersonalHandoff(packet)
      const receipt = target.applyPersonalHandoffSourceHolds(packet.manifest)
      target.close()
      stageHandoffTarget(targetDir, packet.manifest, receipt)
      expect(() => assertHandoffStartupAllowed(sourceDir)).toThrow('handoff_runtime_fenced')
      expect(() => assertHandoffStartupAllowed(targetDir)).toThrow('handoff_runtime_fenced')
      expect(() => activateHandoffTarget(targetDir, INPUT.migrationId, 'b'.repeat(64))).toThrow('handoff_bad_activation_permit')
      const permit = retireHandoffSource(sourceDir, INPUT.migrationId)
      expect(permit).toBe(PERMIT)
      expect(retireHandoffSource(sourceDir, INPUT.migrationId)).toBe(PERMIT)
      expect(() => abortHandoff(sourceDir, INPUT.migrationId)).toThrow('handoff_invalid_transition')
      const activateStore = new AlongStore(join(targetDir, 'along.sqlite'))
      activateStore.activatePersonalHandoffCheckpoint(packet.manifest, permit); activateStore.close()
      activateHandoffTarget(targetDir, INPUT.migrationId, permit)
      expect(() => assertHandoffStartupAllowed(targetDir)).not.toThrow()
      expect(() => assertHandoffStartupAllowed(sourceDir)).toThrow('handoff_runtime_fenced')
      expect(() => abortHandoff(targetDir, INPUT.migrationId)).toThrow('handoff_invalid_transition')
      expect(JSON.stringify(readHandoffStatus(sourceDir))).not.toContain(PERMIT)
    } finally { source.close() }
  })

  it('permits safe source abort before release and leaves aborted staging permanently fenced', () => {
    const source = fixture(), sourceDir = join(dir, 'source'), targetDir = join(dir, 'target')
    try {
      const packet = source.exportPersonalHandoff(INPUT)
      freezeHandoffSource(sourceDir, packet, PERMIT); stageHandoffTarget(targetDir, packet.manifest)
      abortHandoff(sourceDir, INPUT.migrationId); abortHandoff(targetDir, INPUT.migrationId)
      expect(() => assertHandoffStartupAllowed(sourceDir)).not.toThrow()
      expect(() => retireHandoffSource(sourceDir, INPUT.migrationId)).toThrow()
      expect(() => activateHandoffTarget(targetDir, INPUT.migrationId, PERMIT)).toThrow()
      expect(() => assertHandoffStartupAllowed(targetDir)).toThrow()
    } finally { source.close() }
  })

  it('refuses a changed migration, malformed/insecure fence, and an active Runtime directory lock', () => {
    const source = fixture(), sourceDir = join(dir, 'source'), stateDir = join(dir, 'dsh')
    mkdirSync(stateDir)
    try {
      const packet = source.exportPersonalHandoff(INPUT)
      freezeHandoffSource(sourceDir, packet, PERMIT)
      expect(() => stageHandoffTarget(sourceDir, { ...packet.manifest, migrationId: 'another_migration' })).toThrow('handoff_conflicting_migration')
      chmodSync(join(sourceDir, HANDOFF_FENCE), 0o644)
      expect(() => assertHandoffStartupAllowed(sourceDir)).toThrow('handoff_insecure_fence')
      chmodSync(join(sourceDir, HANDOFF_FENCE), 0o600)
      writeFileSync(join(sourceDir, HANDOFF_FENCE), 'broken')
      expect(() => assertHandoffStartupAllowed(sourceDir)).toThrow('handoff_invalid_fence')
      writeFileSync(join(sourceDir, HANDOFF_FENCE), JSON.stringify({ version: 1, phase: 'target_active', manifest: { format: 'along-personal-handoff/v1' } }))
      expect(() => assertHandoffStartupAllowed(sourceDir)).toThrow('handoff_invalid_fence')
      const release = lockSync(sourceDir)
      try { expect(() => withColdHandoffLocks(sourceDir, stateDir, () => {})).toThrow() } finally { release() }
    } finally { source.close() }
  })

  it('checks real orchestrator aggregates rather than trusting an operator idle boolean', () => {
    const store = new Store(join(dir, 'orchestrator.sqlite'))
    try {
      expect(() => assertHandoffOrchestratorDrained(store.db)).not.toThrow()
      store.db.prepare('INSERT INTO ticket(id,value) VALUES(?,?)').run('ticket_live', JSON.stringify({ assignments: [{ state: 'running' }], undelivered: [] }))
      expect(() => assertHandoffOrchestratorDrained(store.db)).toThrow('handoff_orchestrator_not_drained')
    } finally { store.close() }
  })
})

describe('administrative CLI sequence', () => {
  function dsh(path: string): void { mkdirSync(path); new Store(join(path, 'orchestrator.sqlite')).close() }
  const flags = (dataDir: string, stateDir: string) => ['--data-dir', dataDir, '--state-dir', stateDir]
  const sourceFlags = () => ['--user', USER, '--device', DEVICE, '--goals', GOAL, '--target-origin', INPUT.targetOrigin, '--migration-id', INPUT.migrationId,
    '--host-companion-sha256', INPUT.hostCompanionSHA256]

  it('requires a valid explicit companion commitment before freezing any source data', () => {
    const sourceDir = join(dir, 'source'), stateDir = join(dir, 'source-dsh')
    fixture().close(); dsh(stateDir)
    const base = ['freeze-source', ...flags(sourceDir, stateDir), ...sourceFlags().slice(0, -2), '--package', join(dir, 'personal.json')]
    expect(() => runHandoffCLI(base)).toThrow('handoff_missing_host_companion_sha256')
    expect(() => runHandoffCLI([...base, '--host-companion-sha256', 'INVALID'])).toThrow('handoff_invalid_identity')
    expect(existsSync(join(sourceDir, HANDOFF_FENCE))).toBe(false)
    const source = fixture(join(dir, 'other', 'along.sqlite'))
    try {
      const packet = source.exportPersonalHandoff(INPUT)
      delete (packet.manifest as Partial<typeof packet.manifest>).hostCompanionSHA256
      expect(() => validatePersonalHandoff(packet)).toThrow('handoff_invalid_manifest')
    } finally { source.close() }
  })

  it('rehearses freeze/stage/retry/retire/activate with private files and exact source continuity', () => {
    const sourceDir = join(dir, 'source'), targetDir = join(dir, 'target'), sourceState = join(dir, 'source-dsh'), targetState = join(dir, 'target-dsh')
    fixture().close(); mkdirSync(targetDir); dsh(sourceState); dsh(targetState)
    const packet = join(dir, 'personal.json'), permit = join(dir, 'permit.json')
    expect(runHandoffCLI(['inspect', ...flags(sourceDir, sourceState), ...sourceFlags()])).toMatchObject({ phase: 'inspected' })
    expect(existsSync(join(sourceDir, HANDOFF_FENCE))).toBe(false)
    const freeze = () => runHandoffCLI(['freeze-source', ...flags(sourceDir, sourceState), ...sourceFlags(), '--package', packet])
    expect(freeze()).toMatchObject({ phase: 'source_frozen' }); expect(freeze()).toMatchObject({ phase: 'source_frozen' })
    const stage = () => runHandoffCLI(['stage-target', ...flags(targetDir, targetState), '--package', packet])
    expect(stage()).toMatchObject({ phase: 'target_staged', reused: false }); expect(stage()).toMatchObject({ phase: 'target_staged', reused: true })
    runHandoffCLI(['retire-source', ...flags(sourceDir, sourceState), '--migration-id', INPUT.migrationId, '--permit-file', permit])
    const activate = () => runHandoffCLI(['activate-target', ...flags(targetDir, targetState), '--migration-id', INPUT.migrationId, '--package', packet, '--permit-file', permit])
    expect(activate()).toMatchObject({ phase: 'target_active' })
    const cloud = new AlongStore(join(targetDir, 'along.sqlite'))
    cloud.appendSync({ userId: USER, goalId: GOAL, kind: 'goal_updated', payload: { actualNewCloudWrite: true } }); cloud.close()
    expect(activate()).toMatchObject({ phase: 'target_active', reused: true })
    expect(statSync(packet).mode & 0o777).toBe(0o600); expect(statSync(permit).mode & 0o777).toBe(0o600)
    expect(readFileSync(packet, 'utf8')).not.toContain(JSON.parse(readFileSync(permit, 'utf8')).activationPermit)
  })

  it('refuses unrelated nonempty destination without fencing or mutating it', () => {
    const sourceDir = join(dir, 'source'), targetDir = join(dir, 'target'), sourceState = join(dir, 'source-dsh'), targetState = join(dir, 'target-dsh')
    fixture().close(); fixture(join(targetDir, 'along.sqlite')).close(); dsh(sourceState); dsh(targetState)
    const packet = join(dir, 'personal.json')
    runHandoffCLI(['freeze-source', ...flags(sourceDir, sourceState), ...sourceFlags(), '--package', packet])
    expect(() => runHandoffCLI(['stage-target', ...flags(targetDir, targetState), '--package', packet])).toThrow('handoff_destination_not_empty')
    expect(existsSync(join(targetDir, HANDOFF_FENCE))).toBe(false)
  })

  it('stages the required history hold exactly once and activates against its post-hold receipt', () => {
    const sourceDir = join(dir, 'source'), targetDir = join(dir, 'target'), sourceState = join(dir, 'source-dsh'), targetState = join(dir, 'target-dsh')
    const source = fixture()
    source.replaceGoalDataSources(USER, GOAL, [{ provider: 'okx', reason: '原账户报告' }])
    source.sources.acceptEvent({ userId: USER, deviceId: DEVICE }, { event_id: 'history_ready', goal_id: GOAL, provider: 'okx',
      generation: 2, revision: 1, state: 'ready', capabilities: ['trading_history'], occurred_at: NOW, reference: 'synthetic-original-history' })
    source.close(); mkdirSync(targetDir); dsh(sourceState); dsh(targetState)
    const packet = join(dir, 'personal.json'), permit = join(dir, 'permit.json')
    runHandoffCLI(['freeze-source', ...flags(sourceDir, sourceState), ...sourceFlags(), '--package', packet])
    const stage = () => runHandoffCLI(['stage-target', ...flags(targetDir, targetState), '--package', packet])
    const first = stage() as { targetReceipt: { snapshotSHA256: string; syncHighWaterMark: number; sourceHolds: unknown[] } }
    expect(first.targetReceipt.sourceHolds).toHaveLength(1)
    expect(stage()).toMatchObject({ reused: true, targetReceipt: first.targetReceipt })
    runHandoffCLI(['retire-source', ...flags(sourceDir, sourceState), '--migration-id', INPUT.migrationId, '--permit-file', permit])
    expect(runHandoffCLI(['activate-target', ...flags(targetDir, targetState), '--migration-id', INPUT.migrationId, '--package', packet, '--permit-file', permit]))
      .toMatchObject({ phase: 'target_active', targetReceipt: first.targetReceipt })
  })
})

describe('actual opened Source continuity proof', () => {
  async function status(store: AlongStore, overrides: { user?: string; device?: string; ready?: boolean; authorized?: boolean } = {}) {
    const host: AlongApiHost = { along: new AlongService(store), ready: () => overrides.ready ?? true,
      bridgeToken: 'synthetic-bridge-token', settings: {} as AlongApiHost['settings'] }
    return alongSourceRequest(host, { method: 'GET', path: 'workspace-handoff/status', query: new URLSearchParams(),
      headers: { 'x-along-bridge': '1', 'x-along-bridge-token': overrides.authorized === false ? 'wrong-token' : host.bridgeToken,
        'x-along-user': overrides.user ?? USER, 'x-along-device': overrides.device ?? DEVICE },
      body: async () => { throw Error('A GET proof must not read a body') } })
  }

  it('rejects an empty Source even after matching user/device registration and a copied Host/fence receipt', async () => {
    const source = fixture(), targetDir = join(dir, 'target'), emptyDir = join(dir, 'empty')
    const target = new AlongStore(join(targetDir, 'along.sqlite')), empty = new AlongStore(join(emptyDir, 'along.sqlite'))
    try {
      const packet = source.exportPersonalHandoff(INPUT)
      target.importPersonalHandoff(packet)
      const receipt = target.applyPersonalHandoffSourceHolds(packet.manifest)
      stageHandoffTarget(targetDir, packet.manifest, receipt)
      expect(await status(target)).toEqual({ status: 404, body: { error: 'not_found' } })
      target.activatePersonalHandoffCheckpoint(packet.manifest, PERMIT)
      // Database activation without the current active Runtime fence is insufficient.
      expect(await status(target)).toEqual({ status: 404, body: { error: 'not_found' } })
      activateHandoffTarget(targetDir, INPUT.migrationId, PERMIT)
      expect(await status(target)).toMatchObject({ status: 200, body: { format: 'along-personal-handoff/source-status/v1', phase: 'target_active',
        userId: USER, deviceId: DEVICE, migrationId: INPUT.migrationId, manifestSHA256: handoffSHA256(packet.manifest),
        snapshotSHA256: packet.manifest.snapshotSHA256, syncPrefixSHA256: packet.manifest.syncPrefixSHA256, targetReceipt: receipt } })
      empty.assertUser(USER, DEVICE)
      writeFileSync(join(emptyDir, HANDOFF_FENCE), readFileSync(join(targetDir, HANDOFF_FENCE)), { mode: 0o600 })
      expect(await status(empty)).toEqual({ status: 404, body: { error: 'not_found' } })
      expect(await status(target, { user: 'u_55667788' })).toEqual({ status: 404, body: { error: 'not_found' } })
      expect(await status(target, { device: 'd_55667788' })).toEqual({ status: 404, body: { error: 'not_found' } })
      expect(await status(target, { authorized: false })).toEqual({ status: 401, body: { error: 'unauthorized' } })
      expect(await status(target, { ready: false })).toEqual({ status: 503, body: { error: 'along_source_not_ready' } })
      // ACKs and later valid changes do not destroy the original immutable semantic prefix proof.
      target.markSynced(USER, packet.data.sync_outbox.map(row => Number(row.seq)))
      target.appendSync({ userId: USER, goalId: GOAL, kind: 'goal_updated', payload: { laterValidWrite: true } })
      expect(await status(target)).toMatchObject({ status: 200 })
      withRaw(join(targetDir, 'along.sqlite'), db => db.prepare('UPDATE sync_outbox SET payload=? WHERE seq=?').run('{"corrupted":true}', packet.data.sync_outbox[0]!.seq!))
      expect(await status(target)).toEqual({ status: 404, body: { error: 'not_found' } })
    } finally { source.close(); target.close(); empty.close() }
  })
})
