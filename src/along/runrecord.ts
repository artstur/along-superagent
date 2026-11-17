/**
 * The record module (design §2.6, D7): the host registers one execution record (RunRecord) per Worker
 * assignment from domain events alone — never a model call (003 §2 阶段 A 验收③「每次 Worker 结束都有执行
 * 记录且未调用模型」).
 *
 * Subscription (§2.6.1, the worklink module's mechanism §2.5.1): the Runtime (integration module, §2.7.2)
 * dispatches each committed Engine event through the orchestrator store's `afterCommit` into
 * `onDomainEvent`, so a rolled-back Engine transaction leaves no row and a committed one always lands.
 * Only the lifecycle facts register — `assignment.started` (ensure the row), `assignment.ended`
 * (finalize the replaced assignment; the Engine emits it on the retry/restart paths, `tickets.ts:172,319`)
 * and `ticket.ended` (finalize the latest assignment — the normal Worker end: the Engine ends the
 * assignments with the ticket and emits only `ticket.ended`, `tickets.ts:353-357`, so the finalize reads
 * the ticket's `latestReport` and `latestAssignment`, exactly the §2.6.1 reads). The
 * `inputsDelivered/turnEnded` middle facts carry no domain events and no registration granularity a
 * review needs (§2.6.1; Stage E replay reads DSH Store detail). Rows are written only for tickets the
 * worklink module mapped (an Along work): other Sources carry no business object to reference, and the
 * BC-05-01 fields would all be NULL. A `ticket.ended` for an assignment that never started (no
 * `assignment.started` row exists) registers nothing — the record is about an execution, not the ticket.
 *
 * The registered fields are BC-05-01's (§2.6.2): the assignment (`ticket_id`/`assignment_id`), the trigger
 * event via the WorkLink reverse lookup (`user_id`/`work_id`/`goal_id`/`task_id`/`trigger_event_id` — the
 * user from the ticket's Along mandate actor, the rest from the mapping row), the prompt revisions the
 * worker session worked with (`KV.sessions.prompts`, `kv.ts:35` — the Stage A placeholder column for a
 * Stage E Skill version chain, 勿按列名误读), the tool-trace reference (worker session id + assignment id,
 * a reference into the DSH session records, never a copy), the result (`latestReport`'s state/summary,
 * `model.ts:336` — the ending assignment is the latest one whenever a finalize fires), and the ChangeSet
 * link (the last changeset written under the work id, §4.4). The `UNIQUE(ticket_id, assignment_id)`
 * upsert (§3) converges the `assignment.started` ensure, the finalizes and any later re-registration of
 * the same assignment on one row (`rr:<ticket>:<assignment>`).
 *
 * The module also owns the system-side execution note (§2.6.2): at the Worker end it lands the result's
 * state/summary as one `direction='outbound'`/`role='assistant'` message row with a deterministic id
 * (`msg:<user>:out:<ticket>:<assignment>` — re-registration never duplicates it), links it to the work's
 * goal (`message_goal_link`, derived), and appends one `message` sync item — with the inbound user
 * message this retains Stage A's complete audit. These execution notes are background records, never chat; the model chat reply's own row lands with
 * the Stage B wiring. Message, link and sync land in one `atomic()` transaction of the shared store (记录
 * 写入走「存储」同一服务层与事务): a failure rolls the note back whole, the error is contained (§2.6 错误
 * 路径), and the next event for the same assignment rewrites it.
 *
 * 红线 (D7): registration happens only in the host's domain-event callback with no model call — the spec
 * asserts the Stage A proxy (`controller.create` count diff 0 across the end + no new worker relay /
 * candidate prompt, §2.6.3); the DSH model-call counting business-test-cases §1.2 asks for is re-checked
 * with real counts at the Stage E review wiring. 复盘/记忆提取/Skill 整理 are Stage E scheduled batches
 * (D7) — no scheduling here. Registration failures neither retry nor block (§2.6 错误路径): they land in
 * the bounded `errors()` and the `report` sink (the `records` health entry, `src/sources/along.ts:12-17`)
 * and never rethrow into the committed DSH transaction. Logs record no token (003 §3).
 */
import { latestAssignment, latestReport } from '../core/model.ts'
import type { DomainEvent, Repositories } from '../core/ports.ts'
import { workerSessionId } from '../executor/dsh.ts'
import { ALONG_SOURCE } from './worklink.ts'
import type { AlongStore, RunRecordInput } from './store.ts'

/** The record module's input type; the owner is `AlongStore`'s write primitive (design §4.3 — the storage
 * module defines it, `store.ts:99`, and the record module re-exports it as its contract surface). */
export type { RunRecordInput, RunRecordRow } from './store.ts'

/** Host dependencies of the record module (design §2.6). */
export interface RunRecordDeps {
  /** The Along business store — the only writer of along.sqlite (storage module). */
  store: AlongStore
  /** The DSH repositories, read-only: the ticket lookup resolves the mandate actor and the latest report. */
  repo: Pick<Repositories, 'tickets'>
  /** The prompt revisions a session worked with (`KV.sessions.prompts`, `kv.ts:35`); the assembler wires
   * `sessionId => orchestratorStore.get(KV.sessions.prompts(sessionId))`. `undefined` (a session with no
   * bound revision yet) leaves the column untouched — the upsert keeps what an earlier write landed.
   * Optional dep: omitted leaves `prompt_revisions` unset (the Stage A placeholder column; Stage E
   * extends it to a Skill version chain). */
  prompts?: (sessionId: string) => readonly number[] | undefined
  /** Error sink for registration failures — the `records` health entry (§2.6 错误路径). Errors never
   * rethrow into the committed DSH transaction; with no sink, failures stay in the bounded `errors()`. */
  report?: (error: unknown) => void
}

const TRACE_LIMIT = 100
/** Outbound note summary cap (§2.6.2: the note is the report's 摘要, not the full model output). */
const NOTE_SUMMARY_LIMIT = 400
/** The deterministic outbound event id of one assignment's execution note (§2.6.2). */
const outboundEventId = (ticketId: string, assignmentId: string): string => `out:${ticketId}:${assignmentId}`
/** The tool-trace reference (§3 `tool_trace_ref`): worker session id + assignment id — a reference, not a copy. */
const toolTraceRef = (ticketId: string, assignmentId: string): string => `${workerSessionId(ticketId)}:${assignmentId}`
/** The execution note text (§2.6.2: report state/summary 摘要; a report-less end still tells the outcome). */
const noteText = (state: string | undefined, summary: string | undefined, reason: string): string => {
  const brief = summary === undefined ? undefined : summary.length > NOTE_SUMMARY_LIMIT ? `${summary.slice(0, NOTE_SUMMARY_LIMIT)}…` : summary
  if (state !== undefined && brief !== undefined) return `执行说明（${state}）：${brief}`
  if (brief !== undefined) return `执行说明：${brief}`
  return `执行说明：本次执行已结束（${reason}）`
}

/** The record module (design §2.6): one instance per Along service, assembled by the Runtime next to the
 * worklink module over the shared `AlongStore`; the host dispatches domain events into `onDomainEvent`
 * via `afterCommit`. */
export function createRunRecord(deps: RunRecordDeps) {
  const { store, repo } = deps
  const errors: unknown[] = []
  const record = (error: unknown): void => {
    errors.push(error)
    if (errors.length > TRACE_LIMIT) errors.shift()
    try { deps.report?.(error) } catch { /* the sink must not break the dispatch either */ }
  }
  /** The Along user a ticket works for: its mandate actor when Along-bound with an id (the worklink
   * module's `workScopeForTicket` resolution, §2.3.6) — without one there is no user-scoped row to write. */
  const userOf = (ticketId: string): string | undefined => {
    const actor = repo.tickets.get(ticketId)?.mandate.actor
    return actor !== undefined && actor.source === ALONG_SOURCE && actor.id !== '' ? actor.id : undefined
  }
  /** Ensures the assignment's row from the mapping row (`assignment.started`, §2.6.1). */
  const ensure = (ticketId: string, assignmentId: string): void => {
    const row = store.getWorkLink(ticketId)
    // Only Along-mapped work registers: other Sources have no business object to reference (§2.6.2).
    if (row === undefined) return
    store.recordRunRecord({ ticketId, assignmentId, userId: userOf(ticketId), workId: row.workId,
      goalId: row.goalId, taskId: row.taskId, triggerEventId: row.eventId,
      promptRevisions: deps.prompts?.(workerSessionId(ticketId)), toolTraceRef: toolTraceRef(ticketId, assignmentId) })
  }
  /** Finalizes the assignment's row with the result, ChangeSet link and end time, and lands the execution
   * note (`assignment.ended` and the normal Worker end at `ticket.ended`, §2.6.1/§2.6.2). */
  const finalize = (ticketId: string, assignmentId: string, at: string, reason: string): void => {
    const row = store.getWorkLink(ticketId)
    if (row === undefined) return
    const report = latestReport(repo.tickets.get(ticketId) ?? { assignments: [] })
    const changesets = store.changeSetsByWork(row.workId)
    const input: RunRecordInput = { ticketId, assignmentId, userId: userOf(ticketId), workId: row.workId,
      // A ticket accepted before its goal existed (the goal-create path, §2.3.6) maps with goal_id NULL; the
      // goal the work created lands in its ChangeSet, so the record and the execution note resolve it there —
      // otherwise BC-08-11's per-goal conversation would miss the note.
      goalId: row.goalId ?? changesets.find(changeset => changeset.goalId !== undefined)?.goalId, taskId: row.taskId,
      triggerEventId: row.eventId,
      promptRevisions: deps.prompts?.(workerSessionId(ticketId)), toolTraceRef: toolTraceRef(ticketId, assignmentId),
      reportState: report?.state, reportSummary: report?.summary,
      changesetId: changesets.at(-1)?.id, endedAt: at }
    store.recordRunRecord(input)
    writeExecutionNote(input, reason)
  }
  /** Lands the system-side execution note (§2.6.2): one outbound assistant message linked to the work's
   * goal plus one `message` sync — one `atomic()` of the shared store, and only when the note row is new,
   * so a replayed end writes nothing twice. */
  const writeExecutionNote = (input: RunRecordInput, reason: string): void => {
    const userId = input.userId
    if (userId === undefined) return
    const { ticketId, assignmentId, goalId } = input
    const via=repo.tickets.get(ticketId)?.mandate.basis.via
    // Automatic reports may contain private source/health context. RunRecord is the private audit;
    // only the separately validated task result is a mobile delivery, never this model summary.
    if(via&&['health','task_due','task_trigger_review','source_review','scheduled'].includes(via))return
    const eventId = outboundEventId(ticketId, assignmentId)
    store.atomic(() => {
      const id = `msg:${userId}:${eventId}`
      if (store.getMessage(userId, id) !== undefined) return
      const text = noteText(input.reportState, input.reportSummary, reason)
      const message = store.appendMessage({ userId, eventId, role: 'assistant', direction: 'outbound', audience:'background', text })
      if (goalId !== undefined) store.linkMessageToGoals(message.id, [goalId], 'derived')
      store.appendSync({ userId, kind: 'message', goalId, messageId: message.id,
        payload: { message_id: message.id, goal_id: goalId, direction: 'outbound', text, presentation: 'execution' } })
    })
  }
  return {
    /**
     * Host dispatch entry (§2.6.1): the Runtime wires `emit` → `store.afterCommit(() => runrecord.onDomainEvent(event))`
     * next to the worklink dispatch (§2.7.2), so a rolled-back Engine transaction leaves no RunRecord row
     * and a committed one always lands its registration. `assignment.started` ensures the row,
     * `assignment.ended` finalizes the replaced assignment (retry/restart), and `ticket.ended` finalizes
     * the latest assignment — the normal Worker end, whose report the ticket carries. Every other event
     * type is ignored — the middle execution facts carry no domain events and no registration granularity
     * a review needs (§2.6.1).
     */
    onDomainEvent(event: DomainEvent): void {
      try {
        if (event.type === 'assignment.started') ensure(event.data.ticketId, event.data.assignmentId)
        else if (event.type === 'assignment.ended') finalize(event.data.ticketId, event.data.assignmentId, event.at, event.data.reason)
        else if (event.type === 'ticket.ended') {
          const ticket = repo.tickets.get(event.data.ticketId)
          const assignment = ticket === undefined ? undefined : latestAssignment(ticket)
          // An assignment that never started has no execution to record (§2.6.1: the record is about a run).
          if (assignment !== undefined && store.getRunRecord(event.data.ticketId, assignment.id) !== undefined) {
            finalize(event.data.ticketId, assignment.id, event.at, event.data.reason ?? event.data.outcome)
          }
        }
      } catch (error) {
        record(error)
      }
    },
    /** Recent registration failures when no `report` sink is wired (§2.6 错误路径). */
    errors(): readonly unknown[] { return [...errors] },
  }
}

export type RunRecordModule = ReturnType<typeof createRunRecord>
