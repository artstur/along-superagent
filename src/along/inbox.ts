/**
 * The inbox receive state machine (design §2.2, 001 §4.1/§4.3): the one entry through which a phone event
 * becomes durable business state. Everything — the dedup decision, the business write, the delivery queue row
 * and the Inbox row itself — happens inside a single `store.atomic` savepoint, so the persistent receipt is only
 * returned after the transaction committed (BC-08-01); any failure rolls the whole thing back and no receipt is
 * sent. The judgment order is fixed (§2.2.1): explicit refusals before schema parsing (a0), schema (a), kind
 * range (b), ownership (c), dedup/conflict against accepted rows only (d), per-type business writes (e), the
 * delivery enqueue with the D15 `authorization.changed` exception (f), then the receipt (g).
 *
 * Dedup is anchored on `(user_id, event_id)` with the client-declared fields' stable hash (§2.2.8): same hash →
 * `duplicate`, different hash → `conflict` — and **only** accepted rows dedupe. A retry of a rejected event
 * answers `rejected` again with its original reason: a refused event must never read as received, or the
 * client would delete its queued item and silently lose the message (BC-08-02). The row records the precise
 * internal reason (「拒绝原因可查」) while the external receipt unifies ownership refusals as `not_found`
 * (§4.2 — missing and foreign share one code, no existence leak, BC-07-05).
 *
 * Health summaries are saved with the adapter derived here from the D5 seven-type list — never from a client
 * claim (§2.2.4); unknown types are stored as `pending` and never enter a model context. Goal changes can only
 * arrive through chat (D4): `along.goal.updated`/`along.goal.archived` are refused before parsing
 * (`client_goal_mutation`), and the envelope schema has no goal-mutation payload at all.
 */
import { EVENT_ID_SHAPE, EVENT_SCHEMA_VERSION, EventEnvelopeSchema, HEALTH_SUMMARY_TYPES, MESSAGE_KINDS, payloadHash,
  type BoundIdentity, type EventEnvelope, type EventReceipt, type HealthSummaryPayload } from './envelope.ts'
import { OwnershipError, type AlongStore, type InboxEventInput } from './store.ts'

/** Goal mutation is a chat concern (D4): no client event may carry it (BC-01-06's refusal lives here). */
const CLIENT_FORBIDDEN_EVENT_TYPES = new Set(['along.goal.updated', 'along.goal.archived'])
/** Ownership refusals answer `not_found` like a missing resource (§2.2.1c/§4.2); every other reason passes through. */
const externalReason = (reason: string): string => reason === 'ownership' ? 'not_found' : reason

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const legalId = (value: unknown): string | undefined =>
  typeof value === 'string' && EVENT_ID_SHAPE.test(value) ? value : undefined

/** A rejected row keeps what can be salvaged from the raw body for the audit trail; every field is coerced
 * defensively because the envelope may be arbitrary (invalid) input. */
function rejectedRow(raw: Record<string, unknown> | undefined, input: unknown, eventId: string,
  identity: BoundIdentity, receivedAt: string, reason: string): InboxEventInput {
  const baseRevision = typeof raw?.base_revision === 'number' && Number.isInteger(raw.base_revision) && raw.base_revision >= 0
    ? raw.base_revision : undefined
  return {
    userId: identity.userId, eventId,
    schemaVersion: typeof raw?.schema_version === 'string' ? raw.schema_version : EVENT_SCHEMA_VERSION,
    eventType: typeof raw?.event_type === 'string' ? raw.event_type : 'unknown',
    deviceId: identity.deviceId, kind: typeof raw?.kind === 'string' ? raw.kind : undefined,
    goalId: legalId(raw?.goal_id), taskId: legalId(raw?.task_id),
    occurredAt: typeof raw?.occurred_at === 'string' ? raw.occurred_at : undefined,
    receivedAt, timezone: typeof raw?.timezone === 'string' ? raw.timezone : undefined,
    messageId: legalId(raw?.message_id), causationId: legalId(raw?.causation_id), baseRevision,
    payload: raw ?? input, payloadHash: payloadHash(raw), status: 'rejected', rejectReason: reason,
  }
}

/**
 * Saves one row per summary type with the server-derived adapter (§2.2.4): types on the D5 list are `known`,
 * everything else `pending` — saved, but never returned into a model context. The wire payload is snake_case;
 * the store's structural input is camelCase, so this is the single adaptation point.
 */
function saveHealthSummaries(store: AlongStore, userId: string, envelope: EventEnvelope): void {
  const adapt = (summaries: readonly HealthSummaryPayload[]) => summaries.map(summary => ({
    type: summary.type, metricVersion: summary.metric_version, unit: summary.unit, statistic: summary.statistic,
    window: summary.window, timezone: summary.timezone, value: summary.value, availability: summary.availability,
    summarizerVersion: summary.summarizer_version,
  }))
  const knownTypes = HEALTH_SUMMARY_TYPES as readonly string[]
  const summaries = envelope.payload.event_type === 'along.health_summary_updated' ? envelope.payload.summaries : []
  const known = summaries.filter(summary => knownTypes.includes(summary.type))
  const pending = summaries.filter(summary => !knownTypes.includes(summary.type))
  const event = { eventId: envelope.event_id, timezone: envelope.timezone }
  if (known.length !== 0) store.saveHealthSummary(userId, { ...event, payload: { summaries: adapt(known) } }, 'known')
  if (pending.length !== 0) store.saveHealthSummary(userId, { ...event, payload: { summaries: adapt(pending) } }, 'pending')
}

/**
 * The inbox module factory (§2.2): one instance per Along service, over the shared `AlongStore`. `acceptEvent`
 * takes the raw request body — the interface layer may have forwarded an arbitrary JSON value, so every
 * classification here starts from the untrusted input. The facade's structural contract (`AlongInboxModule`)
 * is satisfied without importing it (§4.3: factories depend on the store one-way only).
 */
export function createInbox(store: AlongStore): { acceptEvent(input: unknown, identity: BoundIdentity): EventReceipt } {
  return {
    acceptEvent(input, identity) {
      // One savepoint for the whole machine: dedup, business rows, the delivery queue row and the Inbox row
      // commit together or not at all (BC-08-01; a thrown error rolls everything back and no receipt is sent).
      return store.atomic(() => {
        const raw = isRecord(input) ? input : undefined
        const rawEventId = legalId(raw?.event_id)
        const receivedAt = new Date().toISOString()
        /** Falls the rejected row (when a legal event id anchors it) and answers the unified external reason. */
        const reject = (reason: string, eventId: string | undefined): EventReceipt => {
          if (eventId !== undefined) store.saveInboxEvent(rejectedRow(raw, input, eventId, identity, receivedAt, reason))
          return { status: 'rejected', event_id: eventId ?? '', reason: externalReason(reason) }
        }

        // a0 — explicit refusals before parsing (§2.2.1a0): goal mutation is chat-only (D4/BC-01-06) and a body
        // claiming identity must never reach the schema (BC-07-04; the interface layer refuses first, this
        // keeps the same check for direct callers).
        if (typeof raw?.event_type === 'string' && CLIENT_FORBIDDEN_EVENT_TYPES.has(raw.event_type)) {
          return reject('client_goal_mutation', rawEventId)
        }
        if (raw !== undefined && ('user_id' in raw || 'device_id' in raw)) return reject('identity_in_body', rawEventId)

        // a — the envelope schema is the authority; a refusal with a legal event id falls a rejected row, and
        // one without an anchor answers 400 without a row (§2.2.1a).
        const parsed = EventEnvelopeSchema.safeParse(input)
        if (!parsed.success) return reject('invalid_envelope', rawEventId)
        const envelope = parsed.data

        // b — kind range, read off the envelope (§2.2.1b; the same口径 as `src/sources/along.ts`'s scope). The
        // schema's enum already restricts kinds, so this guards the range against future schema loosening.
        if (envelope.kind !== undefined && !(MESSAGE_KINDS as readonly string[]).includes(envelope.kind)) {
          return reject('unsupported_kind', envelope.event_id)
        }

        // c — ownership before anything else touches business rows (BC-07-05's receiving side): a missing or
        // foreign goal/task is the same refused row, externally `not_found`.
        const feedback = envelope.payload.event_type === 'along.message' && envelope.payload.kind !== 'authorization.changed'
          ? envelope.payload : undefined
        let feedbackTask
        try {
          if (envelope.goal_id !== undefined) store.assertGoalOwner(identity.userId, envelope.goal_id)
          if (envelope.task_id !== undefined) store.assertTaskOwner(identity.userId, envelope.task_id)
          if (feedback !== undefined && feedback.task_id !== undefined && feedback.task_id !== envelope.task_id) {
            store.assertTaskOwner(identity.userId, feedback.task_id)
          }
          if (feedback !== undefined && feedback.task_id !== undefined) feedbackTask = store.assertTaskOwner(identity.userId, feedback.task_id)
        } catch (error) {
          if (!(error instanceof OwnershipError)) throw error
          return reject('ownership', envelope.event_id)
        }

        // d — dedup against **accepted** rows only (§2.2.1d): same hash → duplicate (BC-08-03), different hash →
        // conflict (001 §4.3). A rejected row is re-refused with its original reason — never masked as received.
        const existing = store.findInboxEvent(identity.userId, envelope.event_id)
        if (existing !== undefined) {
          if (existing.status === 'accepted') {
            return existing.payloadHash === payloadHash(envelope)
              ? { status: 'duplicate', event_id: envelope.event_id }
              : { status: 'conflict', event_id: envelope.event_id }
          }
          return { status: 'rejected', event_id: envelope.event_id, reason: externalReason(existing.rejectReason ?? 'invalid_envelope') }
        }

        // e — business writes for the accepted branch; the user row is asserted first (pairing usually created
        // it; direct calls must not strand rows without their owner).
        store.assertUser(identity.userId, identity.deviceId)
        let goalId = envelope.goal_id
        let conversationRoot: string | undefined
        if (envelope.payload.event_type === 'along.user_message' && envelope.causation_id !== undefined) {
          try {
            conversationRoot = store.conversationRoot(identity.userId, envelope.causation_id)
            const associated = store.conversationGoal(identity.userId, conversationRoot)
            if (associated !== undefined && goalId !== undefined && associated !== goalId) return reject('ownership', envelope.event_id)
            goalId ??= associated
          } catch (error) {
            if (!(error instanceof OwnershipError)) throw error
            return reject('ownership', envelope.event_id)
          }
        }
        let receivedSeq: number | undefined
        if (envelope.payload.event_type === 'along.user_message') {
          // 原文先保存（BC-08-11, 001 §4.1）— the message row is the durable conversation, `seq` the only order.
          const message = store.appendMessage({ userId: identity.userId, eventId: envelope.event_id,
            role: 'user', direction: 'inbound', text: envelope.payload.text,
            occurredAt: envelope.occurred_at, timezone: envelope.timezone,
            messageId: envelope.message_id, causationId: conversationRoot ?? envelope.causation_id })
          receivedSeq = message.seq
          // With a goal (already ownership-checked): direct link + immediate input-version raise (001 §7.4).
          // Without one: no link, no raise — a new goal is born from evaluation and back-links the message at
          // commit time (§2.2.1e/§2.3.2); the message is never dropped.
          if (goalId !== undefined) {
            store.linkMessageToGoals(message.id, [goalId], 'direct')
            store.raiseInputVersion(identity.userId, goalId, envelope.event_id)
          }
          store.appendSync({ userId: identity.userId, kind: 'message', goalId, messageId: message.id,
            payload: { message_id: message.id, event_id: envelope.event_id, role: 'user', text: message.text } })
        } else if (envelope.payload.event_type === 'along.health_summary_updated') {
          saveHealthSummaries(store, identity.userId, envelope)
        } else if (feedback !== undefined && feedbackTask !== undefined) {
          // Completion/feedback facts land their own message row keyed by the event id — sharing the client
          // `message_id` with the original never collides (§2.2.6). The text falls back server-side so the
          // non-empty constraint always has a source.
          const text = feedback.note !== undefined && feedback.note.trim() !== '' ? feedback.note
            : feedback.kind === 'task.completed' ? `任务完成反馈：${feedbackTask.content}` : '任务反馈'
          const message = store.appendMessage({ userId: identity.userId, eventId: envelope.event_id,
            role: 'user', direction: 'inbound', audience:'background', text, occurredAt: envelope.occurred_at, timezone: envelope.timezone,
            messageId: envelope.message_id, causationId: envelope.causation_id,
            replyToMessageId: feedback.reply_to_message_id })
          receivedSeq = message.seq
          if (feedback.kind === 'task.completed') {
            // A fact, not a goal edit (D4): status flips to done and the version advances deterministically —
            // no ChangeSet, `basis_changeset` stays NULL so agent-driven and fact-driven revisions stay apart.
            store.appendTaskRevision({ taskId: feedbackTask.id, userId: identity.userId, status: 'done',
              completedFeedbackEventId: envelope.event_id, originEventId: envelope.event_id })
          }
          // `task.feedback` changes no status and raises no version — its meaning is Stage B's Worker's to judge.
        }
        // `authorization.changed` (D15): accepted and recorded in the Inbox row only — no business write, no
        // delivery, never a failure; the revocation workflow itself is explicitly out of Stage A.

        // f — queue for delivery with the stable Trigger id (§4.6; DSH dedupes on it), except the D15 kind:
        // authorization.changed is never delivered, so its row carries no trigger id at all.
        const deliver = envelope.kind !== 'authorization.changed' && envelope.event_type !== 'along.health_summary_updated'
        const triggerId = deliver ? `along:${identity.userId}:${envelope.event_id}` : undefined
        if (deliver) store.enqueueDelivery(identity.userId, envelope.event_id, triggerId!)

        // g — the Inbox row commits with the business rows; only now is the persistent receipt returned.
        store.saveInboxEvent({ userId: identity.userId, eventId: envelope.event_id, schemaVersion: envelope.schema_version,
          eventType: envelope.event_type, deviceId: identity.deviceId, kind: envelope.kind, goalId,
          taskId: envelope.task_id, occurredAt: envelope.occurred_at, receivedAt, timezone: envelope.timezone,
          messageId: envelope.message_id, causationId: envelope.causation_id, baseRevision: envelope.base_revision,
          payload: envelope.payload, payloadHash: payloadHash(envelope), status: 'accepted', triggerId })
        return { status: 'accepted', event_id: envelope.event_id, ...(receivedSeq !== undefined ? { received_seq: receivedSeq } : {}) }
      })
    },
  }
}

export type InboxModule = ReturnType<typeof createInbox>
