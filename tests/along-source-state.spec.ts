import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { migrateAlongSchema } from '../src/along/migrate.ts'
import { SourceStateStore, SOURCE_STATE_SCHEMA, SourceReadInputSchema, type SourceEvent,
  type SourceReadScope } from '../src/along/source-state.ts'

const handles: DatabaseSync[] = [], dirs: string[] = []
afterEach(() => { for (const db of handles.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const start = Date.parse('2030-01-01T12:00:00Z')
function database(path = ':memory:') {
  const db = new DatabaseSync(path); handles.push(db)
  db.exec('PRAGMA foreign_keys=ON'); migrateAlongSchema(db); db.exec(SOURCE_STATE_SCHEMA)
  return db
}
function seed(db: DatabaseSync, suffix = 'a') {
  const identity = { userId: 'user_' + suffix, deviceId: 'device_' + suffix }, goal = 'goal_' + suffix, task = 'task_' + suffix, at = new Date(start).toISOString()
  db.prepare('INSERT INTO user(id,name,device_id,created_at) VALUES(?,?,?,?)').run(identity.userId, suffix, identity.deviceId, at)
  db.prepare('INSERT INTO goal(id,user_id,domain,status,current_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(goal, identity.userId, 'custom', 'active', 1, at, at)
  db.prepare('INSERT INTO user_task(id,goal_id,user_id,status,content,current_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(task, goal, identity.userId, 'open', '分析只读账户摘要', 1, at, at)
  db.prepare('INSERT INTO task_revision(task_id,revision,user_id,goal_id,content,status,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(task, 1, identity.userId, goal, '分析只读账户摘要', 'open', at)
  db.prepare('INSERT INTO input_version(goal_id,user_id,version,updated_at) VALUES(?,?,?,?)').run(goal, identity.userId, 1, at)
  db.prepare('INSERT INTO goal_data_sources(goal_id,user_id,sources,updated_at) VALUES(?,?,?,?)')
    .run(goal, identity.userId, JSON.stringify([{ provider: 'okx', reason: '分析用户明确指定的账户', status: 'recommended' }]), at)
  const scope: SourceReadScope = { userId: identity.userId, goalId: goal, taskId: task, taskRevision: 1, inputVersion: 1,
    ticketId: 'ticket_' + suffix, executionKey: 'event_synthetic' }
  return { identity, goal, task, scope }
}
function fixture() {
  const db = database(), a = seed(db)
  let now = start
  const store = new SourceStateStore(db, { now: () => now })
  const event = (overrides: Partial<SourceEvent> = {}): SourceEvent => ({ event_id: 'source_event_1', goal_id: a.goal, provider: 'okx',
    generation: 1, revision: 1, state: 'ready', capabilities: ['trading_account_summary'], occurred_at: new Date(now).toISOString(), reference: 'ref_1', ...overrides })
  const ready = () => expect(store.acceptEvent(a.identity, event())).toMatchObject({ status: 'accepted', applied: true })
  const read = (max_age_seconds = 60) => store.createRead(a.scope, { provider: 'okx', capability: 'trading_account_summary', max_age_seconds })
  const result = (id: string, extra: Record<string, unknown> = {}) => ({ request_id: id, state: 'ready', generation: 1, revision: 1,
    observed_at: new Date(now).toISOString(), reference: 'ref_1', data: { equity: '1234.50', positions: [{ asset: 'TEST', value: '100.00' }] }, ...extra })
  return { db, ...a, store, event, ready, read, result, advance: (ms: number) => { now += ms }, time: () => now }
}

it('records only strict Host metadata, replays identical event ids and conflicts on changed payloads', () => {
  const f = fixture(), first = f.event()
  expect(f.store.acceptEvent(f.identity, first)).toMatchObject({ status: 'accepted', applied: true, reused: false })
  const before = f.store.queryCurrent(f.identity.userId, f.goal, 'okx')
  f.advance(1000)
  expect(f.store.acceptEvent(f.identity, first)).toMatchObject({ status: 'accepted', reused: true, applied: false })
  expect(f.store.acceptEvent(f.identity, { ...first, reference: 'changed' })).toMatchObject({ status: 'conflict', reason: 'event_payload_conflict' })
  expect(f.store.queryCurrent(f.identity.userId, f.goal, 'okx')).toEqual(before)
  expect(f.db.prepare('SELECT count(*) n FROM source_state_event').get()?.n).toBe(1)
  for (const extra of [{ data: { equity: '999' } }, { summary: 'private' }, { api_key: 'secret' }, { user_id: 'other' }, { device_id: 'other' }]) {
    expect(() => f.store.acceptEvent(f.identity, { ...f.event({ event_id: 'bad' }), ...extra })).toThrow()
  }
  expect(() => f.store.acceptEvent(f.identity, f.event({ event_id: 'bad_cap', capabilities: [] }))).toThrow()
})

it('accepts gaps but rejects late versions, same-version contradictions and ready revival within a closed generation', () => {
  const f = fixture(); f.ready()
  expect(f.store.acceptEvent(f.identity, f.event({ event_id: 'jump', revision: 5, reference: 'ref_5' })).applied).toBe(true)
  expect(f.store.acceptEvent(f.identity, f.event({ event_id: 'late', revision: 4 }))).toMatchObject({ status: 'stale', applied: false })
  expect(f.store.acceptEvent(f.identity, f.event({ event_id: 'contradiction', revision: 5, reference: 'different' })).status).toBe('conflict')
  expect(f.store.acceptEvent(f.identity, f.event({ event_id: 'disconnect', revision: 6, state: 'disconnected', capabilities: [], reference: 'gone' })).applied).toBe(true)
  expect(f.store.acceptEvent(f.identity, f.event({ event_id: 'late_ready', revision: 7 })).reason).toBe('source_generation_closed')
  expect(f.store.acceptEvent(f.identity, f.event({ event_id: 'reconnect', generation: 2, reference: 'ref_new' })).applied).toBe(true)
  expect(f.store.acceptEvent(f.identity, f.event({ event_id: 'old_gen', revision: 100 }))).toMatchObject({ status: 'stale', applied: false })
  expect(f.store.queryCurrent(f.identity.userId, f.goal, 'okx')).toMatchObject({ generation: 2, revision: 1, reference: 'ref_new', state: 'ready' })
})

it('requires an allowed active owned goal for ready while disconnect/revoke can clear a withdrawn grant', () => {
  const f = fixture(); f.ready(); const id = f.read().request_id
  f.store.acceptReadResult(f.identity, f.result(id))
  f.db.prepare('DELETE FROM goal_data_sources WHERE goal_id=?').run(f.goal)
  f.db.prepare("UPDATE goal SET status='archived' WHERE id=?").run(f.goal)
  expect(f.store.acceptEvent(f.identity, f.event({ event_id: 'revoked', revision: 2, state: 'revoked', capabilities: [], reference: 'gone' })).applied).toBe(true)
  expect(f.store.queryCurrent(f.identity.userId, f.goal, 'okx')?.state).toBe('revoked')
  expect(f.store.getRead(f.scope, id)).toMatchObject({ state: 'invalidated' })
  expect(f.db.prepare('SELECT data FROM source_state_read WHERE id=?').get(id)?.data).toBeNull()
  expect(f.store.acceptEvent(f.identity, f.event({ event_id: 'not_allowed', generation: 2 })).status).toBe('rejected')
})

it('honors a trusted synchronous provider assertion and treats source event time separately from data freshness', () => {
  const f = fixture()
  f.db.prepare('DELETE FROM goal_data_sources WHERE goal_id=?').run(f.goal)
  const store = new SourceStateStore(f.db, { now: f.time, assertAllowed: (user, goal, provider) => user === f.identity.userId && goal === f.goal && provider === 'okx' })
  expect(store.acceptEvent(f.identity, f.event({ occurred_at: '2020-01-01T00:00:00Z' })).applied).toBe(true)
  const read = store.createRead(f.scope, { provider: 'okx', capability: 'trading_account_summary', max_age_seconds: 60 })
  expect(store.acceptReadResult(f.identity, f.result(read.request_id))).toMatchObject({ state: 'ready' })
  expect(store.getRead(f.scope, read.request_id)?.data).toMatchObject({ equity: '1234.50' })
})

it('isolates user, device, goal and task scopes for metadata, queues and private results', () => {
  const f = fixture(), other = seed(f.db, 'b'); f.ready(); const id = f.read().request_id
  expect(() => f.store.acceptEvent({ ...f.identity, deviceId: other.identity.deviceId }, f.event({ event_id: 'bad_device' }))).toThrow('source_identity_mismatch')
  expect(() => f.store.acceptEvent(f.identity, f.event({ goal_id: other.goal }))).toThrow('source_scope_mismatch')
  expect(f.store.queryCurrent(other.identity.userId, f.goal, 'okx')).toBeUndefined()
  expect(f.store.pendingReads(other.identity.userId)).toEqual([])
  expect(f.store.acceptReadResult(other.identity, f.result(id))).toMatchObject({ status: 'rejected', reason: 'source_read_not_found' })
  expect(f.store.getRead(other.scope, id)).toBeUndefined()
  expect(f.store.getRead({ ...f.scope, taskId: other.task }, id)).toBeUndefined()
  expect(f.store.getRead({ ...f.scope, inputVersion: 2 }, id)).toBeUndefined()
  expect(f.store.getRead({ ...f.scope, taskRevision: 2 }, id)).toBeUndefined()
  expect(f.store.getRead({ ...f.scope, executionKey: 'other_work' }, id)).toBeUndefined()
  expect(() => f.store.createRead({ ...f.scope, goalId: other.goal }, { provider: 'okx', capability: 'trading_account_summary' })).toThrow('source_read_scope_changed')
})

it('deduplicates same execution reads, backs off Host polls and exposes only a bounded work DTO', () => {
  const f = fixture(); f.ready(); const read = f.read()
  expect(f.store.createRead({ ...f.scope, ticketId: 'resumed' }, { provider: 'okx', capability: 'trading_account_summary', max_age_seconds: 60 }).request_id).toBe(read.request_id)
  expect(f.store.pendingReads(f.identity.userId)).toEqual([{ request_id: read.request_id, goal_id: f.goal, provider: 'okx',
    capability: 'trading_account_summary', generation: 1, revision: 1, max_age_seconds: 60 }])
  expect(f.store.pendingReads(f.identity.userId)).toEqual([])
  expect(f.read().request_id).toBe(read.request_id)
  f.advance(1999); expect(f.store.pendingReads(f.identity.userId)).toEqual([])
  f.advance(1); expect(f.store.pendingReads(f.identity.userId)).toHaveLength(1)
  expect(f.store.getRead(f.scope, read.request_id)?.retry_at).toBe(new Date(f.time() + 4000).toISOString())
  expect(() => f.store.pendingReads(f.identity.userId, 1000)).toThrow('source_read_limit')
})

it('does not refresh a source or expose private account data through event/sync/chat tables', () => {
  const f = fixture(); f.ready(); const id = f.read().request_id
  const before = f.store.queryCurrent(f.identity.userId, f.goal, 'okx')
  f.store.acceptReadResult(f.identity, f.result(id))
  expect(f.store.getRead(f.scope, id)?.data).toMatchObject({ equity: '1234.50' })
  expect(f.store.queryCurrent(f.identity.userId, f.goal, 'okx')).toEqual(before)
  for (const table of ['message', 'sync_outbox', 'event_inbox']) expect(f.db.prepare('SELECT count(*) n FROM ' + table).get()?.n).toBe(0)
  for (const table of ['source_state_event', 'source_state_current']) {
    expect(JSON.stringify(f.db.prepare('SELECT * FROM ' + table).all())).not.toContain('1234.50')
    expect(f.db.prepare('PRAGMA table_info(' + table + ')').all().some(row => row.name === 'data' || row.name === 'summary')).toBe(false)
  }
})

it('keeps duplicate stale results stable and later accepts fresh unchanged cache in the same generation/revision', () => {
  const f = fixture(); f.ready(); const id = f.read().request_id
  f.store.pendingReads(f.identity.userId)
  const stale = f.result(id, { state: 'stale', data: undefined, observed_at: new Date(f.time() - 3600000).toISOString() })
  expect(f.store.acceptReadResult(f.identity, stale)).toMatchObject({ status: 'accepted', state: 'stale' })
  const before = f.db.prepare('SELECT * FROM source_state_read WHERE id=?').get(id)
  f.advance(500)
  expect(f.store.acceptReadResult(f.identity, { ...stale, observed_at: new Date(f.time() - 3600000).toISOString() }).status).toBe('reused')
  expect(f.db.prepare('SELECT * FROM source_state_read WHERE id=?').get(id)).toEqual(before)
  expect(f.store.getRead(f.scope, id)?.data).toBeUndefined()
  expect(f.store.acceptReadResult(f.identity, f.result(id))).toMatchObject({ state: 'ready' })
  expect(f.store.getRead(f.scope, id)).toMatchObject({ state: 'ready', revision: 1, reference: 'ref_1', data: { equity: '1234.50' } })
  expect(f.store.queryCurrent(f.identity.userId, f.goal, 'okx')?.revision).toBe(1)
  expect(f.store.pendingReads(f.identity.userId)).toEqual([])
})

it('recovers unavailable cache results without letting a delayed failure overwrite a fresh ready result', () => {
  const f = fixture(); f.ready(); const id = f.read().request_id
  const unavailable = f.result(id, { state: 'unavailable', data: undefined })
  expect(f.store.acceptReadResult(f.identity, unavailable)).toMatchObject({ state: 'unavailable' })
  const before = f.db.prepare('SELECT * FROM source_state_read WHERE id=?').get(id)
  f.advance(1000)
  expect(f.store.acceptReadResult(f.identity, { ...unavailable, observed_at: new Date(f.time()).toISOString() }).status).toBe('reused')
  expect(f.db.prepare('SELECT * FROM source_state_read WHERE id=?').get(id)).toEqual(before)
  expect(f.store.acceptReadResult(f.identity, f.result(id)).state).toBe('ready')
  expect(f.store.acceptReadResult(f.identity, unavailable)).toMatchObject({ status: 'rejected', state: 'ready' })
  expect(f.store.getRead(f.scope, id)?.data?.equity).toBe('1234.50')
})

it('ages a ready read to stale once and allows re-requesting fresh cache without a new source fact', () => {
  const f = fixture(); f.ready(); const id = f.read().request_id
  f.store.acceptReadResult(f.identity, f.result(id))
  f.advance(59999); expect(f.store.getRead(f.scope, id)?.state).toBe('ready')
  f.advance(1); expect(f.store.getRead(f.scope, id)).toMatchObject({ state: 'stale', reason: 'source_data_expired' })
  expect(f.store.getRead(f.scope, id)?.data).toBeUndefined()
  const before = f.db.prepare('SELECT * FROM source_state_read WHERE id=?').get(id)
  f.advance(100); f.store.getRead(f.scope, id)
  expect(f.db.prepare('SELECT * FROM source_state_read WHERE id=?').get(id)).toEqual(before)
  expect(f.store.pendingReads(f.identity.userId)).toHaveLength(1)
  expect(f.store.acceptReadResult(f.identity, f.result(id)).state).toBe('ready')
  expect(f.read().request_id).toBe(id)
})

it('lets Host polling discover aged results and invalid context without a prior Worker getRead', () => {
  const f = fixture(); f.ready(); const id = f.read().request_id
  f.store.acceptReadResult(f.identity, f.result(id))
  f.advance(61000)
  expect(f.store.pendingReads(f.identity.userId)).toHaveLength(1)
  expect(f.db.prepare('SELECT state FROM source_state_read WHERE id=?').get(id)?.state).toBe('stale')
  f.store.acceptReadResult(f.identity, f.result(id))
  f.db.prepare('UPDATE input_version SET version=2 WHERE goal_id=?').run(f.goal)
  expect(f.store.pendingReads(f.identity.userId)).toEqual([])
  expect(f.db.prepare('SELECT state,data FROM source_state_read WHERE id=?').get(id)).toEqual({ state: 'invalidated', data: null })
})

it('does not expose an already-old ready payload and refuses future observation timestamps', () => {
  const f = fixture(); f.ready(); const id = f.read().request_id
  expect(f.store.acceptReadResult(f.identity, f.result(id, { observed_at: new Date(f.time() + 31000).toISOString() })))
    .toMatchObject({ status: 'rejected', reason: 'source_read_future_observation' })
  expect(f.store.acceptReadResult(f.identity, f.result(id, { observed_at: new Date(f.time() - 60000).toISOString() })).state).toBe('stale')
  expect(f.store.getRead(f.scope, id)?.data).toBeUndefined()
})

it('fails closed if stored capability availability disappears while a read is pending', () => {
  const f = fixture(); f.ready(); const id = f.read().request_id
  f.db.prepare("UPDATE source_state_current SET capabilities='[]' WHERE user_id=? AND goal_id=?").run(f.identity.userId, f.goal)
  expect(f.store.pendingReads(f.identity.userId)).toEqual([])
  expect(f.store.acceptReadResult(f.identity, f.result(id))).toMatchObject({ status: 'rejected', reason: 'source_not_ready' })
  expect(f.store.getRead(f.scope, id)?.data).toBeUndefined()
  expect(() => f.read()).toThrow('source_not_ready')
})

it('follows current same-generation revisions and immediately hides data after another revision update', () => {
  const f = fixture(); f.ready(); const id = f.read().request_id
  expect(f.store.acceptReadResult(f.identity, f.result(id, { revision: 2, reference: 'ref_2' })))
    .toMatchObject({ status: 'rejected', reason: 'source_read_version_mismatch' }) // The fact must arrive before its dataset.
  f.store.acceptEvent(f.identity, f.event({ event_id: 'refresh_2', revision: 2, reference: 'ref_2' }))
  expect(f.store.acceptReadResult(f.identity, f.result(id))).toMatchObject({ status: 'rejected', reason: 'source_read_version_mismatch' })
  expect(f.store.pendingReads(f.identity.userId)[0]?.revision).toBe(2)
  expect(f.store.acceptReadResult(f.identity, f.result(id, { revision: 2, reference: 'ref_2' })).state).toBe('ready')
  expect(f.store.getRead(f.scope, id)).toMatchObject({ state: 'ready', revision: 2, reference: 'ref_2' })
  expect(f.db.prepare('SELECT expected_revision,actual_result_revision FROM source_state_read WHERE id=?').get(id)).toEqual({ expected_revision: 1, actual_result_revision: 2 })
  f.store.acceptEvent(f.identity, f.event({ event_id: 'refresh_3', revision: 3, reference: 'ref_3' }))
  expect(f.store.getRead(f.scope, id)).toMatchObject({ state: 'stale', reason: 'source_revision_changed' })
  expect(f.store.getRead(f.scope, id)?.data).toBeUndefined()
  expect(f.store.acceptReadResult(f.identity, f.result(id, { revision: 3, reference: 'ref_3', data: { equity: '900' } })).state).toBe('ready')
  expect(f.store.acceptReadResult(f.identity, f.result(id, { revision: 2, reference: 'ref_2' })).status).toBe('rejected')
  expect(f.store.getRead(f.scope, id)?.data).toEqual({ equity: '900' })
})

it('rejects old-generation ready but lets an old request be denied without changing a new authorization or read', () => {
  const f = fixture(); f.ready(); const old = f.read().request_id
  f.store.acceptReadResult(f.identity, f.result(old))
  f.store.acceptEvent(f.identity, f.event({ event_id: 'new_generation', generation: 2, reference: 'ref_new' }))
  expect(f.store.getRead(f.scope, old)).toMatchObject({ state: 'invalidated' })
  expect(f.store.acceptReadResult(f.identity, f.result(old))).toMatchObject({ status: 'rejected', state: 'invalidated' })
  const next = f.read().request_id; expect(next).not.toBe(old)
  expect(f.store.acceptReadResult(f.identity, f.result(next, { generation: 2, reference: 'ref_new' })).state).toBe('ready')
  const before = f.store.queryCurrent(f.identity.userId, f.goal, 'okx')
  expect(f.store.acceptReadResult(f.identity, f.result(old, { state: 'denied', reference: 'unavailable', data: undefined })))
    .toMatchObject({ status: 'accepted', state: 'denied' })
  expect(f.store.getRead(f.scope, old)).toMatchObject({ state: 'denied' })
  expect(f.store.queryCurrent(f.identity.userId, f.goal, 'okx')).toEqual(before)
  expect(f.store.getRead(f.scope, next)?.data).toMatchObject({ equity: '1234.50' })
})

it.each(['task_cancelled', 'task_revision', 'input_version', 'goal_archived', 'provider_withdrawn'])('invalidates a private read when %s changes', kind => {
  const f = fixture(); f.ready(); const id = f.read().request_id
  f.store.acceptReadResult(f.identity, f.result(id))
  if (kind === 'task_cancelled') f.db.prepare("UPDATE user_task SET status='cancelled' WHERE id=?").run(f.task)
  if (kind === 'task_revision') f.db.prepare('UPDATE user_task SET current_revision=2 WHERE id=?').run(f.task)
  if (kind === 'input_version') f.db.prepare('UPDATE input_version SET version=2 WHERE goal_id=?').run(f.goal)
  if (kind === 'goal_archived') f.db.prepare("UPDATE goal SET status='archived' WHERE id=?").run(f.goal)
  if (kind === 'provider_withdrawn') f.db.prepare('UPDATE goal_data_sources SET sources=? WHERE goal_id=?').run('[]', f.goal)
  expect(f.store.getRead(f.scope, id)).toMatchObject({ state: 'invalidated', reason: 'source_read_scope_changed' })
  expect(f.db.prepare('SELECT data FROM source_state_read WHERE id=?').get(id)?.data).toBeNull()
  expect(f.store.acceptReadResult(f.identity, f.result(id)).status).toBe('rejected')
  expect(f.store.pendingReads(f.identity.userId)).toEqual([])
  expect(() => f.read()).toThrow('source_read_scope_changed')
})

it('suspends reads while source unavailable and restores the same request after a new verified ready fact', () => {
  const f = fixture(); f.ready(); const id = f.read().request_id
  f.store.acceptEvent(f.identity, f.event({ event_id: 'unavailable', revision: 2, state: 'unavailable', capabilities: [], reference: 'ref_down' }))
  expect(f.store.getRead(f.scope, id)?.state).toBe('unavailable')
  expect(f.store.pendingReads(f.identity.userId)).toEqual([])
  expect(f.store.acceptReadResult(f.identity, f.result(id, { state: 'unavailable', revision: 2, reference: 'ref_down', data: undefined })).state).toBe('unavailable')
  f.store.acceptEvent(f.identity, f.event({ event_id: 'available', revision: 3, reference: 'ref_3' }))
  expect(f.read().request_id).toBe(id)
  expect(f.store.pendingReads(f.identity.userId)[0]?.revision).toBe(3)
  expect(f.store.acceptReadResult(f.identity, f.result(id, { revision: 3, reference: 'ref_3' })).state).toBe('ready')
})

it('treats denial as terminal, removes data and does not alter source facts', () => {
  const f = fixture(); f.ready(); const id = f.read().request_id
  f.store.acceptReadResult(f.identity, f.result(id))
  const before = f.store.queryCurrent(f.identity.userId, f.goal, 'okx')
  const denied = f.result(id, { state: 'denied', data: undefined })
  expect(f.store.acceptReadResult(f.identity, denied).state).toBe('denied')
  expect(f.store.acceptReadResult(f.identity, denied).status).toBe('reused')
  expect(f.store.acceptReadResult(f.identity, f.result(id)).status).toBe('rejected')
  expect(f.store.pendingReads(f.identity.userId)).toEqual([])
  expect(f.db.prepare('SELECT data FROM source_state_read WHERE id=?').get(id)?.data).toBeNull()
  expect(f.store.queryCurrent(f.identity.userId, f.goal, 'okx')).toEqual(before)
})

it('bounds private JSON, rejects credential-shaped data and never accepts data on a nonready response', () => {
  const f = fixture(); f.ready(); const id = f.read().request_id
  for (const data of [[], { equity: NaN }, { apiKey: 'never-store-this' }, { nested: { passphrase: 'never' } }, { value: 'x'.repeat(4097) }, { body: () => 'code' }]) {
    expect(() => f.store.acceptReadResult(f.identity, f.result(id, { data }))).toThrow()
  }
  expect(() => f.store.acceptReadResult(f.identity, f.result(id, { state: 'unavailable' }))).toThrow()
  expect(() => f.store.acceptReadResult(f.identity, f.result(id, { data: undefined }))).toThrow()
  expect(() => f.store.acceptReadResult(f.identity, f.result(id, { summary: {} }))).toThrow()
  for (const max_age_seconds of [0, 59, 86401, Infinity]) expect(() => SourceReadInputSchema.parse({ provider: 'okx', capability: 'trading_account_summary', max_age_seconds })).toThrow()
})

it('shares caller transactions and preserves source/read state across a real restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'along-source-state-')); dirs.push(dir)
  const path = join(dir, 'along.sqlite'), db = database(path), a = seed(db)
  const event: SourceEvent = { event_id: 'source_ready', goal_id: a.goal, provider: 'okx', generation: 1, revision: 1,
    state: 'ready', capabilities: ['trading_account_summary'], occurred_at: new Date(start).toISOString(), reference: 'ref_1' }
  const store = new SourceStateStore(db, { now: () => start })
  db.exec('BEGIN'); store.acceptEvent(a.identity, event); db.exec('ROLLBACK')
  expect(store.queryCurrent(a.identity.userId, a.goal, 'okx')).toBeUndefined()
  store.acceptEvent(a.identity, event)
  db.exec('BEGIN'); const rolled = store.createRead(a.scope, { provider: 'okx', capability: 'trading_account_summary' }); db.exec('ROLLBACK')
  expect(store.getRead(a.scope, rolled.request_id)).toBeUndefined()
  const read = store.createRead(a.scope, { provider: 'okx', capability: 'trading_account_summary' })
  store.acceptReadResult(a.identity, { request_id: read.request_id, generation: 1, revision: 1, state: 'ready',
    observed_at: new Date(start).toISOString(), reference: 'ref_1', data: { equity: '42.00' } })
  db.close(); handles.splice(handles.indexOf(db), 1)
  const reopened = database(path), after = new SourceStateStore(reopened, { now: () => start + 1000 })
  expect(after.acceptEvent(a.identity, event)).toMatchObject({ reused: true, applied: false })
  expect(after.getRead(a.scope, read.request_id)).toMatchObject({ state: 'ready', data: { equity: '42.00' } })
  expect(after.createRead(a.scope, { provider: 'okx', capability: 'trading_account_summary' }).request_id).toBe(read.request_id)
})
