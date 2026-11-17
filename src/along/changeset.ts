/**
 * The version module (design §2.3, 001 §7.4/§8.3/§8.4): the ChangeSet schema, the four-layer validation
 * (schema → object relation → input version → business revision), the atomic auto-commit with version
 * advancement, evidence and sync records, and the idempotent replay. Write qualification is guaranteed here,
 * not by prompts (BC-08-04/05/09): a commit whose claimed `base_revision` or `input_version` is stale is
 * refused as `conflicted` without touching current state, and the check runs inside one `store.atomic`, so a
 * second concurrent commit against the same goal always loses the version comparison (SQLite single writer).
 *
 * Statuses are only applied / conflicted / invalid — there is no pending approval step (D3). Conflicted and
 * invalid commits write no business rows; only the changeset row itself records the status and reason for the
 * audit trail (BC-02-01/02), and the Worker continues from the latest state (001 §8.4). A resubmission under
 * the same idempotency key returns the original result and never replays the ops (BC-02-04).
 *
 * Validation ports the applicable checks of the old DSH chain at equal strength (SD-1; AGENTS.md §5: checks
 * may only be tightened): lengths, ranges and the custom-domain rule from `validateGoalReply`, the assignment
 * consistency (`target_mismatch`) from `requestedTargetFromMessage`, and the number-like target acceptance
 * from `numberLikeTarget` — all ported from `along/web/goal-agent-core.mjs:76,124,153` and pinned by static
 * test vectors in `tests/along-changeset.spec.ts`. Layout is not part of the ChangeSet protocol (SD-7).
 */
import { isResearchTaskContent } from './recommendation.ts'
import { z } from 'zod'
import { PLAN, declinesReminder, localWeekday, planError, publicPlan, singleOccurrence, supportsRecurrence, type PlanInput, type Repeat } from './reminder-plan.ts'
import { TASK_TRIGGER_SCHEMA, type TaskCapability, type TaskTriggerInput } from './task-trigger.ts'
import { hasDailyMandate } from './task-schedule.ts'
import { randomToken, type AlongStore, type ChangeSetRow, type ChangeSetSave, type GoalRevisionRow, type TaskRow } from './store.ts'

export type GoalDomain = 'health' | 'finance' | 'custom'

/** Host-bound commit scope; the model cannot specify any of these fields (design §4.4, BC-07-04). */
export interface CommitScope {
  userId: string
  allowedGoalId?: string
  ticketId?: string
  assignmentId?: string
  workId?: string
  triggerEventId?: string
  requireReminderPlan?: boolean
  requireTaskTrigger?: boolean
}

/** Only applied / conflicted / invalid exist — no pending adoption (D3). Worker-facing fields per design §4.4. */
export type ChangeSetResult =
  | { status: 'applied'; changeset_id: string; goal_revision: number; reused: false }
  | { status: 'applied'; changeset_id: string; reused: true }
  | { status: 'conflicted'; reason: string; diagnostic?:Record<string,unknown> }
  | { status: 'invalid'; reason: string; diagnostic?:Record<string,unknown> }

// ---- schema (design §4.4) ---------------------------------------------------------------------------------------------

export const ALONG_ID_SCHEMA = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/)
export const ALONG_ISO_SCHEMA = z.string().refine(value => Number.isFinite(Date.parse(value)))
export const ALONG_TITLE_SCHEMA = z.string().trim().min(1).max(80) // ≤80 non-empty, validateGoalReply alignment
export const ALONG_CONTENT_SCHEMA = z.string().trim().min(1).max(120) // ≤120, validateTaskReply alignment
export const ALONG_REASON_SCHEMA = z.string().trim().min(1).max(300) // the change note shown to the user
export const ALONG_BASE_REVISION_SCHEMA = z.number().int().min(0).describe('JSON integer, never a quoted string. Root: goal current_revision; task op: that task revision.')
export const ALONG_INPUT_VERSION_SCHEMA = z.number().int().min(1).describe('JSON integer from along_goal_read.input_version, never a quoted string.')

/**
 * Context/constraint list; entries are plain strings or a constrained entry with an optional deadline
 * (§3 `goal_revision.context`: 情境/约束数组，可含带期限情境). The legacy import stores plain strings.
 */
export const ALONG_CONTEXT_SCHEMA = z.array(z.union([
  z.string().trim().min(1).max(300),
  z.object({ text: z.string().trim().min(1).max(300), until: ALONG_ISO_SCHEMA.optional() }).strict(),
])).max(20)

/**
 * Metric of a goal content op. `target` accepts number-like strings because the old chain normalized them
 * before validating (`numberLikeTarget`, goal-agent-core.mjs:124 —「120」/「10,000」 are the number, not a type
 * error); the integer/range enforcement happens in the schema-semantic layer below, per domain.
 */
export const ALONG_METRIC_SCHEMA = z.object({
  type: z.string().trim().min(1).max(64),
  target: z.union([z.number(), z.string().max(32)]),
  unit: z.string().trim().min(1).max(16),
  period: z.string().trim().min(1).max(32),
}).strict()

export const ALONG_OPS_SCHEMA = z.array(z.discriminatedUnion('op', [
  // goal.create carries the full first content; custom goals keep `metric` null (goal-agent-core.mjs:159).
  z.object({ op: z.literal('goal.create'), domain: z.enum(['health', 'finance', 'custom']),
    title: ALONG_TITLE_SCHEMA, metric: ALONG_METRIC_SCHEMA.nullable(), context: ALONG_CONTEXT_SCHEMA.nullable() }).strict(),
  // goal.update cannot change the domain (not a field) and cannot clear the metric (not nullable); a「改回去」
  // restore fills omitted fields from the referenced snapshot (§2.3.5).
  z.object({ op: z.literal('goal.update'), fields: z.object({
    title: ALONG_TITLE_SCHEMA.optional(), metric: ALONG_METRIC_SCHEMA.optional(), context: ALONG_CONTEXT_SCHEMA.optional() }).strict() }).strict(),
  z.object({ op: z.literal('goal.archive') }).strict(),
  z.object({ op: z.literal('task.create'), trigger:TASK_TRIGGER_SCHEMA.optional(), reminder_plan: PLAN.optional(), repeat: z.enum(['once','daily','weekly']).optional(), content: ALONG_CONTENT_SCHEMA, scheduled_at: ALONG_ISO_SCHEMA.optional(),
    task_client_id: ALONG_ID_SCHEMA.optional() }).strict(),
  z.object({ op: z.literal('task.update'), task_id: ALONG_ID_SCHEMA, base_revision: ALONG_BASE_REVISION_SCHEMA,
    fields: z.object({ trigger:z.union([TASK_TRIGGER_SCHEMA,z.literal('keep')]).optional(), reminder_plan: z.union([PLAN,z.literal('keep')]).optional(), repeat: z.enum(['once','daily','weekly']).optional(), content: ALONG_CONTENT_SCHEMA.optional(), scheduled_at: ALONG_ISO_SCHEMA.nullable().optional(),
      status: z.enum(['open', 'done', 'cancelled']).optional() }).strict() }).strict(),
  z.object({ op: z.literal('task.cancel'), task_id: ALONG_ID_SCHEMA, base_revision: ALONG_BASE_REVISION_SCHEMA }).strict(),
])).min(1)

export const ALONG_CHANGE_SET_INPUT_SCHEMA = z.object({
  idempotency_key: z.string().min(1).max(128),
  goal_id: ALONG_ID_SCHEMA.optional(), // absent for goal.create; otherwise required and the host-bound goal
  base_revision: ALONG_BASE_REVISION_SCHEMA,
  input_version: ALONG_INPUT_VERSION_SCHEMA,
  reason: ALONG_REASON_SCHEMA,
  derived_from_changeset: ALONG_ID_SCHEMA.optional(),
  ops: ALONG_OPS_SCHEMA,
}).strict()

export type ChangeSetInput = z.infer<typeof ALONG_CHANGE_SET_INPUT_SCHEMA>
export type ChangeSetOp = ChangeSetInput['ops'][number]

// ---- assignment-consistency port (goal-agent-core.mjs:76, static-vector aligned) --------------------------------------

const CHANGE_PHRASE = '改为|改成|设为|设成|设定成|设定为|定为|达到'
// 「目标/指标」直接限定的动词才算指派目标；「今天运动量提高到 150 分钟」这种事实陈述没有目标词，必须留在外面。
const GOAL_PHRASE = '(?:目标|指标)(?:改为|是|为|调整为|提高到|减到|调到|调成|改到|改成|设为|设成|设定成|定为)?'
const ANY_CHANGE = `${GOAL_PHRASE}|${CHANGE_PHRASE}`
const GOAL_WORD = /目标|指标/
const NOT_GOAL_TARGET = /每天|每日|每次|单次|上限|预算|封顶|最多|不超过|以内/
// 触发词前一句里的否定与假设：「不要把目标改成 150 分钟」「如果改成 150 分钟就好了」。
const NEGATED_TARGET = /不要(?!忘)|别(?!忘)|不用|不想|不必|勿|无需|没必要|不能|不是|如果|假如|要是|万一|假设/
const DEFERRED_TARGET = /下次|以后|之后|回头|再说|将来/
// 触发词前一句正好说到另一件事时，那个数字不是目标：每月房租设为 2500 元。
const OTHER_ITEM = /(房租|房费|房贷|学费|水电费|水电|电费|水费|燃气费|燃气|煤气费|餐费|伙食费|宽带费|物业费|话费|网费|车费|油费|饭钱|菜钱|保险费|保险|保费|评分|得分|打分|分数)$/
const QUALIFIED_AFTER = /^\s*(以内|封顶|如果|要是|假如|万一|假设)/
const TRAILING_COMMENT = /^\s*[，,。；;]?\s*(更好|就行|好了|再说)/
const HEALTH_TARGET = new RegExp(`(${ANY_CHANGE})\\s*(\\d+(?:\\.\\d+)?)\\s*(小时|分钟|分(?![一-龥]))(?:\\s*(\\d+(?:\\.\\d+)?)\\s*(分钟|分(?![一-龥])))?`, 'g')
const FINANCE_TARGETS = [
  new RegExp(`(${ANY_CHANGE})\\s*[¥￥]?\\s*(\\d+(?:,\\d{3})*(?:\\.\\d+)?)\\s*(万|萬)?\\s*(?:元|块|人民币)`, 'g'),
  new RegExp(`(${ANY_CHANGE})\\s*[¥￥]\\s*(\\d+(?:,\\d{3})*(?:\\.\\d+)?)\\s*(万|萬)?`, 'g'),
]

// 数字字符串就是那个数字：模型把 120 写成 "120"（或 "10,000"）时归一成数字再校验（goal-agent-core.mjs:124）。
const NUMBER_LIKE = /^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/
export function numberLikeTarget(value: unknown): unknown {
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!NUMBER_LIKE.test(text)) return value
  const parsed = Number(text.replaceAll(',', ''))
  return Number.isFinite(parsed) ? parsed : value
}

// 触发词所在的那一句：数字是否被「每天 30 分钟」这类限定词修饰，只看同一句。
const clauseBefore = (message: string, index: number): string => {
  const before = message.slice(0, index)
  const cut = Math.max(before.lastIndexOf('，'), before.lastIndexOf(','), before.lastIndexOf('。'),
    before.lastIndexOf('；'), before.lastIndexOf(';'), before.lastIndexOf('\n'), before.lastIndexOf('、'))
  return before.slice(cut + 1)
}

// 「达到」是达成类动词：只有明确指向目标时才算设定目标，否则只是陈述事实。
const isGoalAssignment = (trigger: string, clause: string): boolean => trigger !== '达到' || GOAL_WORD.test(clause)

interface TargetCandidate { at: number; value: number }
const targetCandidates = (message: string, pattern: RegExp, readValue: (match: RegExpMatchArray) => number | null): TargetCandidate[] => {
  const found: TargetCandidate[] = []
  for (const match of message.matchAll(pattern)) {
    const clause = clauseBefore(message, match.index ?? 0)
    if (NOT_GOAL_TARGET.test(clause)) continue
    if (NEGATED_TARGET.test(clause)) continue
    if (DEFERRED_TARGET.test(clause)) continue
    if (OTHER_ITEM.test(clause)) continue
    // 触发词没带目标词时，前面那句话就是在说别的事；只有空句或提到目标的句子才算指派。
    if (!GOAL_WORD.test(match[1] ?? '') && clause.trim() !== '' && !GOAL_WORD.test(clause)) continue
    if (!isGoalAssignment(match[1] ?? '', clause)) continue
    const trailing = message.slice((match.index ?? 0) + match[0].length)
    if (QUALIFIED_AFTER.test(trailing)) continue
    if (TRAILING_COMMENT.test(trailing)) continue
    const value = readValue(match)
    if (value === null) continue
    found.push({ at: match.index ?? 0, value })
  }
  return found
}

/**
 * The user-assigned target in the original message, or `null` when the message assigns none (custom domains
 * never do). Same acceptance as `along/web/goal-agent-core.mjs:76`; pinned by the static vectors in
 * `tests/along-changeset.spec.ts`.
 */
export function requestedTargetFromMessage(message: string, domain: GoalDomain): number | null {
  if (typeof message !== 'string') return null
  if (domain === 'custom') return null
  if (domain === 'health') {
    const found = targetCandidates(message, HEALTH_TARGET, match => {
      const base = match[3] === '小时' ? Number(match[2]) * 60 : Number(match[2])
      const minutes = base + (match[4] !== undefined ? Number(match[4]) : 0)
      return Number.isInteger(minutes) && minutes >= 1 && minutes <= 10080 ? minutes : null
    })
    return found.length !== 0 ? found[found.length - 1]!.value : null
  }
  const found: TargetCandidate[] = []
  for (const pattern of FINANCE_TARGETS) {
    found.push(...targetCandidates(message, pattern, match => {
      const base = Number(String(match[2]).replaceAll(',', ''))
      const amount = base * (match[3] === '万' || match[3] === '萬' ? 10000 : 1)
      return Number.isInteger(amount) && amount >= 1 && amount <= 10000000 ? amount : null
    }))
  }
  // 用户改口时以最后一次为准：「目标改成 150 分钟，目标改成 180 分钟」取 180。
  found.sort((first, second) => first.at - second.at)
  return found.length !== 0 ? found[found.length - 1]!.value : null
}

// ---- commit pipeline ---------------------------------------------------------------------------------------------------

/** Widest schema bound; the health tightening (1..10080, goal-agent-core.mjs:158) happens per domain below. */
const TARGET_LIMIT: Record<GoalDomain, number> = { health: 10080, finance: 10000000, custom: 10000000 }
const targetInRange = (target: number, domain: GoalDomain): boolean => target >= 1 && target <= TARGET_LIMIT[domain]

const asTargetInt = (value: unknown): number | undefined => {
  const target = numberLikeTarget(value)
  return typeof target === 'number' && Number.isInteger(target) ? target : undefined
}

/** Key order-insensitive JSON so parsed snapshot content compares equal to a resubmitted field value. */
const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return value === undefined ? 'undefined' : JSON.stringify(value)
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Audit row for a submission the schema refused; only written when a usable idempotency key can be extracted. */
const invalidAuditRow = (userId: string, raw: unknown, scope: CommitScope): ChangeSetSave | undefined => {
  const value = asRecord(raw)
  const key = value?.idempotency_key
  if (typeof key !== 'string' || key.length < 1 || key.length > 128) return undefined
  const goalId = typeof value?.goal_id === 'string' && ALONG_ID_SCHEMA.safeParse(value.goal_id).success ? value.goal_id : undefined
  const reason = typeof value?.reason === 'string' && value.reason.trim() !== '' ? value.reason.trim().slice(0, 300) : 'invalid_schema'
  return { id: `cs_${randomToken()}`, userId, goalId, status: 'invalid',
    baseRevision: typeof value?.base_revision === 'number' && Number.isInteger(value.base_revision) && value.base_revision >= 0
      ? value.base_revision : 0,
    inputVersion: typeof value?.input_version === 'number' && Number.isInteger(value.input_version) && value.input_version >= 1
      ? value.input_version : 0,
    idempotencyKey: key, triggerEventId: scope.triggerEventId, workId: scope.workId, ticketId: scope.ticketId,
    assignmentId: scope.assignmentId, reason, ops: Array.isArray(value?.ops) ? value.ops : [],
    derivedFromChangeset: typeof value?.derived_from_changeset === 'string' ? value.derived_from_changeset : undefined,
    result: { reason: 'invalid_schema' } }
}

/** The original result of a stored changeset row — the BC-02-04 replay answer, ops are never re-evaluated. */
const replayResult = (row: ChangeSetRow): ChangeSetResult => {
  if (row.status === 'applied') return { status: 'applied', changeset_id: row.id, reused: true }
  const reason = asRecord(row.result)?.reason
  return row.status === 'conflicted'
    ? { status: 'conflicted', reason: typeof reason === 'string' ? reason : 'unknown' }
    : { status: 'invalid', reason: typeof reason === 'string' ? reason : 'unknown' }
}

/** The trigger message's original text when the scope's event is an accepted user message (design §2.3.1). */
const triggerMessageText = (store: AlongStore, scope: CommitScope): string | undefined => {
  if (scope.triggerEventId === undefined) return undefined
  const event = store.findInboxEvent(scope.userId, scope.triggerEventId)
  if (event === undefined || event.eventType !== 'along.user_message') return undefined
  return store.getMessage(scope.userId, `msg:${scope.userId}:${scope.triggerEventId}`)?.text
}

function validateAndApply(store: AlongStore, input: ChangeSetInput, scope: CommitScope, available?:(capability:TaskCapability)=>boolean): ChangeSetResult {
  let goalId: string | undefined
  const refuse = (status: 'conflicted' | 'invalid', reason: string,diagnostic?:Record<string,unknown>): ChangeSetResult => {
    // No business rows: the changeset row itself records the status and reason for audit (BC-02-01/02).
    store.saveChangeSet({ id: `cs_${randomToken()}`, userId: scope.userId, goalId, status,
      baseRevision: input.base_revision, inputVersion: input.input_version, idempotencyKey: input.idempotency_key,
      triggerEventId: scope.triggerEventId, workId: scope.workId, ticketId: scope.ticketId,
      assignmentId: scope.assignmentId, reason: input.reason, ops: input.ops,
      derivedFromChangeset: input.derived_from_changeset, result: { reason,...(diagnostic?{diagnostic}:{}) } })
    return { status, reason,...(diagnostic?{diagnostic}:{}) }
  }

  const health = scope.triggerEventId === undefined ? undefined : store.health.get(scope.triggerEventId)
  if (health && (health.userId !== scope.userId || health.goalId !== scope.allowedGoalId
    || health.inputVersion !== store.inputVersion(health.goalId))) return refuse('conflicted', 'conflicted_input')
  if (health && (health.result || !health.readSnapshot)) return refuse('invalid', 'health_evaluation_unavailable')
  if (health?.due) {
    const task = store.getTask(scope.userId, health.due.taskId)
    if (!task || task.status !== 'open' || task.currentRevision !== health.due.revision
      || task.scheduledAt !== health.due.dueAt) return refuse('conflicted', 'conflicted_revision')
    if (input.ops.some(op => (op.op !== 'task.update' && op.op !== 'task.cancel') || op.task_id !== task.id))
      return refuse('invalid', 'outside_due_task')
    if(store.health.daily(task.id)&&isResearchTaskContent(task.content))
      return refuse('invalid','recurring_research_remains_open')
  }
  if (health && input.ops.some(op => op.op.startsWith('goal.'))) return refuse('invalid', 'health_goal_mutation')

  // ---- object-relation layer (design §2.3.1; invalid_relation covers missing/foreign/ungoal'd/bound-mismatch) ----
  const first = input.ops[0]
  const createOp = first !== undefined && first.op === 'goal.create' ? first : undefined
  let domain: GoalDomain | undefined
  if (createOp !== undefined) {
    // goal.create expects the goal_id absent (§4.4) and is only allowed for a ticket without a bound goal —
    // a bound ticket minting another goal would let the model pick its own target (BC-07-04).
    if (input.goal_id !== undefined || scope.allowedGoalId !== undefined) return refuse('invalid', 'invalid_relation')
    domain = createOp.domain
  } else {
    if (input.goal_id === undefined) return refuse('invalid', 'invalid_relation')
    const goal = store.getGoal(scope.userId, input.goal_id)
    // Missing and foreign are the same outcome — no existence leak (BC-07-05).
    if (goal === undefined) return refuse('invalid', 'invalid_relation')
    if (scope.allowedGoalId !== undefined && input.goal_id !== scope.allowedGoalId) return refuse('invalid', 'invalid_relation')
    if (goal.status === 'archived') return refuse('invalid', 'invalid_relation') // archive 后再更新
    if (store.currentGoalRevision(goal.id) === undefined) return refuse('invalid', 'invalid_relation')
    goalId = goal.id
    domain = goal.domain
  }
  for (const [index, op] of input.ops.entries()) {
    if (op.op === 'goal.create' && index > 0) return refuse('invalid', 'invalid_relation')
    // A create changeset may only be followed by task.create ops of the new goal — nothing else can exist yet.
    if (createOp !== undefined && index > 0 && op.op !== 'task.create') return refuse('invalid', 'invalid_relation')
    if (op.op === 'task.update' || op.op === 'task.cancel') {
      const task = store.getTask(scope.userId, op.task_id)
      if (task === undefined || task.goalId !== goalId) return refuse('invalid', 'invalid_relation') // task 不属 goal
    }
  }

  const message = scope.triggerEventId ? store.getMessage(scope.userId, `msg:${scope.userId}:${scope.triggerEventId}`) : undefined
  const userMessage = message?.role === 'user' && message.direction === 'inbound' ? message : undefined
  const reminderNotes: string[] = []
  type Mandate = NonNullable<ReturnType<AlongStore['health']['daily']>>
  const retained = new Map<ChangeSetOp,Mandate>()
  const evidenceMessages=new Map<ChangeSetOp,typeof userMessage>()
  for (const [opIndex,op] of input.ops.entries()) {
    if (op.op !== 'task.create' && op.op !== 'task.update') continue
    const fields = op.op === 'task.create' ? op : op.fields
    const existing = op.op === 'task.update' ? store.getTask(scope.userId,op.task_id) : undefined
    const plan = fields.reminder_plan
    let userMessage=message?.role==='user'&&message.direction==='inbound'&&message.audience==='conversation'?message:undefined
    if(plan&&plan!=='keep'&&plan.state==='scheduled'&&plan.evidence_event_id) {
      const source=store.getMessage(scope.userId,`msg:${scope.userId}:${plan.evidence_event_id}`)
      const inbox=source&&store.findInboxEvent(scope.userId,source.eventId)
      if(!source||source.audience!=='conversation'||source.role!=='user'||source.direction!=='inbound'||inbox?.status!=='accepted'
        ||inbox.eventType!=='along.user_message'||!goalId||!store.messageLinkedToGoal(source.id,goalId))return refuse('invalid','invalid_schedule_evidence')
      const action=fields.content??existing?.content??''
      const later:typeof source[]=[]
      let beforeSeq:number|undefined
      for(;;) {
        const page=store.messagesByGoal(scope.userId,goalId,{limit:200,beforeSeq})
        later.push(...page.items.filter(m=>m.seq>source.seq&&m.role==='user'&&m.direction==='inbound'&&m.audience==='conversation'))
        const first=page.items[0]
        if(!first||first.seq<=source.seq||page.items.length<200)break
        beforeSeq=first.seq
      }
      if(later.some(m=>declinesReminder(m.text,action)||singleOccurrence(m.text,action,plan.action??action)))return refuse('invalid','superseded_schedule_evidence')
      if(!message&&existing&&fields.scheduled_at&&existing.scheduledAt&&Date.parse(fields.scheduled_at)!==Date.parse(existing.scheduledAt)
        &&source.seq<(later.at(-1)?.seq??source.seq))return refuse('invalid','superseded_schedule_evidence')
      userMessage=source
    }
    evidenceMessages.set(op,userMessage)
    const changesTiming = fields.scheduled_at !== undefined || fields.repeat !== undefined
    const reopening = op.op === 'task.update' && op.fields.status === 'open' && existing?.status !== 'open'
    if(reopening&&(!message||message.role!=='user'||message.direction!=='inbound'||message.audience!=='conversation'))
      return refuse('invalid','reopening_requires_current_user_instruction')
    const priorTrigger=existing&&store.triggers.get(scope.userId,existing.id)
    if(op.op==='task.update'&&op.fields.status==='done'&&priorTrigger?.definition.actor==='agent')return refuse('invalid','task_completion_requires_executor')
    if(existing?.status==='done'&&priorTrigger?.definition.actor==='agent'&&input.input_version<=priorTrigger.inputVersion)
      return refuse('invalid','task_execution_already_settled')
    if(scope.requireTaskTrigger&&(op.op==='task.create'||priorTrigger&&(reopening||changesTiming||fields.content!==undefined))&&fields.trigger===undefined)
      return refuse('invalid','task_trigger_required')
    if(fields.trigger==='keep'&&(!priorTrigger||reopening||fields.content!==undefined&&fields.content!==existing?.content))return refuse('invalid','cannot_keep_task_trigger')
    const trigger=fields.trigger==='keep'?priorTrigger?.definition:fields.trigger??priorTrigger?.definition
    if(trigger) {
      if(trigger.kind==='waiting'&&trigger.resume==='capability_available'&&!trigger.conditions?.length&&available?.(trigger.capability)===true)
        return refuse('invalid','waiting_trigger_requires_condition')
      if(trigger.kind==='time') {
        const time=fields.scheduled_at===undefined?existing?.scheduledAt:fields.scheduled_at
        if(!time)return refuse('invalid','time_trigger_requires_schedule')
      } else if(fields.scheduled_at!==undefined&&fields.scheduled_at!==null)return refuse('invalid','non_time_trigger_has_model_clock')
      if((trigger.kind==='immediate'||trigger.kind==='event'||trigger.kind==='waiting')&&fields.repeat&&fields.repeat!=='once')
        return refuse('invalid','clock_repeat_requires_time_trigger')
      for(const condition of trigger.conditions??[]) {
        if(condition.kind==='source_ready'||condition.kind==='source_updated') {
          if(!goalId||!store.goalDataSources(scope.userId,goalId).some(s=>s.provider===condition.provider))return refuse('invalid','trigger_source_not_recommended')
        } else if(condition.kind==='health_available') {
          if(domain!=='health'&&(!goalId||!store.goalDataSources(scope.userId,goalId).some(s=>s.provider==='apple-health')))return refuse('invalid','trigger_source_not_recommended')
        } else {
          const prerequisite=store.getTask(scope.userId,condition.task_id)
          if(!prerequisite||prerequisite.goalId!==goalId||prerequisite.id===existing?.id)return refuse('invalid','invalid_task_trigger_dependency')
          const reaches=(taskId:string,visited=new Set<string>()):boolean=>{
            if(taskId===existing?.id)return true
            if(visited.has(taskId))return false
            visited.add(taskId)
            const d=store.triggers.get(scope.userId,taskId)?.definition
            return !!d?.conditions?.some(c=>c.kind==='task_completed'&&reaches(c.task_id,visited))
          }
          if(existing&&reaches(prerequisite.id))return refuse('invalid','task_trigger_dependency_cycle')
        }
      }
    }
    if (!plan && scope.requireReminderPlan && (!trigger||trigger.kind==='time') && (op.op === 'task.create' || reopening || changesTiming || userMessage && fields.content !== undefined))
      return refuse('invalid','reminder_plan_required')
    if (plan === 'keep') {
      const mandate = existing && store.health.daily(existing.id)
      if (!existing?.reminderPlan || changesTiming || reopening) return refuse('invalid','cannot_keep_reminder_plan')
      if (mandate?.action && mandate.quote && fields.content) {
        const source = store.getMessage(scope.userId, `msg:${scope.userId}:${mandate.evidence}`)
        if (!source || !supportsRecurrence(source.text,mandate.quote,mandate.action,fields.content,
          mandate.weekday ? 'weekly' : 'daily',mandate.weekday ?? 1,
          existing.reminderPlan.state==='scheduled'?existing.reminderPlan.recurrenceSource:undefined)) return refuse('invalid','cannot_keep_reminder_plan')
      }
      if (userMessage && existing.reminderPlan.state==='scheduled' && declinesReminder(userMessage.text,fields.content??existing.content))
        return refuse('invalid','reminder_declined')
      continue
    }
    if (!userMessage && !plan && existing?.reminderPlan && fields.scheduled_at) {
      if (existing.reminderPlan.state!=='scheduled') return refuse('invalid','reminder_requires_user_chat')
      const prior=store.health.daily(existing.id)
      if (prior?.weekday && localWeekday(fields.scheduled_at,prior.zone)!==prior.weekday) return refuse('invalid','weekly_plan_required')
    }
    if (plan) {
      const content = fields.content ?? existing!.content
      const time = fields.scheduled_at === undefined && plan.state==='scheduled' ? existing?.scheduledAt : fields.scheduled_at
      const repeat = fields.repeat ?? 'once'
      if (plan.state !== 'off' && !userMessage) return refuse('invalid','reminder_requires_user_chat')
      if (plan.state !== 'off' && userMessage && (declinesReminder(userMessage.text,content) ||
        existing?.reminderPlan?.state==='off' && existing.reminderPlan.reason==='opt_out'
        && !/提醒|闹钟|通知|remind|alert|notif/i.test(userMessage.text))) return refuse('invalid','reminder_declined')
      // Changing the clock on the same action preserves its established scope unless the
      // new input explicitly limits it to one occurrence. The old user event remains the evidence.
      const prior = existing && store.health.daily(existing.id)
      if (plan.state==='scheduled' && prior?.quote && prior.action && userMessage && time && !singleOccurrence(userMessage.text,content,prior.action)
        && (!fields.repeat || fields.repeat===(prior.weekday?'weekly':'daily'))) {
        const original = store.getMessage(scope.userId,`msg:${scope.userId}:${prior.evidence}`)
        if (original && userMessage.timezone===prior.zone && Number.isFinite(Date.parse(time))
          && (!prior.weekday || localWeekday(time,prior.zone)===prior.weekday)
          && supportsRecurrence(original.text,prior.quote,prior.action,content,prior.weekday?'weekly':'daily',prior.weekday??1,
            existing?.reminderPlan?.state==='scheduled'?existing.reminderPlan.recurrenceSource:undefined)) {
          retained.set(op,prior)
        } else if (!fields.repeat) return refuse('invalid','task_scoped_repeat_evidence_required')
      }
      const error = planError(plan,time,retained.has(op)?'once':repeat,content,userMessage,trigger?.actor==='agent')
      if (error) return refuse('invalid',error,{op_index:opIndex,field:'reminder_plan',
        evidence_found:plan.state==='scheduled'&&!!plan.evidence&&!!userMessage?.text.includes(plan.evidence),
        action_in_evidence:plan.state==='scheduled'&&!!plan.action&&!!plan.evidence?.includes(plan.action),
        action_in_task:plan.state==='scheduled'&&!!plan.action&&content.includes(plan.action)})
      if (plan.state==='needs_time' && existing?.reminderPlan?.state==='off' && existing.reminderPlan.reason==='opt_out')
        return refuse('invalid','reminder_declined')
    }
    const cadence = fields.repeat
    if (!cadence) continue
    if (!userMessage) return refuse('invalid','repeat_requires_user_chat')
    if (cadence === 'weekly' && (!plan || plan.state!=='scheduled')) return refuse('invalid','weekly_plan_required')
    if (cadence === 'daily') {
      const time = fields.scheduled_at === undefined ? existing?.scheduledAt : fields.scheduled_at
      if (!time || !userMessage.timezone || (!plan && !hasDailyMandate(userMessage.text))) return refuse('invalid','daily_mandate_required')
      try { new Intl.DateTimeFormat('en', {timeZone:userMessage.timezone}) } catch { return refuse('invalid','invalid_timezone') }
    }
  }
  // ----「改回去」restore (§2.3.5): content is generated from the referenced snapshot, never rewritten into it ----
  let snapshot: GoalRevisionRow | undefined
  if (input.derived_from_changeset !== undefined) {
    const updateOp = input.ops[0]
    const derived = store.getChangeSet(scope.userId, input.derived_from_changeset)
    if (updateOp?.op !== 'goal.update' || input.ops.length !== 1 || derived === undefined
      || derived.status !== 'applied' || derived.appliedRevision === undefined || derived.goalId !== goalId) {
      return refuse('invalid', 'invalid_relation')
    }
    const referenced = store.goalRevisions(goalId!).find(revision => revision.revision === derived.appliedRevision)
    if (referenced === undefined || referenced.status !== 'active') return refuse('invalid', 'invalid_relation')
    snapshot = referenced
    if (updateOp.fields.title !== undefined && updateOp.fields.title !== snapshot.title) return refuse('invalid', 'invalid_relation')
    if (updateOp.fields.metric !== undefined && stableJson(updateOp.fields.metric) !== stableJson(snapshot.metric)) {
      return refuse('invalid', 'invalid_relation')
    }
    if (updateOp.fields.context !== undefined && stableJson(updateOp.fields.context) !== stableJson(snapshot.context)) {
      return refuse('invalid', 'invalid_relation')
    }
  }

  // ---- schema-semantic layer that needs the store: metric shape per domain (goal-agent-core.mjs:158-159) ----
  for (const op of input.ops) {
    if (op.op === 'goal.create') {
      if (op.domain === 'custom') {
        if (op.metric !== null) return refuse('invalid', 'invalid_schema') // domain='custom' 时 metric 必须为 null
      } else {
        const target = op.metric === null ? undefined : asTargetInt(op.metric.target)
        if (target === undefined || !targetInRange(target, op.domain)) return refuse('invalid', 'invalid_schema')
      }
    } else if (op.op === 'goal.update' && op.fields.metric !== undefined) {
      const target = asTargetInt(op.fields.metric.target)
      if (domain === 'custom' || target === undefined || !targetInRange(target, domain!)) return refuse('invalid', 'invalid_schema')
    }
  }

  // ---- assignment consistency: the committed target must match what the user's message assigned ----
  // Same strength as the old chain's `validateGoalReply` (goal-agent-core.mjs:166-167); commits without a
  // trigger message (imports, host-driven commits) skip it and record basis 'no_message' in the result column.
  let basis: 'message' | 'no_message' = 'no_message'
  const messageText = triggerMessageText(store, scope)
  if (messageText !== undefined && domain !== undefined) {
    basis = 'message'
    const requested = requestedTargetFromMessage(messageText, domain)
    if (requested !== null) {
      for (const op of input.ops) {
        const target = op.op === 'goal.create' && op.metric !== null ? asTargetInt(op.metric.target)
          : op.op === 'goal.update' && op.fields.metric !== undefined ? asTargetInt(op.fields.metric.target) : undefined
        if (target !== undefined && target !== requested) return refuse('invalid', 'target_mismatch')
      }
    }
  }

  // ---- input-version layer (BC-08-05): a user's new chat raises it, so results from an old input cannot commit ----
  if (scope.triggerEventId !== undefined && messageText !== undefined) {
    if (!store.isCurrentChatInput(scope.userId, scope.triggerEventId, goalId)) return refuse('conflicted', 'conflicted_input')
    if (createOp !== undefined && store.conversationGoal(scope.userId, scope.triggerEventId) !== undefined) {
      return refuse('conflicted', 'conflicted_input')
    }
  }
  // goal.create skips this and the next comparison (no rows exist yet); it requires base_revision = 0 and
  // records input_version 1 (§2.3.1).
  if (createOp === undefined && input.input_version !== store.inputVersion(goalId!)) return refuse('conflicted', 'conflicted_input')

  // ---- business-revision layer (BC-08-04/BC-08-09): the goal's current revision and each task's own ----
  if (createOp !== undefined) {
    if (input.base_revision !== 0) return refuse('conflicted', 'conflicted_revision')
  } else if (input.base_revision !== store.currentRevision('goal', goalId!)) return refuse('conflicted', 'conflicted_revision')
  for (const op of input.ops) {
    if ((op.op === 'task.update' || op.op === 'task.cancel') && op.base_revision !== store.currentRevision('task', op.task_id)) {
      return refuse('conflicted', 'conflicted_revision')
    }
  }

  // ---- atomic auto-commit (§2.3.2): changeset row → ops → version advancement → sync records → result ----
  const changesetId = `cs_${randomToken()}`
  const originEventId = scope.triggerEventId
  store.saveChangeSet({ id: changesetId, userId: scope.userId, goalId, status: 'applied',
    baseRevision: input.base_revision, inputVersion: createOp !== undefined ? 1 : input.input_version,
    idempotencyKey: input.idempotency_key, triggerEventId: scope.triggerEventId, workId: scope.workId,
    ticketId: scope.ticketId, assignmentId: scope.assignmentId, reason: input.reason, ops: input.ops,
    derivedFromChangeset: input.derived_from_changeset })

  const touchedTasks: { task_id: string; task_client_id?: string; revision: number; status: TaskRow['status'] }[] = []
  const current = createOp === undefined ? store.currentGoalRevision(goalId!) : undefined
  let title = snapshot !== undefined ? snapshot.title : current?.title
  let metric = snapshot !== undefined ? snapshot.metric : current?.metric
  let context = snapshot !== undefined ? snapshot.context : current?.context
  let goalStatus: GoalRevisionRow['status'] = snapshot !== undefined ? 'active' : current?.status ?? 'active'
  let goalRevision = current?.revision ?? 0
  if (createOp !== undefined) {
    const goal = store.insertGoal({ userId: scope.userId, domain: createOp.domain, originEventId })
    goalId = goal.id
    goalStatus = 'active'
    title = createOp.title
    metric = createOp.metric === null ? undefined : { ...createOp.metric, target: asTargetInt(createOp.metric.target)! }
    context = createOp.context ?? undefined
    goalRevision = store.appendGoalRevision({ goalId, userId: scope.userId, title, metric, context, status: 'active',
      basisChangeset: changesetId, originEventId })
    // The new goal starts at input version 1, raised by the triggering event (001 §7.4).
    store.ensureInputVersion(scope.userId, goalId, originEventId)
    // The source user message arrived before the goal existed; link it now (§2.3.2).
    const source = originEventId === undefined ? undefined : store.getMessage(scope.userId, `msg:${scope.userId}:${originEventId}`)
    if (source !== undefined) {
      for (const message of store.conversationMessages(scope.userId, source.eventId)) {
        store.linkMessageToGoals(message.id, [goalId], message.role === 'user' ? 'direct' : 'derived')
        store.appendSync({ userId: scope.userId, kind: 'message', goalId, messageId: message.id,
          payload: { message_id: message.id, conversation_id: store.conversationRoot(scope.userId, source.eventId) } })
      }
    }
  }
  function applyPlan(task:TaskRow, plan:PlanInput, repeat:Repeat, time:string|undefined, prior?:Mandate, userMessage:typeof message=message):void {
    if (prior) repeat=prior.weekday?'weekly':'daily'
    const weekday=repeat==='weekly' && time && userMessage?.timezone ? localWeekday(time,userMessage.timezone) : undefined
    const next=publicPlan(plan,repeat,weekday)
    if(prior&&next.state==='scheduled'&&!next.recurrenceSource&&task.reminderPlan?.state==='scheduled'&&task.reminderPlan.recurrenceSource)
      next.recurrenceSource=task.reminderPlan.recurrenceSource
    store.health.savePlan(task.id,next)
    if (prior && time) store.health.setDaily(task.id,{...prior,eventId:prior.evidence,wallTime:time})
    else if (plan.state==='scheduled' && repeat!=='once' && userMessage) {
      store.health.setDaily(task.id,{eventId:userMessage.eventId,zone:userMessage.timezone!,wallTime:time!,
        weekday,quote:plan.evidence,action:plan.action})
    } else store.health.setDaily(task.id)
    if (JSON.stringify(task.reminderPlan)===JSON.stringify(store.health.reminderPlan(task.id)) && task.scheduledAt===time) return
    if (plan.state==='needs_time') reminderNotes.push(plan.question)
    if (plan.state==='scheduled' && plan.source==='agent') {
      const local=new Intl.DateTimeFormat('zh-CN',{timeZone:userMessage!.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(time!))
      const cadence = repeat==='once' ? '本次仅排这一次。' : repeat==='daily' ? '按当地时间每天提醒。' : `按当地时间每周${'一二三四五六日'[weekday!-1]}提醒。`
      reminderNotes.push(`我为「${task.content}」安排了 ${local}（${userMessage!.timezone}）的提醒。${cadence}${plan.explanation}`)
    }
  }
  for (const op of input.ops) {
    if (op.op === 'goal.update') {
      if (op.fields.title !== undefined) title = op.fields.title
      // The metric shape per domain was validated above, so the normalized integer target is defined here.
      if (op.fields.metric !== undefined) metric = { ...op.fields.metric, target: asTargetInt(op.fields.metric.target)! }
      if (op.fields.context !== undefined) context = op.fields.context
      goalRevision = store.appendGoalRevision({ goalId: goalId!, userId: scope.userId, title: title!, metric, context,
        status: goalStatus, basisChangeset: changesetId, originEventId })
    } else if (op.op === 'goal.archive') {
      goalStatus = 'archived'
      goalRevision = store.appendGoalRevision({ goalId: goalId!, userId: scope.userId, title: title!, metric, context,
        status: 'archived', basisChangeset: changesetId, originEventId })
    } else if (op.op === 'task.create') {
      const task = store.insertTask({ goalId: goalId!, userId: scope.userId, content: op.content, scheduledAt: op.scheduled_at })
      const revision = store.appendTaskRevision({ taskId: task.id, userId: scope.userId, content: op.content,
        scheduledAt: op.scheduled_at, basisChangeset: changesetId, originEventId })
      if (op.reminder_plan) applyPlan(task,op.reminder_plan,op.repeat??'once',op.scheduled_at,undefined,evidenceMessages.get(op))
      else if (op.repeat === 'once') store.health.setDaily(task.id)
      else if (op.repeat === 'daily' && message) store.health.setDaily(task.id, {
        eventId: message.eventId, zone: message.timezone!, wallTime: op.scheduled_at! })
      if(op.trigger)store.triggers.put(store.assertTaskOwner(scope.userId,task.id),op.trigger,input.input_version)
      touchedTasks.push({ task_id: task.id, revision, status: 'open',
        ...(op.task_client_id !== undefined ? { task_client_id: op.task_client_id } : {}) })
    } else if (op.op === 'task.update') {
      const prior = store.assertTaskOwner(scope.userId, op.task_id)
      const plan = op.fields.reminder_plan
      const nonTime=op.fields.trigger&&op.fields.trigger!=='keep'&&op.fields.trigger.kind!=='time'
      const inactive = plan && plan !== 'keep' && plan.state !== 'scheduled'
      const revision = store.appendTaskRevision({ taskId: op.task_id, userId: scope.userId, content: op.fields.content,
        status: op.fields.status, scheduledAt: inactive||nonTime ? null : op.fields.scheduled_at, basisChangeset: changesetId, originEventId })
      const task = store.assertTaskOwner(scope.userId, op.task_id), status = task.status
      if (status==='open') {
        if (plan && plan !== 'keep') applyPlan(prior,plan,op.fields.repeat??'once',task.scheduledAt,retained.get(op),evidenceMessages.get(op))
        else if (!task.scheduledAt || op.fields.repeat === 'once') store.health.setDaily(task.id)
        else if (op.fields.repeat === 'daily' && message) store.health.setDaily(task.id, {
          eventId: message.eventId, zone: message.timezone!, wallTime: task.scheduledAt })
        else if (op.fields.scheduled_at) {
          const previous = store.health.daily(task.id)
          if (previous) store.health.setDaily(task.id,{...previous,eventId:previous.evidence,wallTime:task.scheduledAt})
        }
        if (!plan && !userMessage && op.fields.scheduled_at !== undefined && prior.reminderPlan?.state==='scheduled') {
          if (task.scheduledAt) store.health.savePlan(task.id,{...prior.reminderPlan,source:'agent',explanation:input.reason.slice(0,240)})
          else store.health.savePlan(task.id,undefined)
        }
      }
      if(op.fields.trigger&&op.fields.trigger!=='keep') {
        const d=op.fields.trigger,preserveNotice=prior.reminderPlan?.state==='scheduled'&&(!prior.trigger||prior.trigger.notifyBefore)
        store.triggers.put(task,d.actor==='agent'&&d.kind==='time'&&d.notify_before===undefined&&preserveNotice?{...d,notify_before:true}:d,input.input_version)
      }
      if(plan&&plan!=='keep'&&plan.state==='off'&&plan.reason==='opt_out')store.triggers.cancel(scope.userId,task.id)
      touchedTasks.push({ task_id: op.task_id, revision, status })
    } else if (op.op === 'task.cancel') {
      const revision = store.appendTaskRevision({ taskId: op.task_id, userId: scope.userId, status: 'cancelled',
        basisChangeset: changesetId, originEventId })
      touchedTasks.push({ task_id: op.task_id, revision, status: 'cancelled' })
    }
  }

  // Sync records for the phone: the changes themselves plus the short change note (001 §8.4).
  if (createOp !== undefined || snapshot !== undefined || input.ops.some(op => op.op === 'goal.update' || op.op === 'goal.archive')) {
    store.appendSync({ userId: scope.userId, kind: 'goal_updated', goalId, changesetId,
      payload: { goal_id: goalId, goal_revision: goalRevision, status: goalStatus, reason: input.reason } })
  }
  for (const task of touchedTasks) {
    store.appendSync({ userId: scope.userId, kind: 'task_updated', goalId, taskId: task.task_id, changesetId,
      payload: { task_id: task.task_id, goal_id: goalId, status: task.status, revision: task.revision } })
  }
  if (reminderNotes.length && userMessage) {
    const root=store.conversationRoot(scope.userId,userMessage.eventId)
    const note=store.appendMessage({userId:scope.userId,eventId:`plan_${changesetId}`,role:'assistant',direction:'outbound',
      text:[...new Set(reminderNotes)].join('\n'),causationId:root,replyToMessageId:userMessage.id})
    store.linkMessageToGoals(note.id,[goalId!],'derived')
    store.appendSync({userId:scope.userId,kind:'message',goalId,messageId:note.id,changesetId,
      payload:{message_id:note.id,role:'assistant',text:note.text,conversation_id:root}})
  }
  store.appendSync({ userId: scope.userId, kind: 'changeset_note', goalId, changesetId,
    payload: { changeset_id: changesetId, goal_id: goalId, reason: input.reason } })

  store.updateChangeSet(changesetId, { goalId, appliedRevision: goalRevision,
    result: { basis, goal_revision: goalRevision, tasks: touchedTasks } })
  return { status: 'applied', changeset_id: changesetId, goal_revision: goalRevision, reused: false }
}

/** The changeset module factory (design §2.3): one instance per Along service, over the shared `AlongStore`. */
export function createChangeSetModule(store: AlongStore,options:{available?:(capability:TaskCapability)=>boolean}={}): { commitChangeSet(input: ChangeSetInput, scope: CommitScope): ChangeSetResult } {
  return {
    commitChangeSet(input, scope) {
      // Layer 1 (schema): zod strict is the authority — the facade may hand over a structurally-typed shape.
      const parsed = ALONG_CHANGE_SET_INPUT_SCHEMA.safeParse(input)
      if (!parsed.success) {
        const audit = invalidAuditRow(scope.userId, input, scope)
        if (audit !== undefined) store.saveChangeSet(audit)
        return { status: 'invalid', reason: 'invalid_schema' }
      }
      // Everything below — idempotent replay, all four layers, and the application — runs inside one atomic
      // block, so the version comparison and the writes it guards are serialized (BC-08-09's hard guarantee).
      return store.atomic(() => {
        const existing = store.changeSetByIdempotencyKey(scope.userId, parsed.data.idempotency_key)
        if (existing !== undefined) return replayResult(existing)
        return validateAndApply(store, parsed.data, scope, options.available)
      })
    },
  }
}
