/**
 * The worklink module (design §2.5, 001 §2/§7): the single mapping point between Along business objects
 * (goal/task) and DSH execution ids (Ticket/Assignment), plus the DSH thread naming for Along events.
 * Business history never depends on a DSH Session surviving — a WorkLink row is written once per ticket
 * from domain events and read by `workScopeForTicket` afterwards (001 §2: 业务 ID 与执行 ID 独立).
 *
 * Subscription (§2.5.1): the Along Agent Engine already emits the full lifecycle (`src/core/tickets.ts` ticket
 * created/resumed/ended, `src/core/assignments.ts` started/ended, `src/core/evals.ts` decision.recorded,
 * `src/core/intake.ts` trigger.received); the host dispatches each event through the orchestrator store's
 * `afterCommit` — `emit` fires inside the Engine transaction, so writing along.sqlite directly would leave
 * dirty rows on rollback; queued through `afterCommit` the dispatch is discarded when that transaction
 * rolls back and runs only after a real commit. The integration module owns the runtime wiring
 * (`runtime.ts` emit → `store.afterCommit(() => worklink.onDomainEvent(event))`); this module owns the
 * mapping and never fails a committed transaction (§2.5 错误路径): write errors go to the `report` sink
 * (run log / health entry), never rethrown.
 *
 * Thread naming (001 §7.2, `tests/along-phase0.spec.ts:21-25` probe form `goal/exercise/work/<id>`
 * evolved): DSH threads are per ongoing work, never one thread per goal — a goal's messages do not all
 * share a thread, because a follow-up on a shared thread would fan out to (or resume) work a person
 * stopped. A reply joins a work thread only through the server-recorded association (`causation_id` → the
 * Inbox row of the prior event), never through text similarity. The row's `thread_key` is the thread the
 * work's conversation actually lives on: the origin trigger's own work-form thread when it arrived on one
 * (`goal/<goal_id>/work/<segment>`), otherwise a freshly minted `goal/<goal_id>/work/<work_id>` (or the
 * goal-less `work/<work_id>` for a ticket accepted from a goal-less health event, until Stage C backfills
 * the goal). 001 §7.1 constraint, kept as a hard rule here and in `deriveTrigger`: health updates are
 * never disguised as `human = true` (the phase-0 probe at `along-phase0.spec.ts:100-118` locks this), so
 * a health event cannot resume a human-stopped ticket or lift a pause.
 *
 * Work ids are minted server-side (`w_` + 12 hex, design §3) and unique per work; `thread_key` is unique
 * (UNIQUE 兜底, §2.5 错误路径 — when an origin thread was already mapped to an earlier ticket's row, the
 * new work falls back to a minted thread). `decision.recorded` only lands in the trace log for now — no
 * row (§2.5.2). D9 derived event numbers (`deriveTrigger`, 001 §7.4) carry goal id and purpose; per-goal
 * splitting itself is a Stage C concern.
 */
import { threadKey } from '../core/model.ts'
import type { Trigger } from '../core/model.ts'
import type { DomainEvent, Repositories } from '../core/ports.ts'
import type { CommitScope } from './changeset.ts'
import { randomToken, type AlongStore, type WorkLinkRow } from './store.ts'

/** The Along source id; thread keys are `${source}:${id}` (`core/model.ts` `threadKey`), so a thread id of
 * `goal/<goal_id>/work/<work_id>` names the DSH thread `along:goal/<goal_id>/work/<work_id>` — the 001 §7.2
 * naming, whose ThreadRef id form is the phase-0 probe's `goal/exercise/work/<id>` evolved. */
export const ALONG_SOURCE = 'along'

/** Structural view of the envelope fields thread naming needs (design §4.1). The canonical `EventEnvelope`
 * type owner is `src/along/envelope.ts` (inbox module) and is structurally compatible with this input. */
export interface ThreadNamingEvent {
  event_id: string
  event_type: string
  kind?: string
  goal_id?: string
  /** The prior event this message replies to — the server-recorded association (§2.5.4). */
  causation_id?: string
  /** Client message id a `along.message` feedback replies to (payload field, design §4.1). Resolving it needs
   * a lookup by `(user_id, message_id)` that the storage primitives (§4.3) do not expose yet; Stage A routes
   * on `causation_id` and falls through to a request thread when only `reply_to_message_id` is present. */
  reply_to_message_id?: string
}

/** Store-backed lookups `threadFor` uses for association routing; the module injects them, pure callers omit them. */
export interface ThreadNamingContext {
  /** The goal the Inbox row of a prior event is bound to (`envelopeForTrigger` binds it per event, §2.5.3). */
  associatedGoal?(userId: string, eventId: string): string | undefined
  /** Open (in-flight) work rows of one goal, oldest first. */
  openWorks?(goalId: string): readonly WorkLinkRow[]
}

/** Purpose of a D9 derived event (001 §7.4); the number carries the goal id and this purpose. */
export type WorkLinkPurpose = 'replan' | 'notify' | 'fact'

const EVENT_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/
/** Work-form thread id under one goal: `goal/<goal_id>/work/<segment>` (001 §7.2; the probe's form). */
const WORK_THREAD_SHAPE = /^goal\/([^/]+)\/work\/([^/]+)$/

/** Strips the `along:` source prefix from a thread key, giving the ThreadRef id (`envelopeForTrigger` maps
 * `{ source: 'along', id }`, design §4.6). A key without the prefix is returned unchanged. */
export function threadIdFromKey(key: string): string {
  return key.startsWith(`${ALONG_SOURCE}:`) ? key.slice(ALONG_SOURCE.length + 1) : key
}

/** The ThreadRef id of the freshly minted work thread of one work; the goal-less variant covers a ticket
 * accepted from a goal-less health event (§2.5.2, `work_link.goal_id` NULL). */
export function workThreadId(workId: string, goalId?: string): string {
  return goalId === undefined ? `work/${workId}` : `goal/${goalId}/work/${workId}`
}
/** The DSH thread key (`along:<id>`) of a minted work thread — the `work_link.thread_key` fallback form. */
export function workThreadKey(workId: string, goalId?: string): string {
  return threadKey({ source: ALONG_SOURCE, id: workThreadId(workId, goalId) })
}

/** Parses the Inbox event id out of a stable Along Trigger id `along:<user_id>:<event_id>` (design §4.6);
 * the prefixed Trigger id itself is never used as a message key (§2.3). Non-Along shapes return `undefined`. */
export function eventIdFromTriggerId(triggerId: string): string | undefined {
  const parts = triggerId.split(':')
  if (parts.length !== 3 || parts[0] !== ALONG_SOURCE) return undefined
  const eventId = parts[2]!
  return EVENT_ID_SHAPE.test(eventId) ? eventId : undefined
}

/**
 * Thread naming for an Along event (§2.5.4, 001 §7.2; the design's `threadFor(envelope)` extended with the
 * bound user id — the envelope carries no identity, §4.1, and with the optional store lookups the module
 * injects for association routing). Returns the ThreadRef **id**; the DSH thread key is `along:<id>` (see
 * `ALONG_SOURCE`). Rules:
 * - a health summary always gets its own event thread (`health/<user>/<event>`); Stage C may merge it into
 *   an in-flight work thread — never Stage A;
 * - a message joined to an open work by the server-recorded association (its `causation_id` names a prior
 *   event whose Inbox row is bound to the same goal) rides that work's live thread (`goal/<goal>/work/…`,
 *   the latest open work of the goal);
 * - every other message is a fresh request (`goal/<goal>/request/<event>` with a known goal,
 *   `inbox/<user>/<event>` without one) — even when works are open, so two works of one goal never both
 *   process a brand-new sentence (BC-08-06 path ①: an un-subscribed request thread fans out to nobody, the
 *   Eval decides once);
 * - an association pointing at a different goal than the envelope's does not cross threads: the envelope's
 *   goal wins as a fresh request (001 §7.2: the same `goal_id` does not satisfy attach by itself).
 */
export function threadFor(event: ThreadNamingEvent, userId: string, context?: ThreadNamingContext): string {
  if (event.event_type === 'along.health_summary_updated') return `health/${userId}/${event.event_id}`
  const associated = event.causation_id !== undefined && context?.associatedGoal !== undefined
    ? context.associatedGoal(userId, event.causation_id) : undefined
  const goalId = event.goal_id ?? associated
  if (goalId === undefined) return `inbox/${userId}/${event.event_id}`
  const routedByAssociation = associated !== undefined && (event.goal_id === undefined || event.goal_id === associated)
  const latestOpenWork = routedByAssociation ? context?.openWorks?.(goalId).at(-1) : undefined
  return latestOpenWork !== undefined ? threadIdFromKey(latestOpenWork.threadKey)
    : `goal/${goalId}/request/${event.event_id}`
}

/**
 * D9 derived event number (001 §7.4): `<event_id>::g/<goal_id>::<purpose>`, one derived Trigger per affected
 * goal so each goal evaluates and commits independently (Stage C does the splitting; Stage A lands the
 * number and the mapping convention). Everything else — actor, `human`, `addressed`, text, channels — is
 * inherited unchanged: a health event stays `human: false`, never disguised as a person's request (001 §7.1).
 */
export function deriveTrigger(event: Trigger, goalId: string, purpose: WorkLinkPurpose): Trigger {
  return { ...event, id: `${event.id}::g/${goalId}::${purpose}`, threads: [...event.threads],
    meta: { ...event.meta, goal_id: goalId, derive_purpose: purpose } }
}

/** Host dependencies of the worklink module (design §2.5). */
export interface WorkLinkDeps {
  /** The Along business store — the only writer of along.sqlite (storage module). */
  store: AlongStore
  /** The DSH repositories, read-only: ticket and trigger lookups resolve the execution context of an event. */
  repo: Pick<Repositories, 'tickets' | 'triggers'>
  /** Error sink for mapping write failures — the run log / health entry (§2.5 错误路径). Errors never rethrow
   * into the committed DSH transaction; with no sink given, failures stay in the module's bounded `errors()`. */
  report?: (error: unknown) => void
}

const TRACE_LIMIT = 100
const randomWorkId = (): string => `w_${randomToken()}`

/** The worklink module (design §2.5): one instance per Along service, assembled by the Runtime next to the
 * business store; the host dispatches domain events into `onDomainEvent` via `afterCommit`. */
export function createWorkLink(deps: WorkLinkDeps) {
  const { store, repo } = deps
  const trace: string[] = []
  const errors: unknown[] = []
  const record = (error: unknown): void => {
    errors.push(error)
    if (errors.length > TRACE_LIMIT) errors.shift()
    try { deps.report?.(error) } catch { /* the sink must not break the dispatch either */ }
  }
  /** The goal a trigger's envelope was bound to (`meta.goal_id`), or `undefined` for a goal-less health event. */
  const goalOf = (triggerId: string): string | undefined => {
    const trigger = repo.triggers.get(triggerId)
    const goalId = trigger?.meta.goal_id
    if(trigger!==undefined&&typeof goalId==='string'&&goalId!=='')return goalId
    const userId=trigger?.actor?.source===ALONG_SOURCE?trigger.actor.id:undefined
    return userId&&typeof trigger?.meta.task_id==='string'?store.getTask(userId,trigger.meta.task_id)?.goalId:undefined
  }
  /** Preserve a validated task association without granting access to another goal’s task. */
  const taskOf = (trigger: Trigger | undefined, goalId?: string): string | undefined => {
    const userId=trigger?.actor?.source===ALONG_SOURCE?trigger.actor.id:undefined
    const taskId=trigger?.meta.task_id
    if(!userId||!goalId||typeof taskId!=='string')return undefined
    return store.getTask(userId,taskId)?.goalId===goalId?taskId:undefined
  }
  /** The origin trigger's own work-form thread (`goal/<goal>/work/<segment>`) when it matches the work's
   * goal and its segment is a safe id — the thread the work's conversation already lives on (probe form).
   * Any other shape (request, inbox, health threads) mints a fresh work thread. */
  const adoptedThread = (trigger: Trigger, goalId: string | undefined): string | undefined => {
    const ref = trigger.threads[0]
    if (ref === undefined || ref.source !== ALONG_SOURCE || goalId === undefined) return undefined
    const match = WORK_THREAD_SHAPE.exec(ref.id)
    return match !== null && match[1] === goalId && EVENT_ID_SHAPE.test(match[2]!) ? match[2] : undefined
  }
  /** Writes the one row per ticket. `work_id` is always freshly minted (`w_` + 12 hex, design §3); the
   * thread key adopts the work's live thread when the origin carries one, otherwise a minted work thread —
   * and falls back to minted when the adopted key is already mapped to an earlier ticket's row (UNIQUE 兜底). */
  const mapWork = (input: { ticketId: string; goalId?: string; taskId?: string; eventId?: string; triggerId?: string
    segment?: string; kind: 'ticket' | 'resume' }): void => {
    const base = { ticketId: input.ticketId, goalId: input.goalId, taskId:input.taskId, eventId: input.eventId, triggerId: input.triggerId }
    if (input.segment !== undefined && input.goalId !== undefined) {
      try {
        store.recordWorkLink({ ...base, workId: randomWorkId(),
          threadKey: threadKey({ source: ALONG_SOURCE, id: `goal/${input.goalId}/work/${input.segment}` }), kind: input.kind })
        return
      } catch { /* thread already mapped to an earlier ticket's row — fall through to a minted work thread */ }
    }
    const workId = randomWorkId()
    store.recordWorkLink({ ...base, workId, threadKey: workThreadKey(workId, input.goalId), kind: input.kind })
  }
  return {
    /**
     * Host dispatch entry (§2.5.1/§4.6): the Runtime wires `emit` → `store.afterCommit(() => worklink.onDomainEvent(event))`,
     * so a rolled-back Engine transaction leaves no WorkLink row and a committed one always lands its mapping.
     * `ticket.created` opens the mapping row (kind `ticket`), `ticket.resumed` re-points it to a fresh work on
     * the conversation's live thread (kind `resume`, clearing the ended marker), `assignment.started/ended` fill
     * `assignment_id`, and `ticket.ended` marks the row ended (clearing the in-flight marker). Only
     * Along-originated work maps — a ticket accepted from another Source carries no Along business object.
     * `decision.recorded` is trace-only.
     */
    onDomainEvent(event: DomainEvent): void {
      try {
        switch (event.type) {
          case 'ticket.created': {
            const ticket = repo.tickets.get(event.data.ticketId)
            const trigger = ticket === undefined ? undefined : repo.triggers.get(ticket.origin.triggerId)
            // Only Along-originated work maps to business objects; other Sources have no goal/thread vocabulary here.
            if (ticket === undefined || trigger === undefined || trigger.source !== ALONG_SOURCE) return
            const goalId = goalOf(trigger.id)
            mapWork({ ticketId: ticket.id, goalId, taskId:taskOf(trigger,goalId), eventId: eventIdFromTriggerId(trigger.id), triggerId: trigger.id,
              segment: adoptedThread(trigger, goalId), kind: 'ticket' })
            return
          }
          case 'ticket.resumed': {
            const row = store.getWorkLink(event.data.ticketId)
            const trigger = repo.triggers.get(event.data.triggerId)
            const along = trigger !== undefined && trigger.source === ALONG_SOURCE
            // No row and no Along trigger: nothing to map (a ticket created before the module was installed only
            // maps when its resume trigger is Along; a mapped ticket re-points to a fresh work on every resume).
            if (row === undefined && !along) return
            const goalId = row?.goalId ?? (along && trigger !== undefined ? goalOf(trigger.id) : undefined)
            const resumeEventId = trigger === undefined ? undefined : eventIdFromTriggerId(trigger.id)
            mapWork({ ticketId: event.data.ticketId, goalId, taskId:taskOf(trigger,goalId), eventId: resumeEventId,
              triggerId: resumeEventId !== undefined && trigger !== undefined ? trigger.id : undefined,
              segment: trigger === undefined ? undefined : adoptedThread(trigger, goalId),
              kind: row === undefined ? 'ticket' : 'resume' })
            return
          }
          case 'assignment.started':
          case 'assignment.ended': {
            const row = store.getWorkLink(event.data.ticketId)
            // An ended row stays ended; assignment facts never reopen or mutate it. Same assignment id: no-op.
            if (row === undefined || row.endedAt !== undefined || row.assignmentId === event.data.assignmentId) return
            store.recordWorkLink({ ticketId: event.data.ticketId, workId: row.workId, goalId: row.goalId, taskId: row.taskId,
              eventId: row.eventId, triggerId: row.triggerId, threadKey: row.threadKey, kind: row.kind,
              assignmentId: event.data.assignmentId })
            return
          }
          case 'ticket.ended': {
            store.markWorkLinkEnded(event.data.ticketId, event.at)
            return
          }
          case 'decision.recorded': {
            // 追踪日志 only for now — no row (§2.5.2); the record module owns the run-record side.
            trace.push(`${event.at} decision.recorded ${event.data.decisionId} ${event.data.kind} ${event.data.threadKey}`)
            if (trace.length > TRACE_LIMIT) trace.shift()
            return
          }
          default:
            return
        }
      } catch (error) {
        record(error)
      }
    },
    /** §2.5.4 naming with the store-backed association resolver (`envelopeForTrigger` consumes this). */
    threadFor(event: ThreadNamingEvent, userId: string): string {
      return threadFor(event, userId, {
        associatedGoal: (owner, eventId) => store.findInboxEvent(owner, eventId)?.goalId,
        openWorks: goalId => store.workLinksForGoal(goalId),
      })
    },
    /** Open (in-flight) works of one goal — a routing reference for「合并进在途工作 vs 新建工作」(001 §7.3);
     * the hard write-qualification guarantee stays the version check (§2.5.5). */
    openWorksForGoal(goalId: string): WorkLinkRow[] {
      return store.workLinksForGoal(goalId)
    },
    /**
     * Host-bound commit scope for `along_changes_commit` (§2.3.6): the user and goal come from the mapping
     * row and the ticket's Along mandate actor, the working context from the row — `triggerEventId` is the
     * **Inbox event id** (`work_link.event_id`), not the prefixed DSH Trigger id (§2.3). Tickets without an
     * Along mapping or mandate actor have no scope, so Along tools are unavailable to them (§4.5).
     */
    workScopeForTicket(ticketId: string): CommitScope | undefined {
      const row = store.getWorkLink(ticketId)
      if (row === undefined) return undefined
      const actor = repo.tickets.get(ticketId)?.mandate.actor
      const userId = actor?.source === ALONG_SOURCE ? actor.id : undefined
      if (userId === undefined) return undefined
      // A create-work starts without a goal. Once its validated ChangeSet created one, subsequent reads,
      // replies and task adjustments bind to that same goal; the worker still cannot choose another id.
      const createdGoal = row.goalId === undefined ? store.changeSetsByWork(row.workId)
        .find(change => change.status === 'applied' && change.goalId !== undefined)?.goalId : undefined
      return { userId, allowedGoalId: row.goalId ?? createdGoal, ticketId, assignmentId: row.assignmentId, workId: row.workId,
        triggerEventId: row.eventId }
    },
    /** Bounded trace of `decision.recorded` events (§2.5.2: 记入追踪日志，不建行). */
    trace(): readonly string[] { return [...trace] },
    /** Recent mapping write failures when no `report` sink is wired (§2.5 错误路径). */
    errors(): readonly unknown[] { return [...errors] },
  }
}

export type WorkLinkModule = ReturnType<typeof createWorkLink>
