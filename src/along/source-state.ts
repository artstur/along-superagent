/** Host-attested source capability facts and private, task-bound cache reads. Never a public event bus. */
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { z } from 'zod'

const Id = z.string().min(1).max(128)
const Version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const Timestamp = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)))
const Reference = z.string().min(1).max(256).regex(/^[^\r\n\u0000]+$/)
const Provider = z.literal('okx'), Capability = z.literal('trading_account_summary')
const SourceStatus = z.enum(['ready', 'disconnected', 'revoked', 'unavailable'])
export const SourceEventSchema = z.object({
  event_id: Id, goal_id: Id, provider: Provider, generation: Version, revision: Version, state: SourceStatus,
  capabilities: z.array(Capability).max(1), occurred_at: Timestamp, reference: Reference,
}).strict().superRefine((event, ctx) => {
  if (event.state === 'ready' ? event.capabilities.length !== 1 : event.capabilities.length !== 0) {
    ctx.addIssue({ code: 'custom', path: ['capabilities'], message: 'Ready has the verified read capability; other states have none.' })
  }
})
export const SourceReadInputSchema = z.object({ provider: Provider, capability: Capability,
  max_age_seconds: z.number().int().min(60).max(86400).default(1800) }).strict()
type Json = null | string | number | boolean | Json[] | { [key: string]: Json }
type Data = Record<string, Json>
function safeData(value: unknown): value is Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }]
  let nodes = 0
  while (stack.length) {
    const item = stack.pop()!
    if (++nodes > 10000 || item.depth > 12) return false
    const v = item.value
    if (v === null || typeof v === 'boolean') continue
    if (typeof v === 'number') { if (!Number.isFinite(v)) return false; continue }
    if (typeof v === 'string') { if (v.length > 4096) return false; continue }
    if (Array.isArray(v)) {
      if (v.length > 1000) return false
      for (const child of v) stack.push({ value: child, depth: item.depth + 1 })
      continue
    }
    if (!v || typeof v !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false
    const entries = Object.entries(v)
    if (entries.length > 1000) return false
    for (const [key, child] of entries) {
      if (key.length > 128 || /^(?:__proto__|prototype|constructor)$/i.test(key) ||
        /^(?:apikey|secret|apisecret|secretkey|passphrase|password|authorization|accesstoken|refreshtoken|privatekey|credentials?)$/i.test(key.replaceAll(/[_-]/g, ''))) return false
      stack.push({ value: child, depth: item.depth + 1 })
    }
  }
  return JSON.stringify(value).length <= 262144
}
const PrivateData = z.record(z.string(), z.unknown()).refine(safeData, 'A bounded JSON summary without credential fields is required.')
export const SourceReadResultSchema = z.object({
  request_id: Id, state: z.enum(['ready', 'denied', 'stale', 'unavailable']), generation: Version, revision: Version,
  observed_at: Timestamp, reference: Reference, data: PrivateData.optional(),
}).strict().superRefine((result, ctx) => {
  if (result.state === 'ready' ? result.data === undefined : result.data !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['data'], message: 'Only ready carries its private JSON summary.' })
  }
})
export const SOURCE_STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS source_state_event (
 user_id TEXT NOT NULL REFERENCES user(id), event_id TEXT NOT NULL, goal_id TEXT NOT NULL REFERENCES goal(id),
 provider TEXT NOT NULL, payload_hash TEXT NOT NULL, generation INTEGER NOT NULL, revision INTEGER NOT NULL,
 state TEXT NOT NULL, capabilities TEXT NOT NULL, occurred_at TEXT NOT NULL, reference TEXT NOT NULL,
 received_at TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, PRIMARY KEY(user_id,event_id)
);
CREATE TABLE IF NOT EXISTS source_state_current (
 user_id TEXT NOT NULL REFERENCES user(id), goal_id TEXT NOT NULL REFERENCES goal(id), provider TEXT NOT NULL,
 event_id TEXT NOT NULL, generation INTEGER NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL,
 capabilities TEXT NOT NULL, occurred_at TEXT NOT NULL, reference TEXT NOT NULL, received_at TEXT NOT NULL,
 fact_hash TEXT NOT NULL, PRIMARY KEY(user_id,goal_id,provider)
);
CREATE TABLE IF NOT EXISTS source_state_read (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id), goal_id TEXT NOT NULL REFERENCES goal(id),
 task_id TEXT NOT NULL REFERENCES user_task(id), task_revision INTEGER NOT NULL, input_version INTEGER NOT NULL,
 ticket_id TEXT NOT NULL, execution_key TEXT NOT NULL, provider TEXT NOT NULL, capability TEXT NOT NULL,
 generation INTEGER NOT NULL, expected_revision INTEGER NOT NULL, max_age_seconds INTEGER NOT NULL,
 state TEXT NOT NULL, reason TEXT, observed_at TEXT, actual_result_revision INTEGER, actual_result_reference TEXT,
 data TEXT, last_result_hash TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS source_state_read_pending ON source_state_read(user_id,state,next_attempt_at);
CREATE INDEX IF NOT EXISTS source_state_read_goal ON source_state_read(user_id,goal_id,provider,generation);
`
export interface SourceIdentity { userId: string; deviceId: string }
export interface SourceReadScope {
  userId: string; goalId: string; taskId: string; taskRevision: number; inputVersion: number; ticketId: string; executionKey: string
}
export type SourceEvent = z.infer<typeof SourceEventSchema>
export type SourceReadInput = z.input<typeof SourceReadInputSchema>
export interface SourceState extends Omit<SourceEvent, 'event_id'> { received_at: string }
export interface SourceReadView {
  request_id: string
  provider: 'okx'
  capability: 'trading_account_summary'
  state: 'pending' | 'ready' | 'denied' | 'stale' | 'unavailable' | 'invalidated'
  generation: number
  revision: number
  max_age_seconds: number
  reason?: string
  retry_at?: string
  observed_at?: string
  reference?: string
  data?: Data
}
export interface PendingSourceRead {
  request_id: string; goal_id: string; provider: 'okx'; capability: 'trading_account_summary'
  generation: number; revision: number; max_age_seconds: number
}
export interface SourceEventReceipt {
  event_id: string; status: 'accepted' | 'stale' | 'conflict' | 'rejected'; reused: boolean; applied: boolean; reason?: string
}
export interface SourceReadResultReceipt {
  request_id: string; status: 'accepted' | 'reused' | 'rejected'; state?: SourceReadView['state']; reason?: string
}
interface Options {
  now?: () => number
  /** Optional trusted policy assertion. The default checks this goal's persisted provider recommendations. */
  assertAllowed?: (userId: string, goalId: string, provider: 'okx') => boolean | void
}
type Row = Record<string, SQLInputValue>
const canonical = (value: unknown): string => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value !== null && typeof value === 'object' ? '{' + Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => JSON.stringify(key) + ':' + canonical(child)).join(',') + '}' : JSON.stringify(value)
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const stateOf = (row: Row): SourceReadView['state'] => String(row.state) as SourceReadView['state']
/** Stable failure codes without data, credentials, provider response bodies or transport diagnostics. */
export class SourceStateError extends Error { constructor(readonly code: string) { super(code) } }

/** Private source facts/read queue on the caller's shared SQLite transaction; it performs no I/O outside SQLite. */
export class SourceStateStore {
  private serial = 0
  private readonly prefix = 'source_state_' + randomUUID().replaceAll('-', '')
  constructor(private readonly db: DatabaseSync, private readonly options: Options = {}) {}
  private atomic<T>(work: () => T): T {
    const name = this.prefix + '_' + ++this.serial
    this.db.exec('SAVEPOINT ' + name)
    try { const result = work(); this.db.exec('RELEASE ' + name); return result }
    catch (error) { this.db.exec('ROLLBACK TO ' + name); this.db.exec('RELEASE ' + name); throw error }
  }
  private clock(): { ms: number; iso: string } {
    const ms = (this.options.now ?? Date.now)()
    if (!Number.isFinite(ms) || Math.abs(ms) > 8640000000000000) throw new SourceStateError('source_invalid_clock')
    return { ms, iso: new Date(ms).toISOString() }
  }
  private identity(identity: SourceIdentity): void {
    const user = this.db.prepare('SELECT device_id FROM user WHERE id=?').get(identity.userId)
    if (!user || user.device_id !== identity.deviceId) throw new SourceStateError('source_identity_mismatch')
  }
  private owned(userId: string, goalId: string): Row | undefined {
    return this.db.prepare('SELECT * FROM goal WHERE id=? AND user_id=?').get(goalId, userId)
  }
  private allowed(userId: string, goalId: string): boolean {
    try {
      if (this.options.assertAllowed) {
        const result = this.options.assertAllowed(userId, goalId, 'okx')
        return result === undefined || result === true
      }
      const row = this.db.prepare('SELECT sources FROM goal_data_sources WHERE goal_id=? AND user_id=?').get(goalId, userId)
      const sources: unknown = row && JSON.parse(String(row.sources))
      return Array.isArray(sources) && sources.some(source => source?.provider === 'okx')
    } catch { return false }
  }
  queryCurrent(userId: string, goalId: string, provider: 'okx'): SourceState | undefined {
    if (!this.owned(userId, goalId)) return undefined
    const row = this.db.prepare('SELECT * FROM source_state_current WHERE user_id=? AND goal_id=? AND provider=?').get(userId, goalId, provider)
    return row ? { goal_id: goalId, provider: 'okx', generation: Number(row.generation), revision: Number(row.revision),
      state: String(row.state) as SourceState['state'], capabilities: JSON.parse(String(row.capabilities)) as SourceState['capabilities'],
      occurred_at: String(row.occurred_at), reference: String(row.reference), received_at: String(row.received_at) } : undefined
  }
  acceptEvent(identity: SourceIdentity, body: unknown): SourceEventReceipt {
    const event = SourceEventSchema.parse(body), payloadHash = hash(event), { event_id: _eventId, ...fact } = event
    const factHash = hash(fact)
    return this.atomic(() => {
      this.identity(identity)
      const goal = this.owned(identity.userId, event.goal_id)
      if (!goal) throw new SourceStateError('source_scope_mismatch')
      const previous = this.db.prepare('SELECT * FROM source_state_event WHERE user_id=? AND event_id=?').get(identity.userId, event.event_id)
      if (previous) {
        if (previous.payload_hash !== payloadHash) return { event_id: event.event_id, status: 'conflict', reused: false, applied: false, reason: 'event_payload_conflict' }
        return { event_id: event.event_id, status: String(previous.status) as SourceEventReceipt['status'], reused: true, applied: false,
          ...(previous.reason === null ? {} : { reason: String(previous.reason) }) }
      }
      const current = this.db.prepare('SELECT * FROM source_state_current WHERE user_id=? AND goal_id=? AND provider=?')
        .get(identity.userId, event.goal_id, event.provider)
      let status: SourceEventReceipt['status'] = 'accepted', reason: string | undefined, applied = true
      if (current) {
        if (event.generation < Number(current.generation) || event.generation === Number(current.generation) && event.revision < Number(current.revision)) {
          status = 'stale'; reason = 'older_source_version'; applied = false
        } else if (event.generation === Number(current.generation) && event.revision === Number(current.revision)) {
          applied = false
          if (current.fact_hash !== factHash) { status = 'conflict'; reason = 'source_version_conflict' }
        } else if (event.generation === Number(current.generation) && ['disconnected', 'revoked'].includes(String(current.state)) &&
          !['disconnected', 'revoked'].includes(event.state)) {
          status = 'stale'; reason = 'source_generation_closed'; applied = false
        }
      }
      if (applied && event.state === 'ready' && (goal.status !== 'active' || !this.allowed(identity.userId, event.goal_id))) {
        status = 'rejected'; reason = 'source_provider_not_allowed'; applied = false
      }
      const now = this.clock()
      this.db.prepare(`INSERT INTO source_state_event(user_id,event_id,goal_id,provider,payload_hash,generation,revision,state,
        capabilities,occurred_at,reference,received_at,status,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(identity.userId, event.event_id, event.goal_id, event.provider, payloadHash, event.generation, event.revision, event.state,
          JSON.stringify(event.capabilities), event.occurred_at, event.reference, now.iso, status, reason ?? null)
      if (applied) {
        this.db.prepare(`INSERT INTO source_state_current(user_id,goal_id,provider,event_id,generation,revision,state,capabilities,
          occurred_at,reference,received_at,fact_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,goal_id,provider) DO UPDATE SET
          event_id=excluded.event_id,generation=excluded.generation,revision=excluded.revision,state=excluded.state,capabilities=excluded.capabilities,
          occurred_at=excluded.occurred_at,reference=excluded.reference,received_at=excluded.received_at,fact_hash=excluded.fact_hash`)
          .run(identity.userId, event.goal_id, event.provider, event.event_id, event.generation, event.revision, event.state,
            JSON.stringify(event.capabilities), event.occurred_at, event.reference, now.iso, factHash)
        // Capability events never load private datasets. Invalidate/retarget their queue metadata in SQL.
        this.db.prepare(`UPDATE source_state_read SET state='invalidated',reason='source_generation_changed',data=NULL,
          next_attempt_at=?,updated_at=? WHERE user_id=? AND goal_id=? AND provider=? AND generation<>?
          AND state NOT IN ('denied','invalidated')`)
          .run(now.iso, now.iso, identity.userId, event.goal_id, event.provider, event.generation)
        if (event.state === 'disconnected' || event.state === 'revoked') {
          this.db.prepare(`UPDATE source_state_read SET state='invalidated',reason='source_not_authorized',data=NULL,
            next_attempt_at=?,updated_at=? WHERE user_id=? AND goal_id=? AND provider=? AND generation=?
            AND state NOT IN ('denied','invalidated')`)
            .run(now.iso, now.iso, identity.userId, event.goal_id, event.provider, event.generation)
        } else if (event.state === 'unavailable') {
          this.db.prepare(`UPDATE source_state_read SET state='unavailable',reason='source_unavailable',next_attempt_at=?,updated_at=?
            WHERE user_id=? AND goal_id=? AND provider=? AND generation=? AND state NOT IN ('denied','invalidated')
            AND (state<>'unavailable' OR reason IS NOT 'source_unavailable')`)
            .run(now.iso, now.iso, identity.userId, event.goal_id, event.provider, event.generation)
        } else {
          this.db.prepare(`UPDATE source_state_read SET state='stale',reason='source_revision_changed',next_attempt_at=?,updated_at=?
            WHERE user_id=? AND goal_id=? AND provider=? AND generation=? AND state='ready'
            AND (actual_result_revision<>? OR actual_result_reference<>?)`)
            .run(now.iso, now.iso, identity.userId, event.goal_id, event.provider, event.generation, event.revision, event.reference)
          this.db.prepare(`UPDATE source_state_read SET next_attempt_at=? WHERE user_id=? AND goal_id=? AND provider=?
            AND generation=? AND state IN ('pending','stale','unavailable')`)
            .run(now.iso, identity.userId, event.goal_id, event.provider, event.generation)
        }
      }
      return { event_id: event.event_id, status, reused: false, applied, ...(reason ? { reason } : {}) }
    })
  }
  private scopeValid(scope: SourceReadScope): boolean {
    if ([scope.userId, scope.goalId, scope.taskId, scope.ticketId, scope.executionKey].some(value => typeof value !== 'string' || !value || value.length > 256) ||
      !Number.isSafeInteger(scope.taskRevision) || scope.taskRevision < 1 || !Number.isSafeInteger(scope.inputVersion) || scope.inputVersion < 1) return false
    const row = this.db.prepare(`SELECT g.status goal_status,t.status task_status,t.current_revision,v.version FROM user_task t
      JOIN goal g ON g.id=t.goal_id AND g.user_id=t.user_id JOIN input_version v ON v.goal_id=g.id AND v.user_id=g.user_id
      WHERE t.id=? AND t.user_id=? AND t.goal_id=?`).get(scope.taskId, scope.userId, scope.goalId)
    return !!row && row.goal_status === 'active' && row.task_status === 'open' &&
      Number(row.current_revision) === scope.taskRevision && Number(row.version) === scope.inputVersion && this.allowed(scope.userId, scope.goalId)
  }
  private scope(row: Row): SourceReadScope {
    return { userId: String(row.user_id), goalId: String(row.goal_id), taskId: String(row.task_id),
      taskRevision: Number(row.task_revision), inputVersion: Number(row.input_version), ticketId: String(row.ticket_id), executionKey: String(row.execution_key) }
  }
  private row(userId: string, requestId: string): Row | undefined {
    return this.db.prepare('SELECT * FROM source_state_read WHERE id=? AND user_id=?').get(requestId, userId)
  }
  private setState(row: Row, state: SourceReadView['state'], reason: string, now: { ms: number; iso: string }): Row {
    const terminal = state === 'invalidated' || state === 'denied'
    if (row.state === state && row.reason === reason && (!terminal || row.data === null)) return row
    this.db.prepare(`UPDATE source_state_read SET state=?,reason=?,data=CASE WHEN ? THEN NULL ELSE data END,
      next_attempt_at=?,updated_at=? WHERE id=? AND user_id=?`)
      .run(state, reason, terminal ? 1 : 0, now.iso, now.iso, row.id!, row.user_id!)
    return this.row(String(row.user_id), String(row.id))!
  }
  private normalize(row: Row, now: { ms: number; iso: string }): Row {
    if (row.state === 'denied' || row.state === 'invalidated') return row
    if (!this.scopeValid(this.scope(row))) return this.setState(row, 'invalidated', 'source_read_scope_changed', now)
    const source = this.queryCurrent(String(row.user_id), String(row.goal_id), 'okx')
    if (!source || source.generation !== Number(row.generation)) return this.setState(row, 'invalidated', 'source_generation_changed', now)
    if (source.state === 'disconnected' || source.state === 'revoked') return this.setState(row, 'invalidated', 'source_not_authorized', now)
    if (source.state !== 'ready' || !source.capabilities.includes('trading_account_summary')) return this.setState(row, 'unavailable', 'source_unavailable', now)
    if (row.state === 'ready') {
      if (Number(row.actual_result_revision) !== source.revision || row.actual_result_reference !== source.reference)
        return this.setState(row, 'stale', 'source_revision_changed', now)
      const observed = Date.parse(String(row.observed_at))
      if (!Number.isFinite(observed) || observed > now.ms + 30000 || now.ms - observed >= Number(row.max_age_seconds) * 1000)
        return this.setState(row, 'stale', 'source_data_expired', now)
    }
    return row
  }
  private view(row: Row, now: { ms: number; iso: string }): SourceReadView {
    const result: SourceReadView = { request_id: String(row.id), provider: 'okx', capability: 'trading_account_summary',
      state: stateOf(row), generation: Number(row.generation), revision: Number(row.actual_result_revision ?? row.expected_revision),
      max_age_seconds: Number(row.max_age_seconds), ...(row.reason === null ? {} : { reason: String(row.reason) }) }
    if (['pending', 'stale', 'unavailable'].includes(result.state) && Date.parse(String(row.next_attempt_at)) > now.ms) result.retry_at = String(row.next_attempt_at)
    if (row.observed_at !== null) result.observed_at = String(row.observed_at)
    if (row.actual_result_reference !== null) result.reference = String(row.actual_result_reference)
    if (result.state === 'ready' && row.data !== null) result.data = JSON.parse(String(row.data)) as Data
    return result
  }
  createRead(scope: SourceReadScope, body: unknown): SourceReadView {
    const input = SourceReadInputSchema.parse(body)
    return this.atomic(() => {
      if (!this.scopeValid(scope)) throw new SourceStateError('source_read_scope_changed')
      const source = this.queryCurrent(scope.userId, scope.goalId, input.provider)
      if (source?.state !== 'ready' || !source.capabilities.includes(input.capability)) throw new SourceStateError('source_not_ready')
      const id = 'sread_' + hash([scope.userId, scope.goalId, scope.taskId, scope.taskRevision, scope.inputVersion,
        scope.executionKey, input.provider, input.capability, source.generation, input.max_age_seconds]).slice(0, 40)
      const now = this.clock(), previous = this.row(scope.userId, id)
      if (previous) return this.view(this.normalize(previous, now), now)
      this.db.prepare(`INSERT INTO source_state_read(id,user_id,goal_id,task_id,task_revision,input_version,ticket_id,execution_key,
        provider,capability,generation,expected_revision,max_age_seconds,state,next_attempt_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`)
        .run(id, scope.userId, scope.goalId, scope.taskId, scope.taskRevision, scope.inputVersion, scope.ticketId, scope.executionKey,
          input.provider, input.capability, source.generation, source.revision, input.max_age_seconds, now.iso, now.iso, now.iso)
      return this.view(this.row(scope.userId, id)!, now)
    })
  }
  getRead(scope: SourceReadScope, requestId: string): SourceReadView | undefined {
    return this.atomic(() => {
      const row = this.row(scope.userId, requestId)
      if (!row || row.goal_id !== scope.goalId || row.task_id !== scope.taskId || Number(row.task_revision) !== scope.taskRevision ||
        Number(row.input_version) !== scope.inputVersion || row.execution_key !== scope.executionKey) return undefined
      const now = this.clock()
      return this.view(this.normalize(row, now), now)
    })
  }
  pendingReads(userId: string, limit = 20): PendingSourceRead[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new SourceStateError('source_read_limit')
    return this.atomic(() => {
      const now = this.clock(), result: PendingSourceRead[] = []
      const rows = this.db.prepare(`SELECT r.* FROM source_state_read r LEFT JOIN source_state_current s
        ON s.user_id=r.user_id AND s.goal_id=r.goal_id AND s.provider=r.provider
        LEFT JOIN user_task t ON t.id=r.task_id LEFT JOIN goal g ON g.id=r.goal_id LEFT JOIN input_version v ON v.goal_id=r.goal_id
        WHERE r.user_id=? AND r.state IN ('pending','stale','unavailable','ready') AND (
          s.generation IS NULL OR s.generation<>r.generation OR s.state IN ('disconnected','revoked') OR
          t.status<>'open' OR t.current_revision<>r.task_revision OR g.status<>'active' OR v.version<>r.input_version OR
          (s.state='ready' AND ((r.state<>'ready' AND r.next_attempt_at<=?) OR r.state='ready' AND (
            r.actual_result_revision<>s.revision OR r.actual_result_reference<>s.reference OR
            julianday(r.observed_at)<=julianday(?)-r.max_age_seconds/86400.0))))
        ORDER BY r.next_attempt_at,r.created_at,r.id LIMIT 200`).all(userId, now.iso, now.iso)
      for (const candidate of rows) {
        const row = this.normalize(candidate, now)
        if (!['pending', 'stale', 'unavailable'].includes(String(row.state)) || Date.parse(String(row.next_attempt_at)) > now.ms) continue
        const source = this.queryCurrent(userId, String(row.goal_id), 'okx')
        if (source?.state !== 'ready' || !source.capabilities.includes('trading_account_summary') || source.generation !== Number(row.generation)) continue
        const attempts = Math.min(Number(row.attempts) + 1, 31)
        const retry = new Date(now.ms + Math.min(60000, 1000 * 2 ** Math.min(attempts, 6))).toISOString()
        this.db.prepare('UPDATE source_state_read SET attempts=?,next_attempt_at=? WHERE id=? AND user_id=?').run(attempts, retry, row.id!, userId)
        result.push({ request_id: String(row.id), goal_id: String(row.goal_id), provider: 'okx', capability: 'trading_account_summary',
          generation: source.generation, revision: source.revision, max_age_seconds: Number(row.max_age_seconds) })
        if (result.length >= limit) break
      }
      return result
    })
  }
  acceptReadResult(identity: SourceIdentity, body: unknown): SourceReadResultReceipt {
    if (body && typeof body === 'object' && 'data' in body && body.data !== undefined && !safeData(body.data)) throw new SourceStateError('source_read_invalid_data')
    const input = SourceReadResultSchema.parse(body)
    return this.atomic(() => {
      this.identity(identity)
      let row = this.row(identity.userId, input.request_id)
      if (!row) return { request_id: input.request_id, status: 'rejected', reason: 'source_read_not_found' }
      const now = this.clock()
      const resultHash = hash(input.state === 'ready' ? input : { ...input, observed_at: undefined })
      if (input.generation !== Number(row.generation) || input.revision < Number(row.expected_revision)) {
        return { request_id: input.request_id, status: 'rejected', state: stateOf(row), reason: 'source_read_version_mismatch' }
      }
      // Denial is safe to settle even after the original authorization/input has disappeared. It never updates source facts.
      if (input.state === 'denied') {
        if (row.state === 'denied') return { request_id: input.request_id, status: row.last_result_hash === resultHash ? 'reused' : 'rejected', state: 'denied', reason: 'source_read_terminal' }
      } else {
        row = this.normalize(row, now)
        if (row.state === 'invalidated' || row.state === 'denied') return { request_id: input.request_id, status: 'rejected', state: stateOf(row), reason: 'source_read_terminal' }
        const source = this.queryCurrent(identity.userId, String(row.goal_id), 'okx')
        if (!source || source.generation !== input.generation || input.state === 'ready' &&
          (source.state !== 'ready' || !source.capabilities.includes('trading_account_summary'))) return { request_id: input.request_id, status: 'rejected', state: stateOf(row), reason: 'source_not_ready' }
        if (input.revision !== source.revision || input.reference !== source.reference) return { request_id: input.request_id, status: 'rejected', state: stateOf(row), reason: 'source_read_version_mismatch' }
        if (row.last_result_hash === resultHash) return { request_id: input.request_id, status: 'reused', state: stateOf(row) }
        if (row.state === 'ready') return { request_id: input.request_id, status: 'rejected', state: 'ready', reason: 'source_read_terminal' }
      }
      if (row.last_result_hash === resultHash) return { request_id: input.request_id, status: 'reused', state: stateOf(row) }
      const observed = Date.parse(input.observed_at)
      if (input.state === 'ready' && observed > now.ms + 30000) return { request_id: input.request_id, status: 'rejected', state: stateOf(row), reason: 'source_read_future_observation' }
      const state = input.state === 'ready' && now.ms - observed >= Number(row.max_age_seconds) * 1000 ? 'stale' : input.state
      const reason = state === 'ready' ? null : state === 'stale' ? 'source_data_expired' : state === 'denied' ? 'source_read_denied' : 'source_data_unavailable'
      this.db.prepare(`UPDATE source_state_read SET state=?,reason=?,observed_at=?,actual_result_revision=?,actual_result_reference=?,
        data=?,last_result_hash=?,attempts=CASE WHEN ?='ready' THEN 0 ELSE attempts END,next_attempt_at=?,updated_at=? WHERE id=? AND user_id=?`)
        .run(state, reason, input.observed_at, input.revision, input.reference, input.state === 'ready' ? JSON.stringify(input.data) : null,
          resultHash, state, state === 'ready' || state === 'denied' ? now.iso : row.next_attempt_at!, now.iso, input.request_id, identity.userId)
      return { request_id: input.request_id, status: 'accepted', state }
    })
  }
}
