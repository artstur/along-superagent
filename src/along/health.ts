/** Stage C: facts are durable before this module creates narrowly bound automatic follow-up work. */
import { recommendation, RECOMMENDATION_INPUT, hikingIntent, recommendationText, recommendationNotice } from './recommendation.ts'
import { createHash } from 'node:crypto'
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
import { supportsRecurrence } from './reminder-plan.ts'
import { hasDailyMandate, nextDailyTime } from './task-schedule.ts'
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
    if (d.due) return {
      id: `along:${d.userId}:${d.eventId}`, source: 'along', actor: { source: 'along', id: d.userId },
      human: false, at: d.createdAt, threads: [{ source: 'along', id: `goal/${d.goalId}/review/${d.eventId}` }],
      text: 'Review the scheduled task now. Read its goal, conversation and due context. No new phone observations means no new health facts. Retain, adjust or ask only under the current mandate.',
      meta: { event_type: 'along.task_due', goal_id: d.goalId, task_id: d.due.taskId, health_dispatch: d.eventId }
    }
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
  private current(d: HealthDispatch): boolean {
    const store = this.host.store
    if (d.inputVersion !== store.inputVersion(d.goalId)) return false
    if (!d.due) return true
    const task = store.getTask(d.userId, d.due.taskId)
    if (!task || store.getGoal(d.userId, d.goalId)?.status !== 'active') return false
    if (task.status === 'open' && task.currentRevision === d.due.revision && task.scheduledAt === d.due.dueAt) return true
    // A worker may have committed its own revision before finalizing the same ticket.
    return store.taskRevisionOrigin(task.id, task.currentRevision) === d.eventId
  }
  policy(base: Policy, settings: Settings): Policy {
    return {
      ...base,
      gate: (t, thread, tickets) => {
        if (t.meta.event_type !== 'along.task_due' && (t.meta.event_type !== 'along.health_summary_updated' || t.meta.health_dispatch === undefined))
          return base.gate(t, thread, tickets)
        const d = this.bound(t),
          g = d && this.host.store.getGoal(d.userId, d.goalId)
        return d && !d.result && this.current(d) && g?.status === 'active' && this.allowed(d.userId, settings)
          ? {
              admissible: true,
              strength: 'explicit',
              basis: { via: d.due ? 'task_due' : 'health', source: 'along', scope: t.meta, eventId: d.eventId, goalId: d.goalId }
            }
          : { admissible: false, reason: 'untrusted_health_followup' }
      },
      revalidate: (m) => {
        if (m.basis.via !== 'health' && m.basis.via !== 'task_due') return base.revalidate(m)
        const d = this.host.store.health.get(m.basis.eventId)
        return (
          !!d &&
          d.goalId === m.basis.goalId && (m.basis.via === 'task_due') === !!d.due &&
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
      title: d.due ? '到期任务复查' : '健康变化跟进',
      name: d.due ? 'scheduled-task-review' : 'health-followup',
      scope: d.due ? 'Review the single bound due task under the current user mandate. Never change the goal.' :
        'Evaluate the bound existing goal against current aggregate health data; update user tasks through validated Along tools or keep. Never create, rewrite or archive the goal.',
      reason: d.due ? 'Host-verified scheduled task for an allowed paired user' : 'Host-verified health change for an allowed paired user',
      note: t.text
    })
    return true
  }
  forTicket(ticketId: string): HealthDispatch | undefined {
    const ticket = this.host.repo.tickets.get(ticketId),
      t = ticket && this.host.repo.triggers.get(ticket.origin.triggerId)
    return (ticket?.mandate.basis.via === 'health' || ticket?.mandate.basis.via === 'task_due') && t ? this.bound(t) : undefined
  }
  tick(): void {
    if (this.host.closing() || this.host.paused()) return
    const { store, repo } = this.host
    const now = new Date().toISOString()
    for (const { userId, goalId, due } of store.health.recentUnnotifiedTasks(now)) {
      if (!this.allowed(userId)) continue
      store.atomic(() => {
        if (!store.health.claimDueNotice(due.taskId, due.dueAt)) return
        const eventId = 'reminder_' + createHash('sha256')
          .update(JSON.stringify([userId, goalId, due.taskId, Date.parse(due.dueAt)])).digest('hex').slice(0,40)
        store.appendSync({ userId, goalId, taskId:due.taskId, kind:'task_updated',
          payload:{ task_id:due.taskId, goal_id:goalId, revision:due.revision, status:'open',
            notification:{event_id:eventId,kind:'reminder_due',revision:due.revision,scheduled_at:due.dueAt} } })
      })
    }
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
      if (d.due && !this.current(d)) {
        if (ticket && !ticket.ended && latestAssignment(ticket) && latestAssignment(ticket)!.state !== 'ended') this.host.engine().report(ticket.id, { state: 'dropped', summary: 'Superseded scheduled task.' })
        store.health.retireDue(d.eventId)
        continue
      }
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
    const busy = (goalId: string, version: number): boolean => {
      const active = store.workLinksForGoal(goalId).some(link => {
        const ticket = repo.tickets.get(link.ticketId)
        if (!ticket || ticket.ended) return false
        const review = this.forTicket(ticket.id)
        if (review) return !review.result && this.current(review)
        const assignment = latestAssignment(ticket), report = assignment?.report
        // A settled question can wait while a new fact or clock tick gets its own work.
        return !report || !['waiting', 'blocked', 'failed'].includes(report.state)
          || !!(assignment?.deliveredAt && assignment.deliveredAt > report.at)
      })
      return active || store.health.pending().some(d => d.goalId === goalId && d.inputVersion === version && this.current(d)
        && !repo.tickets.list().some(t => t.origin.triggerId === this.trigger(d).id && t.ended))
    }
    for (const { userId, goalId, due } of store.health.dueTasks(now)) {
      const version = store.inputVersion(goalId)
      if (!this.allowed(userId) || busy(goalId, version)) continue
      const snapshot = this.dueSummaries(userId, goalId, due.dueAt)
      const d = store.atomic(() => store.health.dispatchDue(userId, goalId, version, due, snapshot))
      this.host.engine().receive(this.trigger(d))
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
          if (busy(goal.id, version)) continue
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
  private dueSummaries(userId: string, goalId: string, dueAt: string): HealthSummaryRow[] {
    const store = this.host.store, goal = store.getGoal(userId, goalId)
    if (!goal || goal.domain === 'finance') return []
    const state = store.health.state(goalId)
    const metric = store.currentGoalRevision(goalId)?.metric as {type?: string} | undefined
    const watched = state?.inputVersion === store.inputVersion(goalId) ? state.types :
      goal.domain === 'health' && metric?.type ? [metric.type] : []
    if (!watched.length) return []
    return store.latestHealthSummaries(userId).filter(s => watched.includes(s.type) && s.adapter === 'known'
      && s.summarizerVersion === 'along-health-v1' && healthSummaryIsCurrent(s) && Date.parse(s.metricVersion) >= Date.parse(dueAt))
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
  read(ticketId: string, summaries: HealthSummaryRow[]) {
    const d = this.forTicket(ticketId)
    const mandate=d?.due?this.host.store.health.daily(d.due.taskId):undefined
    const eligible = d?.due ? this.dueSummaries(d.userId, d.goalId, d.due.dueAt).filter(s => summaries.some(row => row.id === s.id)) : summaries
    if (d && !d.result) this.host.store.health.read(d.eventId, eligible)
    return { summaries: eligible, ...(d?.due ? { review: { ...d.due, repeat:mandate?(mandate.weekday?'weekly':'daily'):'once',
      ...(mandate?{timezone:mandate.zone,weekday:mandate.weekday,next_occurrence_if_kept:nextDailyTime(d.due.dueAt,mandate.zone,Date.now(),mandate.wallTime,mandate.weekday)}:{}),
      daily_evidence_event_id: this.host.store.health.daily(d.due.taskId)?.weekday ? undefined : this.host.store.health.daily(d.due.taskId)?.evidence,
      reminder_plan: this.host.store.getTask(d.userId,d.due.taskId)?.reminderPlan } } : {}) }
  }
  assertReport(ticketId: string, state: string): void {
    const d = this.forTicket(ticketId)
    if (
      d &&
      ['ready', 'dropped'].includes(state) &&
      !d.result &&
      !(state === 'dropped' && !this.current(d))
    )
      throw new Error('health follow-up not complete; read health and call along_health_followup first')
  }
  private renewDaily(d: HealthDispatch, evidence: string, inherited: boolean): void {
    if (!d.due) throw new Error('daily renewal requires a bound due task')
    const store = this.host.store, due = d.due
    const task = store.assertTaskOwner(d.userId, due.taskId)
    const prior = store.health.daily(task.id)
    if (!prior && !store.health.soleTaskFromMandate(task.id, d.goalId, evidence)) throw new Error('no bound daily user mandate for this task')
    if (prior && prior.evidence !== evidence) throw new Error('daily mandate belongs to another instruction')
    const message = store.getMessage(d.userId, `msg:${d.userId}:${evidence}`)
    const supported = message && (prior?.quote && prior.action
      ? supportsRecurrence(message.text,prior.quote,prior.action,task.content,prior.weekday ? 'weekly' : 'daily',prior.weekday ?? 1)
      : hasDailyMandate(message.text))
    if (task.status !== 'open' || !task.scheduledAt || !message || message.role !== 'user'
      || message.direction !== 'inbound' || !message.timezone || !supported
      || !store.messageLinkedToGoal(message.id, d.goalId)) {
      if (inherited) { store.health.setDaily(task.id); return }
      throw new Error('no bound daily user mandate')
    }
    const wallTime = task.scheduledAt !== due.dueAt ? task.scheduledAt : prior?.wallTime ?? due.dueAt
    const next = nextDailyTime(due.dueAt, message.timezone, Date.now(), wallTime,prior?.weekday)
    store.health.setDaily(task.id, { ...prior,eventId: evidence, zone: message.timezone, wallTime })
    // Respect a different future time explicitly selected by this review.
    if (Date.parse(task.scheduledAt) > Date.now()) return
    const revision = store.appendTaskRevision({ taskId: task.id, userId: d.userId, scheduledAt: next, originEventId: d.eventId })
    store.health.recordRenewal(d.eventId, revision)
    store.appendSync({ userId: d.userId, kind: 'task_updated', goalId: d.goalId, taskId: task.id,
      payload: { task_id: task.id, goal_id: d.goalId, status: task.status, revision } })
  }
  tools(ticketId: string) {
    return [
      alongTool({
        name: 'along_health_followup',
        description:
          'Finish the bound automatic health evaluation. types lists health types actually relevant to this goal (empty for unrelated). keep changes nothing; update requires an applied task ChangeSet; ask records missing information in the background without adding personal chat or a notification. It does not prove the user task completed. Use existing report states honestly; do not require a human action for routine missing observations. Read along_health_read first. Ordinary keep is silent. Identity, goal and evaluated snapshot are host-bound.',
        schema: z
          .object({
            outcome: z.enum(['keep', 'update', 'ask']),
            renew_daily_from_event: z.string().min(1).max(96).optional().describe('Due task only: original user event explicitly delegating this daily schedule. Already bound daily mandates continue automatically. Omit for one-off tasks.'),
            types: z.array(z.enum(HEALTH_SUMMARY_TYPES)).max(7),
            reason: z.string().trim().min(1).max(800),
            text: z.string().trim().min(1).max(1200).optional(),
            recommendation: RECOMMENDATION_INPUT.optional().describe('Due research task only: structured result grounded in this ticket’s actual web source ids and exact quotes. Read the research skill.')
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
              return { status: 'recorded', reused: true, ...(d.result.outcome==='ask'?{audience:'background',delivery:'background_only'}:{}) }
            }
            if (!d.readSnapshot) throw new Error('read along_health_read before finishing')
            if(args.recommendation&&(!d.due||!args.text))throw new Error('recommendation requires a bound due task and user-facing text')
            if (!this.current(d))
              return { status: 'conflicted', reason: 'conflicted_input' }
            const link = store.getWorkLink(ticketId),
              applied = link && store.changeSetsByWork(link.workId).some((c) => c.status === 'applied')
            if ((args.outcome === 'update') !== !!applied) throw new Error('outcome must match applied changes')
            if (args.outcome === 'ask' && !args.text) throw new Error('ask requires a concrete question')
            const dailyEvidence = args.renew_daily_from_event ?? (d.due && store.health.daily(d.due.taskId)?.evidence)
            if (dailyEvidence) this.renewDaily(d, dailyEvidence, !args.renew_daily_from_event)
            const currentTask=d.due?store.getTask(d.userId,d.due.taskId):undefined
            const originalContent=d.due?store.taskRevisionContent(d.userId,d.due.taskId,d.due.revision):undefined
            const structured=args.recommendation?recommendation(store.research,{userId:d.userId,goalId:d.goalId,ticketId,
              ...(hikingIntent(originalContent??'')?{requiredKind:'hiking' as const}:{})},args.recommendation):undefined
            const notice=args.outcome==='ask'?undefined:structured?recommendationNotice(structured,currentTask,originalContent):'task_result'
            const priorSources=JSON.stringify(store.goalDataSources(d.userId,d.goalId))
            store.health.finish(d, args)
            if(priorSources!==JSON.stringify(store.goalDataSources(d.userId,d.goalId))) {
              store.appendSync({userId:d.userId,goalId:d.goalId,kind:'goal_updated',payload:{}})
            }
            if ((args.outcome !== 'keep'||structured) && args.text) {
              const eventId = `followup_${d.eventId}`,
                message = store.appendMessage({
                  userId: d.userId,
                  eventId,
                  role: 'assistant',
                  direction: 'outbound',
                  audience: 'background',
                  text: recommendationText(structured,args.text)
                })
              store.linkMessageToGoals(message.id, [d.goalId], 'derived')
              store.appendSync({
                userId: d.userId,
                kind: 'message',
                goalId: d.goalId,
                taskId: d.due?.taskId,
                messageId: message.id,
                payload: { message_id: message.id, text: message.text, ...(d.due?{task_execution_revision:d.due.revision}:{}), ...(structured?{recommendation:structured}:{}),
                  ...(notice?{notification: {
                  event_id: eventId, kind:notice, revision: currentTask?.currentRevision ?? d.inputVersion
                }}:{}) }
              })
            }
            return { status: 'recorded', reused: false, ...(args.outcome==='ask'?{audience:'background',delivery:'background_only'}:{}) }
          })
      })
    ]
  }
}
