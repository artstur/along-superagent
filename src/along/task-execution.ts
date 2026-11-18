/** Product execution history reconstructed from durable business evidence, never Worker audit counts. */
import { createHash } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { isResearchTaskContent } from './recommendation.ts'

export interface TaskExecutionRecord {
  id: string
  kind: 'research' | 'calculation' | 'completed'
  executedAt: string
  outcome: 'researched' | 'calculated' | 'completed'
  summary?: string
  /** Opaque stored result event: public recommendation or private report detail, never a source-read ID. */
  recommendationEventId?: string
  calculationReceiptId?: string
}
export interface TaskExecutionSummary { version: 1; count: number; records: TaskExecutionRecord[] }

type Row = Record<string, SQLInputValue>
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const parsed = (value: SQLInputValue | undefined): Record<string, unknown> | undefined => {
  try { return typeof value === 'string' ? object(JSON.parse(value)) : undefined } catch { return undefined }
}
const time = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
const stableId = (user: string, goal: string, task: string, key: string) =>
  'exec_' + createHash('sha256').update(JSON.stringify([user, goal, task, key])).digest('hex').slice(0, 40)

/** Caller owns the AlongStore transaction and has checked task ownership. No write or migration occurs. */
export function taskExecution(db: DatabaseSync, userId: string, task: { id: string; goalId: string; content: string }): TaskExecutionSummary {
  const one = (sql: string, ...values: SQLInputValue[]) => db.prepare(sql).get(...values)
  const all = (sql: string, ...values: SQLInputValue[]) => db.prepare(sql).all(...values)
  const development = (eventId: string, messageId?: string): boolean => !!one(`SELECT 1 FROM message_audience_audit
    WHERE user_id=? AND (source_event_id=? OR message_id=?) LIMIT 1`, userId, eventId, messageId ?? '')
  const records = new Map<string, TaskExecutionRecord>()
  const add = (key: string, record: Omit<TaskExecutionRecord, 'id'>) => {
    if (records.has(key) || !time(record.executedAt)) return
    records.set(key, { id: stableId(userId, task.goalId, task.id, key), ...record })
  }

  // A calculator preview or an abandoned tool call is not an execution. Publication must match the
  // actual finished dispatch, occurrence, revision and receipt; model retries share its execution key.
  for(const row of all(`SELECT c.id AS calculation_id,c.execution_key,c.calculation,c.calculated_at,d.event_id,m.id AS message_id FROM task_calculation c
    JOIN health_dispatch d ON d.user_id=c.user_id AND d.goal_id=c.goal_id AND d.input_version=c.input_version
    JOIN task_review r ON r.event_id=d.event_id AND r.task_id=c.task_id AND r.revision=c.task_revision
    JOIN task_trigger_occurrence x ON x.id=c.execution_key AND x.dispatch_event_id=d.event_id AND x.user_id=c.user_id AND x.task_id=c.task_id
    JOIN sync_outbox o ON o.user_id=c.user_id AND o.goal_id=c.goal_id AND o.task_id=c.task_id AND o.kind='message'
    JOIN message m ON m.id=o.message_id AND m.user_id=c.user_id AND m.event_id='followup_'||d.event_id
    WHERE c.user_id=? AND c.goal_id=? AND c.task_id=? AND json_valid(d.result) AND json_valid(o.payload)
      AND json_extract(d.result,'$.calculation_receipt')=c.id AND json_extract(d.result,'$.outcome')<>'ask'
      AND json_extract(o.payload,'$.calculation_receipt_id')=c.id AND x.state='settled'
    ORDER BY o.seq`,userId,task.goalId,task.id)) {
    if(development(String(row.event_id))||development('',String(row.message_id)))continue
    const result=object(parsed(row.calculation)?.result)
    if(typeof result?.value!=='string'||typeof result.unit!=='string')continue
    add('occurrence:'+String(row.execution_key),{kind:'calculation',outcome:'calculated',executedAt:String(row.calculated_at),
      calculationReceiptId:String(row.calculation_id),summary:`计算结果：${result.value}${result.unit==='1'?'':' '+result.unit}`})
  }

  // A completion is a recorded user fact that actually changed the state, not an Agent status edit or
  // a second differently keyed feedback while the task was already done.
  for(const row of all(`SELECT x.id,d.event_id,m.event_id AS result_event_id,m.id AS message_id,m.received_at FROM task_trigger_occurrence x
    JOIN health_dispatch d ON d.event_id=x.dispatch_event_id AND d.user_id=x.user_id AND d.goal_id=x.goal_id
    JOIN source_state_read r ON r.id=json_extract(d.result,'$.source_request_id') AND r.user_id=x.user_id AND r.goal_id=x.goal_id
      AND r.task_id=x.task_id AND r.task_revision=x.task_revision AND r.input_version=d.input_version AND r.execution_key=x.id
    JOIN sync_outbox o ON o.user_id=x.user_id AND o.goal_id=x.goal_id AND o.task_id=x.task_id AND o.kind='message'
    JOIN message m ON m.id=o.message_id AND m.user_id=x.user_id AND m.event_id='followup_'||d.event_id
    WHERE x.user_id=? AND x.goal_id=? AND x.task_id=? AND x.state='settled' AND x.outcome='agent_researched'
      AND json_valid(d.result) AND json_extract(d.result,'$.outcome')<>'ask' AND r.capability='trading_history'
      AND r.actual_result_revision IS NOT NULL AND r.actual_result_reference IS NOT NULL
    ORDER BY o.seq`,userId,task.goalId,task.id)) {
    if(development(String(row.event_id))||development('',String(row.message_id)))continue
    add('occurrence:'+String(row.id),{kind:'research',outcome:'researched',executedAt:String(row.received_at),
      recommendationEventId:String(row.result_event_id),summary:'已依据授权成交与账单报告保存分析；实际窗口、覆盖与限制见详情'})
  }
  for (const row of all(`SELECT r.origin_event_id,e.payload,e.received_at,e.goal_id FROM task_revision r
    JOIN event_inbox e ON e.user_id=r.user_id AND e.event_id=r.origin_event_id
    WHERE r.user_id=? AND r.task_id=? AND r.goal_id=? AND r.status='done'
      AND e.status='accepted' AND e.event_type='along.message' AND e.kind='task.completed'
      AND COALESCE((SELECT previous.status FROM task_revision previous
        WHERE previous.task_id=r.task_id AND previous.revision<r.revision ORDER BY previous.revision DESC LIMIT 1),'open')<>'done'
    ORDER BY r.revision`, userId, task.id, task.goalId)) {
    const payload = parsed(row.payload), eventId = String(row.origin_event_id)
    if (payload?.task_id !== task.id || (row.goal_id !== null && row.goal_id !== task.goalId) || development(eventId)) continue
    add('event:' + eventId, { kind: 'completed', outcome: 'completed', executedAt: String(row.received_at), summary: '已收到任务完成反馈' })
  }
  for(const row of all(`SELECT x.id,x.completion_event_id,x.completed_at,e.payload FROM task_trigger_occurrence x
    JOIN event_inbox e ON e.user_id=x.user_id AND e.event_id=x.completion_event_id
    WHERE x.user_id=? AND x.goal_id=? AND x.task_id=? AND e.status='accepted'
      AND e.event_type='along.message' AND e.kind='task.completed' ORDER BY x.completed_at`,userId,task.goalId,task.id)) {
    const eventId=String(row.completion_event_id)
    if(development(eventId)||parsed(row.payload)?.task_id!==task.id)continue
    add('event:'+eventId,{kind:'completed',outcome:'completed',executedAt:String(row.completed_at),summary:'已收到本次任务完成反馈'})
  }

  {
    const outputs = all(`SELECT o.seq AS output_seq,o.payload,m.id,m.event_id,m.received_at,m.reply_to_message_id FROM sync_outbox o
      JOIN message m ON m.id=o.message_id AND m.user_id=o.user_id
      WHERE o.user_id=? AND o.goal_id=? AND o.task_id=? AND o.kind='message' AND m.role='assistant' AND m.direction='outbound'
      ORDER BY o.seq`, userId, task.goalId, task.id)
    for (const row of outputs) {
      const payload = parsed(row.payload), recommendation = object(payload?.recommendation)
      if (recommendation?.version !== 1 || !Array.isArray(recommendation.sources) || !recommendation.sources.length ||
        !['ready', 'partial', 'unavailable'].includes(String(recommendation.status)) || development('', String(row.id))) continue
      const root = researchRoot(db, userId, task, row)
      if (!root || development(root.eventId)) continue
      const content = executionContent(db, userId, task, row, payload, root.revision)
      const typedResearch=one(`SELECT 1 FROM task_trigger_occurrence x LEFT JOIN task_trigger t ON t.task_id=x.task_id AND t.user_id=x.user_id
        AND t.goal_id=x.goal_id AND t.generation=x.generation WHERE x.user_id=? AND x.goal_id=? AND x.task_id=?
        AND x.dispatch_event_id=? AND x.task_revision=? AND x.state='settled' AND (x.outcome='agent_researched'
          OR x.outcome='researched' AND json_valid(t.definition) AND json_extract(t.definition,'$.actor')='agent'
          AND json_extract(t.definition,'$.capability')='research') LIMIT 1`,
        userId,task.goalId,task.id,root.eventId,root.revision??-1)
      if (!content || !typedResearch&&!isResearchTaskContent(content)) continue
      // Structured source ids must resolve to this user's goal and to one Worker scope that really
      // obtained evidence. Reuse is allowed: the tool request need not be new in this business event.
      const tickets = new Set<string>()
      let supported = true, validAtExecution = false
      for (const value of recommendation.sources) {
        const source = object(value)
        const receipt = source && typeof source.id === 'string' && one(`SELECT ticket_id,metadata FROM research_source
          WHERE id=? AND user_id=? AND goal_id=?`, source.id, userId, task.goalId)
        const metadata = receipt && parsed(receipt.metadata)
        if (!receipt || !metadata || !time(metadata.retrievedAt) || !time(metadata.expiresAt) ||
          Date.parse(metadata.expiresAt) <= Date.parse(metadata.retrievedAt) ||
          Date.parse(metadata.retrievedAt) > Date.parse(String(row.received_at)) + 300_000) { supported = false; break }
        // Historical execution does not disappear when today's weather TTL expires. A partial result may
        // retain stale context alongside valid evidence, but all-stale reuse is not confirmed current output.
        if (Date.parse(metadata.expiresAt) > Date.parse(String(row.received_at))) validAtExecution = true
        tickets.add(String(receipt.ticket_id))
      }
      if (!supported || !validAtExecution || tickets.size !== 1) continue
      const ticket = [...tickets][0]!
      if (!one(`SELECT 1 FROM research_request WHERE user_id=? AND goal_id=? AND ticket_id=? AND status='ok' AND julianday(at)<=julianday(?) LIMIT 1`,
        userId, task.goalId, ticket, String(row.received_at))) continue
      // The evidence belongs to the actual dispatch, not another task's result copied into an outbox.
      if (!one(`SELECT 1 FROM work_link WHERE ticket_id=? AND goal_id=? AND event_id=? UNION ALL
        SELECT 1 FROM run_record WHERE ticket_id=? AND user_id=? AND goal_id=? AND trigger_event_id=? LIMIT 1`,
        ticket, task.goalId, root.eventId, ticket, userId, task.goalId, root.eventId)) continue
      add(root.key, { kind: 'research', outcome: 'researched', executedAt: String(row.received_at),
        summary: '已生成研究方案', recommendationEventId: String(row.event_id) })
    }
  }
  const ordered = [...records.values()].sort((a, b) => Date.parse(b.executedAt) - Date.parse(a.executedAt) || a.id.localeCompare(b.id))
  return { version: 1, count: ordered.length, records: ordered.slice(0, 20) }
}

/** Resolve only precise dispatch links; sharing a conversation root does not make later human input development. */
function researchRoot(db: DatabaseSync, userId: string, task: { id: string; goalId: string }, message: Row): { eventId: string; key: string; revision?: number } | undefined {
  if (typeof message.reply_to_message_id === 'string') {
    const source = db.prepare(`SELECT m.event_id FROM message m JOIN event_inbox e ON e.user_id=m.user_id AND e.event_id=m.event_id
      JOIN research_reply r ON r.message_id=?
      WHERE m.id=? AND m.user_id=? AND m.role='user' AND m.direction='inbound' AND m.audience='conversation'
        AND e.status='accepted' AND e.event_type='along.user_message' AND (e.goal_id=? OR EXISTS (
          SELECT 1 FROM message_goal_link l WHERE l.message_id=m.id AND l.user_id=? AND l.goal_id=?)) LIMIT 1`)
      .get(String(message.id), message.reply_to_message_id, userId, task.goalId, userId, task.goalId)
    if (source) return { eventId: String(source.event_id), key: 'event:' + String(source.event_id) }
  }
  const due = db.prepare(`SELECT d.event_id,r.due_at,r.revision,d.result FROM health_dispatch d JOIN task_review r ON r.event_id=d.event_id
    WHERE d.user_id=? AND d.goal_id=? AND r.task_id=? AND 'followup_'||d.event_id=? AND d.result IS NOT NULL LIMIT 1`)
    .get(userId, task.goalId, task.id, String(message.event_id))
  const result = due && parsed(due.result)
  if (due && time(due.due_at) && result?.recommendation && result.outcome !== 'ask') return {
    eventId: String(due.event_id), key: 'due:' + String(Date.parse(due.due_at)), revision: Number(due.revision),
  }
  return undefined
}

/** Evaluate the action as it existed when the result was delivered, never today's mutable task wording. */
function executionContent(db: DatabaseSync, userId: string, task: { id: string; goalId: string }, message: Row,
  payload: Record<string, unknown> | undefined, dueRevision?: number): string | undefined {
  const notification = object(payload?.notification)
  for (const revision of [payload?.task_execution_revision, notification?.revision, dueRevision]) {
    if (!Number.isSafeInteger(revision) || Number(revision) < 0) continue
    const historical = db.prepare('SELECT content FROM task_revision WHERE user_id=? AND task_id=? AND goal_id=? AND revision=?')
      .get(userId, task.id, task.goalId, Number(revision))
    if (historical) return String(historical.content)
  }
  // Older results predate the dedicated host-bound revision marker. Their immutable outbox order can
  // still resolve the last published task revision, including revisions sharing a millisecond timestamp.
  const published = db.prepare(`SELECT r.content FROM sync_outbox o JOIN task_revision r ON r.user_id=o.user_id
    AND r.task_id=o.task_id AND r.revision=json_extract(o.payload,'$.revision')
    WHERE o.user_id=? AND o.goal_id=? AND o.task_id=? AND o.kind='task_updated' AND o.seq<? ORDER BY o.seq DESC LIMIT 1`)
    .get(userId, task.goalId, task.id, message.output_seq!)
  if (published) return String(published.content)
  const historical = db.prepare(`SELECT content FROM task_revision WHERE user_id=? AND task_id=? AND goal_id=?
    AND julianday(created_at)<=julianday(?) ORDER BY created_at DESC,revision DESC LIMIT 1`)
    .get(userId, task.id, task.goalId, String(message.received_at))
  return historical && String(historical.content)
}
