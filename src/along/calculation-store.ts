/** Durable arithmetic receipts on AlongStore's shared SQLite transaction. */
import { createHash } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { calculate, CalculationError, type CalculationResult } from './calculation.ts'

export const CALCULATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_calculation (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES user(id), goal_id TEXT NOT NULL REFERENCES goal(id),
 task_id TEXT NOT NULL REFERENCES user_task(id), task_revision INTEGER NOT NULL,
 task_content TEXT NOT NULL, input_version INTEGER NOT NULL, ticket_id TEXT NOT NULL,
 execution_key TEXT NOT NULL, input_digest TEXT NOT NULL, calculation TEXT NOT NULL,
 calculated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS task_calculation_input ON task_calculation
 (user_id,goal_id,task_id,task_revision,input_version,execution_key,input_digest);
CREATE INDEX IF NOT EXISTS task_calculation_history ON task_calculation(user_id,goal_id,task_id,calculated_at);
`
/** All fields are host-owned. This is not a model argument schema. */
export interface CalculationScope {
  userId: string
  goalId: string
  taskId: string
  taskRevision: number
  taskContent: string
  inputVersion: number
  ticketId: string
  executionKey: string
}
export interface CalculationReceipt extends CalculationScope {
  id: string
  inputDigest: string
  calculatedAt: string
  calculation: CalculationResult
}
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => JSON.stringify(key) + ':' + stable(child)).join(',') + '}'
  return JSON.stringify(value)
}
const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex')
function validScope(scope: CalculationScope): void {
  for (const value of [scope.userId, scope.goalId, scope.taskId, scope.ticketId, scope.executionKey]) {
    if (typeof value !== 'string' || !value || value.length > 256) throw new CalculationError('calculation_invalid_scope')
  }
  if (!Number.isSafeInteger(scope.taskRevision) || scope.taskRevision < 1 ||
    !Number.isSafeInteger(scope.inputVersion) || scope.inputVersion < 1 ||
    typeof scope.taskContent !== 'string' || !scope.taskContent.trim() || scope.taskContent.length > 120) {
    throw new CalculationError('calculation_invalid_scope')
  }
}
function receipt(row: Record<string, SQLInputValue>): CalculationReceipt {
  return { id: String(row.id), userId: String(row.user_id), goalId: String(row.goal_id), taskId: String(row.task_id),
    taskRevision: Number(row.task_revision), taskContent: String(row.task_content), inputVersion: Number(row.input_version),
    ticketId: String(row.ticket_id), executionKey: String(row.execution_key), inputDigest: String(row.input_digest),
    calculatedAt: String(row.calculated_at), calculation: JSON.parse(String(row.calculation)) as CalculationResult }
}
/**
 * The caller owns schema migration and the transaction. It must check current source authority, input and
 * revisions immediately before invoking this class. Basic ownership and historical content are checked
 * defensively here too; no mutation, notification or task completion is inferred from arithmetic.
 */
export class CalculationStore {
  constructor(private readonly db: DatabaseSync, private readonly now: () => string = () => new Date().toISOString()) {}

  calculate(scope: CalculationScope, input: unknown): CalculationReceipt & { reused: boolean } {
    validScope(scope)
    const bound = this.db.prepare(`SELECT r.content FROM user_task t JOIN goal g ON g.id=t.goal_id
      JOIN task_revision r ON r.task_id=t.id AND r.user_id=t.user_id AND r.goal_id=t.goal_id
      WHERE t.id=? AND t.user_id=? AND t.goal_id=? AND g.user_id=? AND r.revision=?`)
      .get(scope.taskId, scope.userId, scope.goalId, scope.userId, scope.taskRevision)
    if (!bound || bound.content !== scope.taskContent) throw new CalculationError('calculation_scope_mismatch')
    const calculation = calculate(input), inputDigest = hash(calculation.input)
    const id = 'calc_' + hash([scope.userId, scope.goalId, scope.taskId, scope.taskRevision, scope.inputVersion,
      scope.executionKey, inputDigest]).slice(0, 40)
    const previous = this.get(scope, id)
    if (previous) return { ...previous, reused: true }
    const calculatedAt = this.now()
    if (!Number.isFinite(Date.parse(calculatedAt))) throw new CalculationError('calculation_invalid_clock')
    this.db.prepare(`INSERT INTO task_calculation(id,user_id,goal_id,task_id,task_revision,task_content,input_version,
      ticket_id,execution_key,input_digest,calculation,calculated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, scope.userId, scope.goalId, scope.taskId, scope.taskRevision, scope.taskContent, scope.inputVersion,
        scope.ticketId, scope.executionKey, inputDigest, JSON.stringify(calculation), calculatedAt)
    return { ...scope, id, inputDigest, calculatedAt, calculation, reused: false }
  }

  /** A receipt can be reused by a resumed ticket only in the same host-bound business execution. */
  get(scope: CalculationScope, id: string): CalculationReceipt | undefined {
    validScope(scope)
    const row = this.db.prepare(`SELECT * FROM task_calculation WHERE id=? AND user_id=? AND goal_id=? AND task_id=?
      AND task_revision=? AND input_version=? AND execution_key=?`)
      .get(id, scope.userId, scope.goalId, scope.taskId, scope.taskRevision, scope.inputVersion, scope.executionKey)
    return row ? receipt(row) : undefined
  }
}
