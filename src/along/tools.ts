/**
 * The Along worker tools: four reads bound to the user and the dispatch scope, validated ChangeSet writes,
 * and durable conversational answers. The host
 * binds the scope — the model cannot specify `user_id`, the ticket, or the goal (BC-07-04): no tool schema
 * declares a `user_id`/`goal_id` write path, and strict schemas reject anything extra. Reads paginate; health
 * summaries with an unadapted type (`adapter='pending'`) never reach the model context (001 §4.4).
 *
 * Memory and planner-history filtering share Runtime's host-owned MemoryService.
 */
import { healthInterpretation } from './health-context.ts'
import { weeklyCompletionNotice } from './completion.ts'
import { isDeepStrictEqual } from 'node:util'
import { recommendation, RECOMMENDATION_INPUT, hikingIntent, recommendationText, recommendationNotice } from './recommendation.ts'
import { researchTools, researchCapability, type ResearchWeb } from './web-research.ts'
import { healthSummaryIsCurrent, type HealthFollowup } from './health.ts'
import { z } from 'zod'
import { calculate, CalculationInputSchema } from './calculation.ts'
import { SourceReadInputSchema } from './source-state.ts'
import { QUANTITY_SOURCES,QUANTITY_PARAMETERS } from './calculation-evidence.ts'
import { DATA_SOURCE_CATALOG, DATA_SOURCE_INPUT } from './data-sources.ts'
import { alongTool } from './tool.ts'
import { alongArgumentRecovery } from './argument-recovery.ts'
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
// Reuse the business operation's fields object itself; a second lookalike schema would drift.
const taskUpdateOperation = ALONG_OPS_SCHEMA.element.options.find(op=>op.shape.op.value==='task.update') as (typeof ALONG_OPS_SCHEMA.element.options)[4]
const TASK_MUTATION_CONTEXT = {
  task_id:ALONG_ID_SCHEMA,
  base_revision:ALONG_BASE_REVISION_SCHEMA.describe('JSON integer from this existing task revision; never the goal revision or a quoted string.'),
  goal_revision:ALONG_BASE_REVISION_SCHEMA.describe('JSON integer from along_goal_read.goal.current_revision.'),
  input_version:ALONG_INPUT_VERSION_SCHEMA,
  idempotency_key:z.string().min(1).max(128),
  reason:ALONG_REASON_SCHEMA,
}
const TASK_UPDATE_INPUT = z.object({...TASK_MUTATION_CONTEXT,fields:taskUpdateOperation.shape.fields}).strict()
const TASK_CANCEL_INPUT = z.object(TASK_MUTATION_CONTEXT).strict()

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
  content: task.content, scheduled_at: task.scheduledAt, reminder_plan:task.reminderPlan, goal_id: task.goalId,
  ...(task.trigger?{trigger:task.trigger}:{}) })

const revisionView = (revision: GoalRevisionRow) => ({ revision: revision.revision, title: revision.title,
  metric: revision.metric, context: revision.context, status: revision.status, basis_changeset: revision.basisChangeset,
  origin_event_id: revision.originEventId, created_at: revision.createdAt })

const summaryView = (summary: HealthSummaryRow) => ({
  current: healthSummaryIsCurrent(summary),
  unit: summary.unit, statistic: summary.statistic, summarizer_version: summary.summarizerVersion,
  type: summary.type, value: summary.value, metric_version: summary.metricVersion, timezone: summary.timezone,
  availability: summary.availability,
  ...(summary.context ? { context: summary.context } : {}),
  ...(healthInterpretation(summary.type) ? { interpretation: healthInterpretation(summary.type) } : {}),
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
  const currentVersions = () => {
    const bound=scope()
    if(!bound.allowedGoalId)return undefined
    const goal=store.assertGoalOwner(bound.userId,bound.allowedGoalId)
    return {base_revision:goal.currentRevision,input_version:store.inputVersion(goal.id),
      tasks:store.listTasks(bound.userId,{goalId:goal.id},{limit:100}).items.map(t=>({task_id:t.id,base_revision:t.currentRevision}))}
  }
  const mutationRecovery = (name:string,error:z.ZodError) => {
    const recovery=alongArgumentRecovery(name,error),versions=currentVersions()
    return {...recovery,...(versions?{current_versions:{goal_revision:versions.base_revision,input_version:versions.input_version,tasks:versions.tasks}}:{}),
      required_types:{base_revision:'JSON integer from the task revision',goal_revision:'JSON integer from goal current_revision',input_version:'JSON integer from goal input_version'},
      guidance:'No operation was written. Repair the listed fields, never coerce numeric strings. Copy top-level task base_revision, goal_revision and input_version as JSON integers from actual read tools/current_versions. Use this original task_id; do not create a replacement task after a rejected update. fields is the existing task.update fields object; preserve omitted fields. Re-read after conflicts, use a fresh key after a corrected submission.'}
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
    const link=store.getWorkLink(ticketId)
    if(!due&&link&&store.changeSetsByWork(link.workId).some(change=>change.status==='applied'&&Array.isArray(change.ops)&&change.ops.some((raw:unknown)=>{
      if(!raw||typeof raw!=='object')return false
      const op=raw as {op?:string;trigger?:{actor?:string;capability?:string}}
      return op.op==='task.create'&&op.trigger?.actor==='agent'&&op.trigger.capability==='research'
    })))throw new Error('Research execution is already queued by this planning work. Read back its durable task, give the planning reply and report ready; the Host dispatches a separate occurrence with its own sources/results. Do not execute or impersonate that occurrence here.')
    if(due) {
      const context=host.healthFollowup!.taskContext(ticketId)
      if(context.definition?.definition.actor==='agent'&&(context.definition.definition.conditions?.some(c=>(c.kind==='source_ready'||c.kind==='source_updated')&&c.capability==='trading_history')||
        store.sources.hasRead(host.healthFollowup!.sourceScope(ticketId),'trading_history')))
        throw new Error('private history research cannot call public web providers; use a separate public-only task without private data')
    }
    const taskId=due?.taskId??store.getWorkLink(ticketId)?.taskId
    const content=taskId?(due?store.taskRevisionContent(bound.userId,taskId,due.revision):store.getTask(bound.userId,taskId)?.content):undefined
    const original=bound.triggerEventId?store.getMessage(bound.userId,`msg:${bound.userId}:${bound.triggerEventId}`)?.text:undefined
    return {userId:bound.userId,goalId:bound.allowedGoalId,ticketId,...(bound.triggerEventId?{budgetEventId:bound.triggerEventId}:{}),...(hikingIntent(content??'')||hikingIntent(original??'')?{requiredKind:'hiking' as const}:{})}
  }
  const automatic=host.healthFollowup?.forTicket(ticketId)?host.healthFollowup.tools(ticketId):[]
  const dueWork=host.healthFollowup?.forTicket(ticketId)?.due
  const execution=dueWork&&store.triggers.get(scope().userId,dueWork.taskId)?.definition
  const privateHistory=execution?.conditions?.some(c=>(c.kind==='source_ready'||c.kind==='source_updated')&&c.capability==='trading_history')
  const taskFinish=automatic.find(tool=>tool.name==='along_health_followup')
  const tools:Tool[] = [
    alongTool({name:'along_execution_capabilities',description:'Read currently installed execution capabilities and safe public-research configuration status before planning external recommendations. This is a local configuration check, not a network/authentication success or proof a source is connected. No user data or secrets are sent.',
      schema:z.object({}).strict(),execute:async()=>{scope();return {reminder:{installed:true},calculation:{installed:true},public_research:{installed:!!host.web?.(),...researchCapability(host.web?.())}}}}),
    ...(dueWork?[
    alongTool({name:'along_source_read',description:'Request the authorized current summary for this host-dispatched Agent task. A pending/stale/unavailable result is a durable request: report state:progress with the concrete waiting reason and end this attempt for Host retry. There is no report state named waiting; do not invent data, finish the task or repeatedly poll. Host retries on the same occurrence; credentials never reach this tool. Only ready returns private scoped data; never send private values into public search.',
      schema:SourceReadInputSchema,execute:async(args)=>{
        scope()
        if(!host.healthFollowup)throw new Error('task execution unavailable')
        const bound=host.healthFollowup.sourceScope(ticketId)
        return store.sources.createRead(bound,args)
      }}),
    alongTool({name:'along_task_context',description:'Read the actual single task occurrence dispatched by the host, its trigger/executor/capability and current revisions. This also records that you read its evaluated context. It is not a claim that the human acted. No model-selected identities or task ids.',
      schema:z.object({}).strict(),execute:async()=>{
        scope()
        const context=host.healthFollowup?.taskContext(ticketId)
        if(!context)throw new Error('no task execution is bound to this planning work; persist triggers, read them back, reply and report ready so the Host can dispatch the occurrence separately')
        const detail=store.goalDetail(context.task.userId,context.task.goalId)
        return {task:taskView(context.task),trigger:context.definition?.definition,
          occurrence_id:context.occurrence?.id,execution_key:context.occurrence?.id??context.dispatch.eventId,
          goal:{current_revision:detail.goal.currentRevision,input_version:store.inputVersion(detail.goal.id),title:detail.revision?.title,context:detail.revision?.context},
          observations:context.observed.summaries.map(summaryView)}
      }}),
    ]:[]),
    ...(execution?.actor==='agent'&&execution.capability==='calculation'?[alongTool({name:'along_calculate',description:'Execute this host-bound calculation occurrence using bounded exact arithmetic with units, persist its scoped receipt for along_task_finish. Input facts/assumptions are separate from arithmetic correctness. This tool is unavailable to planning tickets.',
      schema:z.object({calculation:CalculationInputSchema,source_request_id:z.string().min(1).max(128).optional(),quantity_sources:QUANTITY_SOURCES.optional(),quantity_parameters:QUANTITY_PARAMETERS.optional()}).strict(),execute:async(args)=>{
        const bound=scope(),d=host.healthFollowup?.forTicket(ticketId)
        if(d?.due) {
          const calcScope=host.healthFollowup!.calculationScope(ticketId)
          return store.atomic(()=>{
            const definition=store.triggers.get(calcScope.userId,calcScope.taskId)?.definition
            const sourceDependent=definition?.conditions?.some(c=>c.kind==='source_ready'||c.kind==='source_updated')
            if((sourceDependent||store.sources.hasRead(calcScope))&&(!args.source_request_id||!args.quantity_sources))throw new Error('source-dependent calculation requires source_request_id and quantity_sources from an actual fresh task read')
            if((args.source_request_id===undefined)!==(args.quantity_sources===undefined))throw new Error('source request and quantity bindings must be provided together')
            if(args.quantity_parameters&&!args.source_request_id)throw new Error('explicit private calculation parameters require the current source read')
            const bindings=args.source_request_id?store.calculationEvidence.verify(calcScope,args.source_request_id,args.quantity_sources,args.calculation.quantities,args.quantity_parameters):undefined
            const receipt=store.calculations.calculate(calcScope,args.calculation,bindings?store.calculationEvidence.digest(bindings):undefined)
            if(bindings)store.calculationEvidence.record(receipt.id,args.source_request_id!,bindings)
            return {receipt_id:receipt.id,result:receipt.calculation.result,input:receipt.calculation.input,trace:receipt.calculation.trace,
              calculated_at:receipt.calculatedAt,reused:receipt.reused,persisted:true,
              input_sources:bindings?[...bindings.sources.map(s=>({quantity:s.quantity,kind:'private_field',unit:s.unit})),
                ...bindings.parameters.map(p=>({quantity:p.quantity,kind:p.kind==='constant'?'named_constant':'user_parameter',unit:p.unit}))]
                :args.calculation.quantities.map(q=>({quantity:q.name,kind:'supplied_input',unit:q.unit??'1'}))}
          })
        }
        throw new Error('calculation requires a dispatched calculation occurrence')
      }})]:[]),
    ...(!automatic.length?[alongTool({name:'along_calculation_preview',description:'Answer a direct user arithmetic question without a task execution. Returns persisted:false and no receipt, never completes a task. After creating a typed task, finish planning and let its separate occurrence run instead.',
      schema:z.object({calculation:CalculationInputSchema}).strict(),execute:async(args)=>{
        const bound=scope()
        const source=bound.triggerEventId&&store.getMessage(bound.userId,`msg:${bound.userId}:${bound.triggerEventId}`)
        if(!source||source.audience!=='conversation'||source.direction!=='inbound'||source.role!=='user')throw new Error('calculation preview requires a real current user question')
        if(!store.isCurrentChatInput(bound.userId,source.eventId,bound.allowedGoalId))return {status:'conflicted',reason:'conflicted_input'}
        const queued=bound.allowedGoalId&&store.listTasks(bound.userId,{goalId:bound.allowedGoalId},{limit:200}).items
          .find(task=>task.status==='open'&&task.trigger?.actor==='agent'&&task.trigger.capability==='calculation'
            &&Date.parse(task.createdAt)>=Date.parse(source.receivedAt))
        if(queued)return {status:'queued_for_execution',persisted:false,task_id:queued.id,
          guidance:'This is the planning ticket, not the dispatched occurrence. The typed calculation is already durable. Read back its trigger, send the direct planning reply, and report ready; the Host will dispatch its execution separately. Do not edit status/content or wait here for its result.'}
        return {...calculate(args.calculation),persisted:false,scope:'conversation_question'}
      }})]:[]),
    ...(taskFinish&&dueWork?[{...taskFinish,name:'along_task_finish',description:'Finish this host-dispatched task occurrence. For calculation provide the actual along_calculate receipt; for public research provide the structured sourced recommendation; for private OKX history research provide this occurrence’s fresh trading_history source_request_id and qualitative text instead. This persists a task result and queues its existing notification channel, never proves phone delivery or human action. Read along_task_context first; no personal chat for background work.'}]:[]),
    alongTool({name:'along_data_sources_catalog',
      description:'Read the trusted data-source capability catalog. A recommendation is not authorization. Use only these provider ids; official setup is not OAuth and never means connected.',
      schema:z.object({}).strict(),execute:async()=>{scope();return {sources:DATA_SOURCE_CATALOG}}}),
    alongTool({name:'along_data_sources_recommend',
      description:'Replace the current goal’s recommended data sources after evaluating its actual data needs. Read the catalog and current goal first. A newly created goal resolves from this original chat. Empty sources withdraw explicit recommendations. Does not connect accounts, accept secrets or change goal content. Never pass user_id, goal_id, URLs or connected status.',
      schema:z.object({base_revision:ALONG_BASE_REVISION_SCHEMA,input_version:ALONG_INPUT_VERSION_SCHEMA,sources:DATA_SOURCE_INPUT}).strict(),
      execute:async args=>store.atomic(()=>{
        const bound=scope()
        const source=bound.triggerEventId?store.getMessage(bound.userId,`msg:${bound.userId}:${bound.triggerEventId}`):undefined
        if(!source||source.audience!=='conversation'||source.role!=='user'||source.direction!=='inbound')throw new Error('data source recommendations require a current user chat')
        const goalId=bound.allowedGoalId??store.conversationGoal(bound.userId,store.conversationRoot(bound.userId,source.eventId))
        if(!goalId)throw new Error('create the goal before recommending data sources')
        const goal=store.assertGoalOwner(bound.userId,goalId)
        if(goal.status!=='active')throw new Error('data source recommendations require an active goal')
        if(!store.isCurrentChatInput(bound.userId,source.eventId,goalId)||store.inputVersion(goalId)!==args.input_version)return {status:'conflicted',reason:'conflicted_input'}
        if(goal.currentRevision!==args.base_revision)return {status:'conflicted',reason:'conflicted_revision'}
        const changed=store.replaceGoalDataSources(bound.userId,goalId,args.sources)
        return {status:'recommended',reused:!changed,data_sources:store.goalDataSources(bound.userId,goalId)}
      })}),
    ...(!privateHistory&&(!automatic.length||dueWork&&(!execution||execution.capability==='research'))
      ?researchTools(store.research,researchScope,host.web??(()=>undefined)):[]),
    alongTool({name:'along_goal_overview',description:"Read one page of this user's goals and current tasks as coordination context. This does not grant writes outside the bound goal. Follow next_cursor for more goals.",
      schema:z.object({cursor:z.string().optional()}).strict(),execute:async args=>{
        const bound=scope(),page=store.listGoals(bound.userId,{limit:20,cursor:args.cursor})
        return {goals:page.items.map(goal=>{const detail=store.goalDetail(bound.userId,goal.id);return {
          goal_id:goal.id,status:goal.status,title:detail.revision?.title,context:detail.revision?.context,tasks:detail.tasks.map(taskView)}}),next_cursor:page.nextCursor}
      }}),
    ...automatic,
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
          data_sources: detail.dataSources,
          bound_task_id:store.getWorkLink(ticketId)?.taskId,
          ...(args.include_revisions === true ? { revisions: store.goalRevisions(goalId).map(revisionView) } : {}),
        }
      },
    }),
    alongTool({
      name: 'along_conversation_read',
      description: 'Read one page of the bound goal\'s conversation, newest page first, chronologically inside a page by seq; pass next_before_seq to page further back. Includes only direct conversation in messages; task-event facts are separately labelled task_feedback, never user chat. Includes timestamps, effective memories and status-labelled memory_history. Current explicit intent takes priority; use source order and meaning to understand updates.',
      schema: z.object({
        before_seq: z.number().int().min(0).optional().describe('Copy next_before_seq from the previous page.'),
        limit: z.number().int().min(1).max(50).optional().describe('Messages per page, 20 by default and 50 at most.'),
      }).strict(),
      execute: async args => {
        const bound = scope()
        const limit = args.limit ?? 20
        if (bound.allowedGoalId === undefined && bound.triggerEventId === undefined) throw new Error('no conversation is bound to this ticket')
        const history = bound.allowedGoalId === undefined
          ? store.conversationMessages(bound.userId, bound.triggerEventId!).filter(message => message.audience === 'conversation' && (args.before_seq === undefined || message.seq < args.before_seq))
          : undefined
        const page: {items:MessageRow[];nextCursor?:string} = history === undefined
          ? store.conversationContextPage(bound.userId, bound.allowedGoalId!, args.before_seq, limit)
          : { items: history.slice(-limit), nextCursor: history.length > limit ? String(history.at(-limit)!.seq) : undefined }
        const conversation=page.items.filter(message=>message.audience==='conversation')
        const feedback=page.items.filter(message=>message.audience==='background').map(message=>{
          const source=store.findInboxEvent(bound.userId,message.eventId)!
          return {event_id:message.eventId,source:'task_event',kind:source.kind,task_id:source.taskId,
            text:message.text,at:message.occurredAt??message.receivedAt}
        })
        const context = host.memory?.context({ userId: bound.userId, goalId: bound.allowedGoalId }, conversation)
        const timezone=page.items.at(-1)?.timezone??[...page.items].reverse().find(m=>m.timezone)?.timezone
        let civil:Record<string,string>={}
        if(timezone)try {civil={local_now:new Intl.DateTimeFormat('sv-SE',{timeZone:timezone,dateStyle:'full',timeStyle:'long',hourCycle:'h23'}).format(new Date()),
          local_weekday:new Intl.DateTimeFormat('en-US',{timeZone:timezone,weekday:'long'}).format(new Date())}}catch{/* Never invent a civil clock for an unknown zone. */}
        return { timezone, now:new Date().toISOString(),...civil, ...(context ? { memories: context.memories, memory_history: context.history } : {}), task_feedback:feedback, messages: (context?.messages ?? conversation).map(message =>
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
        const prior = bound.allowedGoalId ? store.health.state(bound.allowedGoalId) : undefined
        const previous = prior && prior.userId === bound.userId &&
          prior.inputVersion === store.inputVersion(bound.allowedGoalId!)
          ? { evaluated_at: prior.updatedAt, kind: 'prior_evaluation_facts',
              summaries: prior.baseline.filter(summary => args.type === undefined || summary.type === args.type).map(summaryView) }
          : undefined
        return { ...result, summaries: result.summaries.map(summaryView),
          ...(previous ? { previous_assessment: previous } : {}) }
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
        if (!source || source.audience !== 'conversation' || source.role !== 'user' || source.direction !== 'inbound') throw new Error('no user chat is bound to this ticket')
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
        let structured = args.recommendation ? recommendation(store.research,researchScope(),args.recommendation) : undefined
        const completionNotice=structured?weeklyCompletionNotice(host,ticketId):undefined
        if(structured&&completionNotice)structured={...structured,summary:(completionNotice+' '+structured.summary).slice(0,1200),nextStep:(completionNotice+' '+structured.nextStep).slice(0,600)}
        const notify = structured ? recommendationNotice(structured,task||undefined) : args.notify
        const notification = notify && goal ? { event_id: eventId, kind: notify,
          revision: task ? task.currentRevision : goal.currentRevision } : undefined
        const message = store.appendMessage({ userId: bound.userId, eventId, role: 'assistant', direction: 'outbound',
          text: structured&&completionNotice?[structured.summary,structured.nextStep].join('\n').slice(0,1200):recommendationText(structured,args.text), causationId: root, replyToMessageId: source.id })
        if (goalId !== undefined) store.linkMessageToGoals(message.id, [goalId], 'derived')
        store.research.saveReply(message.id,args,structured,notification)
        store.appendSync({ userId: bound.userId, kind: 'message', goalId, taskId, messageId: message.id,
          payload: { message_id: message.id, role: 'assistant', text: message.text, conversation_id: root, ...(task?{task_execution_revision:task.currentRevision}:{}), ...(notification ? { notification } : {}), ...(structured ? {recommendation:structured} : {}) } })
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
        ops: TOOL_OPS_SCHEMA.describe('Each new task needs its typed trigger. For task.update put the task numeric base_revision beside op/task_id, outside fields; fields contains actual changes. A timing edit preserves trigger:"keep" or supplies the full typed trigger. Only time triggers need scheduled_at/reminder_plan; repeat once/daily/weekly belongs beside scheduled_at, never inside reminder_plan. A scheduled plan has state/source/explanation, original evidence/action and optional recurrence_source. Use custom and omit metric for qualitative goals. Numeric goals require their actual metric.'),
      }).strict(),
      invalidArguments:error=>{
        const recovery=alongArgumentRecovery('along_changes_commit',error),versions=currentVersions()
        if(!versions)return recovery
        return {...recovery,current_versions:versions,
          update_structure:{op:'task.update',task_id:'copy an owned task_id above',base_revision:'copy its numeric base_revision above without quotes',fields:{trigger:'keep',scheduled_at:'the authorized ISO time',repeat:'preserve actual cadence',reminder_plan:'a valid plan object; repeat stays outside'}}}
      },
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
          { ...args, ops, ...(bound.allowedGoalId !== undefined ? { goal_id: bound.allowedGoalId } : {}) }, { ...bound, requireReminderPlan:true,requireTaskTrigger:true })
        if (result.status === 'invalid') {
          const guidance:Record<string,string> = {
            reminder_requires_user_chat:'No operation was written. If an original accepted same-goal user instruction already authorizes arranging this reminder, read it and later corrections with along_conversation_read; reference that event_id in reminder_plan.evidence_event_id with its exact evidence and meaningful action, preserving current constraints and cadence. A background review is not itself new authority, but does not require new chat solely because it is background. Do not invent or revive authority. If the actual original mandate is absent, revoked or insufficient, keep/wait and name that concrete gap.',
            task_completion_requires_executor:'Only the Host-dispatched Agent occurrence can complete this task with actual tool evidence. Stop editing its status/content. Finish the current planning reply/report ready to release the goal; the durable trigger will execute separately.',
            task_execution_already_settled:'This Agent execution already finished under the same input. Its result belongs in task detail; do not rewrite the stable task or retry a status edit. Reply from the actual result and finish the planning ticket.',
            task_trigger_required:'Every new/replanned task must include its typed trigger. Use immediate for a real Agent operation now, time with a persisted clock/cadence, event with registered owned conditions, or waiting with a real user_input/capability_available resumption. Include actor and supported capability; a task card alone is not an execution plan.',
            conflicted_health:'The health observations or local planning day changed after this review read them. No task edits were written. Drop this old review honestly; the Host dispatches current facts separately. Do not copy current goal/input revision numbers into the old plan or publish its recommendation.',
            waiting_trigger_requires_condition:'This executor capability is already installed. Missing source data is not a missing calculator: use event with a registered source_ready/health_available/task_completed condition (and the owned source recommendation), or waiting:user_input for genuinely missing user information. A capability_available wait without a condition is only for an actually unavailable executor.',
            trigger_source_not_recommended:'Create/read this goal, read the catalog, and persist the appropriate source recommendation before creating its data-dependent task. The host cannot subscribe to an unimplemented or out-of-goal source.',
            recurring_research_remains_open:'This host-bound review cannot edit or stop the ongoing research task, its wording, time or recurrence. Make no task ChangeSet; deliver this occurrence with along_health_followup outcome:keep and its recommendation. The host renews the existing cadence. A new explicit user chat handles task changes.',
            reminder_plan_required:'Every new task needs reminder_plan in that op. If the action has a time or deadline, choose the next useful future instant as source:agent, repeat:once with explanation. For a genuine missing window use needs_time with one specific question; explicitly declined or untimed work uses off.',
            task_scoped_repeat_evidence_required:'No schedule was written. Inspect diagnostic.requested_repeat, clock_source, recurrence_source and evidence flags. Clock source and recurrence_source are independent: source:agent alone does NOT make recurrence inferred; recurrence_source defaults to user. For genuinely inferred cadence within this accepted ongoing goal, use recurrence_source:agent plus the exact real same-goal evidence/action and truthful explanation; never override explicit one-off/stop/weekday limits. For explicit user cadence quote its actual action and days, not rewritten text. Supported rules are once, daily=all seven days, weekly=one local weekday. 工作日 is not seven-day daily or a whole-workweek single weekly rule. Do not cycle daily/weekly/quotes to probe acceptance. If full cadence is unsupported, record the useful current occurrence as a clearly partial once plan and use a justified next planning review; never claim the full requested series is arranged.',
            weekday_subset_not_daily:'No schedule was written: the quoted instruction limits this action to weekdays, but repeat:daily means all seven days. Do not erase that constraint or switch recurrence_source to bypass it. Current schema supports once/all-days-daily/one-weekday-weekly only. Persist a useful current weekday occurrence as repeat:once and honestly state that the full weekday series is not installed; a relevant automatic planning review may choose next_review_at for the next local day and reassess eligibility then. Do not claim once is the full recurrence or repeatedly retry unchanged cadence.',
            user_clock_evidence_required:'A deadline, class time, or lead time selected by you is not a user-specified reminder clock. Use source:"agent" plus a plain-language explanation. For a human reminder use its actual reminder clock/action evidence; an Agent operation may cite the exact user clock and requested operation. A deadline or lead time selected by you stays source:agent. Do not silently replace a requested recurrence with once.',
            daily_mandate_required:'Re-read the original action and cadence. Do not infer daily from a metric alone or silently replace a requested recurring action with once; persist explicit waiting if essential cadence authority is missing.',
            weekly_plan_required:'A requested weekly action requires a scheduled weekly plan with its own weekday and authorized evidence. Do not substitute once to pass validation. Ask only for a genuinely essential missing booking window; otherwise infer a reasonable clock as source:agent.',
            reminder_declined:'The user declined reminders. Keep or update the action with reminder_plan:{state:"off",reason:"opt_out"} and omit scheduled_at.',
          }
          const remedy = result.reason && guidance[result.reason]
          if (remedy) return {...result,guidance:remedy+' Correct the invalid operations and use a fresh idempotency_key.'}
        }
        return result
      },
    }),
  ]
  const commit=tools.find(tool=>tool.name==='along_changes_commit')!
  const mutate = (args:z.infer<typeof TASK_CANCEL_INPUT>|z.infer<typeof TASK_UPDATE_INPUT>,signal:AbortSignal) => {
    if(!scope().allowedGoalId)throw new Error('an existing goal must be bound before updating or cancelling its task')
    const {task_id,base_revision,goal_revision,input_version,idempotency_key,reason}=args
    const op='fields' in args?{op:'task.update',task_id,base_revision,fields:args.fields}:{op:'task.cancel',task_id,base_revision}
    return commit.execute(commit.schema.parse({idempotency_key,base_revision:goal_revision,input_version,reason,ops:[op]}),signal)
  }
  return [...tools,
    alongTool({name:'along_task_update',description:'Update ONE existing task by its stable task_id. Prefer this for a single-task change. All versions are TOP-LEVEL JSON integers: base_revision is this task revision; goal_revision is the goal current_revision; input_version is the goal input_version. fields uses the existing task.update contract; omitted fields stay unchanged. Timing changes preserve trigger:"keep" or supply the authorized typed trigger and validated plan/cadence. The Host uses the ordinary ChangeSet writer and scope guards. Read back the same task after applied; never create a replacement after a rejection. Multi-task atomic changes and new tasks still use along_changes_commit.',
      schema:TASK_UPDATE_INPUT,invalidArguments:error=>mutationRecovery('along_task_update',error),execute:mutate}),
    alongTool({name:'along_task_cancel',description:'Cancel ONE existing task by its original stable task_id. All versions are TOP-LEVEL JSON integers: task base_revision, goal_revision and input_version. Reuses the ordinary ChangeSet writer, bound goal, current authority and idempotency. Does not create or delete another task, mark a human action complete, or accept user/goal identity. Read current versions first and read back cancellation; stale results/old occurrences cannot revive it.',
      schema:TASK_CANCEL_INPUT,invalidArguments:error=>mutationRecovery('along_task_cancel',error),execute:mutate}),
  ]
}
