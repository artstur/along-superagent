/** Bounded exact arithmetic. No expression evaluator, host I/O or untrusted executable text. */
import { z } from 'zod'

const Name = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/)
const Decimal = z.string().trim().regex(/^-?(?:0|[1-9]\d{0,35})(?:\.\d{1,12})?$/,
  'Use a finite decimal string with at most 36 integer and 12 fractional digits.')
const Unit = z.string().trim().min(1).max(80)
const Places = z.number().int().min(0).max(12)
const Step = z.discriminatedUnion('op', [
  z.object({ id: Name, op: z.enum(['add', 'subtract', 'multiply', 'divide']), inputs: z.tuple([Name, Name]) }).strict(),
  z.object({ id: Name, op: z.enum(['min', 'max']), inputs: z.array(Name).min(2).max(8) }).strict(),
  z.object({ id: Name, op: z.enum(['ceil', 'floor']), inputs: z.tuple([Name]) }).strict(),
  z.object({ id: Name, op: z.literal('round'), inputs: z.tuple([Name]), places: Places }).strict(),
  z.object({ id: Name, op: z.literal('convert'), inputs: z.tuple([Name]), unit: Unit }).strict(),
])
/** The model chooses arithmetic, not any identity, storage path or executable code. */
export const CalculationInputSchema = z.object({
  quantities: z.array(z.object({ name: Name, value: Decimal, unit: Unit.default('1') }).strict()).min(1).max(16),
  steps: z.array(Step).min(1).max(24),
  result_step: Name,
  display_places: Places.default(12),
}).strict()
export type CalculationInput = z.input<typeof CalculationInputSchema>
export type NormalizedCalculationInput = z.output<typeof CalculationInputSchema>
/** Stable arithmetic/contract errors without transport, filesystem or credential diagnostics. */
export class CalculationError extends Error {
  constructor(readonly code: string) { super(code) }
}
interface Rational { n: bigint; d: bigint }
interface Measure { text: string; factor: Rational; dimensions: ReadonlyMap<string, number> }
interface Quantity { value: Rational; unit: Measure }
export interface CalculationValue {
  value: string
  unit: string
  exact: { numerator: string; denominator: string }
  rounded: boolean
}
export interface CalculationResult {
  version: 1
  input: NormalizedCalculationInput
  quantities: { name: string; result: CalculationValue }[]
  trace: { id: string; op: NormalizedCalculationInput['steps'][number]['op']; inputs: string[]; result: CalculationValue }[]
  result: CalculationValue
  rounding: 'half_away_from_zero'
}

const MAX_DIGITS = 128
const fail = (code: string): never => { throw new CalculationError(code) }
const abs = (n: bigint) => n < 0n ? -n : n
function ratio(n: bigint, d = 1n): Rational {
  if (d === 0n) return fail('calculation_division_by_zero')
  if (d < 0n) { n = -n; d = -d }
  let a = abs(n), b = d
  while (b !== 0n) { const r = a % b; a = b; b = r }
  n /= a; d /= a
  if (abs(n).toString().length > MAX_DIGITS || d.toString().length > MAX_DIGITS) return fail('calculation_size_limit')
  return { n, d }
}
const mul = (a: Rational, b: Rational) => ratio(a.n * b.n, a.d * b.d)
const div = (a: Rational, b: Rational) => ratio(a.n * b.d, a.d * b.n)
const add = (a: Rational, b: Rational) => ratio(a.n * b.d + b.n * a.d, a.d * b.d)
const compare = (a: Rational, b: Rational) => a.n * b.d < b.n * a.d ? -1 : a.n * b.d > b.n * a.d ? 1 : 0
function decimal(text: string): Rational {
  const negative = text.startsWith('-'), unsigned = negative ? text.slice(1) : text
  const [whole = '0', fraction = ''] = unsigned.split('.')
  return ratio(BigInt(whole + fraction) * (negative ? -1n : 1n), 10n ** BigInt(fraction.length))
}
function rounded(a: Rational, places: number): Rational {
  const scale = 10n ** BigInt(places), n = abs(a.n) * scale
  let whole = n / a.d
  if ((n % a.d) * 2n >= a.d) whole++
  return ratio(whole * (a.n < 0n ? -1n : 1n), scale)
}
function decimalText(value: Rational, places: number): string {
  const scale = 10n ** BigInt(places), normalized = rounded(value, places)
  const digits = (abs(normalized.n) * scale / normalized.d).toString().padStart(places + 1, '0')
  const text = places ? (digits.slice(0, -places) + '.' + digits.slice(-places)).replace(/\.?0+$/, '') : digits
  return (normalized.n < 0n ? '-' : '') + (text || '0')
}
const units: Readonly<Record<string, readonly [string | null, bigint, bigint?]>> = {
  '1': [null, 1n], '%': [null, 1n, 100n],
  CNY: ['CNY', 1n], 元: ['CNY', 1n], 人民币: ['CNY', 1n], USD: ['USD', 1n],
  s: ['second', 1n], second: ['second', 1n], 秒: ['second', 1n],
  min: ['second', 60n], minute: ['second', 60n], 分钟: ['second', 60n],
  h: ['second', 3600n], hour: ['second', 3600n], 小时: ['second', 3600n],
  day: ['second', 86400n], 天: ['second', 86400n], week: ['second', 604800n], 周: ['second', 604800n],
  month: ['month', 1n], 月: ['month', 1n], year: ['month', 12n], 年: ['month', 12n],
  m: ['m', 1n], 米: ['m', 1n], km: ['m', 1000n], 公里: ['m', 1000n],
  g: ['g', 1n], 克: ['g', 1n], kg: ['g', 1000n], 千克: ['g', 1000n],
}
function power(a: Rational, exponent: number): Rational {
  const e = BigInt(Math.abs(exponent))
  return exponent < 0 ? ratio(a.d ** e, a.n ** e) : ratio(a.n ** e, a.d ** e)
}
function dimensions(entries: Iterable<readonly [string, number]>): Map<string, number> {
  const result = new Map<string, number>()
  for (const [name, exponent] of entries) {
    const value = (result.get(name) ?? 0) + exponent
    if (Math.abs(value) > 8) return fail('calculation_unit_limit')
    if (value) result.set(name, value); else result.delete(name)
  }
  if (result.size > 8) return fail('calculation_unit_limit')
  return result
}
function measure(text: string): Measure {
  const halves = text.split('/')
  if (halves.length > 2 || halves.some(part => !part)) return fail('calculation_invalid_unit')
  const terms = halves.flatMap((half, index) => half.split('*').map(term => ({ term, sign: index ? -1 : 1 })))
  if (terms.length > 8) return fail('calculation_unit_limit')
  let factor = ratio(1n)
  const dims: [string, number][] = []
  for (const { term, sign } of terms) {
    const match = /^(1|%|[A-Za-z\u4E00-\u9FFF][A-Za-z0-9_\u4E00-\u9FFF]{0,23})(?:\^(-?[1-8]))?$/.exec(term)
    if (!match) return fail('calculation_invalid_unit')
    const atom = match[1]!, exponent = Number(match[2] ?? 1) * sign
    const known = Object.hasOwn(units, atom) ? units[atom]! : [atom, 1n] as const
    factor = mul(factor, power(ratio(known[1], known[2] ?? 1n), exponent))
    if (known[0] !== null) dims.push([known[0], exponent])
  }
  return { text, factor, dimensions: dimensions(dims) }
}
const sameUnit = (a: Measure, b: Measure) => a.dimensions.size === b.dimensions.size && [...a.dimensions].every(([name, exponent]) => b.dimensions.get(name) === exponent)
function combinedUnit(a: Measure, b: Measure, divide = false): Measure {
  const dims = dimensions([...a.dimensions, ...[...b.dimensions].map(([name, exponent]) => [name, divide ? -exponent : exponent] as const)])
  const numerator: string[] = [], denominator: string[] = []
  for (const [name, exponent] of [...dims].sort(([a], [b]) => a.localeCompare(b))) {
    (exponent > 0 ? numerator : denominator).push(name + (Math.abs(exponent) === 1 ? '' : '^' + Math.abs(exponent)))
  }
  return { text: (numerator.join('*') || '1') + (denominator.length ? '/' + denominator.join('*') : ''), factor: ratio(1n), dimensions: dims }
}
function view(quantity: Quantity, places: number): CalculationValue {
  const value = div(quantity.value, quantity.unit.factor), shown = rounded(value, places)
  return { value: decimalText(value, places), unit: quantity.unit.text,
    exact: { numerator: value.n.toString(), denominator: value.d.toString() }, rounded: compare(value, shown) !== 0 }
}

/** Compute once from normalized bounded JSON; input numbers remain provided data, not independently verified facts. */
export function calculate(input: unknown): CalculationResult {
  const spec = CalculationInputSchema.parse(input)
  const values = new Map<string, Quantity>()
  const normalized: NormalizedCalculationInput = { ...spec, quantities: [] }
  const quantities: CalculationResult['quantities'] = []
  for (const item of spec.quantities) {
    if (values.has(item.name)) return fail('calculation_duplicate_name')
    const unit = measure(item.unit), value = decimal(item.value)
    const quantity = { value: mul(value, unit.factor), unit }
    values.set(item.name, quantity)
    // Input precision is bounded to twelve decimal places, so this normalization is lossless.
    normalized.quantities.push({ ...item, value: decimalText(value, 12) })
    quantities.push({ name: item.name, result: view(quantity, spec.display_places) })
  }
  const trace: CalculationResult['trace'] = []
  const completed = new Set<string>()
  for (const step of spec.steps) {
    if (values.has(step.id)) return fail('calculation_duplicate_name')
    const inputs = step.inputs.map(name => values.get(name) ?? fail('calculation_unknown_reference'))
    const first = inputs[0]!
    let quantity: Quantity
    switch (step.op) {
      case 'add': case 'subtract': case 'min': case 'max': {
        if (inputs.some(value => !sameUnit(first.unit, value.unit))) return fail('calculation_incompatible_units')
        let value = first.value
        for (const next of inputs.slice(1)) {
          if (step.op === 'add') value = add(value, next.value)
          else if (step.op === 'subtract') value = add(value, ratio(-next.value.n, next.value.d))
          else if (step.op === 'min' ? compare(next.value, value) < 0 : compare(next.value, value) > 0) value = next.value
        }
        quantity = { value, unit: first.unit }; break
      }
      case 'multiply': case 'divide':
        quantity = { value: step.op === 'multiply' ? mul(first.value, inputs[1]!.value) : div(first.value, inputs[1]!.value),
          unit: combinedUnit(first.unit, inputs[1]!.unit, step.op === 'divide') }; break
      case 'ceil': case 'floor': case 'round': {
        const value = div(first.value, first.unit.factor)
        let result: Rational
        if (step.op === 'round') result = rounded(value, step.places)
        else {
          let whole = value.n / value.d
          if (value.n % value.d !== 0n && (step.op === 'ceil' ? value.n > 0n : value.n < 0n)) whole += step.op === 'ceil' ? 1n : -1n
          result = ratio(whole)
        }
        quantity = { value: mul(result, first.unit.factor), unit: first.unit }; break
      }
      case 'convert': {
        const unit = measure(step.unit)
        if (!sameUnit(first.unit, unit)) return fail('calculation_incompatible_units')
        quantity = { value: first.value, unit }; break
      }
    }
    values.set(step.id, quantity)
    completed.add(step.id)
    trace.push({ id: step.id, op: step.op, inputs: [...step.inputs], result: view(quantity, spec.display_places) })
  }
  if (!completed.has(spec.result_step)) return fail('calculation_result_step_required')
  return { version: 1, input: normalized, quantities, trace,
    result: view(values.get(spec.result_step)!, spec.display_places), rounding: 'half_away_from_zero' }
}
