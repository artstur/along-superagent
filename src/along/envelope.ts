/**
 * The Along event envelope (design §4.1/§4.6, inbox module §2.2): the schema both ends of the pipeline speak —
 * the iPhone assembles it (`along/web/event-envelope.mjs`, a JS port of the same semantics, aligned by the
 * static case vectors pinned in `tests/along-inbox.spec.ts` and `along/test/event-queue.test.mjs`), the loopback
 * API forwards it, and the inbox receive state machine validates it before anything touches the business store.
 *
 * Identity never travels in the envelope: `user_id`/`device_id` are bound server-side from the Host's pairing
 * session (§4.2, BC-07-04) and `adapter` for health summaries is derived server-side from the D5 seven-type
 * list (§2.2.4) — the schema's `.strict()` refuses every such field, so a client cannot smuggle them in.
 * `received_at` is likewise server-bound (§2.2.8: it never participates in `payloadHash`, which covers the
 * client-declared fields only — the anchor for same-id dedup/conflict decisions, 001 §4.3).
 *
 * `envelopeForTrigger` maps an accepted envelope onto the core `Trigger` (§4.6): stable id `along:<user>:<event>`
 * (the delivery dedup key on the DSH side, `src/core/intake.ts`), `human` only for a person's chat message
 * (health updates and task facts are never disguised as a person, 001 §7.1, SD-6), and the smallest inline text
 * an evaluation can read. The thread id arrives as a parameter — its naming is the worklink wiring's owner
 * (`src/sources/along.ts` `alongThreads`, §2.5).
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { isoTime, type Trigger } from '../core/index.ts'
import { ALONG_SOURCE } from './worklink.ts'

export const EVENT_SCHEMA_VERSION = '1'
/** `along.goal.updated`/`along.goal.archived` are refused before parsing (client_goal_mutation, §2.2.1a0) —
 * goals change only through chat (D4), so no client event type exists for them. */
export const EVENT_TYPES = ['along.user_message', 'along.health_summary_updated', 'along.message'] as const
/** Only `along.message` events carry a kind; the range matches `src/sources/along.ts`'s scope口径. */
export const MESSAGE_KINDS = ['task.completed', 'task.feedback', 'authorization.changed'] as const
/**
 * The D5 seven health types (`ios/AlongHealth/Sources/HealthKitReader.swift` sampleTypes, design §2.2.4): the
 * receiver derives `adapter` from this list — a summary of one of these is `known`, anything else `pending`
 * (saved but never returned into a model context). Never trusted from the client.
 */
export const HEALTH_SUMMARY_TYPES = ['steps', 'workout', 'active_energy', 'weight', 'resting_heart_rate', 'wrist_temperature', 'sleep'] as const

/** Client stable ids (`event_id`/`goal_id`/… §4.1); the inbox also tests raw bodies against this before a
 * rejected row can be anchored to an event id (§2.2.1a). */
export const EVENT_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/
export const EVENT_ID_SCHEMA = z.string().regex(EVENT_ID_SHAPE)
export const EVENT_ISO_SCHEMA = z.string().refine(value => Number.isFinite(Date.parse(value)))

/** One health summary on the wire (001 §4.4): typed aggregate — never a raw HealthKit sample. `value` is the
 * JSON aggregate; 「实际为零」 is `availability: 'ok'` with `value` 0, distinguishable from the other three states. */
export const HealthSummaryPayloadSchema = z.object({
  type: z.string().min(1).max(64),
  metric_version: z.string().min(1).max(64),
  unit: z.string().min(1).max(16).optional(),
  statistic: z.string().min(1).max(32).optional(),
  window: z.union([z.object({ start: EVENT_ISO_SCHEMA, end: EVENT_ISO_SCHEMA }).strict(), z.object({ night: EVENT_ISO_SCHEMA }).strict()]).optional(),
  timezone: z.string().min(1).max(64),
  value: z.unknown().optional(),
  availability: z.enum(['ok', 'no_permission', 'unavailable', 'not_synced']),
  summarizer_version: z.string().min(1).max(64),
}).strict()

/** Payload rules inside the discriminated union (design §4.1 FeedbackPayloadRefine): a completion/feedback
 * names its task; `authorization.changed` carries no business payload at all (D15: recorded, not acted on).
 * `text` is tightened beyond §4.1's `min(1)`: whitespace-only text would otherwise pass the schema and fail the
 * store's non-empty message constraint mid-transaction (校验只加严，失败前移到 Schema 层). */
const PayloadSchema = z.discriminatedUnion('event_type', [
  z.object({ event_type: z.literal('along.user_message'),
    text: z.string().min(1).max(800).refine(value => value.trim() !== '') }).strict(),
  z.object({ event_type: z.literal('along.health_summary_updated'),
    summaries: z.array(HealthSummaryPayloadSchema).min(1).max(20) }).strict(),
  z.object({ event_type: z.literal('along.message'), kind: z.enum(MESSAGE_KINDS), task_id: EVENT_ID_SCHEMA.optional(),
    completed_at: EVENT_ISO_SCHEMA.optional(), note: z.string().max(500).optional(),
    reply_to_message_id: EVENT_ID_SCHEMA.optional() }).strict(),
]).superRefine((payload, ctx) => {
  if (payload.event_type !== 'along.message') return
  if (payload.kind === 'authorization.changed') {
    for (const field of ['task_id', 'completed_at', 'note', 'reply_to_message_id'] as const) {
      if (payload[field] !== undefined) ctx.addIssue({ code: 'custom', message: `authorization.changed carries no ${field}`, path: [field] })
    }
    return
  }
  if (payload.task_id === undefined) ctx.addIssue({ code: 'custom', message: `${payload.kind} requires task_id`, path: ['task_id'] })
})

const EventEnvelopeObject = z.object({
  event_id: EVENT_ID_SCHEMA, // 重试同号
  schema_version: z.literal(EVENT_SCHEMA_VERSION),
  event_type: z.enum(EVENT_TYPES),
  kind: z.enum(MESSAGE_KINDS).optional(), // 仅 along.message（EnvelopeCrossRefine ②）
  goal_id: EVENT_ID_SCHEMA.optional(), // 服务端做归属检查；健康事件可不带 goal_id
  task_id: EVENT_ID_SCHEMA.optional(),
  occurred_at: EVENT_ISO_SCHEMA, // 仅展示；排序不信任（BC-08-07）
  timezone: z.string().min(1).max(64),
  message_id: EVENT_ID_SCHEMA.optional(), // 关联对话与展示；不参与 message 主键（§2.2.6）
  causation_id: EVENT_ID_SCHEMA.optional(), // 关联原消息/前置事件（防循环）
  base_revision: z.number().int().min(0).optional(), // 提交时看到的业务版本（可空）
  payload: PayloadSchema,
}).strict()

/**
 * Cross-field consistency (§4.1 EnvelopeCrossRefine, mirrored by the web port's static vectors): ① the payload's
 * discriminator must equal the top-level event_type — a mismatched envelope would otherwise fail later with a
 * misleading reason; ② only `along.message` may carry `kind`, and the top-level kind must equal the payload's;
 * stray kinds on other event types are refused.
 */
export const EventEnvelopeSchema: z.ZodType<EventEnvelope> = EventEnvelopeObject.superRefine((envelope, ctx) => {
  const payload = envelope.payload
  if (payload.event_type !== envelope.event_type) {
    ctx.addIssue({ code: 'custom', message: 'payload.event_type does not match envelope event_type', path: ['payload'] })
  }
  if (payload.event_type === 'along.message') {
    if (envelope.kind !== payload.kind) {
      ctx.addIssue({ code: 'custom', message: 'envelope.kind does not match payload.kind', path: ['kind'] })
    }
  } else if (envelope.kind !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'kind is only allowed on along.message events', path: ['kind'] })
  }
})

export type EventEnvelope = z.infer<typeof EventEnvelopeObject>
export type EventPayload = EventEnvelope['payload']
export type HealthSummaryPayload = z.infer<typeof HealthSummaryPayloadSchema>
export type EventEventType = EventEnvelope['event_type']
export type EventMessageKind = EventEnvelope['kind'] & string

/** Server-complete envelope: `received_at` is bound by the receiver at accept time (§4.6 `at`), never declared
 * by the client and never hashed (§2.2.8). */
export interface ReceivedEnvelope extends EventEnvelope { received_at: string }

/** The Host's server-bound pairing identity (§4.2): the envelope never carries it. */
export interface BoundIdentity { userId: string; deviceId: string }

/** Persistent receive receipt (§2.2/§4.2): 200 accepted/duplicate, 409 conflict, 400 rejected. `received_seq`
 * rides along when the event produced a conversation row. */
export type EventReceipt = { status: 'accepted' | 'duplicate' | 'conflict' | 'rejected'; event_id: string; received_seq?: number; reason?: string }

// ---- payloadHash (§2.2.8) -----------------------------------------------------------------------------------------------

/** Client-declared fields — the fixed hash coverage; server-bound identity headers and `received_at` are out. */
const HASH_FIELDS = ['event_id', 'schema_version', 'event_type', 'kind', 'goal_id', 'task_id', 'occurred_at',
  'timezone', 'message_id', 'causation_id', 'base_revision', 'payload'] as const

/** Key order-insensitive JSON so the same envelope always serializes to the same bytes (mirrors the changeset
 * module's helper and the web port byte-for-byte; both ends' static vectors pin it). */
const stableJson = (value: unknown): string => {
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * sha256 over the client-declared fields present on the envelope, sorted by key (§2.2.8). The server compares
 * this against the stored row's hash: same → `duplicate`, different → `conflict` (only for accepted rows,
 * §2.2.1d). The client must retry the same serialized envelope or its re-sends would read as conflicts.
 * Also accepts raw (invalid) bodies so the rejected-row audit stores a stable hash for them too.
 */
export function payloadHash(envelope: EventEnvelope | Record<string, unknown> | unknown): string {
  const source = envelope !== null && typeof envelope === 'object' && !Array.isArray(envelope)
    ? envelope as Record<string, unknown> : {}
  const input: Record<string, unknown> = {}
  for (const field of HASH_FIELDS) {
    if (source[field] !== undefined) input[field] = source[field]
  }
  return createHash('sha256').update(stableJson(input)).digest('hex')
}

// ---- Trigger mapping (§4.6) ---------------------------------------------------------------------------------------------

/** The smallest inline text an evaluation can read for non-chat events (§4.6 `summaryText`). Deterministic;
 * pinned by the inbox spec's trigger vectors. */
export function summaryText(payload: EventPayload): string {
  if (payload.event_type === 'along.health_summary_updated') {
    const parts = payload.summaries.map(summary => {
      const value = summary.availability === 'ok' && summary.value !== undefined ? ` ${stableJson(summary.value)}` : ''
      return `${summary.type} ${summary.availability}${value}`
    })
    return `健康摘要更新：${parts.join('，')}`
  }
  if (payload.event_type === 'along.message') {
    if (payload.kind === 'task.completed') return payload.note !== undefined ? `任务完成反馈：${payload.note}` : '任务完成反馈'
    if (payload.kind === 'task.feedback') return payload.note !== undefined ? `任务反馈：${payload.note}` : '任务反馈'
    return '授权状态已变化'
  }
  return '' // a chat message never goes through summaryText (the caller inlines payload.text)
}

/**
 * Maps an accepted envelope onto the core Trigger (§4.6): stable id `along:<user_id>:<event_id>` (the DSH-side
 * dedup key — a re-delivery of the same event hits intake's `'duplicate'`), the thread id comes from the
 * worklink-owned naming (`src/sources/along.ts` `alongThreads`), `human` only for a person's chat message, and
 * `meta` carries the server fields adapters and worklink read back. The envelope must be server-complete
 * (`received_at` bound); `at` is the receive time, never the client clock.
 */
export function envelopeForTrigger(envelope: ReceivedEnvelope, identity: BoundIdentity, threadId: string): Trigger {
  // The cross-field refine (§4.1 EnvelopeCrossRefine) guarantees payload.event_type === event_type, so the
  // payload's discriminator narrows both — the envelope's own field is the runtime-equal twin of it.
  const payload = envelope.payload
  return {
    id: `along:${identity.userId}:${envelope.event_id}`,
    source: ALONG_SOURCE,
    threads: [{ source: ALONG_SOURCE, id: threadId }],
    actor: { source: ALONG_SOURCE, id: identity.userId },
    human: payload.event_type === 'along.user_message',
    ...(payload.event_type === 'along.user_message' ? { addressed: 'direct' as const } : {}),
    at: isoTime(envelope.received_at),
    text: payload.event_type === 'along.user_message' ? payload.text : summaryText(payload),
    meta: {
      event_type: envelope.event_type,
      ...(envelope.kind !== undefined ? { kind: envelope.kind } : {}),
      ...(envelope.goal_id !== undefined ? { goal_id: envelope.goal_id } : {}),
      ...(envelope.task_id !== undefined ? { task_id: envelope.task_id } : {}),
      ...(envelope.message_id !== undefined ? { message_id: envelope.message_id } : {}),
      ...(envelope.causation_id !== undefined ? { causation_id: envelope.causation_id } : {}),
      schema_version: envelope.schema_version,
    },
  }
}
