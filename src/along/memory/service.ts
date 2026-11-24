/** Memory governance. SDK writes/recall are untrusted proposals; only SQLite facts leave this service. */
import type { AlongStore, MessageRow } from '../store.ts'
import { MemoryCandidateSchema, type GovernedMemory, type MemoryBackend, type MemoryCandidate, type MemorySource } from './model.ts'

/** Governs SDK proposals and serves only current, owned, applicable SQLite memories to planning callers. */
export class MemoryService {
  private busy: Promise<unknown> | undefined
  private closed = false
  constructor(private readonly store: AlongStore, private readonly backend: MemoryBackend) {}

  /** One batch per call. The stage-E scheduler repeats while processed>0, without overlapping work. */
  runBatch(userId: string, throughSeq?: number): Promise<{ processed: number; saved: number; status: 'idle' | 'done' | 'pending' }> {
    if (this.closed) return Promise.reject(new Error('memory service closed'))
    // Calls from separate schedulers share the same in-flight operation, never cross users.
    if (this.busy) return Promise.reject(new Error('memory batch already running'))
    const work = this.process(userId, throughSeq)
    this.busy = work
    return work.finally(() => { this.busy = undefined })
  }
  private async process(userId: string, throughSeq?: number): Promise<{ processed: number; saved: number; status: 'idle' | 'done' | 'pending' }> {
    const memory = this.store.memory
    const generation = memory.cleanupGeneration(userId)
    if (generation !== undefined) {
      try { await this.backend.clearUser(userId) }
      catch { return { processed: 0, saved: 0, status: 'pending' } }
      if (this.closed) return { processed: 0, saved: 0, status: 'pending' }
      memory.finishCleanup(userId, generation)
      if (memory.cleanupGeneration(userId) !== undefined) return { processed: 0, saved: 0, status: 'pending' }
    }
    const operation = memory.prepare(userId, throughSeq)
    if (!operation) {
      memory.finishRebuild(userId)
      return { processed: 0, saved: 0, status: 'idle' }
    }
    const attemptId = memory.startAttempt(operation)
    try {
      const sources = memory.sources(userId, operation.sourceIds)
      // All sources can have been withdrawn since this operation was queued. Do not send old text to Python.
      const result = sources.length === 0 ? { candidates: [], backendIds: [] } : await this.backend.extract({
        userId, operationId: operation.id, attemptId, sources, existing: memory.memories(userId).filter(item => item.status !== 'withdrawn'),
      })
      if (this.closed) return { processed: 0, saved: 0, status: 'pending' }
      if (!Array.isArray(result.candidates) || result.candidates.length > 100 || !Array.isArray(result.backendIds)
        || result.backendIds.some(id => typeof id !== 'string')) throw new Error('invalid memory response')
      // Validate the entire proposal before committing anything; malformed output must stay retryable.
      const candidates = result.candidates.map(candidate => MemoryCandidateSchema.parse(candidate))
      memory.recordSdkResult(attemptId, result.requestId, result.backendIds)
      let saved = 0
      memory.finish(operation, attemptId, result.requestId, result.backendIds, () => {
        // Re-read evidence after awaiting Python. A concurrent forget takes priority over extraction.
        const currentSources = memory.sources(userId, operation.sourceIds)
        for (const candidate of candidates.sort((a, b) => Math.max(...a.sourceMessageIds.map(id => currentSources.find(source => source.id === id)?.seq ?? 0))
          - Math.max(...b.sourceMessageIds.map(id => currentSources.find(source => source.id === id)?.seq ?? 0)))) {
          if (this.apply(userId, candidate, currentSources, result.backendIds)) saved++
        }
      })
      return { processed: operation.sourceIds.length, saved, status: 'done' }
    } catch {
      if (!this.closed) memory.failAttempt(attemptId)
      return { processed: 0, saved: 0, status: 'pending' }
    }
  }

  private apply(userId: string, candidate: MemoryCandidate, sources: MemorySource[], backendIds: string[]): boolean {
    const memory = this.store.memory
    if (!['preference', 'fact'].includes(candidate.category)) return false
    const evidence = candidate.sourceMessageIds.map(id => sources.find(source => source.id === id))
    if (evidence.some(source => source === undefined)) return false
    const verified = evidence as MemorySource[]
    // Return the user's actual words as content: an LLM cannot smuggle invented facts into an otherwise valid quote.
    if (!verified.some(source => source.text.includes(candidate.quote))) return false
    if (candidate.goalId !== undefined && !verified.every(source => source.goalIds.includes(candidate.goalId!))) return false
    if (candidate.backendIds.some(id => !backendIds.includes(id))) throw new Error('unknown SDK reference')
    const sourceSeq = Math.max(...verified.map(source => source.seq))
    if (memory.suppressed(userId, candidate, sourceSeq)) return false
    const previous = memory.memories(userId)
    const related = previous.filter(item => item.topic === candidate.topic && item.goalId === candidate.goalId
      && (item.status === 'active' || item.status === 'conflict'))
    const now = Date.now()
    // Expired history remains a valid relationship target, but cannot create a current conflict.
    const current = related.filter(item => item.expiresAt === undefined || Date.parse(item.expiresAt) > now)
    // Rebuilding the projection or replaying a backlog cannot undo a newer governed user statement.
    if (related.some(item => item.sourceSeq > sourceSeq)) return false
    const relationshipIds = [...candidate.replaces, ...candidate.conflictsWith]
    const targets = relationshipIds.map(id => related.find(item => item.id === id))
    // Never let generated ids supersede another user's fact, another scope or a newer input.
    if (targets.some(item => item === undefined || item.sourceSeq >= sourceSeq)) return false
    if (candidate.replaces.some(id => candidate.conflictsWith.includes(id))) return false
    const same = current.find(item => item.content === candidate.quote)
    let status: GovernedMemory['status'] = candidate.assertion === 'explicit' ? 'active' : 'candidate'
    if (candidate.expiresAt && Date.parse(candidate.expiresAt) <= now) status = 'candidate'
    if (status === 'active') {
      const unresolved = current.filter(item => item.id !== same?.id && !candidate.replaces.includes(item.id))
      if (current.some(item => candidate.conflictsWith.includes(item.id)) || unresolved.length) {
        status = 'conflict'
        for (const item of current) memory.setStatus(userId, item.id, 'conflict')
      } else {
        for (const id of candidate.replaces) memory.setStatus(userId, id, 'superseded')
      }
    } else if (relationshipIds.length) return false // inference cannot invalidate an explicit preference
    memory.save(userId, candidate, sourceSeq, candidate.backendIds, status)
    return true
  }

  /** Missing recall never widens a scope; an outage returns explicitly marked SQLite fallback. */
  async search(scope: { userId: string; goalId?: string }, query: string, limit = 10): Promise<{
    memories: GovernedMemory[]; history: GovernedMemory[]; degraded: boolean; needsClarification: boolean
  }> {
    if (this.closed) throw new Error('memory service closed')
    if (typeof query !== 'string' || !query.trim() || query.length > 2000) throw new Error('invalid memory query')
    const size = Math.max(1, Math.min(50, Math.floor(limit)))
    if (!Number.isFinite(size)) throw new Error('invalid memory limit')
    const initial = this.store.memory.effective(scope.userId, scope.goalId) // validate ownership before calling a remote model
    // A cold handoff carries governed facts, never the Mac SDK's private index IDs. Keep these facts available while unindexed.
    let ids: string[] = [], degraded = this.store.memory.projectionPending(scope.userId) || initial.some(item => item.backendIds.length === 0)
    if (!degraded) try { ids = await this.backend.search({ userId: scope.userId, query, limit: size }) }
    catch { degraded = true }
    if (this.closed) throw new Error('memory service closed')
    degraded ||= this.store.memory.projectionPending(scope.userId)
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) degraded = true
    const effective = this.store.memory.effective(scope.userId, scope.goalId)
    degraded ||= effective.some(item => item.backendIds.length === 0)
    const ranked = degraded ? effective : effective.filter(item => item.backendIds.some(id => ids.includes(id)))
      .sort((a, b) => Math.min(...a.backendIds.filter(id => ids.includes(id)).map(id => ids.indexOf(id)))
        - Math.min(...b.backendIds.filter(id => ids.includes(id)).map(id => ids.indexOf(id))))
    const now = Date.now()
    const needsClarification = this.store.memory.memories(scope.userId).some(item => item.status === 'conflict'
      && (item.goalId === undefined || item.goalId === scope.goalId)
      && (item.expiresAt === undefined || Date.parse(item.expiresAt) > now))
    return { memories: ranked.slice(0, size), history: this.history(scope).slice(0, size), degraded, needsClarification }
  }
  /** Non-current evidence remains intelligible to the planner, with its status and source order intact. */
  private history(scope: { userId: string; goalId?: string }): GovernedMemory[] {
    return this.store.memory.memories(scope.userId).filter(item => item.status !== 'active'
      && (item.goalId === undefined || item.goalId === scope.goalId))
      .sort((a, b) => b.sourceSeq - a.sourceSeq || b.revision - a.revision)
  }
  /** Synchronous and local. Chat history and goals/tasks are deliberately untouched (D13/D16). */
  forget(scope: { userId: string; goalId?: string }, memoryId: string): { withdrawnIds: string[] } {
    if (this.closed) throw new Error('memory service closed')
    if (scope.goalId !== undefined) this.store.memory.assertGoal(scope.userId, scope.goalId)
    const item = this.store.memory.memories(scope.userId).find(memory => memory.id === memoryId)
    if (!item || (item.goalId !== undefined && item.goalId !== scope.goalId)) throw new Error('memory resource not found')
    return { withdrawnIds: this.store.memory.forget(scope.userId, memoryId) }
  }
  /** Host context builder: current facts and labelled history stay distinct; unrelated old conversation remains readable. */
  context<T extends Pick<MessageRow, 'id' | 'userId' | 'text'>>(scope: { userId: string; goalId?: string }, messages: T[]): {
    messages: T[]; memories: GovernedMemory[]; history: GovernedMemory[]
  } {
    return { messages: messages.filter(message => message.userId === scope.userId && this.store.memory.contextAllowed(scope.userId, message.id, message.text)),
      memories: this.store.memory.effective(scope.userId, scope.goalId), history: this.history(scope).slice(0, 20) }
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.backend.close()
    await this.busy?.catch(() => {})
  }
}
