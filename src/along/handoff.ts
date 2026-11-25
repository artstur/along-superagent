/** Bounded cold handoff for one dedicated personal business database. No network, model or SQL import API. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { lockSync } from 'proper-lockfile'
import { migrateAlongSchema, alongSchemaVersion } from './migrate.ts'
import { ALONG_SCHEMA_VERSION } from './schema.ts'
import { SourceStateStore } from './source-state.ts'

export const HANDOFF_FORMAT = 'along-personal-handoff/v1' as const
export const HANDOFF_FENCE = 'personal-handoff.json'
export const HANDOFF_CHECKPOINT_KEY = 'personal_handoff_checkpoint'
/** Closed schema-18 list. Any future/foreign table fails closed before a package can be created. */
export const HANDOFF_TABLES = [
  'changeset', 'delivery', 'due_notice', 'event_inbox', 'goal', 'goal_data_sources', 'goal_revision',
  'health_daily_review', 'health_dispatch', 'health_followup', 'health_review_schedule', 'health_summary',
  'input_version', 'maintenance_batch', 'maintenance_schedule', 'memory', 'memory_attempt', 'memory_blocked_source',
  'memory_cleanup', 'memory_detail', 'memory_operation', 'memory_processed', 'memory_revision', 'memory_suppression',
  'message', 'message_audience_audit', 'message_goal_link', 'meta', 'research_reply', 'research_request',
  'research_source', 'run_record', 'source_goal_review', 'source_state_current', 'source_state_event', 'source_state_read',
  'sync_outbox', 'task_calculation', 'task_calculation_source', 'task_daily', 'task_once', 'task_reminder_plan',
  'task_review', 'task_revision', 'task_trigger', 'task_trigger_occurrence', 'task_trigger_review', 'user', 'user_task', 'work_link',
] as const
type Table = typeof HANDOFF_TABLES[number]
type Cell = null | string | number
export type HandoffRow = Record<string, Cell>
export type HandoffData = Record<Table, HandoffRow[]>
export interface HandoffSourceHold {
  provider: 'okx'; goalId: string; reason: 'cloud_history_unsupported'
  sourceEventId: string; sourceGeneration: number; sourceRevision: number
}
export interface HandoffAppliedSourceHold extends HandoffSourceHold {
  eventId: string; generation: number; revision: number; state: 'unavailable'
}
export interface HandoffTargetReceipt {
  snapshotSHA256: string; syncHighWaterMark: number; sourceHolds: HandoffAppliedSourceHold[]
}
export interface HandoffManifest {
  format: typeof HANDOFF_FORMAT; migrationId: string; sourceUserId: string; sourceDeviceId: string
  schemaVersion: number; targetOrigin: string; createdAt: string; goalIds: string[]
  activationPermitSHA256: string; hostCompanionSHA256: string; snapshotSHA256: string; syncPrefixSHA256: string; syncHighWaterMark: number
  sourceHolds: HandoffSourceHold[]
  tables: { name: Table; rowCount: number; sha256: string }[]
}
export interface PersonalHandoff { manifest: HandoffManifest; data: HandoffData }
export type HandoffPhase = 'source_frozen' | 'source_retired' | 'source_aborted' | 'target_staged' | 'target_active' | 'target_aborted'
export interface HandoffStatus { version: 1; phase: HandoffPhase; manifest: HandoffManifest; targetReceipt?: HandoffTargetReceipt }
interface PrivateFence extends HandoffStatus { activationPermit?: string }
/** Stable administrative refusal; never embeds private rows, credentials or filesystem contents. */
export class HandoffError extends Error { constructor(readonly code: string) { super(code) } }
const fail = (code: string): never => { throw new HandoffError(code) }
const digest = (bytes: string) => createHash('sha256').update(bytes, 'utf8').digest('hex')
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value)
const same = (left: unknown, right: unknown) => canonicalHandoffJSON(left) === canonicalHandoffJSON(right)

/** No locale-dependent ordering, unsafe integers, BLOBs, prototype keys or implicit undefined/null conversion. */
export function canonicalHandoffJSON(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) return fail('handoff_invalid_number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalHandoffJSON).join(',') + ']'
  if (typeof value !== 'object' || !value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail('handoff_invalid_json')
  return '{' + Object.keys(value).sort().map(key => {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) return fail('handoff_invalid_key')
    return JSON.stringify(key) + ':' + canonicalHandoffJSON((value as Record<string, unknown>)[key])
  }).join(',') + '}'
}
export const handoffSHA256 = (value: unknown): string => digest(canonicalHandoffJSON(value))
const sorted = (rows: HandoffRow[]) => rows.sort((a, b) => {
  const left = canonicalHandoffJSON(a), right = canonicalHandoffJSON(b)
  return left < right ? -1 : left > right ? 1 : 0
})
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"'
const columns = (db: DatabaseSync, table: string) => db.prepare(`PRAGMA table_info(${quote(table)})`).all()
  .map(row => ({ name: String(row.name), type: String(row.type), notnull: Number(row.notnull), pk: Number(row.pk) }))
const rows = (db: DatabaseSync, table: string): HandoffRow[] => {
  const records = db.prepare(`SELECT * FROM ${quote(table)}${table === 'source_state_read' ? ' ORDER BY rowid' : ''}`).all().map(row => {
    const result: HandoffRow = {}
    for (const [name, value] of Object.entries(row)) {
      if (value !== null && typeof value !== 'string' && typeof value !== 'number') return fail('handoff_unsupported_cell')
      result[name] = value
    }
    canonicalHandoffJSON(result)
    return result
  })
  return table === 'source_state_read' ? records : sorted(records)
}
const allData = (db: DatabaseSync): HandoffData => {
  readDBCheckpoint(db) // Recognized deployment marker must itself be valid; never silently skip corrupt metadata.
  const data = Object.fromEntries(HANDOFF_TABLES.map(table => [table, rows(db, table)])) as HandoffData
  data.meta = data.meta.filter(row => row.key !== HANDOFF_CHECKPOINT_KEY)
  return data
}
/** Receipt timestamps change during ACK; causal prefix identity includes every other original field, ordered by seq. */
const syncPrefix = (records: HandoffRow[]) => [...records].sort((a, b) => Number(a.seq) - Number(b.seq))
  .map(({ delivered_at: _receipt, ...row }) => row)
function sourceHolds(data: HandoffData): HandoffSourceHold[] {
  return data.source_state_current.filter(row => row.provider === 'okx' && row.state === 'ready' &&
    (JSON.parse(String(row.capabilities)) as string[]).includes('trading_history')).map(row => {
    if (!Number.isSafeInteger(row.generation) || !Number.isSafeInteger(row.revision) || Number(row.generation) < 1 ||
      Number(row.revision) < 1 || Number(row.revision) >= Number.MAX_SAFE_INTEGER) return fail('handoff_invalid_source_version')
    return { provider: 'okx' as const, goalId: String(row.goal_id), reason: 'cloud_history_unsupported' as const,
      sourceEventId: String(row.event_id), sourceGeneration: Number(row.generation), sourceRevision: Number(row.revision) }
  }).sort((a, b) => a.goalId < b.goalId ? -1 : a.goalId > b.goalId ? 1 : 0)
}
function appliedHolds(manifest: HandoffManifest): HandoffAppliedSourceHold[] {
  return manifest.sourceHolds.map(hold => ({ ...hold, eventId: 'handoff_hold_' + handoffSHA256([manifest.migrationId, hold]).slice(0, 40),
    generation: hold.sourceGeneration, revision: hold.sourceRevision + 1, state: 'unavailable' }))
}
function validateTargetReceipt(manifest: HandoffManifest, receipt: HandoffTargetReceipt): void {
  if (!receipt || !same(Object.keys(receipt).sort(), ['snapshotSHA256', 'sourceHolds', 'syncHighWaterMark']) ||
    !hex(receipt.snapshotSHA256) || !Number.isSafeInteger(receipt.syncHighWaterMark) || receipt.syncHighWaterMark < manifest.syncHighWaterMark ||
    !same(receipt.sourceHolds, appliedHolds(manifest))) return fail('handoff_invalid_target_receipt')
}

export function assertHandoffSchema(db: DatabaseSync): void {
  if (ALONG_SCHEMA_VERSION !== 18 || alongSchemaVersion(db) !== 18) return fail('handoff_unsupported_schema')
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => String(row.name))
  if (!same(tables, HANDOFF_TABLES)) return fail('handoff_unsupported_tables')
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('view','trigger') LIMIT 1").get()) return fail('handoff_unsupported_schema_object')
  const reference = new DatabaseSync(':memory:')
  try {
    migrateAlongSchema(reference)
    for (const table of HANDOFF_TABLES) {
      const shape = (database: DatabaseSync) => columns(database, table).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      if (!same(shape(db), shape(reference))) return fail('handoff_unsupported_columns')
      if (!same(db.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all(), reference.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all())) return fail('handoff_unsupported_foreign_keys')
    }
  } finally { reference.close() }
  if (db.prepare('PRAGMA foreign_key_check').get()) return fail('handoff_broken_foreign_key')
  if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') return fail('handoff_integrity_error')
}

/** An idle assignment is not enough: pending inputs, replies and durable effects must be settled too. */
export function assertHandoffOrchestratorDrained(db: DatabaseSync): void {
  for (const table of ['ticket', 'thread', 'outbox', 'effect']) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return fail('handoff_unknown_orchestrator')
  }
  if (db.prepare('SELECT 1 FROM effect LIMIT 1').get()) return fail('handoff_orchestrator_not_drained')
  for (const row of db.prepare('SELECT value FROM ticket').all()) {
    const ticket = JSON.parse(String(row.value)) as { undelivered?: unknown[]; assignments?: { state?: string }[] }
    if (ticket.undelivered?.length || ticket.assignments?.some(assignment => ['pending', 'running'].includes(assignment.state ?? '')))
      return fail('handoff_orchestrator_not_drained')
  }
  for (const row of db.prepare('SELECT value FROM thread').all()) {
    const thread = JSON.parse(String(row.value)) as { pending?: unknown[]; evaluating?: unknown }
    if (thread.pending?.length || thread.evaluating != null) return fail('handoff_orchestrator_not_drained')
  }
  for (const row of db.prepare('SELECT value FROM outbox').all()) {
    if ((JSON.parse(String(row.value)) as { status?: string }).status === 'pending') return fail('handoff_orchestrator_not_drained')
  }
}

/** Runtime suppresses a dispatch when any associated review is explicitly retired. Keep its NULL result/history.
 * A malformed or cross-scope association cannot turn unresolved work into portable retired history. */
function hasPendingHealthDispatch(data: HandoffData): boolean {
  const tasks = new Map(data.user_task.map(row => [row.id, row]))
  const reviews = new Map<Cell | undefined, HandoffRow[]>()
  for (const table of ['task_review', 'task_trigger_review', 'source_goal_review'] as const) for (const row of data[table]) {
    const associated = reviews.get(row.event_id) ?? []
    associated.push(row); reviews.set(row.event_id, associated)
  }
  return data.health_dispatch.some(dispatch => {
    if (dispatch.result !== null) return false
    const associated = reviews.get(dispatch.event_id) ?? []
    if (!associated.some(review => review.retired === 1)) return true
    return associated.some(review => {
      if (review.retired !== 0 && review.retired !== 1) return true
      if ('task_id' in review) {
        const task = tasks.get(review.task_id)
        return !task || task.user_id !== dispatch.user_id || task.goal_id !== dispatch.goal_id
      }
      return !data.source_state_event.some(event => event.event_id === review.source_event_id &&
        event.user_id === dispatch.user_id && event.goal_id === dispatch.goal_id && event.provider === review.provider)
    })
  })
}

function assertBusinessDrained(data: HandoffData): void {
  if (data.work_link.some(row => row.ended_at === null) || data.run_record.some(row => row.ended_at === null) ||
    data.delivery.some(row => !['delivered', 'filtered'].includes(String(row.status))) ||
    hasPendingHealthDispatch(data) || data.maintenance_batch.some(row => row.status === 'pending') ||
    data.memory_operation.some(row => row.status === 'pending') || data.memory_attempt.some(row => row.finished_at === null) ||
    data.task_trigger.some(row => row.state === 'running') ||
    data.task_trigger_occurrence.some(row => ['pending', 'dispatched'].includes(String(row.state))) ||
    data.source_state_read.some(row => row.state === 'pending') || data.research_request.some(row => row.status === 'started'))
    return fail('handoff_business_not_drained')
}

function scopeData(data: HandoffData, userId: string, deviceId: string, goalIds: string[]): void {
  if (data.user.length !== 1 || data.user[0]?.id !== userId || data.user[0]?.device_id !== deviceId) return fail('handoff_not_dedicated_user')
  const actualGoals = data.goal.map(row => String(row.id)).sort()
  if (!same(actualGoals, [...goalIds].sort()) || new Set(goalIds).size !== goalIds.length) return fail('handoff_goal_scope_mismatch')
  const goals = new Set(goalIds), tasks = new Set(data.user_task.map(row => String(row.id)))
  for (const table of HANDOFF_TABLES) for (const row of data[table]) {
    if ('user_id' in row && row.user_id !== null && row.user_id !== userId) return fail('handoff_cross_user_row')
    if ('goal_id' in row && row.goal_id !== null && !goals.has(String(row.goal_id))) return fail('handoff_cross_goal_row')
    if ('task_id' in row && row.task_id !== null && !tasks.has(String(row.task_id))) return fail('handoff_orphan_task')
  }
  const metaKeys = new Set(['schema_version', `memory_epoch:${userId}`, `memory_rebuild:${userId}`, `maintenance_time:${userId}`])
  if (data.meta.some(row => !metaKeys.has(String(row.key)))) return fail('handoff_unknown_meta_key')
}

export interface HandoffExportInput {
  migrationId: string; sourceUserId: string; sourceDeviceId: string; goalIds: string[]; targetOrigin: string
  activationPermitSHA256: string; hostCompanionSHA256: string; createdAt: string
}
function validateInput(input: HandoffExportInput): void {
  if (!id(input.migrationId) || !/^u_[a-f0-9]{8}$/.test(input.sourceUserId) || !/^d_[a-f0-9]{8}$/.test(input.sourceDeviceId) ||
    !Array.isArray(input.goalIds) || input.goalIds.length < 1 || input.goalIds.some(goal => !id(goal)) || !hex(input.activationPermitSHA256) || !hex(input.hostCompanionSHA256) ||
    !Number.isFinite(Date.parse(input.createdAt))) return fail('handoff_invalid_identity')
  let target: URL
  try { target = new URL(input.targetOrigin) } catch { return fail('handoff_invalid_target') }
  if (target.protocol !== 'https:' || target.origin !== input.targetOrigin || target.username || target.password ||
    target.hostname === 'localhost' || target.hostname === '[::1]' || /^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(target.hostname)) return fail('handoff_invalid_target')
}

/** Header-only validation is also used by persisted startup fences, which must fail closed when corrupted. */
function validateManifest(value: unknown): HandoffManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('handoff_invalid_manifest')
  const manifest = value as HandoffManifest
  const keys = ['format', 'migrationId', 'sourceUserId', 'sourceDeviceId', 'schemaVersion', 'targetOrigin', 'createdAt', 'goalIds',
    'activationPermitSHA256', 'hostCompanionSHA256', 'snapshotSHA256', 'syncPrefixSHA256', 'syncHighWaterMark', 'sourceHolds', 'tables'].sort()
  if (!same(Object.keys(manifest).sort(), keys) || manifest.format !== HANDOFF_FORMAT || manifest.schemaVersion !== 18 ||
    !Array.isArray(manifest.goalIds) || !hex(manifest.snapshotSHA256) || !hex(manifest.syncPrefixSHA256) ||
    !Number.isSafeInteger(manifest.syncHighWaterMark) || manifest.syncHighWaterMark < 0 || !Array.isArray(manifest.tables) ||
    manifest.tables.length !== HANDOFF_TABLES.length || !Array.isArray(manifest.sourceHolds)) return fail('handoff_invalid_manifest')
  validateInput(manifest)
  if (!same(manifest.goalIds, [...new Set(manifest.goalIds)].sort())) return fail('handoff_invalid_manifest')
  for (let index = 0; index < HANDOFF_TABLES.length; index++) {
    const group = manifest.tables[index]
    if (!group || !same(Object.keys(group).sort(), ['name', 'rowCount', 'sha256']) || group.name !== HANDOFF_TABLES[index] ||
      !Number.isSafeInteger(group.rowCount) || group.rowCount < 0 || !hex(group.sha256)) return fail('handoff_invalid_manifest')
  }
  const seen = new Set<string>()
  for (const hold of manifest.sourceHolds) {
    if (!hold || !same(Object.keys(hold).sort(), ['provider', 'goalId', 'reason', 'sourceEventId', 'sourceGeneration', 'sourceRevision'].sort()) ||
      hold.provider !== 'okx' || hold.reason !== 'cloud_history_unsupported' || !manifest.goalIds.includes(hold.goalId) ||
      typeof hold.sourceEventId !== 'string' || !hold.sourceEventId.length || hold.sourceEventId.length > 128 || /[\u0000\r\n]/.test(hold.sourceEventId) || !Number.isSafeInteger(hold.sourceGeneration) || hold.sourceGeneration < 1 ||
      !Number.isSafeInteger(hold.sourceRevision) || hold.sourceRevision < 1 || hold.sourceRevision >= Number.MAX_SAFE_INTEGER || seen.has(hold.goalId)) return fail('handoff_invalid_source_hold')
    seen.add(hold.goalId)
  }
  return manifest
}

/** AlongStore calls this while holding its transaction and the administrative caller holds both cold directory locks. */
export function exportHandoffData(db: DatabaseSync, input: HandoffExportInput): PersonalHandoff {
  validateInput(input); assertHandoffSchema(db)
  const data = allData(db)
  scopeData(data, input.sourceUserId, input.sourceDeviceId, input.goalIds); assertBusinessDrained(data)
  // These are index handles, not user memories. A new cloud backend must not address the Mac's records.
  for (const row of data.memory_detail) row.backend_ids = '[]'
  for (const row of data.memory_attempt) if (row.backend_ids !== null) row.backend_ids = '[]'
  for (const table of HANDOFF_TABLES) if (table !== 'source_state_read') sorted(data[table])
  const syncHighWaterMark = Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='sync_outbox'").get()?.seq ?? 0)
  const manifest: HandoffManifest = { format: HANDOFF_FORMAT, ...input, goalIds: [...input.goalIds].sort(), schemaVersion: 18,
    snapshotSHA256: handoffSHA256(data), syncPrefixSHA256: handoffSHA256(syncPrefix(data.sync_outbox)), syncHighWaterMark,
    sourceHolds: sourceHolds(data),
    tables: HANDOFF_TABLES.map(name => ({ name, rowCount: data[name].length, sha256: handoffSHA256(data[name]) })) }
  return { manifest, data }
}

/** Validates a data-only package against an independently generated current schema before running any INSERT. */
export function validatePersonalHandoff(value: unknown): PersonalHandoff {
  canonicalHandoffJSON(value)
  if (!value || typeof value !== 'object' || Array.isArray(value) || !same(Object.keys(value).sort(), ['data', 'manifest'])) return fail('handoff_invalid_package')
  const packet = value as PersonalHandoff, manifest = validateManifest(packet.manifest)
  if (!packet.data || !same(Object.keys(packet.data).sort(), HANDOFF_TABLES)) return fail('handoff_invalid_tables')
  const reference = new DatabaseSync(':memory:')
  try {
    migrateAlongSchema(reference)
    for (const table of HANDOFF_TABLES) {
      const names = columns(reference, table).map(column => column.name).sort(), records = packet.data[table]
      if (!Array.isArray(records)) return fail('handoff_invalid_rows')
      for (const row of records) {
        if (!row || Array.isArray(row) || typeof row !== 'object' || !same(Object.keys(row).sort(), names) ||
          Object.values(row).some(cell => cell !== null && typeof cell !== 'string' && typeof cell !== 'number')) return fail('handoff_invalid_columns')
      }
      if (table !== 'source_state_read' && !same(records, sorted([...records]))) return fail('handoff_unsorted_rows')
    }
  } finally { reference.close() }
  scopeData(packet.data, manifest.sourceUserId, manifest.sourceDeviceId, manifest.goalIds); assertBusinessDrained(packet.data)
  if (!same(manifest.sourceHolds, sourceHolds(packet.data))) return fail('handoff_source_hold_mismatch')
  const expectedTables = HANDOFF_TABLES.map(name => ({ name, rowCount: packet.data[name].length, sha256: handoffSHA256(packet.data[name]) }))
  const high = packet.data.sync_outbox.reduce((n, row) => Math.max(n, Number(row.seq)), 0)
  if (!same(manifest.tables, expectedTables) || handoffSHA256(packet.data) !== manifest.snapshotSHA256 ||
    handoffSHA256(syncPrefix(packet.data.sync_outbox)) !== manifest.syncPrefixSHA256 || high > manifest.syncHighWaterMark) return fail('handoff_digest_mismatch')
  if (packet.data.meta.find(row => row.key === 'schema_version')?.value !== '18') return fail('handoff_unsupported_schema')
  if (packet.data.memory_detail.some(row => row.backend_ids !== '[]') || packet.data.memory_attempt.some(row => row.backend_ids !== null && row.backend_ids !== '[]')) return fail('handoff_external_memory_locator')
  return packet
}

/** Caller AlongStore owns the savepoint; no INSERT OR REPLACE and no side-effect replay. */
export function assertHandoffImportable(db: DatabaseSync, value: unknown): PersonalHandoff {
  const packet = validatePersonalHandoff(value); assertHandoffSchema(db)
  for (const table of HANDOFF_TABLES) {
    const existing = rows(db, table)
    if (table === 'meta') {
      if (!same(existing, [{ key: 'schema_version', value: '18' }])) return fail('handoff_destination_not_empty')
    } else if (existing.length) return fail('handoff_destination_not_empty')
  }
  return packet
}
export function importHandoffData(db: DatabaseSync, value: unknown): HandoffManifest {
  const packet = assertHandoffImportable(db, value)
  // Deferral handles forward references in the fixed schema. The transaction owner checks all FKs before release.
  db.exec('PRAGMA defer_foreign_keys=ON')
  for (const table of HANDOFF_TABLES) {
    const names = columns(db, table).map(column => column.name)
    const statement = db.prepare(`INSERT INTO ${quote(table)} (${names.map(quote).join(',')}) VALUES (${names.map(() => '?').join(',')})`)
    for (const row of packet.data[table]) {
      if (table === 'meta' && row.key === 'schema_version') continue
      statement.run(...names.map(name => row[name] as SQLInputValue))
    }
  }
  if (db.prepare('PRAGMA foreign_key_check').get()) return fail('handoff_broken_foreign_key')
  const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='sync_outbox'").get()
  if (sequence) db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='sync_outbox'").run(packet.manifest.syncHighWaterMark)
  else db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run('sync_outbox', packet.manifest.syncHighWaterMark)
  for (const table of HANDOFF_TABLES) if (!same(rows(db, table), packet.data[table])) return fail('handoff_readback_mismatch')
  writeDBCheckpoint(db, { version: 1, phase: 'target_staged', manifest: packet.manifest })
  return packet.manifest
}

function readDBCheckpoint(db: DatabaseSync): HandoffStatus | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get(HANDOFF_CHECKPOINT_KEY)
  if (!row) return undefined
  try {
    const checkpoint = JSON.parse(String(row.value)) as HandoffStatus
    if (checkpoint.version !== 1 || !['target_staged', 'target_active', 'target_aborted'].includes(checkpoint.phase) ||
      !same(Object.keys(checkpoint).sort(), (checkpoint.targetReceipt ? ['version', 'phase', 'manifest', 'targetReceipt'] : ['version', 'phase', 'manifest']).sort())) return fail('handoff_invalid_checkpoint')
    validateManifest(checkpoint.manifest)
    if (checkpoint.targetReceipt) validateTargetReceipt(checkpoint.manifest, checkpoint.targetReceipt)
    if (checkpoint.phase === 'target_active' && !checkpoint.targetReceipt) return fail('handoff_invalid_checkpoint')
    const user = db.prepare('SELECT device_id FROM user WHERE id=?').get(checkpoint.manifest.sourceUserId)
    if (user?.device_id !== checkpoint.manifest.sourceDeviceId) return fail('handoff_invalid_checkpoint')
    return checkpoint
  } catch { return fail('handoff_invalid_checkpoint') }
}
function writeDBCheckpoint(db: DatabaseSync, checkpoint: HandoffStatus): void {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(HANDOFF_CHECKPOINT_KEY, canonicalHandoffJSON(checkpoint))
}
function targetReceiptOf(db: DatabaseSync, manifest: HandoffManifest): HandoffTargetReceipt {
  const source = new SourceStateStore(db), holds = appliedHolds(manifest)
  for (const hold of holds) {
    const current = source.queryCurrent(manifest.sourceUserId, hold.goalId, 'okx')
    const event = db.prepare('SELECT status,state,generation,revision FROM source_state_event WHERE user_id=? AND event_id=?')
      .get(manifest.sourceUserId, hold.eventId)
    if (!current || current.state !== 'unavailable' || current.generation !== hold.generation || current.revision !== hold.revision ||
      current.capabilities.length || current.reference !== 'handoff:' + manifest.migrationId + ':cloud_history_unsupported' ||
      !event || event.status !== 'accepted' || event.state !== 'unavailable' || event.generation !== hold.generation || event.revision !== hold.revision)
      return fail('handoff_source_hold_failed')
  }
  const data = allData(db)
  scopeData(data, manifest.sourceUserId, manifest.sourceDeviceId, manifest.goalIds); assertBusinessDrained(data)
  return { snapshotSHA256: handoffSHA256(data),
    syncHighWaterMark: Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='sync_outbox'").get()?.seq ?? 0), sourceHolds: holds }
}

/** Appends compatibility facts through the existing source-state primitive; never fabricates reads or rewrites old events. */
export function applyHandoffSourceHolds(db: DatabaseSync, manifest: HandoffManifest): HandoffTargetReceipt {
  validateManifest(manifest); assertHandoffSchema(db)
  const checkpoint = readDBCheckpoint(db)
  if (!checkpoint || checkpoint.phase !== 'target_staged' || !same(checkpoint.manifest, manifest)) return fail('handoff_invalid_checkpoint')
  const source = new SourceStateStore(db, { now: () => Date.parse(manifest.createdAt) })
  const holds = appliedHolds(manifest)
  for (const hold of holds) {
    const reference = 'handoff:' + manifest.migrationId + ':cloud_history_unsupported'
    const receipt = source.acceptEvent({ userId: manifest.sourceUserId, deviceId: manifest.sourceDeviceId }, {
      event_id: hold.eventId, goal_id: hold.goalId, provider: 'okx', generation: hold.generation, revision: hold.revision,
      state: 'unavailable', capabilities: [], occurred_at: manifest.createdAt, reference,
    })
    const current = source.queryCurrent(manifest.sourceUserId, hold.goalId, 'okx')
    if (receipt.status !== 'accepted' || !current || current.state !== 'unavailable' || current.generation !== hold.generation ||
      current.revision !== hold.revision || current.reference !== reference || current.capabilities.length) return fail('handoff_source_hold_failed')
    if (!receipt.reused) db.prepare('INSERT INTO sync_outbox(user_id,kind,goal_id,payload,created_at) VALUES(?,?,?,?,?)')
      .run(manifest.sourceUserId, 'goal_updated', hold.goalId, '{}', manifest.createdAt)
  }
  const targetReceipt = targetReceiptOf(db, manifest)
  writeDBCheckpoint(db, { ...checkpoint, targetReceipt })
  return targetReceipt
}

/** AlongStore owns this transition. The file fence remains staged until the same cold CLI commits it next. */
export function activateHandoffCheckpoint(db: DatabaseSync, manifest: HandoffManifest, permit: string): HandoffTargetReceipt {
  const checkpoint = readDBCheckpoint(db)
  if (!checkpoint || !['target_staged', 'target_active'].includes(checkpoint.phase) || !same(checkpoint.manifest, manifest) ||
    !hex(permit) || digest(permit) !== manifest.activationPermitSHA256 || !checkpoint.targetReceipt) return fail('handoff_invalid_checkpoint')
  const actual = targetReceiptOf(db, manifest)
  if (!same(actual, checkpoint.targetReceipt)) return fail('handoff_target_changed')
  writeDBCheckpoint(db, { ...checkpoint, phase: 'target_active' })
  return actual
}

export interface SourceHandoffStatus {
  format: 'along-personal-handoff/source-status/v1'; phase: 'target_active'; migrationId: string; userId: string; deviceId: string
  manifestSHA256: string; snapshotSHA256: string; syncPrefixSHA256: string; syncHighWaterMark: number
  activationPermitSHA256: string; hostCompanionSHA256: string; sourceHolds: HandoffSourceHold[]; targetReceipt: HandoffTargetReceipt
}
/** Proof comes from this actual database and its own Runtime directory, never a Host-configured alternate state file. */
export function sourceHandoffStatus(db: DatabaseSync, dataDir: string, identity: { userId: string; deviceId: string }): SourceHandoffStatus | undefined {
  const checkpoint = readDBCheckpoint(db)
  if (!checkpoint || checkpoint.phase !== 'target_active' || checkpoint.manifest.sourceUserId !== identity.userId ||
    checkpoint.manifest.sourceDeviceId !== identity.deviceId || !checkpoint.targetReceipt) return undefined
  const fence = readHandoffStatus(dataDir)
  if (!fence || fence.phase !== 'target_active' || !same(checkpoint, fence)) return undefined
  const manifest = checkpoint.manifest
  const prefix = db.prepare('SELECT * FROM sync_outbox WHERE seq<=?').all(manifest.syncHighWaterMark) as HandoffRow[]
  if (prefix.some(row => row.user_id !== identity.userId) || handoffSHA256(syncPrefix(prefix)) !== manifest.syncPrefixSHA256 ||
    manifest.goalIds.some(goal => !db.prepare('SELECT 1 FROM goal WHERE id=? AND user_id=?').get(goal, identity.userId))) return undefined
  return { format: 'along-personal-handoff/source-status/v1', phase: 'target_active', migrationId: manifest.migrationId,
    userId: identity.userId, deviceId: identity.deviceId, manifestSHA256: handoffSHA256(manifest),
    snapshotSHA256: manifest.snapshotSHA256, syncPrefixSHA256: manifest.syncPrefixSHA256, syncHighWaterMark: manifest.syncHighWaterMark,
    activationPermitSHA256: manifest.activationPermitSHA256, hostCompanionSHA256: manifest.hostCompanionSHA256,
    sourceHolds: manifest.sourceHolds, targetReceipt: checkpoint.targetReceipt }
}

/** Deterministic isolated rehearsal used to distinguish a valid post-hold stage from unrelated target changes. */
export function expectedHandoffTarget(packet: PersonalHandoff): HandoffTargetReceipt {
  validatePersonalHandoff(packet)
  const reference = new DatabaseSync(':memory:')
  try {
    reference.exec('PRAGMA foreign_keys=ON'); migrateAlongSchema(reference); reference.exec('BEGIN')
    importHandoffData(reference, packet)
    const receipt = applyHandoffSourceHolds(reference, packet.manifest)
    reference.exec('COMMIT')
    return receipt
  } finally { reference.close() }
}

/** Fully durable, owner-only replacement: no follow of an existing destination or leaked temp files. */
function durableJSON(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = file + '.' + randomUUID() + '.tmp'
  let fd: number | undefined
  try {
    fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, canonicalHandoffJSON(value) + '\n'); fsyncSync(fd); closeSync(fd); fd = undefined
    renameSync(temp, file)
    const directory = openSync(dirname(file), 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  } finally { if (fd !== undefined) closeSync(fd); if (existsSync(temp)) unlinkSync(temp) }
}

function readFence(dir: string): PrivateFence | undefined {
  const file = join(dir, HANDOFF_FENCE)
  let text: string
  try {
    if (statSync(file).mode & 0o077) return fail('handoff_insecure_fence')
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let value: PrivateFence
  try { value = JSON.parse(text) as PrivateFence } catch { return fail('handoff_invalid_fence') }
  const phases: HandoffPhase[] = ['source_frozen', 'source_retired', 'source_aborted', 'target_staged', 'target_active', 'target_aborted']
  try {
    if (!value || value.version !== 1 || !phases.includes(value.phase)) return fail('handoff_invalid_fence')
    const needsPermit = ['source_frozen', 'source_retired'].includes(value.phase)
    const keys = needsPermit ? ['version', 'phase', 'manifest', 'activationPermit'] : ['version', 'phase', 'manifest']
    if (value.targetReceipt !== undefined && value.phase.startsWith('target_')) keys.push('targetReceipt')
    if (!same(Object.keys(value).sort(), keys.sort())) return fail('handoff_invalid_fence')
    validateManifest(value.manifest)
    if (needsPermit && (!hex(value.activationPermit) || digest(value.activationPermit) !== value.manifest.activationPermitSHA256)) return fail('handoff_invalid_fence')
    if (value.targetReceipt !== undefined) validateTargetReceipt(value.manifest, value.targetReceipt)
    if (value.phase === 'target_active' && !value.targetReceipt) return fail('handoff_invalid_fence')
  } catch { return fail('handoff_invalid_fence') }
  return value
}
export function readHandoffStatus(dir: string): HandoffStatus | undefined {
  const fence = readFence(dir)
  return fence && { version: 1, phase: fence.phase, manifest: fence.manifest, ...(fence.targetReceipt ? { targetReceipt: fence.targetReceipt } : {}) }
}
/** Called by Runtime while holding the normal Along directory lock, before opening a writable business store. */
export function assertHandoffStartupAllowed(dir: string): void {
  const status = readFence(dir)
  if (status && !['source_aborted', 'target_active'].includes(status.phase)) return fail('handoff_runtime_fenced')
}

function matching(dir: string, manifest: HandoffManifest): PrivateFence | undefined {
  const fence = readFence(dir)
  if (fence && !same(fence.manifest, manifest)) return fail('handoff_conflicting_migration')
  return fence
}
/** Requires caller's cold locks. A source cannot be activated using the exported package alone. */
export function freezeHandoffSource(dir: string, packet: PersonalHandoff, activationPermit: string): HandoffStatus {
  validatePersonalHandoff(packet)
  if (!hex(activationPermit) || digest(activationPermit) !== packet.manifest.activationPermitSHA256) return fail('handoff_bad_activation_permit')
  const previous = matching(dir, packet.manifest)
  if (previous && previous.phase !== 'source_frozen') return fail('handoff_invalid_transition')
  durableJSON(join(dir, HANDOFF_FENCE), { version: 1, phase: 'source_frozen', manifest: packet.manifest, activationPermit })
  return readHandoffStatus(dir)!
}
export function stageHandoffTarget(dir: string, manifest: HandoffManifest, targetReceipt?: HandoffTargetReceipt): HandoffStatus {
  validateManifest(manifest)
  if (targetReceipt !== undefined) validateTargetReceipt(manifest, targetReceipt)
  const previous = matching(dir, manifest)
  if (previous && previous.phase !== 'target_staged') return fail('handoff_invalid_transition')
  durableJSON(join(dir, HANDOFF_FENCE), { version: 1, phase: 'target_staged', manifest, ...(targetReceipt ? { targetReceipt } : previous?.targetReceipt ? { targetReceipt: previous.targetReceipt } : {}) })
  return readHandoffStatus(dir)!
}
/** Returns the new migration-only permit after the irreversible source fence is durably committed. */
export function retireHandoffSource(dir: string, migrationId: string): string {
  const fence = readFence(dir)
  if (!fence || fence.manifest.migrationId !== migrationId || !['source_frozen', 'source_retired'].includes(fence.phase) ||
    !hex(fence.activationPermit) || digest(fence.activationPermit) !== fence.manifest.activationPermitSHA256) return fail('handoff_invalid_transition')
  durableJSON(join(dir, HANDOFF_FENCE), { ...fence, phase: 'source_retired' })
  return fence.activationPermit
}
export function activateHandoffTarget(dir: string, migrationId: string, activationPermit: string): HandoffStatus {
  const fence = readFence(dir)
  if (!fence || fence.manifest.migrationId !== migrationId || !['target_staged', 'target_active'].includes(fence.phase) ||
    !hex(activationPermit) || digest(activationPermit) !== fence.manifest.activationPermitSHA256) return fail('handoff_bad_activation_permit')
  if (fence.phase === 'target_staged') {
    const db = new DatabaseSync(join(dir, 'along.sqlite'), { readOnly: true })
    try {
      const expected = fence.targetReceipt
      if (!expected) return fail('handoff_target_changed')
      const checkpoint = readDBCheckpoint(db)
      if (!checkpoint || checkpoint.phase !== 'target_active' || !same(checkpoint.manifest, fence.manifest) || !same(checkpoint.targetReceipt, expected)) return fail('handoff_invalid_checkpoint')
      const actual = targetReceiptOf(db, fence.manifest)
      if (!same(actual, expected)) return fail('handoff_target_changed')
    } finally { db.close() }
  }
  durableJSON(join(dir, HANDOFF_FENCE), { ...fence, phase: 'target_active' })
  return readHandoffStatus(dir)!
}
export function abortHandoff(dir: string, migrationId: string): HandoffStatus {
  const fence = readFence(dir)
  if (!fence || fence.manifest.migrationId !== migrationId || !['source_frozen', 'source_aborted', 'target_staged', 'target_aborted'].includes(fence.phase)) return fail('handoff_invalid_transition')
  const phase = fence.phase.startsWith('source_') ? 'source_aborted' : 'target_aborted'
  durableJSON(join(dir, HANDOFF_FENCE), { version: 1, phase, manifest: fence.manifest })
  return readHandoffStatus(dir)!
}

/** Same lock paths as Runtime; no lock deletion, active override, or timeout-based trust inference. */
export function withColdHandoffLocks<T>(dataDir: string, stateDir: string, work: () => T): T {
  const data = resolve(dataDir), state = resolve(stateDir)
  if (data === state || data.startsWith(state + '/') || state.startsWith(data + '/')) return fail('handoff_directories_overlap')
  const releaseState = lockSync(stateDir, { stale: 30_000, retries: 0 })
  try {
    const releaseData = lockSync(dataDir, { stale: 30_000, retries: 0 })
    try { return work() } finally { releaseData() }
  } finally { releaseState() }
}
export const newHandoffActivationPermit = (): string => randomBytes(32).toString('hex')
/** Secret stays local; this helper is for a cold export retry, never for a public status response. */
export function sourceHandoffPreparation(dir: string, migrationId: string): { createdAt: string; activationPermit: string } {
  const fence = readFence(dir)
  if (!fence) return { createdAt: new Date().toISOString(), activationPermit: newHandoffActivationPermit() }
  if (fence.phase !== 'source_frozen' || fence.manifest.migrationId !== migrationId || !hex(fence.activationPermit)) return fail('handoff_invalid_transition')
  return { createdAt: fence.manifest.createdAt, activationPermit: fence.activationPermit }
}
export function writePersonalHandoff(file: string, packet: PersonalHandoff): void {
  validatePersonalHandoff(packet)
  if (existsSync(file)) return fail('handoff_output_exists')
  durableJSON(file, packet)
}
export function readPersonalHandoff(file: string): PersonalHandoff {
  if (statSync(file).mode & 0o077) return fail('handoff_insecure_package')
  return validatePersonalHandoff(JSON.parse(readFileSync(file, 'utf8')))
}
export function writeHandoffActivationPermit(file: string, permit: string): void {
  if (existsSync(file) || !hex(permit)) return fail('handoff_output_exists')
  durableJSON(file, { format: HANDOFF_FORMAT, activationPermit: permit })
}
export function readHandoffActivationPermit(file: string): string {
  if (statSync(file).mode & 0o077) return fail('handoff_insecure_permit')
  const value = JSON.parse(readFileSync(file, 'utf8')) as { format?: unknown; activationPermit?: unknown }
  if (value.format !== HANDOFF_FORMAT || !hex(value.activationPermit)) return fail('handoff_bad_activation_permit')
  return value.activationPermit
}
