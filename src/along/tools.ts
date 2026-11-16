/**
 * The Along worker tools: four reads bound to the user and the dispatch scope, validated ChangeSet writes,
 * and durable conversational answers. The host
 * binds the scope — the model cannot specify `user_id`, the ticket, or the goal (BC-07-04): no tool schema
 * declares a `user_id`/`goal_id` write path, and strict schemas reject anything extra. Reads paginate; health
 * summaries with an unadapted type (`adapter='pending'`) never reach the model context (001 §4.4).
 *
 * Memory and planner-history filtering share Runtime's host-owned MemoryService.
 */
import { isDeepStrictEqual } from 'node:util'
import { recommendation, RECOMMENDATION_INPUT, hikingIntent, recommendationText, recommendationNotice } from './recommendation.ts'
import { researchTools, type ResearchWeb } from './web-research.ts'
import { healthSummaryIsCurrent, type HealthFollowup } from './health.ts'
import { z } from 'zod'
import { alongTool } from './tool.ts'
import type { MemoryService } from './memory/service.ts'
import { memoryTools } from './memory/tools.ts'
import { createHash } from 'node:crypto'
import type { Tool } from '../app/tools/tool.ts'
import type { CommitScope } from './changeset.ts'
import { ALONG_BASE_REVISION_SCHEMA, ALONG_ID_SCHEMA, ALONG_INPUT_VERSION_SCHEMA,
  ALONG_OPS_SCHEMA, ALONG_REASON_SCHEMA, ALONG_METRIC_SCHEMA } from './changeset.ts'
import type { AlongService } from './service.ts'
import type { GoalRevisionRow, HealthSummaryRow, TaskRow, MessageRow } from './store.ts'

// Custom goals have no configurable metric. Make that invariant explicit in the model's parameter schema
// instead of an object/null union. The complete business schema still validates the derived operations.
const [createGoalOperation, ...otherOperations] = ALONG_OPS_SCHEMA.element.options
const TOOL_CREATE_GOAL_SCHEMA = z.discriminatedUnion('domain', [
  createGoalOperation.extend({ domain: z.literal('custom'), metric: z.null().optional().describe('Omit for custom goals; the host supplies null.') }),
  createGoalOperation.extend({ domain: z.enum(['health', 'finance']), metric: ALONG_METRIC_SCHEMA }),
])
const TOOL_OPS_SCHEMA = z.array(z.discriminatedUnion('op', [TOOL_CREATE_GOAL_SCHEMA, ...otherOperations])).min(1)

/** Host dependencies of the Along tools; the Runtime assembles them when the Along service is installed. */
export interface AlongToolsHost {
  /** The assembled business service: reads through the store, commits through the changeset module. */
  readonly service: Pick<AlongService, 'alongStore' | 'commitChangeSet'>
  /** Runtime-owned memory, optional for standalone business-tool callers. */
  readonly memory?: MemoryService
  readonly healthFollowup?: HealthFollowup
  readonly web?: () => ResearchWeb | undefined
  /** Reverse lookup of the host-bound scope for a ticket — worklink's `workScopeForTicket` in production (§2.5). */
  readonly scopeFor: (ticketId: string) => CommitScope | undefined
}

/** The D5 seven health summary types; unknown types are stored with `adapter='pending'` by the receiver. */
const HEALTH_TYPES = ['steps', 'workout', 'active_energy', 'weight', 'resting_heart_rate', 'wrist_temperature', 'sleep'] as const

const taskView = (task: TaskRow) => ({ task_id: task.id, status: task.status, revision: task.currentRevision,
  content: task.content, scheduled_at: task.scheduledAt, reminder_plan:task.reminderPlan, goal_id: task.goalId })

const revisionView = (revision: GoalRevisionRow) => ({ revision: revision.revision, title: revision.title,
  metric: revision.metric, context: revision.context, status: revision.status, basis_changeset: revision.basisChangeset,
  origin_event_id: revision.originEventId, created_at: revision.createdAt })

const summaryView = (summary: HealthSummaryRow) => ({
  current: healthSummaryIsCurrent(summary),
  unit: summary.unit, statistic: summary.statistic, summarizer_version: summary.summarizerVersion,
  type: summary.type, value: summary.value, metric_version: summary.metricVersion, timezone: summary.timezone,
  availability: summary.availability,
  ...(summary.windowStart !== undefined ? { window: { start: summary.windowStart, end: summary.windowEnd } } : {}),
})

/** The Along tools of one worker ticket; registered by `executorTools` alongside the DSH work tools (D8). */
export function alongTools(host: AlongToolsHost, ticketId: string): Tool[] {
  const store = host.service.alongStore
  const scope = (): CommitScope => {
    host.healthFollowup?.assertActive(ticketId)
    const bound = host.scopeFor(ticketId)
    if (bound === undefined) throw new Error(`ticket ${ticketId} has no Along work scope; Along tools are unavailable`)
    return bound
  }
  // Reads are bound to the dispatch scope: a bound ticket reads its own goal (a foreign goal_id is refused);
  // an unbound ticket must name a goal_id, which the store still ownership-checks (BC-07-05).
  const readableGoalId = (bound: CommitScope, provided?: string): string => {
    if (provided !== undefined) {
      if (bound.allowedGoalId !== undefined && provided !== bound.allowedGoalId) {
        throw new Error(`along tools are bound to goal ${bound.allowedGoalId}; goal ${provided} is outside this work's dispatch scope`)
      }
      return provided
    }
    if (bound.allowedGoalId !== undefined) return bound.allowedGoalId
    throw new Error('no goal is bound to this ticket; pass goal_id to name the goal to read')
  }
  const researchScope = () => {
    const bound=scope()
    if(!bound.allowedGoalId)throw new Error('research requires a bound existing goal')
    if(store.getGoal(bound.userId,bound.allowedGoalId)?.status!=='active')throw new Error('research requires an active goal')
    const due=host.healthFollowup?.forTicket(ticketId)?.due
    const taskId=due?.taskId??store.getWorkLink(ticketId)?.taskId
    const content=taskId?(due?store.taskRevisionContent(bound.userId,taskId,due.revision):store.getTask(bound.userId,taskId)?.content):undefined
    const original=bound.triggerEventId?store.getMessage(bound.userId,`msg:${bound.userId}:${bound.triggerEventId}`)?.text:undefined
    return {userId:bound.userId,goalId:bound.allowedGoalId,ticketId,...(bound.triggerEventId?{budgetEventId:bound.triggerEventId}:{}),...(hikingIntent(content??'')||hikingIntent(original??'')?{requiredKind:'hiking' as const}:{})}
  }
  return [
    ...researchTools(store.research,researchScope,host.web??(()=>undefined)),
    alongTool({name:'along_goal_overview',description:"Read one page of this user's goals and current tasks as coordination context. This does not grant writes outside the bound goal. Follow next_cursor for more goals.",
      schema:z.object({cursor:z.string().optional()}).strict(),execute:async args=>{
        const bound=scope(),page=store.listGoals(bound.userId,{limit:20,cursor:args.cursor})
        return {goals:page.items.map(goal=>{const detail=store.goalDetail(bound.userId,goal.id);return {
          goal_id:goal.id,status:goal.status,title:detail.revision?.title,context:detail.revision?.context,tasks:detail.tasks.map(taskView)}}),next_cursor:page.nextCursor}
      }}),
    ...(host.healthFollowup?.forTicket(ticketId) ? host.healthFollowup.tools(ticketId) : []),
    ...(host.memory ? memoryTools(host.memory, () => {
      const bound = scope()
      return { userId: bound.userId, goalId: bound.allowedGoalId }
    }) : []),
    alongTool({
      name: 'along_goal_read',
      description: 'Read the current state of one Along goal: domain, status, current revision, input version, title, metric and context, with its tasks and optionally its full revision history. Reads are bound to the dispatched goal; commit base_revision/input_version come from current_revision/input_version here.',
      schema: z.object({
        goal_id: ALONG_ID_SCHEMA.optional().describe('Defaults to the goal bound to this ticket.'),
        include_revisions: z.boolean().optional().describe('Include the goal\'s full revision history.'),
      }).strict(),
      execute: async args => {
        const bound = scope()
        const goalId = readableGoalId(bound, args.goal_id)
        const detail = store.goalDetail(bound.userId, goalId)
        return {
          goal: { goal_id: detail.goal.id, domain: detail.goal.domain, status: detail.goal.status,
            current_revision: detail.goal.currentRevision, input_version: store.inputVersion(goalId),
            title: detail.revision?.title, metric: detail.revision?.metric, context: detail.revision?.context },
          tasks: detail.tasks.map(taskView),
          bound_task_id:store.getWorkLink(ticketId)?.taskId,
          ...(args.include_revisions === true ? { revisions: store.goalRevisions(goalId).map(revisionView) } : {}),
        }
      },
    }),
    alongTool({
      name: 'along_conversation_read',
      description: 'Read one page of the bound goal\'s conversation, newest page first, chronologically inside a page by seq; pass next_before_seq to page further back. Includes original messages, timestamps, effective memories and status-labelled memory_history. Current explicit intent takes priority; use source order and meaning to understand updates.',
      schema: z.object({
        before_seq: z.number().int().min(0).optional().describe('Copy next_before_seq from the previous page.'),
        limit: z.number().int().min(1).max(50).optional().describe('Messages per page, 20 by default and 50 at most.'),
      }).strict(),
      execute: async args => {
        const bound = scope()
        const limit = args.limit ?? 20
        if (bound.allowedGoalId === undefined && bound.triggerEventId === undefined) throw new Error('no conversation is bound to this ticket')
        const history = bound.allowedGoalId === undefined
          ? store.conversationMessages(bound.userId, bound.triggerEventId!).filter(message => args.before_seq === undefined || message.seq < args.before_seq)
          : undefined
        let page: {items:MessageRow[];nextCursor?:string} = history === undefined ? store.messagesByGoal(bound.userId, bound.allowedGoalId!,
          { beforeSeq: args.before_seq, limit }) : { items: history.slice(-limit),
            nextCursor: history.length > limit ? String(history.at(-limit)!.seq) : undefined }
        if(bound.allowedGoalId){
          const feedback=store.taskFeedbackByGoal(bound.userId,bound.allowedGoalId,args.before_seq,limit+1)
          const combined=[...new Map([...page.items,...feedback].map(message=>[message.id,message])).values()].sort((a,b)=>a.seq-b.seq)
          const items=combined.slice(-limit)
          page={items,nextCursor:combined.length>limit||page.nextCursor||feedback.length>limit?String(items[0]!.seq):undefined}
        }
        const context = host.memory?.context({ userId: bound.userId, goalId: bound.allowedGoalId }, page.items)
        return { timezone: page.items.at(-1)?.timezone ?? [...page.items].reverse().find(m=>m.timezone)?.timezone, now:new Date().toISOString(), ...(context ? { memories: context.memories, memory_history: context.history } : {}), messages: (context?.messages ?? page.items).map(message =>
            ({ seq: message.seq, event_id: message.eventId, role: message.role, text: message.text, at: message.occurredAt ?? message.receivedAt })),
          ...(page.nextCursor !== undefined ? { next_before_seq: Number(page.nextCursor) } : {}) }
      },
    }),
    alongTool({
      name: 'along_task_list',
      description: 'List the user\'s tasks with their stable ids, statuses and revisions — scoped to the bound goal when one is bound; use their task_id and revision for task.update and task.cancel in along_changes_commit.',
      schema: z.object({
        status: z.enum(['open', 'done', 'cancelled']).optional(),
      }).strict(),
      execute: async args => {
        const bound = scope()
        const page = store.listTasks(bound.userId, { goalId: bound.allowedGoalId, status: args.status }, { limit: 100 })
        return { tasks: page.items.map(taskView) }
      },
    }),
    alongTool({
      name: 'along_health_read',
      description: 'Read the current health summaries the phone has synced: value, window, timezone, availability and metric version per type. Types the server has not adapted yet are withheld; a missing permission, unavailable data or a not-yet-synced type is reported as availability instead of an empty value.',
      schema: z.object({
        type: z.enum(HEALTH_TYPES).optional().describe('One summary type; omit for all adapted types.'),
      }).strict(),
      execute: async args => {
        const bound = scope()
        const summaries = store.latestHealthSummaries(bound.userId)
          .filter(summary => summary.adapter === 'known') // 待适配类型不进模型上下文（001 §4.4）
          .filter(summary => args.type === undefined || summary.type === args.type)
        const result = host.healthFollowup?.read(ticketId, summaries) ?? { summaries }
        return { ...result, summaries: result.summaries.map(summaryView) }
      },
    }),
    alongTool({
      name: 'along_chat_reply',
      description: 'Persist the user-facing answer to this work\'s original chat. Read along_conversation_read first. Respond to observations or ask one essential question without creating a goal. After applied changes describe the result. One answer per original event; retries with identical text reuse it. Identity and conversation are host-bound. Superseded inputs return conflicted_input: let the newer work answer.',
      schema: z.object({ text: z.string().trim().min(1).max(1200),
        recommendation: RECOMMENDATION_INPUT.optional().describe('Structured live recommendation. Read the research skill; use only source ids and exact quotes from this ticket’s Along web tools. URLs and times are supplied by the host.'),
        notify: z.enum(['recommendation_ready', 'task_result']).optional().describe('Only when delivering the requested recommendation or an actionable execution result in a goal. Omit for an ordinary chat answer, acknowledgement or plan edit.'),
        task_id: ALONG_ID_SCHEMA.optional().describe('For a result on a specific task, use its verified ID within this goal.')
      }).strict(),
      execute: async args => store.atomic(() => {
        const bound = scope()
        if (bound.triggerEventId === undefined) throw new Error('no chat is bound to this ticket')
        const source = store.getMessage(bound.userId, `msg:${bound.userId}:${bound.triggerEventId}`)
        if (!source || source.role !== 'user' || source.direction !== 'inbound') throw new Error('no user chat is bound to this ticket')
        const root = store.conversationRoot(bound.userId, source.eventId)
        const goalId = bound.allowedGoalId ?? store.conversationGoal(bound.userId, root)
        const eventId = `reply_${createHash('sha256').update(source.id).digest('hex').slice(0, 40)}`
        const existing = store.getMessage(bound.userId, `msg:${bound.userId}:${eventId}`)
        if (existing) {
          if (store.research.reply(existing.id) ? !isDeepStrictEqual(store.research.reply(existing.id)?.input,args) : existing.text!==args.text||args.recommendation!==undefined) throw new Error('reply already exists with different content')
          return { status: 'replied', message_id: existing.id, reused: true }
        }
        if (!store.isCurrentChatInput(bound.userId, source.eventId, goalId)) return { status: 'conflicted', reason: 'conflicted_input' }
        const goal = goalId && store.getGoal(bound.userId, goalId)
        const taskId=args.task_id??(args.recommendation?store.getWorkLink(ticketId)?.taskId:undefined)
        const task = taskId && store.getTask(bound.userId, taskId)
        if (args.notify && (!goal || goal.status !== 'active')) throw new Error('notifications require an active bound goal')
        if (taskId && ((!args.notify&&!args.recommendation) || !task || task.goalId !== goalId)) throw new Error('notification task outside this goal')
        const structured = args.recommendation ? recommendation(store.research,researchScope(),args.recommendation) : undefined
        const notify = structured ? recommendationNotice(structured,task||undefined) : args.notify
        const notification = notify && goal ? { event_id: eventId, kind: notify,
          revision: task ? task.currentRevision : goal.currentRevision } : undefined
        const message = store.appendMessage({ userId: bound.userId, eventId, role: 'assistant', direction: 'outbound',
          text: recommendationText(structured,args.text), causationId: root, replyToMessageId: source.id })
        if (goalId !== undefined) store.linkMessageToGoals(message.id, [goalId], 'derived')
        store.research.saveReply(message.id,args,structured,notification)
        store.appendSync({ userId: bound.userId, kind: 'message', goalId, taskId, messageId: message.id,
          payload: { message_id: message.id, role: 'assistant', text: message.text, conversation_id: root, ...(notification ? { notification } : {}), ...(structured ? {recommendation:structured} : {}) } })
        return { status: 'replied', message_id: message.id, reused: false }
      }),
    }),
    alongTool({
      name: 'along_changes_commit',
      description: 'Commit one ChangeSet that applies goal/task operations atomically after validation: schema, object relations, input version and business revision. The user, ticket and goal are bound by the host — never pass user_id or goal_id. Take base_revision from along_goal_read\'s current_revision and input_version from its input_version; a goal.create ChangeSet (no bound goal yet) takes base_revision 0. On reason conflicted_input/conflicted_revision the state moved: re-read and resubmit with a fresh idempotency_key; on invalid fix the operations; applied means it is already in effect (no approval step).',
      schema: z.object({
        idempotency_key: z.string().min(1).max(128)
          .describe('Stable key of this very submission; a retry under the same key returns the original result.'),
        base_revision: ALONG_BASE_REVISION_SCHEMA,
        input_version: ALONG_INPUT_VERSION_SCHEMA,
        reason: ALONG_REASON_SCHEMA.describe('One-sentence change note the user will see.'),
        derived_from_changeset: ALONG_ID_SCHEMA.optional()
          .describe('For「改回去」: the applied ChangeSet whose goal snapshot is restored; fields must match or be omitted.'),
        ops: TOOL_OPS_SCHEMA.describe('For qualitative goals choose custom and omit metric. Numeric health/finance goals require type, target, unit and period. Every new task needs reminder_plan: scheduled (supply future scheduled_at, source agent or user, and explanation), needs_time (one question), or off (untimed or opt_out). For edits keep is explicit. Daily/weekly require a matching quoted user mandate and action.'),
      }).strict(),
      execute: async args => {
        const bound = scope()
        const createFirst = args.ops[0] !== undefined && args.ops[0].op === 'goal.create'
        if (createFirst && (bound.triggerEventId === undefined || store.findInboxEvent(bound.userId, bound.triggerEventId)?.eventType !== 'along.user_message')) {
          throw new Error('goal creation requires a host-bound user chat')
        }
        if (bound.allowedGoalId === undefined && !createFirst) {
          throw new Error('no goal is bound to this ticket; only a ChangeSet whose first op is goal.create can be committed')
        }
        const ops = ALONG_OPS_SCHEMA.parse(args.ops.map(op => op.op === 'goal.create' && op.domain === 'custom' ? { ...op, metric: null } : op))
        const result = host.service.commitChangeSet(
          { ...args, ops, ...(bound.allowedGoalId !== undefined ? { goal_id: bound.allowedGoalId } : {}) }, { ...bound, requireReminderPlan:true })
        if (result.status === 'invalid') {
          const guidance:Record<string,string> = {
            recurring_research_remains_open:'This host-bound review cannot edit or stop the ongoing research task, its wording, time or recurrence. Make no task ChangeSet; deliver this occurrence with along_health_followup outcome:keep and its recommendation. The host renews the existing cadence. A new explicit user chat handles task changes.',
            reminder_plan_required:'Every new task needs reminder_plan in that op. If the action has a time or deadline, choose the next useful future instant as source:agent, repeat:once with explanation. For a genuine missing window use needs_time with one specific question; explicitly declined or untimed work uses off.',
            task_scoped_repeat_evidence_required:'Re-read the explicit user mandate and the existing task/time first. A once plan does not fulfill a clearly requested weekly cadence; report any unresolved cadence accurately. Use the original cadence clause, a specific action shared with the task, and the actual reminder weekday. For an explicit 补上每周 instruction quote the complete command including 补上; retain the existing future task clock if unchanged. Without a reminder verb use source:agent with a truthful explanation, not a forged source:user reminder quote. Do not substitute once for a clearly requested weekly cadence; explain the unresolved part if still unverified.',
            user_clock_evidence_required:'A deadline, class time, or lead time selected by you is not a user-specified reminder clock. Use source:"agent" plus a plain-language explanation. For user source, quote the single original clock + reminder verb + exact task action, and pass that action. If cadence was also rejected, schedule the next occurrence once.',
            daily_mandate_required:'When daily reminders have not been delegated for this action, schedule the next useful occurrence as source:agent and repeat:once.',
            weekly_plan_required:'If weekly evidence is incomplete, schedule a concrete next occurrence once, or ask for the essential booking window.',
            reminder_declined:'The user declined reminders. Keep or update the action with reminder_plan:{state:"off",reason:"opt_out"} and omit scheduled_at.',
          }
          const remedy = result.reason && guidance[result.reason]
          if (remedy) return {...result,guidance:remedy+' Correct the invalid operations and use a fresh idempotency_key.'}
        }
        return result
      },
    }),
  ]
}
