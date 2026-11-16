/** Storage component owned by AlongStore: same handle, transaction owner and database lifetime. */
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { GovernedMemory, MemoryCandidate, MemoryOperation, MemorySource, MemoryStatus } from './model.ts'

const hash = (value: string): string => createHash('sha256').update(value.normalize('NFKC').trim()).digest('hex')
type Row = Record<string, SQLInputValue>
const list = (value: SQLInputValue | undefined): string[] => JSON.parse(String(value)) as string[]
const stamp = (): string => new Date().toISOString()

/** AlongStore-owned persistence for governed memories, source suppression and recoverable batch attempts. */
export class MemoryStore {
  constructor(private readonly db: DatabaseSync, private readonly atomic: <T>(work: () => T) => T) {}
  private rows(sql: string, ...values: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...values) }
  private run(sql: string, ...values: SQLInputValue[]): void { this.db.prepare(sql).run(...values) }
  private memory(row: Row): GovernedMemory {
    return { id: String(row.id), userId: String(row.user_id), content: String(row.content), topic: String(row.topic),
      goalId: row.goal_id === null ? undefined : String(row.goal_id), expiresAt: row.expires_at === null ? undefined : String(row.expires_at),
      status: String(row.status) as MemoryStatus, revision: Number(row.current_revision), sourceMessageIds: list(row.source_ids),
      sourceSeq: Number(row.source_seq), backendIds: list(row.backend_ids), category: String(row.category) as GovernedMemory['category'],
      assertion: String(row.assertion) as GovernedMemory['assertion'] }
  }
  memories(userId: string): GovernedMemory[] {
    return this.rows(`SELECT m.*, d.*, r.content FROM memory m JOIN memory_detail d ON d.memory_id=m.id
      JOIN memory_revision r ON r.memory_id=m.id AND r.revision=m.current_revision WHERE m.user_id=? ORDER BY m.created_at,m.id`, userId)
      .map(row => this.memory(row))
  }
  /** Rechecks all filters at read time, including after a slow SDK search returns. */
  effective(userId: string, goalId?: string, now = Date.now()): GovernedMemory[] {
    if (goalId !== undefined) this.assertGoal(userId, goalId)
    return this.memories(userId).filter(memory => memory.status === 'active'
      && (memory.goalId === undefined || memory.goalId === goalId)
      && (memory.expiresAt === undefined || Date.parse(memory.expiresAt) > now)
      && !memory.sourceMessageIds.some(id => this.blocked(userId, id)))
  }
  assertGoal(userId: string, goalId: string): void {
    if (this.rows('SELECT id FROM goal WHERE user_id=? AND id=?', userId, goalId).length !== 1) throw new Error('memory resource not found')
  }
  blocked(userId: string, messageId: string): boolean {
    return this.rows('SELECT 1 FROM memory_blocked_source WHERE user_id=? AND message_id=?', userId, messageId).length > 0
  }
  /** Without full summary provenance, a withdrawal starts a fresh planner-history window (display history stays intact). */
  contextAllowed(userId: string, messageId: string, text: string): boolean {
    const row = this.rows('SELECT seq,text FROM message WHERE user_id=? AND id=?', userId, messageId)[0]
    if (!row || row.text !== text || this.blocked(userId, messageId)) return false
    const cutoff = Number(this.rows('SELECT IFNULL(MAX(through_seq),0) AS seq FROM memory_suppression WHERE user_id=?', userId)[0]!.seq)
    return Number(row.seq) > cutoff
  }
  /** Only actual inbound chat is eligible, never task feedback, health events or assistant suggestions. */
  sources(userId: string, ids?: readonly string[], unprocessed = false): MemorySource[] {
    if (ids?.length === 0) return []
    const rows = this.rows(`SELECT m.* FROM message m LEFT JOIN event_inbox e ON e.user_id=m.user_id AND e.event_id=m.event_id
      WHERE m.user_id=? AND m.role='user' AND m.direction='inbound'
      AND (e.event_id IS NULL OR (e.event_type='along.user_message' AND e.status='accepted'))
      AND NOT EXISTS(SELECT 1 FROM memory_blocked_source b WHERE b.user_id=m.user_id AND b.message_id=m.id)
      AND (m.seq > COALESCE((SELECT MAX(s.through_seq) FROM memory_suppression s WHERE s.user_id=m.user_id),0)
        OR EXISTS(SELECT 1 FROM memory kept JOIN memory_detail d ON d.memory_id=kept.id, json_each(d.source_ids) evidence
          WHERE kept.user_id=m.user_id AND kept.status='active' AND evidence.value=m.id
          AND (kept.expires_at IS NULL OR kept.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))))
      ${unprocessed ? 'AND NOT EXISTS(SELECT 1 FROM memory_processed p WHERE p.user_id=m.user_id AND p.message_id=m.id)' : ''}
      ${ids ? `AND m.id IN (${ids.map(() => '?').join(',')})` : ''}
      ORDER BY m.seq ${unprocessed ? 'LIMIT 20' : ''}`, userId, ...(ids ?? []))
    const cutoff = Number(this.rows('SELECT IFNULL(MAX(through_seq),0) AS seq FROM memory_suppression WHERE user_id=?', userId)[0]!.seq)
    const kept = cutoff > 0 ? this.memories(userId).filter(item => item.status === 'active'
      && (item.expiresAt === undefined || Date.parse(item.expiresAt) > Date.now())) : []
    return rows.map(row => ({
      // After a withdrawal, old history is not re-sent wholesale. Only unchanged governed quotes can rebuild its projection.
      id: String(row.id), text: Number(row.seq) > cutoff ? String(row.text)
        : [...new Set(kept.filter(item => item.sourceMessageIds.includes(String(row.id))).map(item => item.content))].join('\n'), seq: Number(row.seq),
      goalIds: this.rows("SELECT goal_id FROM message_goal_link WHERE user_id=? AND message_id=? AND relation='direct'", userId, String(row.id))
        .map(link => String(link.goal_id)),
    }))
  }
  prepare(userId: string): MemoryOperation | undefined {
    return this.atomic(() => {
      const pending = this.rows("SELECT * FROM memory_operation WHERE user_id=? AND status='pending' ORDER BY created_at,id LIMIT 1", userId)[0]
      if (pending) return this.operation(pending)
      const sources = this.sources(userId, undefined, true).slice(0, 20)
      if (sources.length === 0) return undefined
      const epoch = this.rows('SELECT value FROM meta WHERE key=?', `memory_epoch:${userId}`)[0]?.value ?? '0'
      const id = `mo_${hash(JSON.stringify([userId, epoch, sources.map(source => source.id)])).slice(0, 32)}`
      this.run('INSERT OR IGNORE INTO memory_operation(id,user_id,source_ids,created_at) VALUES(?,?,?,?)', id, userId,
        JSON.stringify(sources.map(source => source.id)), stamp())
      return this.operation(this.rows('SELECT * FROM memory_operation WHERE id=?', id)[0]!)
    })
  }
  private operation(row: Row): MemoryOperation {
    return { id: String(row.id), userId: String(row.user_id), sourceIds: list(row.source_ids),
      status: String(row.status) as MemoryOperation['status'], attempts: Number(row.attempts) }
  }
  startAttempt(operation: MemoryOperation): string {
    return this.atomic(() => {
      const id = `ma_${randomUUID()}`
      // A prior process can have died after SDK success; the next attempt stays attached to the same logical operation.
      this.run("UPDATE memory_attempt SET status=CASE WHEN status='sdk_done' THEN 'interrupted_after_sdk' ELSE 'interrupted' END,finished_at=? WHERE operation_id=? AND status IN ('running','sdk_done')", stamp(), operation.id)
      this.run("UPDATE memory_operation SET attempts=attempts+1 WHERE id=? AND user_id=?", operation.id, operation.userId)
      this.run("INSERT INTO memory_attempt(id,operation_id,status,started_at) VALUES(?,?,'running',?)", id, operation.id, stamp())
      return id
    })
  }
  failAttempt(attemptId: string): void {
    this.atomic(() => { this.run("UPDATE memory_attempt SET status='failed',finished_at=? WHERE id=?", stamp(), attemptId) })
  }
  recordSdkResult(attemptId: string, requestId: string | undefined, backendIds: string[]): void {
    this.atomic(() => { this.run("UPDATE memory_attempt SET status='sdk_done',request_id=?,backend_ids=? WHERE id=?",
      requestId ?? null, JSON.stringify(backendIds), attemptId) })
  }
  finish(operation: MemoryOperation, attemptId: string, requestId: string | undefined, backendIds: string[], apply: () => void): void {
    this.atomic(() => {
      apply()
      for (const id of operation.sourceIds) this.run('INSERT OR IGNORE INTO memory_processed(user_id,message_id,operation_id) VALUES(?,?,?)',
        operation.userId, id, operation.id)
      this.run("UPDATE memory_attempt SET status='done',request_id=?,backend_ids=?,finished_at=? WHERE id=?", requestId ?? null,
        JSON.stringify(backendIds), stamp(), attemptId)
      this.run("UPDATE memory_operation SET status='done',finished_at=? WHERE id=?", stamp(), operation.id)
      this.finishRebuild(operation.userId)
    })
  }
  suppressed(userId: string, candidate: MemoryCandidate, sourceSeq: number): boolean {
    if (candidate.sourceMessageIds.some(id => this.blocked(userId, id))) return true
    return this.rows('SELECT * FROM memory_suppression WHERE user_id=?', userId).some(row =>
      sourceSeq <= Number(row.through_seq) && (row.scope === '*' || row.scope === (candidate.goalId ?? '*'))
        && (row.content_hash === hash(candidate.quote) || row.topic === candidate.topic))
  }
  /** Called only after service validation, within finish's transaction. Stable evidence id makes retries idempotent. */
  save(userId: string, candidate: MemoryCandidate, sourceSeq: number, backendIds: string[], status: MemoryStatus): GovernedMemory {
    const id = `m_${hash(JSON.stringify([userId, candidate.goalId ?? '', candidate.topic, hash(candidate.quote), candidate.expiresAt ?? '', [...candidate.sourceMessageIds].sort()])).slice(0, 32)}`
    const exists = this.memories(userId).find(memory => memory.id === id || (memory.topic === candidate.topic
      && memory.goalId === candidate.goalId && memory.content === candidate.quote && memory.expiresAt === candidate.expiresAt && memory.status === status))
    if (exists) {
      // A rebuilt SDK projection may assign new node ids to identical governed evidence. No semantic/status change.
      this.run('UPDATE memory_detail SET backend_ids=?,source_ids=?,source_seq=MAX(source_seq,?) WHERE memory_id=?',
        JSON.stringify([...new Set([...exists.backendIds, ...backendIds])]),
        JSON.stringify([...new Set([...exists.sourceMessageIds, ...candidate.sourceMessageIds])]), sourceSeq, exists.id)
      return exists // Never reactivate a revoked/superseded revision on retry.
    }
    const now = stamp()
    this.run(`INSERT INTO memory(id,user_id,status,scope,evidence_message_id,expires_at,current_revision,created_at,updated_at)
      VALUES(?,?,?,?,?,?,1,?,?)`, id, userId, status, candidate.goalId ?? null, candidate.sourceMessageIds[0]!, candidate.expiresAt ?? null, now, now)
    this.run('INSERT INTO memory_revision(memory_id,revision,content,status,created_at) VALUES(?,1,?,?,?)', id, candidate.quote, status, now)
    this.run(`INSERT INTO memory_detail(memory_id,topic,goal_id,category,assertion,source_ids,source_seq,backend_ids,content_hash)
      VALUES(?,?,?,?,?,?,?,?,?)`, id, candidate.topic, candidate.goalId ?? null, candidate.category, candidate.assertion,
      JSON.stringify(candidate.sourceMessageIds), sourceSeq, JSON.stringify(backendIds), hash(candidate.quote))
    return this.memories(userId).find(memory => memory.id === id)!
  }
  setStatus(userId: string, id: string, status: MemoryStatus): void {
    const memory = this.memories(userId).find(memory => memory.id === id)
    if (!memory) throw new Error('memory resource not found')
    if (memory.status === status || memory.status === 'withdrawn') return
    const now = stamp()
    this.run('INSERT INTO memory_revision(memory_id,revision,content,status,created_at) VALUES(?,?,?,?,?)', id, memory.revision + 1, memory.content, status, now)
    this.run('UPDATE memory SET status=?,current_revision=current_revision+1,updated_at=? WHERE id=? AND user_id=?', status, now, id, userId)
  }
  /** Synchronous withdrawal; closure over shared evidence also covers derived/merged memories. */
  forget(userId: string, id: string): string[] {
    return this.atomic(() => {
      const memories = this.memories(userId)
      const root = memories.find(memory => memory.id === id)
      if (!root) throw new Error('memory resource not found')
      const affected = new Set([id]), blocked = new Set(root.sourceMessageIds)
      let grew = true
      while (grew) {
        grew = false
        for (const memory of memories) if (!affected.has(memory.id) && (memory.sourceMessageIds.some(source => blocked.has(source))
          || (memory.topic === root.topic && (root.goalId === undefined || memory.goalId === root.goalId)))) {
          affected.add(memory.id); memory.sourceMessageIds.forEach(source => blocked.add(source)); grew = true
        }
      }
      const throughSeq = Number(this.rows('SELECT IFNULL(MAX(seq),0) AS seq FROM message WHERE user_id=?', userId)[0]!.seq)
      for (const memory of memories.filter(item => affected.has(item.id))) {
        this.setStatus(userId, memory.id, 'withdrawn')
        this.run('INSERT OR IGNORE INTO memory_suppression(user_id,memory_id,topic,scope,through_seq,content_hash) VALUES(?,?,?,?,?,?)',
          userId, memory.id, memory.topic, memory.goalId ?? '*', throughSeq, hash(memory.content))
      }
      for (const source of blocked) this.run('INSERT OR IGNORE INTO memory_blocked_source(user_id,message_id) VALUES(?,?)', userId, source)
      this.run(`INSERT INTO memory_cleanup(user_id,generation,created_at) VALUES(?,1,?)
        ON CONFLICT(user_id) DO UPDATE SET generation=generation+1,created_at=excluded.created_at`, userId, stamp())
      return [...affected]
    })
  }
  cleanupGeneration(userId: string): number | undefined {
    const row = this.rows('SELECT generation FROM memory_cleanup WHERE user_id=?', userId)[0]
    return row ? Number(row.generation) : undefined
  }
  /** Deleting or rebuilding the SDK projection must not hide current SQLite facts. */
  projectionPending(userId: string): boolean {
    return this.cleanupGeneration(userId) !== undefined
      || this.rows('SELECT 1 FROM meta WHERE key=?', `memory_rebuild:${userId}`).length > 0
  }
  finishCleanup(userId: string, generation: number): void {
    this.atomic(() => {
      // Another forget may have happened while Python was deleting. Keep that generation pending.
      if (this.cleanupGeneration(userId) !== generation) return
      this.run("INSERT OR REPLACE INTO meta(key,value) VALUES(?, '1')", `memory_rebuild:${userId}`)
      this.run('DELETE FROM memory_cleanup WHERE user_id=? AND generation=?', userId, generation)
      // Governed SQLite facts remain available during rebuild; SDK content is never the authority.
      this.run('DELETE FROM memory_processed WHERE user_id=? AND message_id NOT IN (SELECT message_id FROM memory_blocked_source WHERE user_id=?)', userId, userId)
      this.run(`INSERT INTO meta(key,value) VALUES(?, '1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1`, `memory_epoch:${userId}`)
    })
  }
  /** Clear fallback only after the last rebuild operation commits, or no eligible sources remain. */
  finishRebuild(userId: string): void {
    this.atomic(() => {
      if (this.cleanupGeneration(userId) !== undefined
        || !this.rows('SELECT 1 FROM meta WHERE key=?', `memory_rebuild:${userId}`).length) return
      if (this.rows("SELECT 1 FROM memory_operation WHERE user_id=? AND status='pending' LIMIT 1", userId).length
        || this.sources(userId, undefined, true).length) return
      this.run('DELETE FROM meta WHERE key=?', `memory_rebuild:${userId}`)
    })
  }
  /** Diagnostic counts, no prompts or secrets. */
  attempts(userId: string): { id: string; status: string; operationId: string; requestId?: string }[] {
    return this.rows(`SELECT a.* FROM memory_attempt a JOIN memory_operation o ON o.id=a.operation_id WHERE o.user_id=? ORDER BY a.started_at`, userId)
      .map(row => ({ id: String(row.id), status: String(row.status), operationId: String(row.operation_id),
        requestId: row.request_id === null ? undefined : String(row.request_id) }))
  }
}
