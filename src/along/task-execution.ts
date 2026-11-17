/** Product execution history reconstructed from durable business evidence, never Worker audit counts. */
import { createHash } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { isResearchTaskContent } from './recommendation.ts'

export interface TaskExecutionRecord {
  id: string
  kind: 'research' | 'completed'
  executedAt: string
  outcome: 'researched' | 'completed'
  summary?: string
  recommendationEventId?: string
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

  // A completion is a recorded user fact that actually changed the state, not an Agent status edit or
  // a second differently keyed feedback while the task was already done.
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

  if (isResearchTaskContent(task.content)) {
    const outputs = all(`SELECT o.payload,m.id,m.event_id,m.received_at,m.reply_to_message_id FROM sync_outbox o
      JOIN message m ON m.id=o.message_id AND m.user_id=o.user_id
      WHERE o.user_id=? AND o.goal_id=? AND o.task_id=? AND o.kind='message' AND m.role='assistant' AND m.direction='outbound'
      ORDER BY o.seq`, userId, task.goalId, task.id)
    for (const row of outputs) {
      const recommendation = object(parsed(row.payload)?.recommendation)
      if (recommendation?.version !== 1 || !Array.isArray(recommendation.sources) || !recommendation.sources.length ||
        !['ready', 'partial', 'unavailable'].includes(String(recommendation.status)) || development('', String(row.id))) continue
      const root = researchRoot(db, userId, task, row)
      if (!root || development(root.eventId)) continue
      // Structured source ids must resolve to this user's goal and to one Worker scope that really
      // obtained evidence. Reuse is allowed: the tool request need not be new in this business event.
      const tickets = new Set<string>()
      let supported = true
      for (const value of recommendation.sources) {
        const source = object(value)
        const receipt = source && typeof source.id === 'string' && one(`SELECT ticket_id,metadata FROM research_source
          WHERE id=? AND user_id=? AND goal_id=?`, source.id, userId, task.goalId)
        const metadata = receipt && parsed(receipt.metadata)
        if (!receipt || !metadata || !time(metadata.retrievedAt) || Date.parse(metadata.retrievedAt) > Date.parse(String(row.received_at)) + 300_000) { supported = false; break }
        tickets.add(String(receipt.ticket_id))
      }
      if (!supported || tickets.size !== 1) continue
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
function researchRoot(db: DatabaseSync, userId: string, task: { id: string; goalId: string }, message: Row): { eventId: string; key: string } | undefined {
  if (typeof message.reply_to_message_id === 'string') {
    const source = db.prepare(`SELECT m.event_id FROM message m JOIN event_inbox e ON e.user_id=m.user_id AND e.event_id=m.event_id
      JOIN research_reply r ON r.message_id=?
      WHERE m.id=? AND m.user_id=? AND m.role='user' AND m.direction='inbound' AND m.audience='conversation'
        AND e.status='accepted' AND e.event_type='along.user_message' AND (e.goal_id=? OR EXISTS (
          SELECT 1 FROM message_goal_link l WHERE l.message_id=m.id AND l.user_id=? AND l.goal_id=?)) LIMIT 1`)
      .get(String(message.id), message.reply_to_message_id, userId, task.goalId, userId, task.goalId)
    if (source) return { eventId: String(source.event_id), key: 'event:' + String(source.event_id) }
  }
  const due = db.prepare(`SELECT d.event_id,r.due_at,d.result FROM health_dispatch d JOIN task_review r ON r.event_id=d.event_id
    WHERE d.user_id=? AND d.goal_id=? AND r.task_id=? AND 'followup_'||d.event_id=? AND d.result IS NOT NULL LIMIT 1`)
    .get(userId, task.goalId, task.id, String(message.event_id))
  const result = due && parsed(due.result)
  if (due && time(due.due_at) && result?.recommendation && result.outcome !== 'ask') return {
    eventId: String(due.event_id), key: 'due:' + String(Date.parse(due.due_at)),
  }
  return undefined
}
