/** Stage C: facts are durable before this module creates narrowly bound automatic follow-up work. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { Candidate, Policy } from '../core/index.ts'
import type { Engine } from '../core/engine.ts'
import { canRetry, latestAssignment } from '../core/index.ts'
import type { Trigger } from '../core/model.ts'
import type { Settings } from '../policy.ts'
import type { Store } from '../app/store.ts'
import type { AlongStore, HealthSummaryRow } from './store.ts'
import type { HealthDispatch } from './health-store.ts'
import { HEALTH_SUMMARY_TYPES } from './envelope.ts'
import { alongTool } from './tool.ts'

const thresholds: Record<string, number> = {
  steps: 500,
  workout: 5,
  active_energy: 50,
  weight: 0.1,
  resting_heart_rate: 3,
  wrist_temperature: 0.1,
  sleep: 15
}
/** Freshness describes applicability, never fabricates a zero from missing/offline data. */
export function healthSummaryIsCurrent(s: HealthSummaryRow, now = Date.now()): boolean {
  if (s.summarizerVersion !== 'along-health-v1') return true
  const end = Date.parse(s.windowEnd ?? '')
  if (['steps', 'workout', 'active_energy'].includes(s.type)) return end > now
  if (s.type === 'sleep') return end > now - 36 * 60 * 60_000
  if (s.type === 'resting_heart_rate') return s.availability !== 'ok' || end > now - 7 * 86400_000
  if (s.type === 'wrist_temperature') return s.availability !== 'ok' || end > now - 30 * 86400_000
  return true
}
const comparable = (s: HealthSummaryRow) => [
  s.type,
  s.windowStart,
  s.windowEnd,
  s.timezone,
  s.unit,
  s.statistic,
  s.summarizerVersion
]
export function significantHealthChange(current: HealthSummaryRow, previous?: HealthSummaryRow): boolean {
  if (
    !previous ||
    !isDeepStrictEqual(comparable(current), comparable(previous)) ||
    current.availability !== previous.availability
  )
    return true
  if (current.availability !== 'ok') return false
  return (
    typeof current.value === 'number' &&
    typeof previous.value === 'number' &&
    Math.abs(current.value - previous.value) + 1e-9 >= (thresholds[current.type] ?? 0)
  )
}
/** Typed goal crossings bypass noise thresholds; never infer numeric targets from prose. */
export function healthTargetCrossed(
  current: HealthSummaryRow,
  previous: HealthSummaryRow | undefined,
  metric: unknown
): boolean {
  if (
    !previous ||
    current.availability !== 'ok' ||
    previous.availability !== 'ok' ||
    typeof current.value !== 'number' ||
    typeof previous.value !== 'number' ||
    !metric ||
    typeof metric !== 'object'
  )
    return false
  const target = metric as { type?: string; target?: unknown; unit?: string; period?: string }
  const units: Record<string, string> = { 分钟: 'min', 步: 'count', 千卡: 'kcal' }
  const periods: Record<string, string> = { steps: 'day', workout: 'week', active_energy: 'day', sleep: 'day' }
  const value = typeof target.target === 'number' ? target.target : NaN
  return (
    target.type === current.type &&
    (units[target.unit ?? ''] ?? target.unit) === current.unit &&
    periods[current.type] !== undefined &&
    target.period === periods[current.type] &&
    Number.isFinite(value) &&
    current.value !== previous.value &&
    (current.value - value) * (previous.value - value) <= 0
  )
}
interface HealthHost {
  store: AlongStore
  repo: Pick<Store, 'tickets' | 'triggers' | 'threads'>
  engine(): Pick<Engine, 'receive' | 'decide' | 'reevaluate' | 'retryTicket' | 'report'>
  settings(): Settings
  paused(): boolean
  closing(): boolean
}
/** Owns health change admission, per-goal serialization and host-bound completion evidence. */
export class HealthFollowup {
  constructor(private readonly host: HealthHost) {}
  private allowed(userId: string, settings = this.host.settings()): boolean {
    return (
      settings.eval.mode === 'auto' &&
      settings.sources.along?.enabled === true &&
      settings.sources.github?.enabled === false &&
      (settings.policy.sources.along?.allowed ?? []).some((user) => user.id === userId)
    )
  }
  private trigger(d: HealthDispatch): Trigger {
    return {
      id: `along:${d.userId}:${d.eventId}`,
      source: 'along',
      actor: { source: 'along', id: d.userId },
      human: false,
      at: d.createdAt,
      threads: [{ source: 'along', id: `goal/${d.goalId}/health/${d.eventId}` }],
      text: 'Health summaries changed. Read the bound goal, conversation, tasks, memory and along_health_read. Decide relevance semantically. Keep the user goal unchanged; adjust tasks only when justified. Call along_health_followup with watched types and a reason before reporting ready. Ordinary keep needs no chat or notification.',
      meta: { event_type: 'along.health_summary_updated', goal_id: d.goalId, health_dispatch: d.eventId }
    }
  }
  private bound(t: Trigger): HealthDispatch | undefined {
    const d =
      typeof t.meta.health_dispatch === 'string' ? this.host.store.health.get(t.meta.health_dispatch) : undefined
    return d && isDeepStrictEqual(t, this.trigger(d)) ? d : undefined
  }
  policy(base: Policy, settings: Settings): Policy {
    return {
      ...base,
      gate: (t, thread, tickets) => {
        if (t.meta.event_type !== 'along.health_summary_updated' || t.meta.health_dispatch === undefined)
          return base.gate(t, thread, tickets)
        const d = this.bound(t),
          g = d && this.host.store.getGoal(d.userId, d.goalId)
        return d && !d.result && g?.status === 'active' && this.allowed(d.userId, settings)
          ? {
              admissible: true,
              strength: 'explicit',
              basis: { via: 'health', source: 'along', scope: t.meta, eventId: d.eventId, goalId: d.goalId }
            }
          : { admissible: false, reason: 'untrusted_health_followup' }
      },
      revalidate: (m) => {
        if (m.basis.via !== 'health') return base.revalidate(m)
        const d = this.host.store.health.get(m.basis.eventId)
        return (
          !!d &&
          d.goalId === m.basis.goalId &&
          m.actor.source === 'along' &&
          m.actor.id === d.userId &&
          this.allowed(d.userId, settings) &&
          this.host.store.getGoal(d.userId, d.goalId)?.status === 'active'
        )
      }
    }
  }
  assess(candidate: Candidate): boolean {
    if (candidate.triggers.length !== 1) return false
    const t = candidate.triggers[0]!,
      d = this.bound(t)
    if (!d || d.result) return false
    this.host.engine().decide(t.id, {
      evalId: candidate.evalId,
      kind: 'accept',
      title: '健康变化跟进',
      name: 'health-followup',
      scope:
        'Evaluate the bound existing goal against current aggregate health data; update user tasks through validated Along tools or keep. Never create, rewrite or archive the goal.',
      reason: 'Host-verified health change for an allowed paired user',
      note: t.text
    })
    return true
  }
  forTicket(ticketId: string): HealthDispatch | undefined {
    const ticket = this.host.repo.tickets.get(ticketId),
      t = ticket && this.host.repo.triggers.get(ticket.origin.triggerId)
    return ticket?.mandate.basis.via === 'health' && t ? this.bound(t) : undefined
  }
  tick(): void {
    if (this.host.closing() || this.host.paused()) return
    const { store, repo } = this.host
    // A crash after business completion but before the Worker's final report must not hold this goal forever.
    for (const ticket of repo.tickets.list()) {
      if (ticket.ended) continue
      const completed = this.forTicket(ticket.id),
        last = latestAssignment(ticket)
      if (
        completed?.result &&
        this.allowed(completed.userId) &&
        last?.report &&
        ['waiting', 'failed', 'blocked'].includes(last.report.state) &&
        !(last.deliveredAt && last.deliveredAt > last.report.at) &&
        Date.now() - Date.parse(last.report.at) > 60_000
      ) {
        this.host.engine().report(ticket.id, { state: 'ready', summary: completed.result.reason, question: null })
      }
    }
    // The immutable row is an outbox across the Along/DSH database boundary.
    for (const d of store.health.pending()) {
      if (!this.allowed(d.userId)) continue
      const ticket = repo.tickets.list().find((t) => t.origin.triggerId === this.trigger(d).id)
      if (ticket) {
        const last = latestAssignment(ticket)
        const retryFrom = ticket.delivery?.at ?? last?.report?.at ?? last?.endedAt
        if (
          !ticket.ended &&
          d.inputVersion === store.inputVersion(d.goalId) &&
          retryFrom &&
          Date.now() - Date.parse(retryFrom) > 60_000
        ) {
          if (canRetry(ticket)) this.host.engine().retryTicket(ticket.id)
          else if (last?.report?.state === 'waiting' && !(last.deliveredAt && last.deliveredAt > last.report.at)) {
            this.host.engine().report(ticket.id, {
              state: 'failed',
              summary: 'The health worker became idle without a durable follow-up result; retry after backoff.'
            })
          }
        }
        continue
      } // Never reopen an ended/stopped ticket; a subsequent changed input gets a new dispatch.
      if (store.getGoal(d.userId, d.goalId)?.status !== 'active') continue
      const t = this.trigger(d),
        saved = repo.triggers.get(t.id)
      this.host.engine().receive(t)
      if (saved) {
        const thread = repo.threads.get(`along:${t.threads[0]!.id}`)
        if (!thread?.evaluating && !thread?.pending.includes(t.id)) this.host.engine().reevaluate(t.id)
      }
    }
    for (const userId of store.health.users()) {
      if (!this.allowed(userId)) continue
      const summaries = store
        .latestHealthSummaries(userId)
        .filter((s) => s.adapter === 'known' && s.summarizerVersion === 'along-health-v1' && healthSummaryIsCurrent(s))
      if (!summaries.length) continue
      // Pagination is intentional: no implicit first-200-goals limit.
      let cursor: string | undefined
      do {
        const page = store.listGoals(userId, { limit: 200, cursor })
        cursor = page.nextCursor
        for (const goal of page.items) {
          if (goal.domain === 'finance' || goal.status !== 'active') continue
          const version = store.inputVersion(goal.id)
          if (
            store.workLinksForGoal(goal.id).some((w) => {
              const ticket = repo.tickets.get(w.ticketId)
              if (!ticket || ticket.ended) return false
              const health = this.forTicket(ticket.id)
              if (health) return health.inputVersion === version
              const assignment = latestAssignment(ticket),
                report = assignment?.report
              // A settled question or failed work must not require a chat before fresh health data can be evaluated.
              return (
                !report ||
                !['waiting', 'blocked', 'failed'].includes(report.state) ||
                !!(assignment?.deliveredAt && assignment.deliveredAt > report.at)
              )
            })
          )
            continue
          const unresolved = store.health
            .pending()
            .find(
              (d) =>
                d.goalId === goal.id &&
                d.inputVersion === version &&
                !repo.tickets.list().some((t) => t.origin.triggerId === this.trigger(d).id && t.ended)
            )
          if (unresolved) continue
          const state = store.health.state(goal.id)
          const metric = store.currentGoalRevision(goal.id)?.metric
          const watched: readonly string[] = state?.inputVersion === version ? state.types : HEALTH_SUMMARY_TYPES
          if (
            state?.inputVersion === version &&
            !summaries.some((s) => !state.seenTypes.includes(s.type)) &&
            !summaries.some(
              (s) =>
                watched.includes(s.type) &&
                (significantHealthChange(
                  s,
                  state.baseline.find((b) => b.type === s.type)
                ) ||
                  healthTargetCrossed(
                    s,
                    state.baseline.find((b) => b.type === s.type),
                    metric
                  ))
            )
          )
            continue
          // All current values travel in one bounded snapshot; later arrivals wait for the next work.
          const d = store.health.dispatch(userId, goal.id, version, summaries)
          const t = this.trigger(d)
          if (!d.result && !repo.triggers.get(t.id)) this.host.engine().receive(t)
        }
      } while (cursor)
    }
  }
  assertActive(ticketId: string): void {
    const d = this.forTicket(ticketId)
    if (!d) return
    const ticket = this.host.repo.tickets.get(ticketId)
    if (
      !ticket ||
      ticket.ended ||
      !this.allowed(d.userId) ||
      this.host.paused() ||
      this.host.closing() ||
      this.host.store.getGoal(d.userId, d.goalId)?.status !== 'active'
    )
      throw new Error('health capability unavailable')
  }
  read(ticketId: string, summaries: HealthSummaryRow[]): void {
    const d = this.forTicket(ticketId)
    if (d && !d.result) this.host.store.health.read(d.eventId, summaries)
  }
  assertReport(ticketId: string, state: string): void {
    const d = this.forTicket(ticketId)
    if (
      d &&
      ['ready', 'dropped'].includes(state) &&
      !d.result &&
      !(state === 'dropped' && d.inputVersion !== this.host.store.inputVersion(d.goalId))
    )
      throw new Error('health follow-up not complete; read health and call along_health_followup first')
  }
  tools(ticketId: string) {
    return [
      alongTool({
        name: 'along_health_followup',
        description:
          'Finish the bound automatic health evaluation. types lists health types actually relevant to this goal (empty for unrelated). keep changes nothing; update requires an applied task ChangeSet; ask requires one essential user-facing question. Read along_health_read first. Ordinary keep is silent. Identity, goal and evaluated snapshot are host-bound.',
        schema: z
          .object({
            outcome: z.enum(['keep', 'update', 'ask']),
            types: z.array(z.enum(HEALTH_SUMMARY_TYPES)).max(7),
            reason: z.string().trim().min(1).max(800),
            text: z.string().trim().min(1).max(1200).optional()
          })
          .strict(),
        execute: async (args) =>
          this.host.store.atomic(() => {
            const d = this.forTicket(ticketId),
              ticket = this.host.repo.tickets.get(ticketId),
              store = this.host.store
            if (!d || !ticket || ticket.ended || this.host.paused() || this.host.closing() || !this.allowed(d.userId))
              throw new Error('health capability unavailable')
            if (d.result) {
              if (!isDeepStrictEqual(d.result, args)) throw new Error('follow-up already finished differently')
              return { status: 'recorded', reused: true }
            }
            if (!d.readSnapshot) throw new Error('read along_health_read before finishing')
            if (store.inputVersion(d.goalId) !== d.inputVersion)
              return { status: 'conflicted', reason: 'conflicted_input' }
            const link = store.getWorkLink(ticketId),
              applied = link && store.changeSetsByWork(link.workId).some((c) => c.status === 'applied')
            if ((args.outcome === 'update') !== !!applied) throw new Error('outcome must match applied changes')
            if (args.outcome === 'ask' && !args.text) throw new Error('ask requires a concrete question')
            store.health.finish(d, args)
            if (args.outcome !== 'keep' && args.text) {
              const eventId = `followup_${d.eventId}`,
                message = store.appendMessage({
                  userId: d.userId,
                  eventId,
                  role: 'assistant',
                  direction: 'outbound',
                  text: args.text
                })
              store.linkMessageToGoals(message.id, [d.goalId], 'derived')
              store.appendSync({
                userId: d.userId,
                kind: 'message',
                goalId: d.goalId,
                messageId: message.id,
                payload: { message_id: message.id, text: args.text }
              })
            }
            return { status: 'recorded', reused: false }
          })
      })
    ]
  }
}
