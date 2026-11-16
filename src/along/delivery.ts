/**
 * The delivery pump (design §2.2.2, SD-8): the durable `delivery` rows queued by the inbox are fed into the DSH
 * core at least once, from an in-process timer. The queue lives in along.sqlite because BC-08-01 requires the
 * Inbox row, the business rows and the pending delivery to commit in one transaction — no external queue could
 * do that. At-least-once is safe because the DSH side dedupes on the stable Trigger id (`src/core/intake.ts`:
 * a re-delivered id answers `'duplicate'`), so a redelivery never creates a second ticket (BC-08-03).
 *
 * Per pass the pump claims due rows (`status IN ('pending','failed') AND next_attempt_at <= now`; the claim
 * itself presets a 30s lease so a crashed process's claims expire back into the scan), rebuilds the Trigger
 * from the accepted Inbox row — thread naming re-resolved through the worklink-owned wiring
 * (`src/sources/along.ts` `alongThreads`) with the store-backed association context, since delivery time is
 * when intake actually routes — and awaits `receive` to completion before advancing anything
 * (`src/sources/host.ts` receive contract). `'stored'` and `'duplicate'` are both delivered; `'filtered'` is
 * terminal (the Source scope refused — retrying could never succeed, so the row is closed with the scope's
 * reason); anything thrown is a failed attempt with exponential backoff owned by the store, turning `failed`
 * after 12 attempts with a slow 10-minute cadence and a one-time user-visible failure sync (§2.2.3).
 *
 * Shutdown aborts the timer; claimed-but-unfinished rows keep their lease and expire back into the scan, so
 * restarts continue the delivery (BC-09-04: no data is cleared on a rollback of the link switch either).
 */
import { isoTime, type ReceiveResult, type Trigger } from '../core/index.ts'
import { alongThreads } from '../sources/along.ts'
import { envelopeForTrigger, type EventMessageKind, type ReceivedEnvelope } from './envelope.ts'
import type { AlongStore, DeliveryRow, InboxEventRow } from './store.ts'

/** Pump cadence (§2.2.2 — the stage-0 chosen in-process timer; 004 §3). */
export const DELIVERY_INTERVAL_MS = 1_000
/** Rows claimed per pass; the 1s cadence keeps latency low and the lease keeps crashed claims bounded. */
const DELIVERY_BATCH = 10

/** Host dependencies of the pump (§2.2.2): `receive` is the SourceContext's receive (Engine intake), and
 * `filteredReason` reads the scope refusal back from the orchestrator store's disposition. */
export interface DeliveryDeps {
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
  filteredReason(triggerId: string): string | undefined
  /** Error sink for pump-level surprises (row-less triggers, sink failures); per-row attempt failures are
   * already durable on the delivery row. Never throws into the pump loop. */
  report?: (error: unknown) => void
}

const reportQuiet = (deps: DeliveryDeps, error: unknown): void => {
  try { deps.report?.(error) } catch { /* the sink must not break the pump */ }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Rebuilds the server-complete envelope from the stored Inbox row (§4.1 + server-bound `received_at`). */
function receivedEnvelopeOf(event: InboxEventRow): ReceivedEnvelope {
  const payload = isRecord(event.payload) ? event.payload : {}
  return {
    event_id: event.eventId,
    // Accepted rows only ever store the schema the receiver validated (§4.1 literal '1'); the row's column is
    // TEXT, so the rebuild asserts the literal the state machine guaranteed at accept time.
    schema_version: event.schemaVersion as ReceivedEnvelope['schema_version'],
    event_type: event.eventType as ReceivedEnvelope['event_type'],
    ...(event.kind !== undefined ? { kind: event.kind as EventMessageKind } : {}),
    ...(event.goalId !== undefined ? { goal_id: event.goalId } : {}),
    ...(event.taskId !== undefined ? { task_id: event.taskId } : {}),
    occurred_at: event.occurredAt ?? event.receivedAt,
    timezone: event.timezone ?? 'UTC',
    ...(event.messageId !== undefined ? { message_id: event.messageId } : {}),
    ...(event.causationId !== undefined ? { causation_id: event.causationId } : {}),
    ...(event.baseRevision !== undefined ? { base_revision: event.baseRevision } : {}),
    payload: payload as ReceivedEnvelope['payload'],
    received_at: event.receivedAt,
  }
}

/**
 * The Trigger of one queued delivery (§4.6): stable id `along:<user_id>:<event_id>`, thread re-resolved at
 * delivery time (that is when intake routes and fans out — a reply joins the work thread that is live *now*,
 * via the server-recorded association, never text similarity). A delivery row without its accepted Inbox row
 * is an integrity violation and fails like any other attempt.
 */
export function triggerForDelivery(store: AlongStore, row: DeliveryRow): Trigger {
  const event = store.findInboxEvent(row.userId, row.eventId)
  if (event === undefined || event.status !== 'accepted') {
    throw new Error(`delivery ${row.triggerId} has no accepted inbox row to deliver`)
  }
  const payload = isRecord(event.payload) ? event.payload : {}
  const replyTo = event.eventType === 'along.message' && typeof payload.reply_to_message_id === 'string'
    ? payload.reply_to_message_id : undefined
  const threadId = alongThreads({ event_id: event.eventId, event_type: event.eventType, kind: event.kind,
    goal_id: event.goalId, causation_id: event.causationId, ...(replyTo !== undefined ? { reply_to_message_id: replyTo } : {}) },
    row.userId, {
      associatedGoal: (owner, eventId) => store.findInboxEvent(owner, eventId)?.goalId,
      openWorks: goalId => store.workLinksForGoal(goalId),
    })[0]?.id
  if (threadId === undefined) throw new Error(`delivery ${row.triggerId} produced no thread`)
  return envelopeForTrigger(receivedEnvelopeOf(event), { userId: event.userId, deviceId: event.deviceId }, threadId)
}

/**
 * One delivery pass: claim due rows, deliver each into `deps.receive`, and close the row per the outcome.
 * Returns the number of rows claimed (0 when idle). Exported beside `startDeliveryPump` so tests drive the
 * pump deterministically without timers.
 */
export async function deliverDueDeliveries(store: AlongStore, deps: DeliveryDeps, now = Date.now()): Promise<number> {
  const rows = store.claimDueDeliveries(now, DELIVERY_BATCH)
  for (const row of rows) {
    const at = isoTime(new Date().toISOString())
    try {
      const result = await deps.receive(triggerForDelivery(store, row))
      if (result === 'filtered') {
        // Terminal: the scope refused (Source uninstalled/disabled, `listened:false`) — record the reason and
        // never retry; a user message still gets its one-time explicit failure sync (§2.2.3).
        store.markDeliveryFiltered(row.triggerId, at, deps.filteredReason(row.triggerId) ?? 'filtered')
      } else {
        // 'stored' and 'duplicate' both mean delivered — the DSH dedup is the idempotence that makes
        // at-least-once safe (BC-08-03); the cursor only advances after receive completed.
        store.markDelivered(row.triggerId, at)
      }
    } catch (error) {
      reportQuiet(deps, error)
      try { store.recordDeliveryFailure(row.triggerId, at, error instanceof Error ? error.message : String(error)) }
      catch (sinkError) { reportQuiet(deps, sinkError) }
    }
  }
  return rows.length
}

/**
 * Starts the pump (§2.2.2): a 1s in-process timer over `deliverDueDeliveries`, single-flight (a pass that is
 * still awaiting `receive` skips its ticks), aborted by `signal`. Returns the stopper; stopping leaves claimed
 * rows on their lease to expire back into the scan — restarts continue delivery (at-least-once).
 */
export function startDeliveryPump(store: AlongStore, deps: DeliveryDeps, signal: AbortSignal): () => void {
  let running = false
  let stopped = signal.aborted
  const tick = (): void => {
    if (running || stopped || signal.aborted) return
    running = true
    void deliverDueDeliveries(store, deps)
      .catch(error => reportQuiet(deps, error))
      .finally(() => { running = false })
  }
  const timer = setInterval(tick, DELIVERY_INTERVAL_MS)
  timer.unref?.()
  const stop = (): void => { stopped = true; clearInterval(timer) }
  if (signal.aborted) { stop(); return stop }
  signal.addEventListener('abort', stop, { once: true })
  tick()
  return stop
}
