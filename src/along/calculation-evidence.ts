/** Binds each private calculation input to a fresh field, a named constant or an explicit current user parameter. */
import { isDeepStrictEqual } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { CalculationInputSchema, type CalculationInput } from './calculation.ts'
import type { SourceReadScope, SourceStateStore } from './source-state.ts'

const QuantityName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/)
export const QUANTITY_SOURCES = z.array(z.object({ quantity: QuantityName,
  path: z.array(z.string().min(1).max(128).refine(key => !['__proto__', 'prototype', 'constructor'].includes(key))).min(1).max(8),
}).strict()).max(16)
export const CALCULATION_CONSTANTS = {
  percent_base: '100', months_per_year: '12', days_per_week: '7', hours_per_day: '24',
  minutes_per_hour: '60', seconds_per_minute: '60', identity_one: '1', zero: '0',
} as const
export const QUANTITY_PARAMETERS = z.array(z.discriminatedUnion('kind', [
  z.object({ quantity: QuantityName, kind: z.literal('constant'), name: z.enum([
    'percent_base', 'months_per_year', 'days_per_week', 'hours_per_day',
    'minutes_per_hour', 'seconds_per_minute', 'identity_one', 'zero',
  ]) }).strict(),
  z.object({ quantity: QuantityName, kind: z.literal('user'), event_id: z.string().min(1).max(96),
    quote: z.string().trim().min(1).max(300) }).strict(),
])).max(16)
export type QuantityParameter = z.infer<typeof QUANTITY_PARAMETERS>[number]
export interface VerifiedCalculationEvidence {
  version: 1
  read: { request_id: string; provider: 'okx'; capability: 'trading_account_summary'; generation: number; revision: number; reference: string; observed_at: string }
  sources: { quantity: string; path: string[]; value: string; unit: string }[]
  parameters: (QuantityParameter & { value: string; unit: string })[]
}
export const CALCULATION_EVIDENCE_DDL = `CREATE TABLE IF NOT EXISTS task_calculation_source (
 receipt_id TEXT PRIMARY KEY REFERENCES task_calculation(id),request_id TEXT NOT NULL REFERENCES source_state_read(id),bindings TEXT NOT NULL
);`

/** Normalizes decimal text without rounding source numbers to match a model's proposed precision. */
function decimal(value: unknown): string | undefined {
  if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) return
  let text = String(value)
  if (typeof value === 'number' && /e/i.test(text)) {
    const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(text)
    if (!match) return
    const digits = match[2]! + (match[3] ?? ''), place = match[2]!.length + Number(match[4])
    text = match[1]! + (place <= 0 ? '0.' + '0'.repeat(-place) + digits : place >= digits.length
      ? digits + '0'.repeat(place - digits.length) : digits.slice(0, place) + '.' + digits.slice(place))
  }
  if (text.length > 400 || !/^[-+]?\d+(?:\.\d+)?$/.test(text)) return
  const negative = text.startsWith('-'), [whole, fraction = ''] = text.replace(/^[-+]/, '').split('.')
  const normalized = whole!.replace(/^0+(?=\d)/, '') + (fraction.replace(/0+$/, '') ? '.' + fraction.replace(/0+$/, '') : '')
  return negative && normalized !== '0' ? '-' + normalized : normalized
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const UNIT_WORDS: Readonly<Record<string, string>> = {
  USD: '(?:USD|美元|美金)', CNY: '(?:CNY|人民币|元)', 元: '(?:CNY|人民币|元)', 人民币: '(?:CNY|人民币|元)',
  month: '(?:months?|个月|月)', 月: '(?:months?|个月|月)', year: '(?:years?|年)', 年: '(?:years?|年)',
  day: '(?:days?|天|日)', 天: '(?:days?|天|日)', week: '(?:weeks?|周|星期)', 周: '(?:weeks?|周|星期)',
  h: '(?:hours?|小时)', hour: '(?:hours?|小时)', 小时: '(?:hours?|小时)', min: '(?:minutes?|分钟)', minute: '(?:minutes?|分钟)', 分钟: '(?:minutes?|分钟)',
  s: '(?:seconds?|秒)', second: '(?:seconds?|秒)', 秒: '(?:seconds?|秒)', count: '(?:count|个(?!月|小时)|笔|项|次)', '%': '(?:%|％)',
  m: '(?:m|米)', 米: '(?:m|米)', km: '(?:km|公里|千米)', 公里: '(?:km|公里|千米)',
  g: '(?:g|克)', 克: '(?:g|克)', kg: '(?:kg|千克|公斤)', 千克: '(?:kg|千克|公斤)',
}
/** Literal/unit evidence is deliberately bounded; it does not infer a goal target or prove the user's statement true. */
function userLiteral(quote: string, value: string, unit: string): boolean {
  const parts = unit.split('/')
  if (parts.length > 2 || parts.some(part => part !== '1' && !Object.hasOwn(UNIT_WORDS, part))) return false
  const numerator = parts[0] === '1' ? undefined : UNIT_WORDS[parts[0]!], denominator = parts[1] && UNIT_WORDS[parts[1]]
  for (const match of quote.matchAll(/(?<![\d.+-])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\d.])/g)) {
    if (decimal(match[0].replaceAll(',', '')) !== decimal(value)) continue
    const before = quote.slice(0, match.index), after = quote.slice(match.index! + match[0].length)
    if (!numerator && !denominator) {
      if (/^\s*(?:倍|无量纲|dimensionless)(?![A-Za-z])/i.test(after) || /(?:无量纲|dimensionless)\s*[:：]?\s*$/i.test(before)) return true
      continue
    }
    const suffix = numerator && new RegExp('^\\s*' + numerator + '(?![A-Za-z])', 'i').exec(after)
    const prefix = numerator && new RegExp(numerator + '\\s*$', 'i').test(before)
    if (!suffix && !prefix) continue
    if (!denominator) return true
    if (suffix && new RegExp('^\\s*(?:/|每)\\s*' + denominator + '(?![A-Za-z])', 'i').test(after.slice(suffix[0].length)) ||
      new RegExp('(?:每|' + escape('per') + '\\s+)' + denominator + '\\s*(?:的)?\\s*$', 'i').test(before)) return true
  }
  return false
}
const parameterInput = (item: VerifiedCalculationEvidence['parameters'][number]): QuantityParameter => item.kind === 'constant'
  ? { quantity: item.quantity, kind: item.kind, name: item.name }
  : { quantity: item.quantity, kind: item.kind, event_id: item.event_id, quote: item.quote }
const semantic = (value: VerifiedCalculationEvidence) => ({ ...value, read: { ...value.read, observed_at: undefined } })

/** Private receipt evidence only; caller wraps verify/calculate/record or final publication in its Host transaction. */
export class CalculationEvidenceStore {
  constructor(private readonly db: DatabaseSync, private readonly sources: SourceStateStore) {}
  has(receiptId:string):boolean {return !!this.db.prepare('SELECT 1 FROM task_calculation_source WHERE receipt_id=?').get(receiptId)}
  verify(scope: SourceReadScope, requestId: string, rawSources: unknown, rawQuantities: CalculationInput['quantities'], rawParameters: unknown = []): VerifiedCalculationEvidence {
    const bindings = QUANTITY_SOURCES.parse(rawSources), parameters = QUANTITY_PARAMETERS.parse(rawParameters)
    const quantities = CalculationInputSchema.shape.quantities.parse(rawQuantities)
    const read = this.sources.getRead(scope, requestId)
    if (read?.state !== 'ready' || !read.data || !read.reference || !read.observed_at)
      throw new Error('calculation requires a fresh authorized source read for this occurrence')
    if (!bindings.length) throw new Error('private calculation requires at least one registered source field')
    if (new Set(quantities.map(q => q.name)).size !== quantities.length) throw new Error('duplicate calculation quantity')
    const names = new Set<string>(), sourceEvidence: VerifiedCalculationEvidence['sources'] = [], parameterEvidence: VerifiedCalculationEvidence['parameters'] = []
    const claim = (name: string) => {
      if (names.has(name)) throw new Error('duplicate quantity evidence')
      names.add(name)
      const quantity = quantities.find(q => q.name === name)
      if (!quantity) throw new Error('evidence quantity is not a calculation input')
      return quantity
    }
    for (const binding of bindings) {
      const quantity = claim(binding.quantity), field = binding.path.length === 1 ? binding.path[0] : undefined
      if (!field || !['tradingEquityUsd', 'assetCount', 'positionCount'].includes(field)) throw new Error('quantity source path is not a registered summary field')
      const value = Object.hasOwn(read.data, field) ? decimal(read.data[field]) : undefined
      if (value === undefined || decimal(quantity.value) !== value) throw new Error('quantity does not match its authorized source value')
      const unit = field === 'tradingEquityUsd' ? 'USD' : 'count'
      if (quantity.unit !== unit) throw new Error('quantity unit is not the authorized source field unit')
      if (unit === 'count' && (!/^\d+$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER))) throw new Error('source count must be a nonnegative safe integer')
      sourceEvidence.push({ quantity: binding.quantity, path: [...binding.path], value, unit })
    }
    for (const parameter of parameters) {
      const quantity = claim(parameter.quantity), value = decimal(quantity.value)!, unit = quantity.unit
      if (parameter.kind === 'constant') {
        if (unit !== '1' || value !== CALCULATION_CONSTANTS[parameter.name]) throw new Error('quantity does not match its named standard constant')
      } else {
        const message = this.db.prepare(`SELECT m.text,m.event_id FROM message m
          JOIN message_goal_link l ON l.message_id=m.id AND l.goal_id=? AND l.relation='direct'
          JOIN event_inbox e ON e.user_id=m.user_id AND e.event_id=m.event_id
          WHERE m.user_id=? AND m.audience='conversation' AND m.role='user' AND m.direction='inbound'
          AND e.status='accepted' AND e.event_type='along.user_message' ORDER BY m.seq DESC LIMIT 1`).get(scope.goalId, scope.userId)
        if (!message || message.event_id !== parameter.event_id || !String(message.text).includes(parameter.quote)) throw new Error('user parameter requires exact current same-goal accepted direct evidence')
        if (!userLiteral(parameter.quote, value, unit)) throw new Error('user parameter literal and unit are not present in its quoted evidence')
      }
      parameterEvidence.push({ ...parameter, value, unit })
    }
    if (quantities.some(q => !names.has(q.name))) throw new Error('each calculation quantity requires an explicit source or parameter')
    return { version: 1, read: { request_id: requestId, provider: read.provider, capability: read.capability,
      generation: read.generation, revision: read.revision, reference: read.reference, observed_at: read.observed_at },
      sources: sourceEvidence.sort((a,b) => a.quantity.localeCompare(b.quantity)), parameters: parameterEvidence.sort((a,b) => a.quantity.localeCompare(b.quantity)) }
  }
  record(receiptId: string, requestId: string, evidence: VerifiedCalculationEvidence): void {
    const receipt = this.db.prepare('SELECT * FROM task_calculation WHERE id=?').get(receiptId)
    if (!receipt) throw new Error('calculation receipt is unavailable')
    const scope: SourceReadScope = { userId: String(receipt.user_id), goalId: String(receipt.goal_id), taskId: String(receipt.task_id),
      taskRevision: Number(receipt.task_revision), inputVersion: Number(receipt.input_version), ticketId: String(receipt.ticket_id), executionKey: String(receipt.execution_key) }
    const quantities = (JSON.parse(String(receipt.calculation)) as {input:CalculationInput}).input.quantities
    const verified = this.verify(scope, requestId, evidence.sources.map(({quantity,path}) => ({quantity,path})), quantities, evidence.parameters.map(parameterInput))
    if (!isDeepStrictEqual(semantic(verified), semantic(evidence))) throw new Error('calculation evidence changed before recording')
    const prior = this.db.prepare('SELECT request_id,bindings FROM task_calculation_source WHERE receipt_id=?').get(receiptId)
    if (prior) {
      const stored = JSON.parse(String(prior.bindings)) as VerifiedCalculationEvidence
      if (prior.request_id !== requestId || !isDeepStrictEqual(semantic(stored), semantic(evidence))) throw new Error('calculation receipt already has different input evidence')
      return
    }
    this.db.prepare('INSERT INTO task_calculation_source(receipt_id,request_id,bindings) VALUES(?,?,?)').run(receiptId, requestId, JSON.stringify(verified))
  }
  assertCurrent(scope: SourceReadScope, receiptId: string, quantities: CalculationInput['quantities']): void {
    const row = this.db.prepare('SELECT * FROM task_calculation_source WHERE receipt_id=?').get(receiptId)
    if (!row) throw new Error('source-dependent calculation has no actual input evidence')
    const stored = JSON.parse(String(row.bindings)) as VerifiedCalculationEvidence | z.infer<typeof QUANTITY_SOURCES>
    // Old source-only rows can be revalidated. Implicit literal exemptions are deliberately not grandfathered in.
    const sources = Array.isArray(stored) ? stored : stored.sources.map(({quantity,path}) => ({quantity,path}))
    const parameters = Array.isArray(stored) ? [] : stored.parameters.map(parameterInput)
    const current = this.verify(scope, String(row.request_id), sources, quantities, parameters)
    if (!Array.isArray(stored) && !isDeepStrictEqual(semantic(current), semantic(stored))) throw new Error('calculation input evidence was superseded')
  }
}
