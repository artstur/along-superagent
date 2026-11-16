/** Durable due work enters the normal DSH Engine; Workers invoke host-owned memory governance. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { canRetry, latestAssignment, liveTicket, type Candidate, type Engine, type Policy, type Ticket, type Trigger } from '../core/index.ts'
import type { Settings } from '../policy.ts'
import type { Store } from '../app/store.ts'
import type { AlongStore } from './store.ts'
import type { MemoryService } from './memory/service.ts'
import type { MaintenanceBatch } from './maintenance-store.ts'
import { alongTool } from './tool.ts'
import { KV } from '../kv.ts'

export const MAINTENANCE_SOURCE = 'along-maintenance'
const RETRY_MS = 60_000, PAGES_PER_CALL = 5
/** Next local configured time, computed as calendar time so DST and wake-up do not replay missed days. */
export function nextMaintenanceAt(now: Date, time = '03:00'): string {
  const [hour, minute] = time.split(':').map(Number)
  const next = new Date(now)
  next.setHours(hour!, minute!, 0, 0)
  if (next <= now) { next.setDate(next.getDate() + 1); next.setHours(hour!, minute!, 0, 0) }
  return next.toISOString()
}
export interface MaintenanceHost {
  store: AlongStore
  memory: MemoryService
  repo: Pick<Store, 'tickets' | 'triggers' | 'threads' | 'get'>
  engine(): Pick<Engine, 'receive' | 'decide' | 'retryTicket' | 'reevaluate'>
  settings(): Settings
  available(): boolean
  paused(): boolean
  closing(): boolean
  now?: () => Date
  time?: () => string
}
/** One scheduler and execution capability per local Runtime, with durable recovery across both SQLite stores. */
export class AlongMaintenance {
  private active?: Promise<unknown>
  private recovered = false
  constructor(private readonly host: MaintenanceHost) {}
  private now(): Date { return this.host.now?.() ?? new Date() }
  private next(now = this.now()): string { return nextMaintenanceAt(now, this.host.time?.() ?? '03:00') }
  private allowed(settings: Settings, userId: string): boolean {
    return this.host.available() && settings.sources.along?.enabled === true && settings.sources.github?.enabled === false
      && (settings.policy.sources.along?.allowed ?? []).some(user => user.id === userId)
  }
  private trigger(batch: MaintenanceBatch): Trigger {
    return { id: `${MAINTENANCE_SOURCE}:${batch.id}`, source: MAINTENANCE_SOURCE,
      threads: [{ source: MAINTENANCE_SOURCE, id: batch.id }], actor: { source: MAINTENANCE_SOURCE, id: batch.userId },
      human: false, at: batch.createdAt, text: 'Run the host-bound memory maintenance batch using along_maintenance_run. Continue while status is pending and retry_at is absent. If retry_at is present, report failed and end the turn; the scheduler retries after backoff. Report ready only after status is done. Do not modify goals, tasks, files or chat.',
      meta: { batch_id: batch.id, user_id: batch.userId, kind: 'memory' } }
  }
  private bound(trigger: Trigger): MaintenanceBatch | undefined {
    if (trigger.source !== MAINTENANCE_SOURCE || typeof trigger.meta.batch_id !== 'string') return undefined
    const batch = this.host.store.maintenance.get(trigger.meta.batch_id)
    return batch && isDeepStrictEqual(trigger, this.trigger(batch)) ? batch : undefined
  }
  private ticket(batch: MaintenanceBatch): Ticket | undefined {
    return this.host.repo.tickets.list().find(ticket => ticket.origin.triggerId === this.trigger(batch).id)
  }
  /** Adds only the host's persisted scheduled capability; all other policy behavior stays with the base. */
  policy(base: Policy, settings: Settings): Policy {
    return { ...base,
      gate: (trigger, thread, tickets) => {
        if (trigger.source !== MAINTENANCE_SOURCE) return base.gate(trigger, thread, tickets)
        const batch = this.bound(trigger)
        return batch?.status === 'pending' && this.allowed(settings, batch.userId)
          ? { admissible: true, strength: 'explicit', basis: { via: 'scheduled', source: MAINTENANCE_SOURCE,
            scope: { batch_id: batch.id }, scheduleId: batch.id } }
          : { admissible: false, reason: 'untrusted_scheduled_work' }
      },
      revalidate: mandate => {
        if (mandate.basis.via !== 'scheduled') return base.revalidate(mandate)
        const batch = this.host.store.maintenance.get(mandate.basis.scheduleId)
        return !!batch && batch.status !== 'stopped' && this.allowed(settings, batch.userId)
          && mandate.actor.source === MAINTENANCE_SOURCE && mandate.actor.id === batch.userId
      },
    }
  }
  /** Handles a fixed maintenance candidate without an extra model/router decision. */
  assess(candidate: Candidate): boolean {
    if (candidate.triggers.length !== 1) return false
    const trigger = candidate.triggers[0]!, batch = this.bound(trigger)
    if (!batch || batch.status !== 'pending') return false
    this.host.engine().decide(trigger.id, { evalId: candidate.evalId, kind: 'accept', title: '记忆批量维护',
      scope: 'Process only the host-bound memory batch through along_maintenance_run; no goal, task, file or conversation changes.',
      name: 'memory-maintenance', reason: 'Persisted scheduled memory maintenance', note: trigger.text })
    return true
  }
  /** Called by the Runtime's existing pass timer, and on startup/settings changes. */
  tick(): void {
    if (this.host.closing()) return
    if (!this.recovered) {
      // The DSH end may have committed just before a crash prevented its afterCommit business record.
      for (const ticket of this.host.repo.tickets.list()) if (this.forTicket(ticket.id)) {
        for (const assignment of ticket.assignments) this.record(ticket.id, assignment.id)
      }
      this.recovered = true
    }
    if (this.host.paused() || !this.host.available()) return
    const { store, repo } = this.host, now = this.now(), stamp = now.toISOString()
    for (const userId of store.maintenance.users()) {
      if (!this.allowed(this.host.settings(), userId)) continue
      let batch = store.maintenance.outstanding(userId)
      if (!batch) {
        const due = store.maintenance.nextDue(userId, this.next(now), { time: this.host.time?.() ?? '03:00', now: stamp })
        if (due > stamp) continue
        if (!store.memory.hasWork(userId)) { store.maintenance.advance(userId, this.next(now)); continue }
        batch = store.maintenance.create(userId, due, stamp)
      }
      const ticket = this.ticket(batch)
      if (ticket?.ended?.by === 'human') { this.stopBatch(batch.id, batch.userId); continue }
      if (batch.retryAt > stamp) continue
      if (ticket) {
        if (liveTicket(ticket) && canRetry(ticket)) this.host.engine().retryTicket(ticket.id)
        continue
      }
      const trigger = this.trigger(batch)
      // The persisted batch remains the outbox until a Ticket exists; a crash after receive is safe to replay.
      const saved = repo.triggers.get(trigger.id)
      if (saved && !isDeepStrictEqual(saved, trigger)) throw new Error('maintenance trigger mismatch')
      this.host.engine().receive(trigger)
      if (saved) {
        const thread = repo.threads.get(`${MAINTENANCE_SOURCE}:${batch.id}`)
        if (!thread?.pending.includes(trigger.id) && !thread?.evaluating) this.host.engine().reevaluate(trigger.id)
      }
    }
  }
  /** Resolves the capability from the actual Ticket origin, never from model-provided IDs. */
  forTicket(ticketId: string): MaintenanceBatch | undefined {
    const ticket = this.host.repo.tickets.get(ticketId)
    const trigger = ticket && this.host.repo.triggers.get(ticket.origin.triggerId)
    const batch = trigger && this.bound(trigger)
    return ticket?.mandate.basis.via === 'scheduled' && batch && ticket.mandate.basis.scheduleId === batch.id
      && ticket.mandate.actor.source === MAINTENANCE_SOURCE && ticket.mandate.actor.id === batch.userId ? batch : undefined
  }
  tools(ticketId: string) {
    return [alongTool({ name: 'along_maintenance_run',
      description: 'Execute up to five host-bound memory pages. No user, batch or filesystem parameters. Repeat pending without retry_at; when retry_at is returned report failed and end the turn. Report ready only after done. Governance and persistence determine completion.',
      schema: z.object({}).strict(), execute: async (_args, signal) => this.run(ticketId, signal) })]
  }
  private async run(ticketId: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const batch = this.forTicket(ticketId), ticket = this.host.repo.tickets.get(ticketId)
    if (!batch || !ticket || !liveTicket(ticket) || batch.status === 'stopped'
      || !this.allowed(this.host.settings(), batch.userId) || this.host.paused() || this.host.closing()) throw new Error('maintenance capability unavailable')
    if (batch.status === 'done') return { status: 'done', processed: batch.processed, saved: batch.saved }
    if (batch.retryAt > this.now().toISOString()) return { status: 'pending', retry_at: batch.retryAt }
    if (this.active) return this.defer(batch.id)
    const work = this.process(batch, ticketId, signal)
    this.active = work
    try { return await work } finally { this.active = undefined }
  }
  private async process(batch: MaintenanceBatch, ticketId: string, signal: AbortSignal) {
    const { store, memory } = this.host
    store.maintenance.attempt(batch.id)
    try {
      for (let page = 0; page < PAGES_PER_CALL; page++) {
        signal.throwIfAborted()
        if (this.host.paused() || this.host.closing() || !liveTicket(this.host.repo.tickets.get(ticketId)!)
          || !this.allowed(this.host.settings(), batch.userId)) throw new Error('maintenance interrupted')
        const result = await memory.runBatch(batch.userId, batch.throughSeq)
        store.maintenance.checkpoint(batch.id, result.processed, result.saved)
        const current = this.host.repo.tickets.get(ticketId)
        if (current?.ended?.by === 'human') {
          this.stopBatch(batch.id, batch.userId)
          return { status: 'stopped' }
        }
        signal.throwIfAborted()
        if (this.host.paused() || this.host.closing() || !this.allowed(this.host.settings(), batch.userId)) return this.defer(batch.id)
        if (result.status === 'pending') return this.defer(batch.id)
        if (!store.memory.hasWork(batch.userId, batch.throughSeq)) {
          store.atomic(() => {
            store.maintenance.finish(batch.id, this.now().toISOString())
            store.maintenance.advance(batch.userId, this.next(), this.now().toISOString())
          })
          return { status: 'done', processed: store.maintenance.get(batch.id)!.processed, saved: store.maintenance.get(batch.id)!.saved }
        }
      }
      return { status: 'pending' }
    } catch { return this.defer(batch.id) }
  }
  private defer(id: string) {
    const retryAt = new Date(this.now().getTime() + RETRY_MS).toISOString()
    this.host.store.maintenance.defer(id, retryAt)
    return { status: 'pending', retry_at: retryAt }
  }
  private stopBatch(id: string, userId: string): void {
    this.host.store.atomic(() => {
      this.host.store.maintenance.finish(id, this.now().toISOString(), true)
      this.host.store.maintenance.advance(userId, this.next())
    })
  }
  /** A model's report cannot replace the durable completion checkpoint. */
  assertReport(ticketId: string, state: string): void {
    const batch = this.forTicket(ticketId)
    if (batch && ['ready', 'dropped'].includes(state) && batch.status !== 'done') throw new Error('maintenance batch is not complete; call along_maintenance_run first')
  }
  /** Retain execution evidence without producing chat messages or phone sync. */
  record(ticketId: string, assignmentId?: string): void {
    const batch = this.forTicket(ticketId), ticket = this.host.repo.tickets.get(ticketId)
    if (!batch || !ticket) return
    const assignment = assignmentId ? ticket.assignments.find(item => item.id === assignmentId) : latestAssignment(ticket)
    if (!assignment || assignment.state === 'pending') return
    this.host.store.recordRunRecord({ ticketId, assignmentId: assignment.id, userId: batch.userId,
      promptRevisions: this.host.repo.get(KV.sessions.prompts(`worker-${ticketId}`)),
      toolTraceRef: `worker-${ticketId}:${assignment.id}`, reportState: assignment.report?.state, reportSummary: assignment.report?.summary,
      endedAt: assignment.endedAt ?? ticket.ended?.at })
  }
  async idle(): Promise<void> { await this.active }
}
