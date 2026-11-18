/** Stage C: facts are durable before this module creates narrowly bound automatic follow-up work. */
import { reconcileSourceGoalReviews,sourceReviewCurrent,sourceReviewContext,finishSourceReview,SOURCE_REVIEW_FINISH } from './source-goal-review.ts'
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
import { requestTaskReview, taskReviewCurrent, taskReviewContext, finishTaskReview, TASK_REVIEW_FINISH, TaskReviewError } from './task-repair.ts'
import { calculationResultText } from './calculation-result.ts'
import { OKXHistoryReportSchema,okxHistoryResultText } from './okx-history.ts'
import type { AlongIdentity } from './service.ts'
import { TaskActivation, type ActivationHost } from './task-activation.ts'
import type { CalculationScope } from './calculation-store.ts'

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
  available?:ActivationHost['available']
  source?:ActivationHost['source']
}
/** Owns health change admission, per-goal serialization and host-bound completion evidence. */
export class HealthFollowup {
  readonly activation:TaskActivation
  constructor(private readonly host: HealthHost) {
    this.activation=new TaskActivation({store:host.store,available:host.available,source:host.source,allowed:userId=>this.allowed(userId),currentHealth:healthSummaryIsCurrent})
  }
  private allowed(userId: string, settings = this.host.settings()): boolean {
    return (
      settings.eval.mode === 'auto' &&
      settings.sources.along?.enabled === true &&
      settings.sources.github?.enabled === false &&
      (settings.policy.sources.along?.allowed ?? []).some((user) => user.id === userId)
    )
  }
  requestTaskReview(identity:AlongIdentity,body:unknown) {
    if(this.host.paused()||this.host.closing()||!this.allowed(identity.userId))throw new TaskReviewError('task_review_unavailable')
    return requestTaskReview(this.host.store,identity,body)
  }
  private trigger(d: HealthDispatch): Trigger {
    if(d.sourceReview)return {id:`along:${d.userId}:${d.eventId}`,source:'along',actor:{source:'along',id:d.userId},human:false,at:d.createdAt,
      threads:[{source:'along',id:`goal/${d.goalId}/source-review/${d.eventId}`}],
      text:'A newly admitted real source capability became ready for an existing goal. Read along_source_review_context and all original goal/conversation/task pages. Review minimum useful next steps against actual coverage. Preserve old human meaning/status/clock and unrelated typed tasks; never relabel old tasks as calculations. Every open legacy task needs a persisted user trigger: preserve its existing clock as time, otherwise waiting with a real reason and resume condition. Create a separate registered Agent task only when genuinely useful, or record specific need_data. This is metadata-only background planning, never private data read, account performance evidence, user chat, notification or execution. Finish with along_source_review_finish before reporting ready.',
      meta:{event_type:'along.source_ready_review',goal_id:d.goalId,health_dispatch:d.eventId,provider:d.sourceReview.provider,generation:d.sourceReview.generation,revision:d.sourceReview.revision}}
    if(d.repair)return {id:`along:${d.userId}:${d.eventId}`,source:'along',actor:{source:'along',id:d.userId},human:false,at:d.createdAt,
      threads:[{source:'along',id:`goal/${d.goalId}/task-trigger-review/${d.eventId}`}],
      text:'Inspect only the bound task trigger and cadence against the current goal and real accepted conversation evidence. This is private host maintenance, not a new user message, clock or health observation. Read along_task_review_context, use the existing scoped ChangeSet writer, and call along_task_review_finish only after durable read-back. Preserve original content, status and existing clock. No chat, notifications, calculations, research execution or other task edits.',
      meta:{event_type:'along.task_trigger_review',goal_id:d.goalId,task_id:d.repair.taskId,task_trigger_review:d.eventId}}
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
      typeof t.meta.task_trigger_review==='string'?this.host.store.health.get(t.meta.task_trigger_review):
      typeof t.meta.health_dispatch === 'string' ? this.host.store.health.get(t.meta.health_dispatch) : undefined
    return d && isDeepStrictEqual(t, this.trigger(d)) ? d : undefined
  }
  private current(d: HealthDispatch): boolean {
    const store = this.host.store
    if(d.sourceReview)return sourceReviewCurrent(store,d)
    if(d.repair)return taskReviewCurrent(store,d)
    if (d.inputVersion !== store.inputVersion(d.goalId)) return false
    if(!this.activation.current(d))return false
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
        if (t.meta.event_type!=='along.source_ready_review'&&t.meta.event_type!=='along.task_trigger_review'&&t.meta.event_type !== 'along.task_due' && (t.meta.event_type !== 'along.health_summary_updated' || t.meta.health_dispatch === undefined))
          return base.gate(t, thread, tickets)
        const d = this.bound(t),
          g = d && this.host.store.getGoal(d.userId, d.goalId)
        return d && !d.result && this.current(d) && g?.status === 'active' && this.allowed(d.userId, settings)
          ? {
              admissible: true,
              strength: 'explicit',
              basis: { via: d.sourceReview?'source_review':d.repair?'task_trigger_review':d.due ? 'task_due' : 'health', source: 'along', scope: t.meta, eventId: d.eventId, goalId: d.goalId }
            }
          : { admissible: false, reason: 'untrusted_health_followup' }
      },
      revalidate: (m) => {
        if (m.basis.via !== 'source_review'&&m.basis.via !== 'task_trigger_review'&&m.basis.via !== 'health' && m.basis.via !== 'task_due') return base.revalidate(m)
        const d = this.host.store.health.get(m.basis.eventId)
        return (
          !!d &&
          d.goalId === m.basis.goalId && (m.basis.via === 'task_due') === !!d.due &&
          (m.basis.via==='task_trigger_review')===!!d.repair&&(m.basis.via==='source_review')===!!d.sourceReview&&(!(d.repair||d.sourceReview)||this.current(d))&&
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
      title: d.sourceReview?'来源就绪后续评':d.repair?'任务触发修复':d.due ? '到期任务复查' : '健康变化跟进',
      name: d.sourceReview?'source-goal-review':d.repair?'task-trigger-review':d.due ? 'scheduled-task-review' : 'health-followup',
      scope: d.sourceReview?'Review this goal against current accepted source capability metadata. Preserve original human tasks and unrelated typed fields; create only useful separate typed Agent steps or honest need_data. Never read private data, change goals, post chat or execute tasks in this review.':d.repair?'Inspect and repair only this existing task trigger/plan through validated ChangeSets; preserve goal, other tasks, content, status and existing clock. Read original evidence and finish with persisted postconditions. No user chat or execution notification.':d.due ? 'Review the single bound due task under the current user mandate. Never change the goal.' :
        'Evaluate the bound existing goal against current aggregate health data; update user tasks through validated Along tools or keep. Never create, rewrite or archive the goal.',
      reason: d.sourceReview?'Host-verified new-capability bootstrap for an existing goal':d.repair?'Persisted private task-trigger maintenance request with real same-goal user evidence':d.due ? 'Host-verified scheduled task for an allowed paired user' : 'Host-verified health change for an allowed paired user',
      note: t.text
    })
    return true
  }
  forTicket(ticketId: string): HealthDispatch | undefined {
    const ticket = this.host.repo.tickets.get(ticketId),
      t = ticket && this.host.repo.triggers.get(ticket.origin.triggerId)
    return (ticket?.mandate.basis.via==='source_review'||ticket?.mandate.basis.via==='task_trigger_review'||ticket?.mandate.basis.via === 'health' || ticket?.mandate.basis.via === 'task_due') && t ? this.bound(t) : undefined
  }
  tick(): void {
    if (this.host.closing() || this.host.paused()) return
    const { store, repo } = this.host
    const now = new Date().toISOString()
    store.atomic(()=>{this.activation.prepare(now);reconcileSourceGoalReviews(store)})
    for (const { userId, goalId, due } of store.health.recentUnnotifiedTasks(now)) {
      if (!this.allowed(userId)) continue
      const task=store.getTask(userId,due.taskId)
      if(!task||!this.activation.allowDue(task)||!this.activation.notifyBefore(task))continue
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
      if ((d.due||d.repair||d.sourceReview) && !this.current(d)) {
        if (ticket && !ticket.ended && latestAssignment(ticket) && latestAssignment(ticket)!.state !== 'ended') this.host.engine().report(ticket.id, { state: 'dropped', summary: 'Superseded scheduled task.' })
        if(d.sourceReview)store.health.retireSourceReview(d.eventId);else if(d.repair)store.health.retireRepair(d.eventId);else store.health.retireDue(d.eventId)
        continue
      }
      if (ticket) {
        // A persisted private read is Host work, not another model turn. Construct its exact
        // occurrence scope directly; taskContext would falsely mark a Worker context as read.
        const occurrence=d.due&&this.activation.occurrence(d)
        if(d.due&&occurrence&&store.sources.awaitingData({userId:d.userId,goalId:d.goalId,taskId:d.due.taskId,
          taskRevision:d.due.revision,inputVersion:d.inputVersion,ticketId:ticket.id,executionKey:occurrence.id}))continue
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
      // A source fact is persisted immediately, but its review waits for an already-running goal Worker.
      if(d.sourceReview&&store.workLinksForGoal(d.goalId).some(link=>{
        const other=repo.tickets.get(link.ticketId)
        if(!other||other.ended)return false
        const review=this.forTicket(other.id)
        if(review&&(review.result||!this.current(review)))return false
        const assignment=latestAssignment(other),report=assignment?.report
        return !report||!['waiting','blocked','failed'].includes(report.state)||!!(assignment?.deliveredAt&&assignment.deliveredAt>report.at)
      }))continue
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
        if (review&&(review.result||!this.current(review)))return false
        const assignment = latestAssignment(ticket), report = assignment?.report
        // A settled question can wait while a new fact or clock tick gets its own work.
        return !report || !['waiting', 'blocked', 'failed'].includes(report.state)
          || !!(assignment?.deliveredAt && assignment.deliveredAt > report.at)
      })
      return active || store.health.pending().some(d => d.goalId === goalId && d.inputVersion === version && this.current(d)
        && !repo.tickets.list().some(t => t.origin.triggerId === this.trigger(d).id))
    }
    for (const { userId, goalId, due } of store.health.dueTasks(now)) {
      const version = store.inputVersion(goalId)
      if (!this.allowed(userId) || busy(goalId, version)) continue
      const task=store.getTask(userId,due.taskId)
      if(!task||!this.activation.allowDue(task))continue
      const snapshot = this.dueSummaries(userId, goalId, due.dueAt)
      const d = store.atomic(() => {
        const dispatched=store.health.dispatchDue(userId, goalId, version, due, snapshot)
        this.activation.bind(dispatched)
        return dispatched
      })
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
      (d.repair||d.sourceReview)&&!this.current(d)||
      !this.allowed(d.userId) ||
      this.host.paused() ||
      this.host.closing() ||
      this.host.store.getGoal(d.userId, d.goalId)?.status !== 'active'
    )
      throw new Error('health capability unavailable')
  }
  /** Host-owned context for a single automatic task. A UI timestamp or model-selected id grants no execution scope. */
  taskContext(ticketId:string) {
    this.assertActive(ticketId)
    const d=this.forTicket(ticketId)
    if(!d?.due)throw new Error('no task execution is bound to this planning work; persist triggers, read them back, reply and report ready so the Host can dispatch the occurrence separately')
    if(!d.result&&!this.current(d))throw new Error('task input or trigger was superseded')
    const task=this.host.store.assertTaskOwner(d.userId,d.due.taskId)
    const observed=this.read(ticketId,this.host.store.latestHealthSummaries(d.userId))
    return {task,dispatch:d,definition:this.activation.definition(d),occurrence:this.activation.occurrence(d),observed}
  }
  /** Scope consumed by the deterministic journal, never selected or widened by the model. */
  calculationScope(ticketId:string):CalculationScope {
    const {task,dispatch,definition,occurrence}=this.taskContext(ticketId)
    if(definition?.definition.actor!=='agent'||definition.definition.capability!=='calculation'||dispatch.result)
      throw new Error('calculation requires an active host-bound calculation task')
    return {userId:dispatch.userId,goalId:dispatch.goalId,taskId:task.id,taskRevision:dispatch.due!.revision,
      taskContent:this.host.store.taskRevisionContent(dispatch.userId,task.id,dispatch.due!.revision)!,
      inputVersion:dispatch.inputVersion,ticketId,executionKey:occurrence?.id??dispatch.eventId}
  }
  sourceScope(ticketId:string) {
    const {task,dispatch,definition,occurrence}=this.taskContext(ticketId)
    if(definition?.definition.actor!=='agent'||dispatch.result||!occurrence)throw new Error('source reads require an active host-bound Agent task')
    return {userId:dispatch.userId,goalId:dispatch.goalId,taskId:task.id,taskRevision:dispatch.due!.revision,
      inputVersion:dispatch.inputVersion,ticketId,executionKey:occurrence.id}
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
    if(d?.sourceReview&&state==='ready'&&(!d.result||!this.current(d)))throw new Error('source review not complete: read the bound context and persist an honest review outcome first')
    if(d?.repair&&state==='ready'&&(!d.result||d.result.outcome==='ask'||!this.current(d)))throw new Error('task trigger review not complete: persist and verify the actual bound trigger/plan first')
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
      ? supportsRecurrence(message.text,prior.quote,prior.action,task.content,prior.weekday ? 'weekly' : 'daily',prior.weekday ?? 1,
          task.reminderPlan?.state==='scheduled'?task.reminderPlan.recurrenceSource:undefined)
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
    if(this.forTicket(ticketId)?.sourceReview)return [
      alongTool({name:'along_source_review_context',description:'Read this existing goal, original tasks/conversation and accepted source capability coverage. Follow remaining conversation/task pages. Ready metadata is not private data. Only the declared legacy trigger fields or useful separate Agent tasks may change; no chat, execution or source write.',schema:z.object({}).strict(),execute:async()=>{this.assertActive(ticketId);const d=this.forTicket(ticketId);if(!d?.sourceReview)throw new Error('source review unavailable');return this.host.store.atomic(()=>sourceReviewContext(this.host.store,d))}}),
      alongTool({name:'along_source_review_finish',description:'Seal this background planning review with keep/revise/need_data after current-state read-back. need_data names missing facts/capabilities and settles only this review, never the actual goal/task. No health baseline, message, notification or execution count is written.',schema:SOURCE_REVIEW_FINISH,execute:async args=>{this.assertActive(ticketId);const d=this.forTicket(ticketId);if(!d?.sourceReview)throw new Error('source review unavailable');return this.host.store.atomic(()=>finishSourceReview(this.host.store,d,args))}}),
    ]
    if(this.forTicket(ticketId)?.repair)return [
      alongTool({name:'along_task_review_context',description:'Read the current bound goal, task, original accepted user evidence and conversation for this private background repair. This is not a new user input, due occurrence or health observation. Existing content, status and scheduled clock are immutable. The returned scope grants only this task trigger/plan repair.',schema:z.object({}).strict(),execute:async()=>{this.assertActive(ticketId);const d=this.forTicket(ticketId);if(!d?.repair)throw new TaskReviewError('task_review_unavailable');return this.host.store.atomic(()=>taskReviewContext(this.host.store,d))}}),
      alongTool({name:'along_task_review_finish',description:'Finish the private trigger/plan repair only after actual validated ChangeSet persistence and read-back. Supply the exact expected trigger and cadence to verify them. Waiting is not ready. This tool never creates chat, notifications, execution history or health baselines.',schema:TASK_REVIEW_FINISH,execute:async args=>{this.assertActive(ticketId);const d=this.forTicket(ticketId);if(!d?.repair)throw new TaskReviewError('task_review_unavailable');return this.host.store.atomic(()=>finishTaskReview(this.host.store,d,args))}}),
    ]
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
            source_request_id:z.string().min(1).max(128).optional().describe('Typed Agent research only: this occurrence’s actual ready trading_history request_id. Publishes Host-rendered facts plus qualitative text without fabricating web citations; fresh scoped read is rechecked at finish.'),
            recommendation: RECOMMENDATION_INPUT.optional().describe('Due research task only: structured result grounded in this ticket’s actual web source ids and exact quotes. Read the research skill.'),
            calculation_receipt:z.string().min(1).max(96).optional().describe('Calculation task only: the receipt_id returned by the registered along_calculate tool in this exact occurrence.')
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
            const definition=this.activation.definition(d)?.definition
            if(definition?.actor==='agent'&&definition.capability==='research'&&args.outcome!=='ask'&&
              (definition.conditions?.some(c=>(c.kind==='source_ready'||c.kind==='source_updated')&&c.capability==='trading_history')||
                store.sources.hasRead(this.sourceScope(ticketId),'trading_history'))&&!args.source_request_id)
              throw new Error('history-dependent research requires its actual fresh source_request_id; public citations cannot replace the private read')
            const historyRead=args.source_request_id?store.sources.getRead(this.sourceScope(ticketId),args.source_request_id):undefined
            if(args.source_request_id&&(definition?.actor!=='agent'||definition.capability!=='research'||args.outcome==='ask'||
              args.recommendation||args.calculation_receipt||!args.text||historyRead?.state!=='ready'||historyRead.capability!=='trading_history'||!historyRead.data))
              throw new Error('history result requires this typed Agent research occurrence’s fresh authorized history read and qualitative text')
            const historyReport=historyRead?.data?OKXHistoryReportSchema.parse(historyRead.data):undefined
            const calculation=args.calculation_receipt?store.calculations.get(this.calculationScope(ticketId),args.calculation_receipt):undefined
            if(args.calculation_receipt&&!calculation)throw new Error('calculation receipt is not bound to this task occurrence')
            const privateCalculation=!!calculation&&(store.calculationEvidence.has(calculation.id)||store.sources.hasRead(this.sourceScope(ticketId)))
            if(calculation&&(privateCalculation||definition?.conditions?.some(c=>c.kind==='source_ready'||c.kind==='source_updated')))
              store.calculationEvidence.assertCurrent(this.sourceScope(ticketId),calculation.id,calculation.calculation.input.quantities)
            if(definition?.actor==='agent'&&args.outcome!=='ask') {
              if(definition.capability==='calculation'&&!calculation)throw new Error('calculation task requires its actual persisted tool receipt')
              if(definition.capability==='research'&&!args.recommendation&&!historyReport)throw new Error('research task requires a structured sourced result')
              if(definition.capability==='reminder'&&!args.text)throw new Error('reminder execution requires its user-facing notification text')
            }
            const link = store.getWorkLink(ticketId),
              applied = link && store.changeSetsByWork(link.workId).some((c) => c.status === 'applied')
            if ((args.outcome === 'update') !== !!applied) throw new Error('outcome must match applied changes')
            if (args.outcome === 'ask' && !args.text) throw new Error('ask requires a concrete question')
            const dailyEvidence = args.renew_daily_from_event ?? (d.due && store.health.daily(d.due.taskId)?.evidence)
            if (dailyEvidence) this.renewDaily(d, dailyEvidence, !args.renew_daily_from_event)
            const originalContent=d.due?store.taskRevisionContent(d.userId,d.due.taskId,d.due.revision):undefined
            const structured=args.recommendation?recommendation(store.research,{userId:d.userId,goalId:d.goalId,ticketId,
              ...(hikingIntent(originalContent??'')?{requiredKind:'hiking' as const}:{})},args.recommendation):undefined
            if(definition?.actor==='agent'&&definition.capability==='research'&&args.outcome!=='ask'&&!structured?.sources.length&&!historyReport)
              throw new Error('research execution requires actual verified sources; report failed or blocked, not completion')
            const resultText=calculation?calculationResultText(calculation.calculation,privateCalculation):historyReport?okxHistoryResultText(historyReport,args.text!):args.text
            const priorSources=JSON.stringify(store.goalDataSources(d.userId,d.goalId))
            store.health.finish(d, args)
            this.activation.settle(d,args.outcome==='ask'?'waiting':calculation?'calculated':historyReport?'agent_researched':structured?(definition?.actor==='agent'&&definition.capability==='research'?'agent_researched':'researched'):'notification_queued')
            if(definition?.actor==='agent'&&args.outcome==='ask') {
              const task=store.assertTaskOwner(d.userId,d.due!.taskId)
              store.triggers.put(task,{kind:'waiting',actor:'agent',capability:definition.capability,conditions:definition.conditions,
                resume:'user_input',reason:args.text!.slice(0,240)},d.inputVersion)
            }
            if(definition?.actor==='agent'&&(calculation||structured||historyReport)&&args.outcome!=='ask'
              &&!(definition.kind==='event'&&definition.repeat==='on_change')&&!store.health.daily(d.due!.taskId)) {
              const task=store.assertTaskOwner(d.userId,d.due!.taskId)
              const revision=store.appendTaskRevision({taskId:task.id,userId:d.userId,status:'done',originEventId:d.eventId})
              store.appendSync({userId:d.userId,goalId:d.goalId,taskId:task.id,kind:'task_updated',payload:{task_id:task.id,goal_id:d.goalId,revision,status:'done'}})
            }
            const currentTask=d.due?store.getTask(d.userId,d.due.taskId):undefined
            const notice=args.outcome==='ask'?undefined:structured?recommendationNotice(structured,currentTask,originalContent,definition?.actor==='agent'&&definition.capability==='research'):'task_result'
            if(priorSources!==JSON.stringify(store.goalDataSources(d.userId,d.goalId))) {
              store.appendSync({userId:d.userId,goalId:d.goalId,kind:'goal_updated',payload:{}})
            }
            if ((args.outcome !== 'keep'||structured||calculation||historyReport||definition?.actor==='agent'&&definition.capability==='reminder') && resultText) {
              const eventId = `followup_${d.eventId}`,
                message = store.appendMessage({
                  userId: d.userId,
                  eventId,
                  role: 'assistant',
                  direction: 'outbound',
                  audience: 'background',
                  text: recommendationText(structured,resultText)
                })
              store.linkMessageToGoals(message.id, [d.goalId], 'derived')
              store.appendSync({
                userId: d.userId,
                kind: 'message',
                goalId: d.goalId,
                taskId: d.due?.taskId,
                messageId: message.id,
                payload: { message_id: message.id, text: message.text, ...(d.due?{task_execution_revision:d.due.revision}:{}), ...(structured?{recommendation:structured}:{}),
                  ...(calculation?{calculation_receipt_id:calculation.id}:{}),
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
