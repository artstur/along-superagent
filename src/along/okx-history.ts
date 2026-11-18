/** Bounded deterministic Host report, never arbitrary history blobs or execution instructions. */
import { z } from 'zod'
const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const timestamp=z.string().datetime({offset:true}).refine(value=>Number.isFinite(Date.parse(value)))
const decimal=z.string().max(160).regex(/^-?\d+(?:\.\d+)?$/)
const optionalDecimal=z.union([decimal,z.literal('')])
const identifier=z.string().max(96).regex(/^[A-Za-z0-9_.:-]*$/)
const currency=z.string().min(1).max(24).regex(/^[A-Z0-9]+$/)
const instType=z.enum(['SPOT','MARGIN','SWAP','FUTURES','OPTION','EVENTS'])
const stream=z.object({kind:z.enum(['fills','bills']),instType:z.enum(['SPOT','MARGIN','SWAP','FUTURES','OPTION','EVENTS','ALL']),
  status:z.enum(['complete','truncated','unavailable']),reason:z.enum(['none','page_limit','api_unavailable']),pages:count.max(20)}).strict()
export const OKX_HISTORY_FILL=z.object({billId:identifier.min(1),tradeId:identifier,ordId:identifier,instType,
  instId:identifier.min(1),side:z.enum(['buy','sell']),posSide:z.enum(['long','short','net','']),fillPx:optionalDecimal,fillSz:optionalDecimal,
  fillPnl:optionalDecimal,fee:optionalDecimal,feeCcy:z.union([currency,z.literal('')]),ts:z.string().regex(/^\d{13}$/),tag:identifier.max(32)}).strict()
export const OKX_HISTORY_BILL=z.object({billId:identifier.min(1),instType:z.union([instType,z.literal('')]),instId:identifier,
  type:z.string().regex(/^\d{1,4}$/),subType:z.string().regex(/^\d{0,4}$/),ccy:currency,pnl:optionalDecimal,fee:optionalDecimal,
  balChg:optionalDecimal,sz:optionalDecimal,px:optionalDecimal,ts:z.string().regex(/^\d{13}$/)}).strict()
const fillGroup=z.object({instType,instId:identifier.min(1),feeCcy:z.union([currency,z.literal('')]),fillCount:count,orderCount:count,buyCount:count,sellCount:count,
  feeCashflow:decimal.nullable(),missingValues:count}).strict()
const billGroup=z.object({instType:z.union([instType,z.literal('')]),instId:identifier,ccy:currency,billCount:count,
  tradePnl:decimal.nullable(),tradeFee:decimal.nullable(),tradeNet:decimal.nullable(),fundingCashflow:decimal.nullable(),
  otherCashflow:decimal.nullable(),otherCount:count,missingValues:count}).strict()
export const OKXHistoryReportSchema=z.object({version:z.literal(1),windowStart:timestamp,windowEnd:timestamp,
  coverage:z.object({complete:z.boolean(),streams:z.array(stream).length(7),fillCount:count.max(3000),billCount:count.max(2000),
    matchedFillCount:count,unmatchedFillCount:count,groupsTruncated:z.boolean()}).strict(),
  totals:z.object({fills:count.max(3000),orders:count.max(3000),bills:count.max(2000),buys:count.max(3000),sells:count.max(3000)}).strict(),
  groups:z.object({fills:z.array(fillGroup).max(100),bills:z.array(billGroup).max(100)}).strict(),
  sampleFills:z.array(OKX_HISTORY_FILL).max(10),sampleBills:z.array(OKX_HISTORY_BILL).max(10),
  limitations:z.array(z.string().min(1).max(400)).max(32)}).strict().superRefine((report,ctx)=>{
    const error=(message:string)=>ctx.addIssue({code:'custom',message})
    const start=Date.parse(report.windowStart),end=Date.parse(report.windowEnd)
    if(end<=start||end-start>90*86400000+1)error('Invalid bounded history observation window')
    const streamKeys=report.coverage.streams.map(s=>s.kind+':'+s.instType)
    const expected=['fills:SPOT','fills:MARGIN','fills:SWAP','fills:FUTURES','fills:OPTION','fills:EVENTS','bills:ALL']
    if(expected.some(key=>!streamKeys.includes(key))||new Set(streamKeys).size!==7)error('Every fixed history stream must declare coverage')
    for(const s of report.coverage.streams)if(s.status==='complete'?s.reason!=='none':s.reason==='none')error('Stream reason must match its coverage')
    if(!report.coverage.streams.some(s=>s.status==='complete')&&!report.totals.fills&&!report.totals.bills)error('Unavailable empty streams do not establish usable history')
    if(report.coverage.complete&&(report.coverage.groupsTruncated||report.coverage.streams.some(s=>s.status!=='complete')))error('Incomplete data cannot claim complete coverage')
    if(report.coverage.fillCount!==report.totals.fills||report.coverage.billCount!==report.totals.bills||
      report.coverage.matchedFillCount+report.coverage.unmatchedFillCount!==report.totals.fills||
      report.totals.buys+report.totals.sells!==report.totals.fills||report.totals.orders>report.totals.fills)error('Inconsistent history counts')
    for(const rows of [report.sampleFills,report.sampleBills])for(const row of rows)if(Number(row.ts)<start||Number(row.ts)>end)error('Example lies outside observation window')
  })
export type OKXHistoryReport=z.infer<typeof OKXHistoryReportSchema>

/** Numerical facts are rendered from verified report fields, not retyped or recomputed by the model. */
export function okxHistoryResultText(report:OKXHistoryReport,interpretation:string):string {
  const amount=(value:string|null)=>value===null?'未知':value
  const rows=[`OKX 成交与账单观察窗口：${report.windowStart} 至 ${report.windowEnd}。`,
    `覆盖${report.coverage.complete?'完整':'不完整'}：已采集${report.totals.fills}笔成交、${report.totals.bills}条账单。以下是已观测分量，不是全账户净收益；现货期初成本及用户策略规则/映射仍需补充。`,
    '币种分别保留；成交手续费与账单手续费是替代证据，不重复相加。']
  for(const group of report.groups.fills.slice(0,3))rows.push(`${group.instId} 成交手续费现金流：${amount(group.feeCashflow)} ${group.feeCcy}（负数为支出，正数为返佣）。`)
  for(const group of report.groups.bills.slice(0,3))rows.push(`${group.instId||group.instType||'账户'} ${group.ccy}：普通交易账单盈亏分量${amount(group.tradePnl)}、手续费${amount(group.tradeFee)}、两项合计${amount(group.tradeNet)}；资金费现金流${amount(group.fundingCashflow)}，其他现金流${amount(group.otherCashflow)}。`)
  const facts=rows.join('\n')
  const budget=Math.max(0,1200-facts.length-10)
  return (facts+'\nAgent解读：'+interpretation.slice(0,budget)).slice(0,1200)
}
