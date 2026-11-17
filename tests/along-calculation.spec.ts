import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { calculate, CalculationInputSchema, type CalculationInput } from '../src/along/calculation.ts'
import { CalculationStore, CALCULATION_SCHEMA, type CalculationScope } from '../src/along/calculation-store.ts'
import { migrateAlongSchema } from '../src/along/migrate.ts'

const budget: CalculationInput = {
  quantities: [{ name: 'target', value: '60000', unit: 'CNY' }, { name: 'saved', value: '10000', unit: 'CNY' },
    { name: 'monthly', value: '2500', unit: 'CNY/month' }],
  steps: [{ id: 'remaining', op: 'subtract', inputs: ['target', 'saved'] },
    { id: 'months', op: 'divide', inputs: ['remaining', 'monthly'] },
    { id: 'whole_months', op: 'ceil', inputs: ['months'] }], result_step: 'whole_months',
}
const binary = (op: 'add' | 'subtract' | 'multiply' | 'divide' | 'min' | 'max', a: string, b: string, unit = '1'): CalculationInput => ({
  quantities: [{ name: 'a', value: a, unit }, { name: 'b', value: b, unit }],
  steps: [{ id: 'answer', op, inputs: ['a', 'b'] }], result_step: 'answer',
})
const unary = (op: 'ceil' | 'floor' | 'round', value: string, unit = '1', places = 0): CalculationInput => ({
  quantities: [{ name: 'a', value, unit }],
  steps: [op === 'round' ? { id: 'answer', op, inputs: ['a'], places } : { id: 'answer', op, inputs: ['a'] }], result_step: 'answer',
})

it('performs a real multi-step budget calculation with exact money and calendar-month units', () => {
  const result = calculate(budget)
  expect(result.result).toEqual({ value: '20', unit: 'month', exact: { numerator: '20', denominator: '1' }, rounded: false })
  expect(result.trace.map(item => item.result.value)).toEqual(['50000', '20', '20'])
  expect(result.quantities[2]?.result.unit).toBe('CNY/month')
  expect(JSON.parse(JSON.stringify(result))).toEqual(result)
})

it('preserves exact decimals and reports display rounding without pretending a third is finite', () => {
  expect(calculate(binary('add', '0.1', '0.2')).result).toMatchObject({ value: '0.3', exact: { numerator: '3', denominator: '10' }, rounded: false })
  expect(calculate(binary('divide', '1', '3')).result).toEqual({ value: '0.333333333333', unit: '1', exact: { numerator: '1', denominator: '3' }, rounded: true })
  expect(calculate({ ...binary('divide', '2', '3'), display_places: 2 }).result).toMatchObject({ value: '0.67', exact: { numerator: '2', denominator: '3' }, rounded: true })
  expect(calculate(binary('add', '-0.000', '0')).result.value).toBe('0')
})

it.each([
  ['ceil', '-1.01', 0, '-1'], ['floor', '-1.01', 0, '-2'], ['ceil', '1.01', 0, '2'],
  ['round', '1.25', 1, '1.3'], ['round', '-1.25', 1, '-1.3'], ['round', '-0.005', 2, '-0.01'],
] as const)('uses correct signed %s rounding for %s', (op, input, places, expected) => {
  expect(calculate(unary(op, input, 'CNY', places)).result.value).toBe(expected)
})

it('rounds in the displayed quantity unit, not in hidden canonical seconds or grams', () => {
  expect(calculate(unary('ceil', '1.2', 'hour')).result).toMatchObject({ value: '2', unit: 'hour' })
  expect(calculate(unary('round', '1.235', 'kg', 2)).result).toMatchObject({ value: '1.24', unit: 'kg' })
})

it('converts compatible units explicitly and adds a mixed time quantity correctly', () => {
  const result = calculate({ quantities: [{ name: 'a', value: '1', unit: 'hour' }, { name: 'b', value: '30', unit: 'min' }],
    steps: [{ id: 'total', op: 'add', inputs: ['a', 'b'] }, { id: 'minutes', op: 'convert', inputs: ['total'], unit: 'min' }], result_step: 'minutes' })
  expect(result.trace[0]?.result).toMatchObject({ value: '1.5', unit: 'hour' })
  expect(result.result).toMatchObject({ value: '90', unit: 'min' })
  expect(calculate({ quantities: [{ name: 'a', value: '1', unit: 'year' }], steps: [{ id: 'months', op: 'convert', inputs: ['a'], unit: 'month' }], result_step: 'months' }).result.value).toBe('12')
})

it('handles percentage scales and dimensional multiplication without implicit unit loss', () => {
  expect(calculate(binary('add', '10', '20', '%')).result).toMatchObject({ value: '30', unit: '%' })
  const result = calculate({ quantities: [{ name: 'price', value: '200', unit: 'CNY' }, { name: 'discount', value: '15', unit: '%' }],
    steps: [{ id: 'amount', op: 'multiply', inputs: ['price', 'discount'] }], result_step: 'amount' })
  expect(result.result).toMatchObject({ value: '30', unit: 'CNY' })
  expect(calculate(binary('min', '-3', '2', 'book')).result.value).toBe('-3')
  expect(calculate(binary('max', '-3', '2', 'book')).result.value).toBe('2')
})

it('refuses silent currency conversion and calendar-month/day approximations', () => {
  const addCurrency = binary('add', '1', '2', 'CNY')
  addCurrency.quantities[1]!.unit = 'USD'
  expect(() => calculate(addCurrency)).toThrow('calculation_incompatible_units')
  for (const [source, target] of [['CNY', 'USD'], ['month', 'day'], ['year', 'hour']]) {
    expect(() => calculate({ quantities: [{ name: 'a', value: '1', unit: source }],
      steps: [{ id: 'answer', op: 'convert', inputs: ['a'], unit: target }], result_step: 'answer' })).toThrow('calculation_incompatible_units')
  }
})

it('rejects zero division, forward references, duplicate names and uncomputed results', () => {
  expect(() => calculate(binary('divide', '1', '0'))).toThrow('calculation_division_by_zero')
  expect(() => calculate({ ...binary('add', '1', '2'), steps: [{ id: 'answer', op: 'add', inputs: ['a', 'later'] }] })).toThrow('calculation_unknown_reference')
  const duplicate = binary('add', '1', '2'); duplicate.quantities[1]!.name = 'a'
  expect(() => calculate(duplicate)).toThrow('calculation_duplicate_name')
  expect(() => calculate({ ...binary('add', '1', '2'), steps: [{ id: 'a', op: 'add', inputs: ['a', 'b'] }] })).toThrow('calculation_duplicate_name')
  expect(() => calculate({ ...binary('add', '1', '2'), result_step: 'a' })).toThrow('calculation_result_step_required')
})

it('bounds payloads and arithmetic instead of accepting executable, nonfinite or unbounded inputs', () => {
  for (const value of ['NaN', 'Infinity', '1e309', '0x10', 'process.env.SECRET', '1;require("fs")', '9'.repeat(37)]) {
    expect(() => calculate(binary('add', value, '1'))).toThrow()
  }
  expect(() => calculate({ ...binary('add', '1', '2'), code: 'readFile("/private")' })).toThrow()
  expect(() => calculate({ ...binary('add', '1', '2'), display_places: 100 })).toThrow()
  expect(() => calculate({ ...binary('add', '1', '2'), steps: Array.from({ length: 25 }, (_, i) => ({ id: 'x' + i, op: 'add', inputs: ['a', 'b'] })) })).toThrow()
  expect(() => calculate(binary('add', '1', '2', '/etc/passwd'))).toThrow('calculation_invalid_unit')
  expect(() => calculate(binary('multiply', '1', '2', 'm^8'))).toThrow('calculation_unit_limit')
  const huge = '9'.repeat(36)
  expect(() => calculate({ quantities: [{ name: 'a', value: huge }],
    steps: [{ id: 'b', op: 'multiply', inputs: ['a', 'a'] }, { id: 'c', op: 'multiply', inputs: ['b', 'b'] }], result_step: 'c' })).toThrow('calculation_size_limit')
})

it('exposes a finite nonrecursive JSON tool schema and does not treat object prototype names as code', () => {
  const schema = z.toJSONSchema(CalculationInputSchema)
  expect(JSON.stringify(schema).length).toBeLessThan(30000)
  expect(schema.additionalProperties).toBe(false)
  expect(schema.properties?.quantities).toMatchObject({ maxItems: 16 })
  expect(schema.properties?.steps).toMatchObject({ maxItems: 24 })
  expect(() => CalculationInputSchema.parse({ ...binary('add', '1', '2'), user_id: 'foreign' })).toThrow()
  const input = binary('add', '1', '2', 'constructor')
  input.quantities[0]!.name = 'constructor'; input.steps[0]!.inputs[0] = 'constructor'
  expect(calculate(input).result).toMatchObject({ value: '3', unit: 'constructor' })
})

const dbs: DatabaseSync[] = [], dirs: string[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function open(path = ':memory:') {
  const db = new DatabaseSync(path); dbs.push(db)
  db.exec('PRAGMA foreign_keys=ON'); migrateAlongSchema(db); db.exec(CALCULATION_SCHEMA)
  return db
}
function seed(db: DatabaseSync, suffix = 'a'): CalculationScope {
  const userId = 'user_' + suffix, goalId = 'goal_' + suffix, taskId = 'task_' + suffix, at = '2030-01-01T00:00:00.000Z'
  db.prepare('INSERT INTO user(id,name,device_id,created_at) VALUES(?,?,?,?)').run(userId, suffix, 'device_' + suffix, at)
  db.prepare('INSERT INTO goal(id,user_id,domain,status,current_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(goalId, userId, 'custom', 'active', 1, at, at)
  db.prepare('INSERT INTO user_task(id,goal_id,user_id,status,content,current_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(taskId, goalId, userId, 'open', '计算需要存多少个月', 1, at, at)
  db.prepare('INSERT INTO task_revision(task_id,revision,user_id,goal_id,content,status,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(taskId, 1, userId, goalId, '计算需要存多少个月', 'open', at)
  return { userId, goalId, taskId, taskRevision: 1, taskContent: '计算需要存多少个月', inputVersion: 1,
    ticketId: 'ticket_' + suffix, executionKey: 'event_synthetic' }
}

it('stores exact proof idempotently, allows corrected inputs in one execution and does not finish a person task', () => {
  const db = open(), scope = seed(db), store = new CalculationStore(db, () => '2030-01-01T00:01:00.000Z')
  const first = store.calculate(scope, budget)
  expect(first).toMatchObject({ reused: false, taskContent: scope.taskContent, calculation: { result: { value: '20', unit: 'month' } } })
  const replay = store.calculate({ ...scope, ticketId: 'resumed_ticket' }, budget)
  expect(replay).toMatchObject({ id: first.id, reused: true, ticketId: scope.ticketId, calculatedAt: first.calculatedAt })
  const corrected = structuredClone(budget); corrected.quantities[2]!.value = '2000'
  expect(store.calculate(scope, corrected).calculation.result.value).toBe('25')
  expect(db.prepare('SELECT count(*) n,count(DISTINCT execution_key) executions FROM task_calculation').get()).toEqual({ n: 2, executions: 1 })
  expect(db.prepare('SELECT status,current_revision FROM user_task WHERE id=?').get(scope.taskId)).toEqual({ status: 'open', current_revision: 1 })
  expect(db.prepare('SELECT count(*) n FROM sync_outbox').get()?.n).toBe(0) // Integration owns delivery.
})

it('keeps ownership, execution, task and input-version boundaries and refuses forged historical content', () => {
  const db = open(), a = seed(db), b = seed(db, 'b'), store = new CalculationStore(db)
  const first = store.calculate(a, budget), other = store.calculate(b, budget)
  expect(first.id).not.toBe(other.id)
  for (const scope of [b, { ...a, inputVersion: 2 }, { ...a, executionKey: 'other_event' }, { ...a, taskRevision: 2 }]) {
    expect(store.get(scope, first.id)).toBeUndefined()
  }
  expect(() => store.calculate({ ...a, goalId: b.goalId }, budget)).toThrow('calculation_scope_mismatch')
  expect(() => store.calculate({ ...a, userId: b.userId }, budget)).toThrow('calculation_scope_mismatch')
  expect(() => store.calculate({ ...a, taskContent: '声称已徒步' }, budget)).toThrow('calculation_scope_mismatch')
})

it('does not persist invalid arithmetic and rolls back with the caller-owned business transaction', () => {
  const db = open(), scope = seed(db), store = new CalculationStore(db)
  expect(() => store.calculate(scope, binary('divide', '1', '0'))).toThrow('calculation_division_by_zero')
  expect(db.prepare('SELECT count(*) n FROM task_calculation').get()?.n).toBe(0)
  db.exec('BEGIN'); const computed = store.calculate(scope, budget); db.exec('ROLLBACK')
  expect(store.get(scope, computed.id)).toBeUndefined()
})

it('retains exact receipt identity and execution-time task content across restart and later wording changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'along-calculation-')); dirs.push(dir)
  const path = join(dir, 'along.sqlite'), db = open(path), scope = seed(db)
  const first = new CalculationStore(db, () => '2030-01-01T00:01:00.000Z').calculate(scope, budget)
  db.close(); dbs.splice(dbs.indexOf(db), 1)
  const reopened = open(path), store = new CalculationStore(reopened, () => '2030-01-02T00:01:00.000Z')
  expect(store.calculate(scope, budget)).toMatchObject({ id: first.id, reused: true, calculatedAt: first.calculatedAt })
  reopened.prepare('UPDATE user_task SET content=?,current_revision=2 WHERE id=?').run('实际进行周末徒步', scope.taskId)
  expect(store.get(scope, first.id)?.taskContent).toBe('计算需要存多少个月')
  expect(store.get(scope, first.id)?.calculation.result.value).toBe('20')
})

it('normalizes exact decimal spelling for receipt replay and bounds host scope/clock data', () => {
  const db = open(), scope = seed(db), store = new CalculationStore(db)
  const input = binary('add', '0.1000', '0.2')
  const first = store.calculate(scope, input)
  expect(store.calculate(scope, binary('add', '0.1', '0.200')).id).toBe(first.id)
  expect(() => store.calculate({ ...scope, executionKey: '' }, input)).toThrow('calculation_invalid_scope')
  expect(() => store.calculate({ ...scope, taskRevision: NaN }, input)).toThrow('calculation_invalid_scope')
  expect(() => new CalculationStore(db, () => 'not a clock').calculate({ ...scope, executionKey: 'next_event' }, input)).toThrow('calculation_invalid_clock')
})
