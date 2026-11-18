/**
 * The only writer of the Along business database (`along.sqlite`): storage primitives owned by the Stage A
 * storage module (design §2.1/§3/§4.3). Every business write goes through this class — other modules must not
 * run their own SQL against the business database. All writes run inside `atomic()` savepoints so that Inbox +
 * business rows + deliveries commit or roll back together (BC-08-01), and every read that returns user data
 * checks ownership itself (BC-07-05): callers never rely on an external assertion.
 *
 * Open pattern copied from `src/app/store.ts` (`node:sqlite` `DatabaseSync`, WAL, `synchronous=FULL`, chmod
 * 0600, version check plus single-transaction migration); the directory lock is held by the Runtime, not here.
 */
import { DatabaseSync, type SQLInputValue, type StatementResultingChanges } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isoTime } from '../core/model.ts'
import { migrateAlongSchema } from './migrate.ts'
import type { HealthContext } from './health-context.ts'
import { MemoryStore } from './memory/store.ts'
import type { ReminderPlan } from './reminder-plan.ts'
import { ResearchStore } from './research-store.ts'
import { HealthStore } from './health-store.ts'
import { MaintenanceStore } from './maintenance-store.ts'
import { recommendedSources, type DataSourceInput, type GoalDataSource } from './data-sources.ts'
import { taskExecution, type TaskExecutionSummary } from './task-execution.ts'
import { TaskTriggerStore, type TaskTriggerView } from './task-trigger.ts'
import { CalculationStore } from './calculation-store.ts'
import { SourceStateStore } from './source-state.ts'
import { CalculationEvidenceStore } from './calculation-evidence.ts'

/** Page of rows for the paged reads; `nextCursor` feeds back through `PageCursor.cursor`/`beforeSeq`. */
export interface Page<T> { items: T[]; nextCursor?: string }
/** Paging input. `limit` is clamped to 200; seq-keyed pages (messages) take `beforeSeq`, keyset pages take the opaque `cursor`. */
export interface PageCursor { beforeSeq?: number; cursor?: string; limit: number }
export interface TaskFilter { goalId?: string; status?: 'open' | 'done' | 'cancelled' }

export interface GoalRow {
  id: string; userId: string; domain: 'health' | 'finance' | 'custom'; status: 'active' | 'archived'
  currentRevision: number; originEventId?: string; createdAt: string; updatedAt: string
}
export interface GoalRevisionRow {
  goalId: string; revision: number; userId: string; title: string; metric?: unknown; context?: unknown
  status: 'active' | 'archived'; basisChangeset?: string; originEventId?: string; createdAt: string
}
export interface TaskRow {
  id: string; goalId: string; userId: string; status: 'open' | 'done' | 'cancelled'; content: string
  scheduledAt?: string; reminderPlan?: ReminderPlan; previousDailyOccurrence?: string; completedFeedbackEventId?: string; currentRevision: number; createdAt: string; updatedAt: string
  execution?: TaskExecutionSummary
  trigger?: TaskTriggerView
}
export interface TaskRevisionRow {
  taskId: string; revision: number; userId: string; goalId: string; content: string; status: 'open' | 'done' | 'cancelled'
  scheduledAt?: string; basisChangeset?: string; originEventId?: string; createdAt: string
}
export type MessageAudience = 'conversation' | 'background'
export interface MessageRow {
  audience: MessageAudience
  id: string; userId: string; eventId: string; role: 'user' | 'assistant' | 'system'; direction: 'inbound' | 'outbound'
  text: string; seq: number; occurredAt?: string; receivedAt: string; timezone?: string
  messageId?: string; causationId?: string; replyToMessageId?: string; createdAt: string
}
export interface AppendMessageInput {
  /** Set only by trusted host code; never accepted from an event or model schema. */
  audience?: MessageAudience
  userId: string; eventId: string; role: 'user' | 'assistant' | 'system'; direction: 'inbound' | 'outbound'; text: string
  occurredAt?: string; timezone?: string; messageId?: string; causationId?: string; replyToMessageId?: string
}
/** A message plus the goals it is linked to: one message row, many links — the body is never copied (BC-08-08). */
export interface MessageWithLinks extends MessageRow { goals: { goalId: string; relation: 'direct' | 'derived' }[] }

export interface ChangeSetRow {
  id: string; userId: string; goalId?: string; status: 'applied' | 'conflicted' | 'invalid'
  baseRevision: number; inputVersion: number; appliedRevision?: number; idempotencyKey: string
  triggerEventId?: string; workId?: string; ticketId?: string; assignmentId?: string
  reason: string; ops: unknown; derivedFromChangeset?: string; createdAt: string; result?: unknown
}
export interface ChangeSetSave extends Omit<ChangeSetRow, 'createdAt' | 'ops' | 'result'> { ops: unknown; result?: unknown }

export interface HealthSummaryPayload {
  type: string; metricVersion: string; unit?: string; statistic?: string
  window?: { start: string; end: string } | { night: string }; timezone?: string; value?: unknown
  availability: 'ok' | 'no_permission' | 'unavailable' | 'not_synced'; summarizerVersion: string
  context?: HealthContext
}
/**
 * Structural view of the health event envelope the store needs; the canonical `EventEnvelope` type lives in
 * `src/along/envelope.ts` (inbox module, design §4.3) and is structurally compatible with this input.
 */
export interface HealthSummaryEvent { eventId: string; timezone?: string; payload: { summaries?: readonly HealthSummaryPayload[] } }
export interface HealthSummaryRow {
  id: string; userId: string; type: string; metricVersion: string; windowStart?: string; windowEnd?: string
  timezone?: string; unit?: string; statistic?: string; value?: unknown; availability: 'ok' | 'no_permission' | 'unavailable' | 'not_synced'
  summarizerVersion: string; adapter: 'known' | 'pending'; eventId: string; receivedAt: string; superseded: boolean
  context?: HealthContext
}

export interface InboxEventInput {
  userId: string; eventId: string; schemaVersion: string; eventType: string; deviceId: string
  kind?: string; goalId?: string; taskId?: string; occurredAt?: string; receivedAt: string; timezone?: string
  messageId?: string; causationId?: string; baseRevision?: number
  payload: unknown; payloadHash: string; status: 'accepted' | 'rejected'; rejectReason?: string; triggerId?: string
}
export interface InboxEventRow extends InboxEventInput { createdAt: string }

export interface DeliveryRow {
  seq: number; userId: string; eventId: string; triggerId: string
  status: 'pending' | 'delivered' | 'failed' | 'filtered'; attempts: number; nextAttemptAt: number
  lastAttemptAt?: string; lastError?: string; deliveredAt?: string; createdAt: string
}

export interface WorkLinkInput {
  ticketId: string; assignmentId?: string; workId: string; goalId?: string; taskId?: string
  eventId?: string; triggerId?: string; threadKey: string; kind: 'ticket' | 'resume'
}
export interface WorkLinkRow {
  ticketId: string; assignmentId?: string; workId: string; goalId?: string; taskId?: string
  eventId?: string; triggerId?: string; threadKey: string; kind: 'ticket' | 'resume'; endedAt?: string; createdAt: string
}

export interface RunRecordInput {
  ticketId: string; assignmentId: string; userId?: string; workId?: string; goalId?: string; taskId?: string
  triggerEventId?: string; promptRevisions?: readonly number[]; toolTraceRef?: string
  reportState?: string; reportSummary?: string; changesetId?: string; endedAt?: string
}
export interface RunRecordRow {
  id: string; ticketId: string; assignmentId: string; userId?: string; workId?: string; goalId?: string; taskId?: string
  triggerEventId?: string; promptRevisions?: number[]; toolTraceRef?: string
  reportState?: string; reportSummary?: string; changesetId?: string; endedAt?: string; createdAt: string
}

export interface SyncItemInput {
  userId: string; kind: 'goal_updated' | 'task_updated' | 'changeset_note' | 'message' | 'delivery_failed'
  goalId?: string; taskId?: string; messageId?: string; changesetId?: string; payload: unknown
}
export interface SyncItem {
  seq: number; userId: string; kind: SyncItemInput['kind']; goalId?: string; taskId?: string
  messageId?: string; changesetId?: string; payload: unknown; createdAt: string; deliveredAt?: string
}

export interface GoalDetail { goal: GoalRow; revision?: GoalRevisionRow; tasks: TaskRow[]; recentChangesets: ChangeSetRow[]; dataSources: GoalDataSource[] }

/** Thrown when a resource is missing **or** belongs to another user — one shape for both, so existence never leaks (BC-07-05). */
export class OwnershipError extends Error {
  constructor() { super('along resource not found for this user') }
}
/** Thrown when the business data directory would sit inside the worker execution root (or vice versa) — BC-07-02. */
export class AlongIsolationError extends Error {}

/** Random URL-safe token (`12` hex chars by default) for server-generated `g_`/`t_`/`cs_`/`w_` ids. */
export const randomToken = (bytes = 6): string => randomBytes(bytes).toString('hex')

/** The worker execution root defaults to `<stateDir>/work` (`src/app/execution-environment.ts`); see `assertAlongDataIsolation`. */
const containsPath = (parent: string, child: string): boolean => {
  const pathFromParent = relative(parent, child)
  // Only a complete `..` segment escapes the parent; `..private` is an ordinary child name.
  return pathFromParent === '' || (!isAbsolute(pathFromParent)
    && pathFromParent !== '..' && !pathFromParent.startsWith(`..${sep}`))
}
/**
 * Fail-fast startup guard (BC-07-02): the business data directory and the worker execution root must not contain
 * each other, so worker tickets cannot be rooted at (or above) the business database. Directory placement is a
 * convention, not a sandbox — the write path is guarded by this service layer plus version checks.
 */
export function assertAlongDataIsolation(alongStateDir: string, workerRoot: string): void {
  const data = resolve(alongStateDir)
  const root = resolve(workerRoot)
  if (containsPath(data, root) || containsPath(root, data)) throw new AlongIsolationError(`along data directory ${data} must not overlap the worker execution root ${root} (BC-07-02)`)
}

const MAX_PAGE = 200
const pageLimit = (limit: number): number => Math.max(1, Math.min(MAX_PAGE, Math.floor(limit)))
const encodeKeyCursor = (at: string, id: string): string => JSON.stringify([at, id])
const decodeKeyCursor = (cursor: string | undefined): [string, string] | undefined => {
  if (cursor === undefined) return undefined
  let value: unknown
  try { value = JSON.parse(cursor) } catch { throw new Error('invalid page cursor') }
  if (!Array.isArray(value) || typeof value[0] !== 'string' || typeof value[1] !== 'string') throw new Error('invalid page cursor')
  return [value[0], value[1]]
}
/** Continuation cursor of seq-keyed pages: a plain non-negative integer string. */
const decodeSeqCursor = (cursor: string | undefined): number | undefined => {
  if (cursor === undefined) return undefined
  if (!/^\d+$/.test(cursor)) throw new Error('invalid page cursor')
  return Number(cursor)
}
const DELIVERY_LEASE_MS = 30_000
const DELIVERY_FAILURE_LIMIT = 12
const DELIVERY_FAILED_RETRY_MS = 600_000
const DELIVERY_MAX_BACKOFF_MS = 60_000
const AVAILABILITIES = new Set(['ok', 'no_permission', 'unavailable', 'not_synced'])

const jsonOrUndefined = (value: unknown): string | null => value === undefined ? null : JSON.stringify(value)

/**
 * SQLite-backed business store. One instance per process; the Runtime holds the `alongStateDir` directory lock
 * so a second process cannot open the same database (single writer).
 */
export class AlongStore {
  private readonly db: DatabaseSync
  /** Memory persistence shares this store's handle, savepoints and lifetime. */
  readonly memory: MemoryStore
  readonly maintenance: MaintenanceStore
  readonly health: HealthStore
  readonly research: ResearchStore
  readonly triggers: TaskTriggerStore
  readonly calculations: CalculationStore
  readonly sources: SourceStateStore
  readonly calculationEvidence:CalculationEvidenceStore
  private depth = 0
  /**
   * Opens (or creates) the database at `path`, sets the durability PRAGMAs and migrates the schema.
   * @throws When the schema version is unsupported or migration fails; the handle is closed in every error case.
   */
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    try {
      chmodSync(path, 0o600)
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON')
      migrateAlongSchema(this.db)
      this.memory = new MemoryStore(this.db, work => this.atomic(work))
      this.maintenance = new MaintenanceStore(this.db, work => this.atomic(work))
      this.health = new HealthStore(this.db)
      this.research = new ResearchStore(this.db)
      this.triggers = new TaskTriggerStore(this.db)
      this.calculations = new CalculationStore(this.db)
      this.sources = new SourceStateStore(this.db)
      this.calculationEvidence=new CalculationEvidenceStore(this.db,this.sources)
    } catch (error) {
      this.db.close()
      throw error
    }
  }
  /** Closes the underlying SQLite handle. */
  close(): void { this.db.close() }

  private run(sql: string, ...values: unknown[]): StatementResultingChanges {
    return this.db.prepare(sql).run(...values.map(value => value === undefined ? null : value as SQLInputValue))
  }
  private one(sql: string, ...values: unknown[]): Record<string, SQLInputValue> | undefined {
    return this.db.prepare(sql).get(...values.map(value => value === undefined ? null : value as SQLInputValue))
  }
  private all(sql: string, ...values: unknown[]): Record<string, SQLInputValue>[] {
    return this.db.prepare(sql).all(...values.map(value => value === undefined ? null : value as SQLInputValue))
  }
  private scalar(sql: string, ...values: unknown[]): unknown {
    const row = this.one(sql, ...values)
    return row === undefined ? undefined : Object.values(row)[0]
  }
  /**
   * Executes `operation` in a savepoint (nested inside any outer transaction); a failure rolls back its changes
   * only. Every write path of this class runs through here, so composed flows (accept, commit, import) are
   * all-or-nothing (BC-08-01).
   */
  atomic<T>(operation: () => T): T {
    const level = this.depth++
    const name = `along_atomic_${level}`
    this.db.exec(`SAVEPOINT ${name}`)
    let value: T
    try { value = operation(); this.db.exec(`RELEASE ${name}`) }
    catch (error) { this.db.exec(`ROLLBACK TO ${name}`); this.db.exec(`RELEASE ${name}`); throw error }
    finally { this.depth-- }
    return value
  }

  private text = (value: unknown): string => String(value)
  private opt = (value: unknown): string | undefined => value === null || value === undefined ? undefined : String(value)
  private int = (value: unknown): number => Number(value)
  private bool = (value: unknown): boolean => Number(value) === 1

  private goalRow(row: Record<string, SQLInputValue>): GoalRow {
    return { id: this.text(row.id), userId: this.text(row.user_id), domain: this.text(row.domain) as GoalRow['domain'],
      status: this.text(row.status) as GoalRow['status'], currentRevision: this.int(row.current_revision),
      originEventId: this.opt(row.origin_event_id), createdAt: this.text(row.created_at), updatedAt: this.text(row.updated_at) }
  }
  private goalRevisionRow(row: Record<string, SQLInputValue>): GoalRevisionRow {
    return { goalId: this.text(row.goal_id), revision: this.int(row.revision), userId: this.text(row.user_id), title: this.text(row.title),
      metric: row.metric === null ? undefined : JSON.parse(String(row.metric)), context: row.context === null ? undefined : JSON.parse(String(row.context)),
      status: this.text(row.status) as GoalRevisionRow['status'], basisChangeset: this.opt(row.basis_changeset),
      originEventId: this.opt(row.origin_event_id), createdAt: this.text(row.created_at) }
  }
  private taskRow(row: Record<string, SQLInputValue>): TaskRow {
    return { id: this.text(row.id), goalId: this.text(row.goal_id), userId: this.text(row.user_id),
      status: this.text(row.status) as TaskRow['status'], content: this.text(row.content), scheduledAt: this.opt(row.scheduled_at),
      reminderPlan: this.health.reminderPlan(this.text(row.id)),
      previousDailyOccurrence: this.health.previousDailyOccurrence(this.text(row.id), this.int(row.current_revision)),
      completedFeedbackEventId: this.opt(row.completed_feedback_event_id), currentRevision: this.int(row.current_revision),
      createdAt: this.text(row.created_at), updatedAt: this.text(row.updated_at),
      ...(this.triggers.view(this.text(row.user_id),this.text(row.id)) ? {trigger:this.triggers.view(this.text(row.user_id),this.text(row.id))} : {}) }
  }
  private messageRow(row: Record<string, SQLInputValue>): MessageRow {
    return { id: this.text(row.id), userId: this.text(row.user_id), eventId: this.text(row.event_id),
      audience: this.text(row.audience) as MessageAudience, role: this.text(row.role) as MessageRow['role'], direction: this.text(row.direction) as MessageRow['direction'],
      text: this.text(row.text), seq: this.int(row.seq), occurredAt: this.opt(row.occurred_at), receivedAt: this.text(row.received_at),
      timezone: this.opt(row.timezone), messageId: this.opt(row.message_id), causationId: this.opt(row.causation_id),
      replyToMessageId: this.opt(row.reply_to_message_id), createdAt: this.text(row.created_at) }
  }
  private changeSetRow(row: Record<string, SQLInputValue>): ChangeSetRow {
    return { id: this.text(row.id), userId: this.text(row.user_id), goalId: this.opt(row.goal_id),
      status: this.text(row.status) as ChangeSetRow['status'], baseRevision: this.int(row.base_revision),
      inputVersion: this.int(row.input_version), appliedRevision: row.applied_revision === null ? undefined : this.int(row.applied_revision),
      idempotencyKey: this.text(row.idempotency_key), triggerEventId: this.opt(row.trigger_event_id),
      workId: this.opt(row.work_id), ticketId: this.opt(row.ticket_id), assignmentId: this.opt(row.assignment_id),
      reason: this.text(row.reason), ops: JSON.parse(String(row.ops)), derivedFromChangeset: this.opt(row.derived_from_changeset),
      createdAt: this.text(row.created_at), result: row.result === null ? undefined : JSON.parse(String(row.result)) }
  }
  private healthRow(row: Record<string, SQLInputValue>): HealthSummaryRow {
    return { id: this.text(row.id), userId: this.text(row.user_id), type: this.text(row.type), metricVersion: this.text(row.metric_version),
      windowStart: this.opt(row.window_start), windowEnd: this.opt(row.window_end), timezone: this.opt(row.timezone),
      unit: this.opt(row.unit), statistic: this.opt(row.statistic), value: row.value === null ? undefined : JSON.parse(String(row.value)),
      availability: this.text(row.availability) as HealthSummaryRow['availability'], summarizerVersion: this.text(row.summarizer_version),
      adapter: this.text(row.adapter) as HealthSummaryRow['adapter'], eventId: this.text(row.event_id),
      receivedAt: this.text(row.received_at), superseded: this.bool(row.superseded),
      ...(typeof row.context === 'string' ? { context: JSON.parse(row.context) as HealthContext } : {}) }
  }
  private inboxRow(row: Record<string, SQLInputValue>): InboxEventRow {
    return { userId: this.text(row.user_id), eventId: this.text(row.event_id), schemaVersion: this.text(row.schema_version),
      eventType: this.text(row.event_type), deviceId: this.text(row.device_id), kind: this.opt(row.kind),
      goalId: this.opt(row.goal_id), taskId: this.opt(row.task_id), occurredAt: this.opt(row.occurred_at),
      receivedAt: this.text(row.received_at), timezone: this.opt(row.timezone), messageId: this.opt(row.message_id),
      causationId: this.opt(row.causation_id), baseRevision: row.base_revision === null ? undefined : this.int(row.base_revision),
      payload: JSON.parse(String(row.payload)), payloadHash: this.text(row.payload_hash),
      status: this.text(row.status) as InboxEventRow['status'], rejectReason: this.opt(row.reject_reason),
      triggerId: this.opt(row.trigger_id), createdAt: this.text(row.created_at) }
  }
  private deliveryRow(row: Record<string, SQLInputValue>): DeliveryRow {
    return { seq: this.int(row.seq), userId: this.text(row.user_id), eventId: this.text(row.event_id), triggerId: this.text(row.trigger_id),
      status: this.text(row.status) as DeliveryRow['status'], attempts: this.int(row.attempts), nextAttemptAt: this.int(row.next_attempt_at),
      lastAttemptAt: this.opt(row.last_attempt_at), lastError: this.opt(row.last_error),
      deliveredAt: this.opt(row.delivered_at), createdAt: this.text(row.created_at) }
  }
  private workLinkRow(row: Record<string, SQLInputValue>): WorkLinkRow {
    return { ticketId: this.text(row.ticket_id), assignmentId: this.opt(row.assignment_id), workId: this.text(row.work_id),
      goalId: this.opt(row.goal_id), taskId: this.opt(row.task_id), eventId: this.opt(row.event_id), triggerId: this.opt(row.trigger_id),
      threadKey: this.text(row.thread_key), kind: this.text(row.kind) as WorkLinkRow['kind'],
      endedAt: this.opt(row.ended_at), createdAt: this.text(row.created_at) }
  }
  private syncRow(row: Record<string, SQLInputValue>): SyncItem {
    return { seq: this.int(row.seq), userId: this.text(row.user_id), kind: this.text(row.kind) as SyncItem['kind'],
      goalId: this.opt(row.goal_id), taskId: this.opt(row.task_id), messageId: this.opt(row.message_id),
      changesetId: this.opt(row.changeset_id), payload: JSON.parse(String(row.payload)),
      createdAt: this.text(row.created_at), deliveredAt: this.opt(row.delivered_at) }
  }
  private runRecordRow(row: Record<string, SQLInputValue>): RunRecordRow {
    return { id: this.text(row.id), ticketId: this.text(row.ticket_id), assignmentId: this.text(row.assignment_id),
      userId: this.opt(row.user_id), workId: this.opt(row.work_id), goalId: this.opt(row.goal_id), taskId: this.opt(row.task_id),
      triggerEventId: this.opt(row.trigger_event_id),
      promptRevisions: row.prompt_revisions === null ? undefined : JSON.parse(String(row.prompt_revisions)) as number[],
      toolTraceRef: this.opt(row.tool_trace_ref), reportState: this.opt(row.report_state), reportSummary: this.opt(row.report_summary),
      changesetId: this.opt(row.changeset_id), endedAt: this.opt(row.ended_at), createdAt: this.text(row.created_at) }
  }

  // ---- users & ownership --------------------------------------------------------------------------------------------

  /** Idempotently upserts the paired user (first sight of a bound identity); a provided `deviceId` re-binds the same user (device replacement). */
  assertUser(userId: string, deviceId?: string): void {
    this.atomic(() => {
      this.run('INSERT INTO user (id, name, device_id, created_at) VALUES (?, NULL, ?, ?) ON CONFLICT(id) DO UPDATE SET device_id = CASE WHEN excluded.device_id = \'\' THEN user.device_id ELSE excluded.device_id END',
        userId, deviceId ?? '', new Date().toISOString())
    })
  }
  /** The user's goal row, or `undefined` when it is missing **or** owned by someone else (no existence leak). */
  getGoal(userId: string, goalId: string): GoalRow | undefined {
    const row = this.one('SELECT * FROM goal WHERE id = ?', goalId)
    return row === undefined || this.text(row.user_id) !== userId ? undefined : this.goalRow(row)
  }
  /** @throws `OwnershipError` when the goal is missing or belongs to another user (BC-07-05). */
  assertGoalOwner(userId: string, goalId: string): GoalRow {
    const goal = this.getGoal(userId, goalId)
    if (!goal) throw new OwnershipError()
    return goal
  }
  /** The user's task row, or `undefined` when it is missing **or** owned by someone else (no existence leak). */
  taskRevisionOrigin(taskId: string, revision: number): string | undefined {
    return this.opt(this.one('SELECT origin_event_id FROM task_revision WHERE task_id=? AND revision=?', taskId, revision)?.origin_event_id)
  }
  /** The original task wording at a host-bound due revision, with ownership checked. */
  taskRevisionContent(userId:string,taskId:string,revision:number):string | undefined {
    const task=this.getTask(userId,taskId)
    if(!task)return undefined
    return this.opt(this.one('SELECT content FROM task_revision WHERE task_id=? AND revision=? AND user_id=?',taskId,revision,userId)?.content)
      ??(task.currentRevision===revision?task.content:undefined)
  }
  /** Wording before this host message's own edits, using existing revision history (not a clock snapshot). */
  taskBeforeMessage(userId:string,taskId:string,message:MessageRow):{content:string;scheduledAt?:string}|undefined {
    if(!this.getTask(userId,taskId)||message.userId!==userId)return
    const row=this.one(`SELECT content,scheduled_at FROM task_revision WHERE user_id=? AND task_id=? AND created_at<=?
      AND (origin_event_id IS NULL OR origin_event_id<>?) ORDER BY revision DESC LIMIT 1`,userId,taskId,message.receivedAt,message.eventId)
    return row?{content:this.text(row.content),scheduledAt:this.opt(row.scheduled_at)}:undefined
  }
  getTask(userId: string, taskId: string): TaskRow | undefined {
    const row = this.one('SELECT * FROM user_task WHERE id = ?', taskId)
    return row === undefined || this.text(row.user_id) !== userId ? undefined : this.taskRow(row)
  }
  /** @throws `OwnershipError` when the task is missing or belongs to another user (BC-07-05). */
  assertTaskOwner(userId: string, taskId: string): TaskRow {
    const task = this.getTask(userId, taskId)
    if (!task) throw new OwnershipError()
    return task
  }

  // ---- version primitives ---------------------------------------------------------------------------------------------

  /** Current object revision; `0` when the row does not exist yet (`goal.create` expects `base_revision = 0`). */
  currentRevision(kind: 'goal' | 'task', id: string): number {
    const row = kind === 'goal'
      ? this.one('SELECT current_revision FROM goal WHERE id = ?', id)
      : this.one('SELECT current_revision FROM user_task WHERE id = ?', id)
    return row === undefined ? 0 : this.int(row.current_revision)
  }
  /** The goal's input version; `0` when absent, so a stale claimed input version can never match. */
  inputVersion(goalId: string): number {
    const row = this.one('SELECT version FROM input_version WHERE goal_id = ?', goalId)
    return row === undefined ? 0 : this.int(row.version)
  }
  /** Raises the input version (a user's new chat); the raising event is recorded for the audit trail (001 §7.4). */
  raiseInputVersion(userId: string, goalId: string, eventId: string): number {
    return this.atomic(() => {
      this.assertGoalOwner(userId, goalId)
      this.run(`INSERT INTO input_version (goal_id, user_id, version, raised_by, updated_at) VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(goal_id) DO UPDATE SET version = input_version.version + 1, raised_by = excluded.raised_by, updated_at = excluded.updated_at`,
        goalId, userId, eventId, new Date().toISOString())
      return this.inputVersion(goalId)
    })
  }
  /** Inserts `version = 1` when missing (goal creation and legacy import); never bumps an existing row. */
  ensureInputVersion(userId: string, goalId: string, raisedBy?: string): number {
    return this.atomic(() => {
      this.assertGoalOwner(userId, goalId)
      this.run('INSERT INTO input_version (goal_id, user_id, version, raised_by, updated_at) VALUES (?, ?, 1, ?, ?) ON CONFLICT(goal_id) DO NOTHING',
        goalId, userId, raisedBy, new Date().toISOString())
      return this.inputVersion(goalId)
    })
  }

  // ---- goals & tasks (written by the changeset module and the legacy import) -------------------------------------------

  /** Creates the goal current-state row (revision 0, status `active`); content lands via `appendGoalRevision`. */
  insertGoal(input: { userId: string; domain: GoalRow['domain']; goalId?: string; originEventId?: string }): GoalRow {
    return this.atomic(() => {
      this.assertUser(input.userId)
      const id = input.goalId ?? `g_${randomToken()}`
      const now = new Date().toISOString()
      this.run('INSERT INTO goal (id, user_id, domain, status, current_revision, origin_event_id, created_at, updated_at) VALUES (?, ?, ?, \'active\', 0, ?, ?, ?)',
        id, input.userId, input.domain, input.originEventId, now, now)
      return this.assertGoalOwner(input.userId, id)
    })
  }
  /**
   * Appends the next goal revision and moves the current pointer; the goal row's `status` follows the revision's.
   * Import and first-creation pass `basisChangeset: undefined` (design §3 `goal_revision.basis_changeset`).
   */
  appendGoalRevision(input: { goalId: string; userId: string; title: string; metric?: unknown; context?: unknown
    status: GoalRevisionRow['status']; basisChangeset?: string; originEventId?: string }): number {
    return this.atomic(() => {
      const goal = this.assertGoalOwner(input.userId, input.goalId)
      const revision = goal.currentRevision + 1
      const now = new Date().toISOString()
      this.run(`INSERT INTO goal_revision (goal_id, revision, user_id, title, metric, context, status, basis_changeset, origin_event_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.goalId, revision, input.userId, input.title, jsonOrUndefined(input.metric), jsonOrUndefined(input.context),
        input.status, input.basisChangeset, input.originEventId, now)
      this.run('UPDATE goal SET current_revision = ?, status = ?, updated_at = ? WHERE id = ?', revision, input.status, now, input.goalId)
      return revision
    })
  }
  /** The revision row currently pointed at by `goal.current_revision`. */
  currentGoalRevision(goalId: string): GoalRevisionRow | undefined {
    const row = this.one('SELECT * FROM goal_revision WHERE goal_id = ? AND revision = (SELECT current_revision FROM goal WHERE id = ?)', goalId, goalId)
    return row === undefined ? undefined : this.goalRevisionRow(row)
  }
  /** All revisions of one goal, oldest first (`along_goal_read include_revisions`). */
  goalRevisions(goalId: string): GoalRevisionRow[] {
    return this.all('SELECT * FROM goal_revision WHERE goal_id = ? ORDER BY revision', goalId).map(row => this.goalRevisionRow(row))
  }
  /** Creates a task current-state row (revision 0, status `open`); content history lands via `appendTaskRevision`. */
  insertTask(input: { goalId: string; userId: string; content: string; scheduledAt?: string | null; taskId?: string }): TaskRow {
    return this.atomic(() => {
      this.assertGoalOwner(input.userId, input.goalId)
      const id = input.taskId ?? `t_${randomToken()}`
      const now = new Date().toISOString()
      this.run(`INSERT INTO user_task (id, goal_id, user_id, status, content, scheduled_at, completed_feedback_event_id, current_revision, created_at, updated_at)
        VALUES (?, ?, ?, 'open', ?, ?, NULL, 0, ?, ?)`,
        id, input.goalId, input.userId, input.content, input.scheduledAt, now, now)
      return this.assertTaskOwner(input.userId, id)
    })
  }
  /**
   * Appends the next task revision, syncs the current-state row, and moves the pointer. `scheduledAt: null` clears
   * the field; `undefined` keeps it. A completion feedback (`completedFeedbackEventId`) is a fact recorded by the
   * receiver (design §2.2.6, D4), never a ChangeSet, and must not be overwritten afterwards (BC-02-07).
   */
  appendTaskRevision(input: { taskId: string; userId: string; content?: string; status?: TaskRow['status']; scheduledAt?: string | null
    basisChangeset?: string; originEventId?: string; completedFeedbackEventId?: string }): number {
    return this.atomic(() => {
      const task = this.assertTaskOwner(input.userId, input.taskId)
      const revision = task.currentRevision + 1
      const content = input.content ?? task.content
      const status = input.status ?? task.status
      const scheduledAt = input.scheduledAt === undefined ? task.scheduledAt : input.scheduledAt
      const completed = input.completedFeedbackEventId ?? task.completedFeedbackEventId
      const now = new Date().toISOString()
      this.run(`INSERT INTO task_revision (task_id, revision, user_id, goal_id, content, status, scheduled_at, basis_changeset, origin_event_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.taskId, revision, input.userId, task.goalId, content, status, scheduledAt, input.basisChangeset, input.originEventId, now)
      this.run('UPDATE user_task SET content = ?, status = ?, scheduled_at = ?, completed_feedback_event_id = ?, current_revision = ?, updated_at = ? WHERE id = ?',
        content, status, scheduledAt, completed, revision, now, input.taskId)
      if (status !== 'open') {
        this.health.setDaily(input.taskId)
        this.health.savePlan(input.taskId,undefined)
      }
      this.triggers.carry({id:task.id,userId:task.userId,goalId:task.goalId,currentRevision:revision,status,content,
        ...(scheduledAt?{scheduledAt}:{}),createdAt:task.createdAt})
      return revision
    })
  }

  // ---- messages (BC-08-07 / BC-08-08) -----------------------------------------------------------------------------------

  /**
   * Appends one message row. `id` is anchored to the event (`msg:<user_id>:<event_id>`), so a re-sent event never
   * creates a second row; `seq` is allocated per user inside the transaction and is the **only** causal order —
   * `occurredAt` is display metadata and never participates in ordering (BC-08-07).
   */
  appendMessage(input: AppendMessageInput): MessageRow {
    return this.atomic(() => {
      const id = `msg:${input.userId}:${input.eventId}`
      const existing = this.one('SELECT * FROM message WHERE id = ?', id)
      if (existing !== undefined) return this.messageRow(existing)
      if (typeof input.text !== 'string' || input.text.trim() === '') throw new Error('along message text must not be empty')
      const now = new Date().toISOString()
      const parent = input.replyToMessageId && this.getMessage(input.userId, input.replyToMessageId)
      const audience = input.role === 'assistant' && parent && parent.audience === 'background' ? 'background' : input.audience ?? 'conversation'
      const seq = Number(this.scalar('SELECT IFNULL(MAX(seq), 0) FROM message WHERE user_id = ?', input.userId) ?? 0) + 1
      this.run(`INSERT INTO message (id, user_id, event_id, role, direction, text, seq, occurred_at, received_at, timezone, message_id, causation_id, reply_to_message_id, created_at, audience)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, input.userId, input.eventId, input.role, input.direction, input.text, seq,
        input.occurredAt === undefined ? null : isoTime(input.occurredAt), now, input.timezone,
        input.messageId, input.causationId, input.replyToMessageId, now, audience)
      return { audience, id, userId: input.userId, eventId: input.eventId, role: input.role, direction: input.direction, text: input.text,
        seq, occurredAt: input.occurredAt === undefined ? undefined : isoTime(input.occurredAt), receivedAt: now,
        timezone: input.timezone, messageId: input.messageId, causationId: input.causationId,
        replyToMessageId: input.replyToMessageId, createdAt: now }
    })
  }
  /** The user's message row by its deterministic id, or `undefined` when missing or owned by someone else. */
  getMessage(userId: string, messageId: string): MessageRow | undefined {
    const row = this.one('SELECT * FROM message WHERE id = ?', messageId)
    return row === undefined || this.text(row.user_id) !== userId ? undefined : this.messageRow(row)
  }
  messageLinkedToGoal(messageId: string, goalId: string): boolean {
    return !!this.one('SELECT 1 FROM message_goal_link WHERE message_id=? AND goal_id=?', messageId, goalId)
  }
  /** Resolves a user-message conversation by server-owned ancestry; unknown/foreign references are identical. */
  conversationRoot(userId: string, eventId: string): string {
    let message = this.getMessage(userId, `msg:${userId}:${eventId}`)
    if (!message || message.role !== 'user' || message.direction !== 'inbound') throw new OwnershipError()
    for (let depth = 0; message.causationId !== undefined; depth++) {
      const parent = this.getMessage(userId, `msg:${userId}:${message.causationId}`)
      if (!parent || parent.role !== 'user' || parent.seq >= message.seq || depth >= 100) throw new OwnershipError()
      message = parent
    }
    return message.eventId
  }
  /** Validated conversation root is stored on follow-up messages; first messages use their own event id. */
  conversationMessages(userId: string, eventId: string): MessageRow[] {
    const root = this.conversationRoot(userId, eventId)
    return this.all('SELECT * FROM message WHERE user_id = ? AND (event_id = ? OR causation_id = ?) ORDER BY seq',
      userId, root, root).map(row => this.messageRow(row))
  }
  /** Goal association from a persisted user message, including a goal created after the message arrived. */
  conversationGoal(userId: string, eventId: string): string | undefined {
    const root = this.conversationRoot(userId, eventId)
    const row = this.one('SELECT goal_id FROM message_goal_link WHERE user_id = ? AND message_id = ? ORDER BY goal_id LIMIT 1',
      userId, `msg:${userId}:${root}`)
    return row === undefined ? undefined : this.text(row.goal_id)
  }
  /** Checks the original input even if a worker re-reads a newer version number before committing. */
  isCurrentChatInput(userId: string, eventId: string, goalId?: string): boolean {
    const source = this.getMessage(userId, `msg:${userId}:${eventId}`)
    if (!source || source.audience !== 'conversation' || source.role !== 'user') return false
    if (goalId !== undefined) {
      this.assertGoalOwner(userId,goalId)
      return !this.one(`SELECT 1 FROM message m JOIN message_goal_link l ON l.message_id=m.id AND l.goal_id=?
        WHERE m.user_id=? AND m.audience='conversation' AND m.direction='inbound' AND m.role='user' AND m.seq>? LIMIT 1`,goalId,userId,source.seq)
    }
    return !this.conversationMessages(userId,eventId).some(message => message.audience === 'conversation' && message.direction === 'inbound' && message.role === 'user' && message.seq > source.seq)
  }
  /** Rebuilds a phone cache from durable rows; payloads expose business data only, never execution credentials. */
  workspaceSync(userId: string, afterSeq: number, limit: number, conversationVersion = 1): Page<SyncItem> {
    const page = this.syncPage(userId, afterSeq, limit)
    return { ...page, items: page.items.map(item => {
      const message = item.messageId === undefined ? undefined : this.getMessage(userId, item.messageId)
      const snapshot = item.goalId === undefined ? {} : { snapshot: this.goalDetail(userId, item.goalId) }
      const payload = { ...item.payload as Record<string,unknown> }
      // A historical model-labelled ask has no host authority to alert a person. Project safely without
      // mutating its original audit/outbox row or refreshing the notification's age.
      if (message && this.one("SELECT 1 FROM message_audience_audit WHERE user_id=? AND message_id=? UNION ALL SELECT 1 FROM health_dispatch WHERE user_id=? AND 'followup_'||event_id=? AND json_extract(result,'$.outcome')='ask' LIMIT 1",userId,message.id,userId,message.eventId)) payload.classification_only=true
      // Old clients cannot understand an audience or remove cached messages. Keep the original sequence so
      // pagination/ack stay sound, but never forward new internal wording to them. An upgraded client replays.
      if (message?.audience === 'background' && conversationVersion !== 1) return {
        ...item, kind: 'changeset_note' as const, payload: snapshot,
      }
      return { ...item, payload: { ...payload, ...snapshot,
        ...(message === undefined ? {} : { message, audience: message.audience }) } }
    }) }
  }

  /** Host-only, evidence-backed correction of known development events. Bodies, goal/task state and inbox
   * receipts stay immutable. No API or Worker tool exposes this operation. Shared conversation roots are NOT
   * followed: a later real user message may share the root but is never a descendant answer to this input. */
  isolateDevelopmentEvents(userId: string, eventIds: readonly string[], evidenceRef: string, options: { dryRun?: boolean } = {}): { changed: string[] } {
    if (!eventIds.length || eventIds.length > 100 || typeof evidenceRef !== 'string' || !evidenceRef.trim() || evidenceRef.length > 1000)
      throw new Error('explicit development events and evidence are required')
    return this.atomic(() => {
      const changed: string[] = []
      for (const eventId of new Set(eventIds)) {
        const source = this.getMessage(userId, `msg:${userId}:${eventId}`)
        const inbox = this.findInboxEvent(userId, eventId)
        if (!source || !inbox || inbox.status !== 'accepted' || inbox.eventType !== 'along.user_message' || source.role !== 'user') throw new OwnershipError()
        const rows = this.all(`SELECT DISTINCT m.* FROM message m WHERE m.user_id=? AND (
          m.id=? OR (m.role='assistant' AND m.direction='outbound' AND m.reply_to_message_id=?) OR m.id IN (
            SELECT o.message_id FROM sync_outbox o JOIN changeset c ON c.id=o.changeset_id
            WHERE o.user_id=? AND c.user_id=? AND c.trigger_event_id=? AND o.kind='message'
          ) OR m.event_id IN (
            SELECT 'out:'||r.ticket_id||':'||r.assignment_id FROM run_record r WHERE r.user_id=? AND r.trigger_event_id=?
          )) ORDER BY m.seq`, userId, source.id, source.id, userId, userId, eventId, userId, eventId)
        for (const row of rows) {
          const message = this.messageRow(row)
          if (message.audience === 'background' || changed.includes(message.id)) continue
          if (options.dryRun) { changed.push(message.id); continue }
          this.run('INSERT INTO message_audience_audit(message_id,user_id,source_event_id,evidence_ref,previous_audience,created_at) VALUES(?,?,?,?,?,?)',
            message.id, userId, eventId, evidenceRef, message.audience, new Date().toISOString())
          this.run("UPDATE message SET audience='background' WHERE id=? AND user_id=?", message.id, userId)
          const prior = this.one("SELECT * FROM sync_outbox WHERE user_id=? AND message_id=? AND kind='message' ORDER BY seq DESC LIMIT 1", userId, message.id)
          const item = prior && this.syncRow(prior)
          this.appendSync({ userId, kind:'message', messageId:message.id,
            goalId:item?.goalId, taskId:item?.taskId, changesetId:item?.changesetId,
            payload:{ ...item?.payload as Record<string,unknown>, audience:'background', classification_only:true } })
          changed.push(message.id)
        }
      }
      return { changed }
    })
  }
  /** Links one message to many goals without copying the body (BC-08-08); every goal must belong to the message's user. */
  linkMessageToGoals(messageId: string, goalIds: readonly string[], relation: 'direct' | 'derived'): void {
    this.atomic(() => {
      const message = this.one('SELECT user_id FROM message WHERE id = ?', messageId)
      if (message === undefined) throw new OwnershipError()
      const userId = this.text(message.user_id)
      for (const goalId of goalIds) {
        const goal = this.one('SELECT user_id FROM goal WHERE id = ?', goalId)
        if (goal === undefined || this.text(goal.user_id) !== userId) throw new OwnershipError()
        this.run('INSERT INTO message_goal_link (message_id, goal_id, user_id, relation) VALUES (?, ?, ?, ?) ON CONFLICT(message_id, goal_id) DO NOTHING',
          messageId, goalId, userId, relation)
      }
    })
  }

  // ---- paged reads (every read checks ownership itself; BC-07-05) --------------------------------------------------------

  /** Goals newest first, keyset-paged by `(updated_at, id)`. */
  listGoals(userId: string, cursor: PageCursor = { limit: 50 }): Page<GoalRow> {
    const limit = pageLimit(cursor.limit)
    const key = decodeKeyCursor(cursor.cursor)
    const rows = key === undefined
      ? this.all('SELECT * FROM goal WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?', userId, limit)
      : this.all('SELECT * FROM goal WHERE user_id = ? AND (updated_at < ? OR (updated_at = ? AND id < ?)) ORDER BY updated_at DESC, id DESC LIMIT ?',
        userId, key[0], key[0], key[1], limit)
    const items = rows.map(row => this.goalRow(row))
    const last = items.at(-1)
    return { items, nextCursor: items.length === limit && last ? encodeKeyCursor(last.updatedAt, last.id) : undefined }
  }
  /** Goal detail: current revision, the goal's tasks, and the most recent change notes. */
  goalDetail(userId: string, goalId: string): GoalDetail {
    return this.atomic(() => ({
      goal: this.assertGoalOwner(userId, goalId),
      revision: this.currentGoalRevision(goalId),
      tasks: this.listTasks(userId, { goalId }, { limit: MAX_PAGE }).items.map(task => ({ ...task, execution: this.taskExecution(userId, task.id) })),
      recentChangesets: this.changeSetsByGoal(userId, goalId, { limit: 5 }).items,
      dataSources: this.goalDataSources(userId, goalId),
    }))
  }
  /** Display recommendations are scoped to a goal; they never grant access to an account. */
  goalDataSources(userId: string, goalId: string): GoalDataSource[] {
    const goal=this.assertGoalOwner(userId,goalId)
    const row=this.one('SELECT sources FROM goal_data_sources WHERE goal_id=? AND user_id=?',goalId,userId)
    const sources=row?recommendedSources(JSON.parse(String(row.sources))):[]
    const health=this.health.state(goalId)
    if (!sources.some(source=>source.provider==='apple-health') && (goal.domain==='health'||
        health?.inputVersion===this.inputVersion(goalId)&&health.types.length>0)) {
      sources.push({provider:'apple-health',status:'recommended',reason:'此目标需要所选健康摘要，用于评估和跟进安排。'})
    }
    return sources
  }
  /** Shares the goal writer's transaction. Host callers must establish current chat/version scope first. */
  replaceGoalDataSources(userId: string, goalId: string, input: DataSourceInput[]): boolean {
    return this.atomic(()=>{
      if(this.assertGoalOwner(userId,goalId).status!=='active')throw new Error('data sources require an active goal')
      const sources=recommendedSources(input).map(({provider,reason})=>({provider,reason}))
      const serialized=JSON.stringify(sources)
      const previous=this.one('SELECT sources FROM goal_data_sources WHERE goal_id=? AND user_id=?',goalId,userId)
      if((previous?String(previous.sources):'[]')===serialized)return false
      this.run('INSERT INTO goal_data_sources(goal_id,user_id,sources,updated_at) VALUES(?,?,?,?) ON CONFLICT(goal_id) DO UPDATE SET sources=excluded.sources,updated_at=excluded.updated_at',
        goalId,userId,serialized,new Date().toISOString())
      this.appendSync({userId,goalId,kind:'goal_updated',payload:{}})
      return true
    })
  }
  /** Product execution evidence, separate from worker assignment/run audit. */
  taskExecution(userId: string, taskId: string): TaskExecutionSummary {
    const task = this.assertTaskOwner(userId, taskId)
    return taskExecution(this.db, userId, task)
  }
  /** Tasks newest first, optionally filtered by goal (ownership-checked) and status. */
  listTasks(userId: string, filter: TaskFilter = {}, cursor: PageCursor = { limit: 50 }): Page<TaskRow> {
    const limit = pageLimit(cursor.limit)
    if (filter.goalId !== undefined) this.assertGoalOwner(userId, filter.goalId)
    const conditions = ['user_id = ?'], values: unknown[] = [userId]
    if (filter.goalId !== undefined) { conditions.push('goal_id = ?'); values.push(filter.goalId) }
    if (filter.status !== undefined) { conditions.push('status = ?'); values.push(filter.status) }
    const key = decodeKeyCursor(cursor.cursor)
    if (key !== undefined) { conditions.push('(updated_at < ? OR (updated_at = ? AND id < ?))'); values.push(key[0], key[0], key[1]) }
    values.push(limit)
    const rows = this.all(`SELECT * FROM user_task WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`, ...values)
    const items = rows.map(row => this.taskRow(row))
    const last = items.at(-1)
    return { items, nextCursor: items.length === limit && last ? encodeKeyCursor(last.updatedAt, last.id) : undefined }
  }
  /**
   * Full conversation of one goal, paged backwards from the newest message; each page is ordered by `seq`
   * ascending so it reads chronologically. `beforeSeq`/`cursor` continue into older pages (BC-08-07: order is
   * `seq`, never `occurred_at`).
   */
  messagesByGoal(userId: string, goalId: string, cursor: PageCursor = { limit: 50 }): Page<MessageWithLinks> {
    const limit = pageLimit(cursor.limit)
    return this.atomic(() => {
      this.assertGoalOwner(userId, goalId)
      const before = cursor.beforeSeq ?? decodeSeqCursor(cursor.cursor)
      const rows = (before === undefined
        ? this.all(`SELECT m.* FROM message m JOIN message_goal_link l ON l.message_id = m.id AND l.goal_id = ?
            WHERE m.user_id = ? ORDER BY m.seq DESC LIMIT ?`, goalId, userId, limit)
        : this.all(`SELECT m.* FROM message m JOIN message_goal_link l ON l.message_id = m.id AND l.goal_id = ?
            WHERE m.user_id = ? AND m.seq < ? ORDER BY m.seq DESC LIMIT ?`, goalId, userId, before, limit))
      const items = rows.map(row => this.messageRow(row)).reverse()
        .map(message => ({ ...message,
          goals: this.all('SELECT goal_id, relation FROM message_goal_link WHERE message_id = ? ORDER BY goal_id', message.id)
            .map(link => ({ goalId: this.text(link.goal_id), relation: this.text(link.relation) as 'direct' | 'derived' })) }))
      const oldest = items[0]
      return { items, nextCursor: items.length === limit && oldest ? String(oldest.seq) : undefined }
    })
  }
  /** Worker-facing history: filter trusted conversation and separate task-event facts BEFORE LIMIT. Internal
   * execution/maintenance rows never masquerade as user utterances and cannot consume a conversation page. */
  conversationContextPage(userId:string,goalId:string,beforeSeq?:number,limit=20):Page<MessageRow> {
    this.assertGoalOwner(userId,goalId)
    const size=pageLimit(limit)
    const rows=this.all(`SELECT m.* FROM message m WHERE m.user_id=? AND (? IS NULL OR m.seq<?) AND (
      (m.audience='conversation' AND EXISTS (SELECT 1 FROM message_goal_link l WHERE l.message_id=m.id AND l.goal_id=?))
      OR EXISTS (SELECT 1 FROM event_inbox e JOIN user_task t ON t.id=COALESCE(e.task_id,json_extract(e.payload,'$.task_id'))
        AND t.user_id=e.user_id WHERE e.user_id=m.user_id AND e.event_id=m.event_id AND t.goal_id=?
        AND e.status='accepted' AND e.event_type='along.message'
        AND COALESCE(e.kind,json_extract(e.payload,'$.kind')) IN ('task.feedback','task.completed'))
      ) ORDER BY m.seq DESC LIMIT ?`,userId,beforeSeq,beforeSeq,goalId,goalId,size+1)
    const items=rows.slice(0,size).map(row=>this.messageRow(row)).reverse()
    return {items,...(rows.length>size?{nextCursor:String(items[0]!.seq)}:{})}
  }
  /** Original task feedback from older snapshots may have no message_goal_link; resolve its owned task at read time. */
  taskFeedbackByGoal(userId:string,goalId:string,beforeSeq?:number,limit=50):MessageRow[] {
    this.assertGoalOwner(userId,goalId)
    return this.all(`SELECT m.* FROM message m JOIN event_inbox e ON e.user_id=m.user_id AND e.event_id=m.event_id
      JOIN user_task t ON t.id=COALESCE(e.task_id,json_extract(e.payload,'$.task_id')) AND t.user_id=m.user_id
      WHERE m.user_id=? AND t.goal_id=? AND e.status='accepted' AND e.event_type='along.message'
      AND COALESCE(e.kind,json_extract(e.payload,'$.kind')) IN ('task.feedback','task.completed')
      AND (? IS NULL OR m.seq<?) ORDER BY m.seq DESC LIMIT ?`,userId,goalId,beforeSeq,beforeSeq,pageLimit(limit)).map(row=>this.messageRow(row)).reverse()
  }
  /** ChangeSets of one goal, newest first, keyset-paged by `(created_at, id)` — the「改回去」history. */
  changeSetsByGoal(userId: string, goalId: string, cursor: PageCursor = { limit: 50 }): Page<ChangeSetRow> {
    const limit = pageLimit(cursor.limit)
    return this.atomic(() => {
      this.assertGoalOwner(userId, goalId)
      const key = decodeKeyCursor(cursor.cursor)
      const rows = key === undefined
        ? this.all('SELECT * FROM changeset WHERE goal_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', goalId, userId, limit)
        : this.all(`SELECT * FROM changeset WHERE goal_id = ? AND user_id = ?
            AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`,
          goalId, userId, key[0], key[0], key[1], limit)
      const items = rows.map(row => this.changeSetRow(row))
      const last = items.at(-1)
      return { items, nextCursor: items.length === limit && last ? encodeKeyCursor(last.createdAt, last.id) : undefined }
    })
  }

  // ---- change sets (written by the changeset module) ---------------------------------------------------------------------

  /** Inserts a ChangeSet row; returns `false` when the user's idempotency key already exists (BC-02-04 replay). */
  saveChangeSet(row: ChangeSetSave): boolean {
    return this.atomic(() => {
      const result = this.run(`INSERT INTO changeset (id, user_id, goal_id, status, base_revision, input_version, applied_revision, idempotency_key,
          trigger_event_id, work_id, ticket_id, assignment_id, reason, ops, derived_from_changeset, created_at, result)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, idempotency_key) DO NOTHING`,
        row.id, row.userId, row.goalId, row.status, row.baseRevision, row.inputVersion, row.appliedRevision, row.idempotencyKey,
        row.triggerEventId, row.workId, row.ticketId, row.assignmentId, row.reason, JSON.stringify(row.ops),
        row.derivedFromChangeset, new Date().toISOString(), jsonOrUndefined(row.result))
      return Number(result.changes) > 0
    })
  }
  /** Backfills `goal_id` / `applied_revision` / `result` after application (goal.create commits insert with `goal_id` NULL). */
  updateChangeSet(id: string, patch: { goalId?: string; appliedRevision?: number; result?: unknown }): void {
    this.atomic(() => {
      this.run('UPDATE changeset SET goal_id = COALESCE(?, goal_id), applied_revision = COALESCE(?, applied_revision), result = COALESCE(?, result) WHERE id = ?',
        patch.goalId, patch.appliedRevision, jsonOrUndefined(patch.result), id)
    })
  }
  /** The row behind a user's idempotency key — the replay source for BC-02-04. */
  changeSetByIdempotencyKey(userId: string, idempotencyKey: string): ChangeSetRow | undefined {
    const row = this.one('SELECT * FROM changeset WHERE user_id = ? AND idempotency_key = ?', userId, idempotencyKey)
    return row === undefined ? undefined : this.changeSetRow(row)
  }
  /** One ChangeSet row by id (owner-checked). */
  getChangeSet(userId: string, changesetId: string): ChangeSetRow | undefined {
    const row = this.one('SELECT * FROM changeset WHERE id = ?', changesetId)
    return row === undefined || this.text(row.user_id) !== userId ? undefined : this.changeSetRow(row)
  }
  /** ChangeSets produced under one work id — the RunRecord tracking link (003 §3). */
  changeSetsByWork(workId: string): ChangeSetRow[] {
    return this.all('SELECT * FROM changeset WHERE work_id = ? ORDER BY created_at, id', workId).map(row => this.changeSetRow(row))
  }

  // ---- health summaries (D5; the receiver derives `adapter`, the store never trusts a client claim) ------------------------

  /** Saves one row per summary type, idempotent per `(user, event, type)`; unknown availability is refused. */
  saveHealthSummary(userId: string, envelope: HealthSummaryEvent, adapter: 'known' | 'pending'): void {
    this.atomic(() => {
      if (typeof envelope.eventId !== 'string' || envelope.eventId === '') throw new Error('along health summary event has no event id')
      const summaries = envelope.payload.summaries ?? []
      if (summaries.length === 0) throw new Error('along health summary event carries no summaries')
      const receivedAt = new Date().toISOString()
      for (const summary of summaries) {
        if (!AVAILABILITIES.has(summary.availability)) throw new Error(`unknown health availability ${String(summary.availability)}`)
        const windowStart = summary.window === undefined ? undefined : 'night' in summary.window ? summary.window.night : summary.window.start
        const windowEnd = summary.window === undefined ? undefined : 'night' in summary.window ? summary.window.night : summary.window.end
        const previous = this.latestHealthSummaries(userId).find(row => row.type === summary.type)
        this.run(`INSERT INTO health_summary (id, user_id, type, metric_version, window_start, window_end, timezone, unit, statistic, value,
            availability, summarizer_version, adapter, event_id, received_at, context, superseded)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(id) DO NOTHING`,
          `hs:${userId}:${envelope.eventId}:${summary.type}`, userId, summary.type, summary.metricVersion,
          windowStart, windowEnd, summary.timezone ?? envelope.timezone, summary.unit, summary.statistic,
          jsonOrUndefined(summary.value), summary.availability, summary.summarizerVersion, adapter, envelope.eventId, receivedAt, jsonOrUndefined(summary.context))
        if (summary.summarizerVersion === 'along-health-v1') {
          // A later receive is not a later reading. Unknown -> available may legitimately carry an older observation date.
          const latest = ['weight', 'resting_heart_rate', 'wrist_temperature'].includes(summary.type)
          const orderedWindow = !previous || (latest && (previous.availability !== 'ok' || summary.availability !== 'ok'))
            || Date.parse(windowStart ?? '') >= Date.parse(previous.windowStart ?? '')
          const newer = previous?.summarizerVersion !== 'along-health-v1'
            || Date.parse(summary.metricVersion) >= Date.parse(previous.metricVersion) && orderedWindow
          const currentId = newer ? `hs:${userId}:${envelope.eventId}:${summary.type}` : previous!.id
          this.run(`UPDATE health_summary SET superseded=CASE WHEN id=? THEN 0 ELSE 1 END WHERE user_id=? AND type=?`,
            currentId, userId, summary.type)
        }
      }
    })
  }
  /** The current value of each type: the newest non-superseded row per type (superseding is a Stage C concern). */
  latestHealthSummaries(userId: string): HealthSummaryRow[] {
    const rows = this.all('SELECT * FROM health_summary WHERE user_id = ? AND superseded = 0 ORDER BY type, received_at DESC, id', userId)
    const latest: HealthSummaryRow[] = []
    for (const row of rows.map(row => this.healthRow(row))) {
      if (latest.some(item => item.type === row.type)) continue
      latest.push(row)
    }
    return latest
  }

  // ---- event inbox (rows written by the inbox module's receive state machine) ---------------------------------------------

  /** Finds the stored Inbox row for `(user_id, event_id)` — the dedup/conflict/rejected-retry source (BC-08-02/03). */
  findInboxEvent(userId: string, eventId: string): InboxEventRow | undefined {
    const row = this.one('SELECT * FROM event_inbox WHERE user_id = ? AND event_id = ?', userId, eventId)
    return row === undefined ? undefined : this.inboxRow(row)
  }
  /** Inserts an Inbox row; returns `false` when `(user_id, event_id)` already exists (the state machine decides above it). */
  saveInboxEvent(input: InboxEventInput): boolean {
    return this.atomic(() => {
      const result = this.run(`INSERT INTO event_inbox (user_id, event_id, schema_version, event_type, kind, device_id, goal_id, task_id,
          occurred_at, received_at, timezone, message_id, causation_id, base_revision, payload, payload_hash, status, reject_reason, trigger_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, event_id) DO NOTHING`,
        input.userId, input.eventId, input.schemaVersion, input.eventType, input.kind, input.deviceId, input.goalId, input.taskId,
        input.occurredAt === undefined ? undefined : isoTime(input.occurredAt), input.receivedAt, input.timezone, input.messageId, input.causationId, input.baseRevision,
        JSON.stringify(input.payload), input.payloadHash, input.status, input.rejectReason, input.triggerId, new Date().toISOString())
      return Number(result.changes) > 0
    })
  }

  // ---- delivery queue (consumed by the delivery pump; at-least-once into DSH) ----------------------------------------------

  /** Queues a trigger for delivery; `trigger_id` is unique, so re-queuing the same event is a no-op. */
  enqueueDelivery(userId: string, eventId: string, triggerId: string): void {
    this.atomic(() => {
      const now = new Date().toISOString()
      this.run(`INSERT INTO delivery (user_id, event_id, trigger_id, status, attempts, next_attempt_at, created_at)
        VALUES (?, ?, ?, 'pending', 0, ?, ?) ON CONFLICT(trigger_id) DO NOTHING`, userId, eventId, triggerId, Date.now(), now)
    })
  }
  /** One delivery row by its stable trigger id (pump observability and tests). */
  getDelivery(triggerId: string): DeliveryRow | undefined {
    const row = this.one('SELECT * FROM delivery WHERE trigger_id = ?', triggerId)
    return row === undefined ? undefined : this.deliveryRow(row)
  }
  /**
   * Claims due deliveries (`status IN ('pending','failed') AND next_attempt_at <= now`, oldest first) and presets a
   * 30s lease on each so a crashed process's claims expire back into the scan (at-least-once, design §2.2.2).
   */
  claimDueDeliveries(now: number, limit: number): DeliveryRow[] {
    return this.atomic(() => {
      const rows = this.all("SELECT * FROM delivery WHERE status IN ('pending', 'failed') AND next_attempt_at <= ? ORDER BY seq LIMIT ?", now, limit)
      for (const row of rows) {
        this.run("UPDATE delivery SET next_attempt_at = ? WHERE seq = ? AND status IN ('pending', 'failed')", now + DELIVERY_LEASE_MS, row.seq)
      }
      return rows.map(row => this.deliveryRow(row))
    })
  }
  /** Marks a delivery delivered (terminal success). */
  markDelivered(triggerId: string, at: string): void {
    this.atomic(() => {
      this.run("UPDATE delivery SET status = 'delivered', delivered_at = ?, last_attempt_at = ? WHERE trigger_id = ? AND status IN ('pending', 'failed')",
        at, at, triggerId)
    })
  }
  /**
   * Records a failed attempt: `attempts + 1`, exponential backoff `1s/2s/4s…` capped at 60s; from 12 attempts the row
   * turns `failed` (slow 10-minute retries continue) and a one-time `delivery_failed` sync is appended for user
   * messages, so the phone can see the explicit failure (design §2.2.3).
   */
  recordDeliveryFailure(triggerId: string, at: string, error: string): { attempts: number; status: 'pending' | 'failed' } {
    return this.atomic(() => {
      const row = this.one('SELECT * FROM delivery WHERE trigger_id = ?', triggerId)
      if (row === undefined) throw new Error(`delivery ${triggerId} does not exist`)
      const current = this.deliveryRow(row)
      if (current.status === 'delivered' || current.status === 'filtered') {
        return { attempts: current.attempts, status: current.attempts >= DELIVERY_FAILURE_LIMIT ? 'failed' : 'pending' }
      }
      const attempts = current.attempts + 1
      const failed = attempts >= DELIVERY_FAILURE_LIMIT
      const atMs = Date.parse(at)
      const nextAttemptAt = failed ? atMs + DELIVERY_FAILED_RETRY_MS : atMs + Math.min(1000 * 2 ** (attempts - 1), DELIVERY_MAX_BACKOFF_MS)
      this.run("UPDATE delivery SET attempts = ?, status = ?, next_attempt_at = ?, last_attempt_at = ?, last_error = ? WHERE trigger_id = ?",
        attempts, failed ? 'failed' : 'pending', nextAttemptAt, at, error, triggerId)
      if (failed) this.appendDeliveryFailedSync(current.userId, current.eventId, error)
      return { attempts, status: failed ? 'failed' : 'pending' }
    })
  }
  /** Terminal `filtered` outcome (scope refused); the same one-time user-message failure sync applies (design §2.2.3). */
  markDeliveryFiltered(triggerId: string, at: string, reason: string): void {
    this.atomic(() => {
      const row = this.one('SELECT * FROM delivery WHERE trigger_id = ?', triggerId)
      if (row === undefined) throw new Error(`delivery ${triggerId} does not exist`)
      const current = this.deliveryRow(row)
      this.run("UPDATE delivery SET status = 'filtered', last_attempt_at = ?, last_error = ? WHERE trigger_id = ? AND status IN ('pending', 'failed')",
        at, reason, triggerId)
      if (current.status !== 'filtered') this.appendDeliveryFailedSync(current.userId, current.eventId, reason)
    })
  }
  /** One `delivery_failed` sync per event, keyed on the message id the event produced (`msg:<user>:<event>`). */
  private appendDeliveryFailedSync(userId: string, eventId: string, error: string): void {
    const event = this.one('SELECT event_type FROM event_inbox WHERE user_id = ? AND event_id = ?', userId, eventId)
    if (event === undefined || this.text(event.event_type) !== 'along.user_message') return
    const messageId = `msg:${userId}:${eventId}`
    const existing = this.one("SELECT 1 FROM sync_outbox WHERE user_id = ? AND kind = 'delivery_failed' AND message_id = ?", userId, messageId)
    if (existing !== undefined) return
    this.appendSync({ userId, kind: 'delivery_failed', messageId, payload: { event_id: eventId, error } })
  }

  // ---- work links & run records (written by the worklink / record modules) -------------------------------------------------

  /**
   * Upserts the one row per ticket: `ticket.created` inserts, `ticket.resumed` re-points `work_id`/`thread_key` and
   * re-opens the row; assignment updates fill `assignment_id` without clobbering the goal mapping (design §2.5.2).
   */
  recordWorkLink(link: WorkLinkInput): void {
    this.atomic(() => {
      this.run(`INSERT INTO work_link (ticket_id, assignment_id, work_id, goal_id, task_id, event_id, trigger_id, thread_key, kind, ended_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(ticket_id) DO UPDATE SET
          assignment_id = COALESCE(excluded.assignment_id, work_link.assignment_id),
          work_id = excluded.work_id,
          goal_id = COALESCE(excluded.goal_id, work_link.goal_id),
          task_id = COALESCE(excluded.task_id, work_link.task_id),
          event_id = COALESCE(excluded.event_id, work_link.event_id),
          trigger_id = COALESCE(excluded.trigger_id, work_link.trigger_id),
          thread_key = excluded.thread_key,
          kind = excluded.kind,
          ended_at = CASE WHEN excluded.kind = 'resume' THEN NULL ELSE work_link.ended_at END`,
        link.ticketId, link.assignmentId, link.workId, link.goalId, link.taskId, link.eventId, link.triggerId, link.threadKey, link.kind,
        new Date().toISOString())
    })
  }
  /** The mapping row of one ticket (`workScopeForTicket`'s reverse lookup). */
  getWorkLink(ticketId: string): WorkLinkRow | undefined {
    const row = this.one('SELECT * FROM work_link WHERE ticket_id = ?', ticketId)
    return row === undefined ? undefined : this.workLinkRow(row)
  }
  /** Open (in-flight) work rows of one goal — routing reference only; the hard guarantee stays the version check. */
  workLinksForGoal(goalId: string): WorkLinkRow[] {
    return this.all(`SELECT w.* FROM work_link w WHERE w.ended_at IS NULL AND (w.goal_id=? OR w.goal_id IS NULL AND EXISTS (
      SELECT 1 FROM changeset c WHERE c.work_id=w.work_id AND c.goal_id=? AND c.status='applied')) ORDER BY w.created_at`,goalId,goalId)
      .map(row => ({...this.workLinkRow(row),goalId}))
  }
  /** Marks the ticket's row ended (clears the in-flight marker); `ticket.ended` owns this call. */
  markWorkLinkEnded(ticketId: string, at: string): void {
    this.atomic(() => { this.run('UPDATE work_link SET ended_at = ? WHERE ticket_id = ? AND ended_at IS NULL', at, ticketId) })
  }
  /**
   * Upserts the execution record, idempotent on `(ticket_id, assignment_id)` (`rr:<ticket>:<assignment>`): the
   * `assignment.started` ensure and the `assignment.ended` finalize of the same assignment converge on one row.
   */
  recordRunRecord(record: RunRecordInput): void {
    this.atomic(() => {
      const id = `rr:${record.ticketId}:${record.assignmentId}`
      this.run(`INSERT INTO run_record (id, ticket_id, assignment_id, user_id, work_id, goal_id, task_id, trigger_event_id,
          prompt_revisions, tool_trace_ref, report_state, report_summary, changeset_id, ended_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          user_id = COALESCE(excluded.user_id, user_id), work_id = COALESCE(excluded.work_id, work_id),
          goal_id = COALESCE(excluded.goal_id, goal_id), task_id = COALESCE(excluded.task_id, task_id),
          trigger_event_id = COALESCE(excluded.trigger_event_id, trigger_event_id),
          prompt_revisions = COALESCE(excluded.prompt_revisions, prompt_revisions),
          tool_trace_ref = COALESCE(excluded.tool_trace_ref, tool_trace_ref),
          report_state = COALESCE(excluded.report_state, report_state),
          report_summary = COALESCE(excluded.report_summary, report_summary),
          changeset_id = COALESCE(excluded.changeset_id, changeset_id),
          ended_at = COALESCE(excluded.ended_at, ended_at)`,
        id, record.ticketId, record.assignmentId, record.userId, record.workId, record.goalId, record.taskId, record.triggerEventId,
        record.promptRevisions === undefined ? null : JSON.stringify(record.promptRevisions), record.toolTraceRef,
        record.reportState, record.reportSummary, record.changesetId, record.endedAt, new Date().toISOString())
    })
  }
  /** The execution record of one assignment (record module idempotency and tests). */
  getRunRecord(ticketId: string, assignmentId: string): RunRecordRow | undefined {
    const row = this.one('SELECT * FROM run_record WHERE ticket_id = ? AND assignment_id = ?', ticketId, assignmentId)
    return row === undefined ? undefined : this.runRecordRow(row)
  }

  // ---- sync outbox (phone pull + ack; BC-00-05) -----------------------------------------------------------------------------

  /** Appends a sync item; returns its `seq` (the phone's pull cursor position). */
  appendSync(item: SyncItemInput): number {
    return this.atomic(() => {
      const result = this.run(`INSERT INTO sync_outbox (user_id, kind, goal_id, task_id, message_id, changeset_id, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        item.userId, item.kind, item.goalId, item.taskId, item.messageId, item.changesetId, JSON.stringify(item.payload), new Date().toISOString())
      return Number(result.lastInsertRowid)
    })
  }
  /** Sync items after `afterSeq`, oldest first — the offline phone pulls forward (BC-00-05). */
  syncPage(userId: string, afterSeq: number, limit: number): Page<SyncItem> {
    const page = pageLimit(limit)
    const rows = this.all('SELECT * FROM sync_outbox WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?', userId, afterSeq, page)
    const items = rows.map(row => this.syncRow(row))
    const last = items.at(-1)
    return { items, nextCursor: items.length === page && last ? String(last.seq) : undefined }
  }
  /** Backfills `delivered_at` for the acked seqs (001 §4.3's third state). */
  markSynced(userId: string, seqs: readonly number[]): void {
    this.atomic(() => {
      if (seqs.length === 0) return
      const placeholders = seqs.map(() => '?').join(', ')
      this.run(`UPDATE sync_outbox SET delivered_at = ? WHERE user_id = ? AND delivered_at IS NULL AND seq IN (${placeholders})`,
        new Date().toISOString(), userId, ...seqs)
    })
  }

  /** Row totals for one user — the audit counts of the legacy import report (BC-09-02). */
  counts(userId: string): { goals: number; tasks: number; messages: number } {
    const count = (sql: string): number => Number(this.scalar(sql, userId) ?? 0)
    return { goals: count('SELECT COUNT(*) FROM goal WHERE user_id = ?'),
      tasks: count('SELECT COUNT(*) FROM user_task WHERE user_id = ?'),
      messages: count('SELECT COUNT(*) FROM message WHERE user_id = ?') }
  }
}
