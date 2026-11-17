/** Pins private calculation inputs to an actual fresh, authorized task read; no executable paths. */
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { CalculationInput } from './calculation.ts'
import type { SourceReadScope,SourceStateStore } from './source-state.ts'
export const QUANTITY_SOURCES=z.array(z.object({quantity:z.string().min(1).max(48),
  path:z.array(z.string().min(1).max(128).refine(k=>!['__proto__','prototype','constructor'].includes(k))).min(1).max(8)}).strict()).max(16)
type Bindings=z.infer<typeof QUANTITY_SOURCES>
export const CALCULATION_EVIDENCE_DDL=`CREATE TABLE IF NOT EXISTS task_calculation_source (
 receipt_id TEXT PRIMARY KEY REFERENCES task_calculation(id),request_id TEXT NOT NULL REFERENCES source_state_read(id),bindings TEXT NOT NULL
);`
const decimal=(value:unknown):string|undefined=>{
 const text=typeof value==='number'&&Number.isFinite(value)?value.toFixed(12):typeof value==='string'?value:undefined
 if(!text||!/^[-+]?\d+(?:\.\d+)?$/.test(text))return
 const negative=text.startsWith('-'),[whole,fraction='']=text.replace(/^[-+]/,'').split('.')
 const result=whole!.replace(/^0+(?=\d)/,'')+(fraction.replace(/0+$/,'')?'.'+fraction.replace(/0+$/,''):'')
 return negative&&result!=='0'?'-'+result:result
}
export class CalculationEvidenceStore {
 constructor(private readonly db:DatabaseSync,private readonly sources:SourceStateStore){}
 verify(scope:SourceReadScope,requestId:string,raw:unknown,quantities:CalculationInput['quantities']):Bindings {
  const bindings=QUANTITY_SOURCES.parse(raw),read=this.sources.getRead(scope,requestId)
  if(read?.state!=='ready'||!read.data)throw new Error('calculation requires a fresh authorized source read for this occurrence')
  const names=new Set<string>()
  for(const b of bindings) {
   if(names.has(b.quantity))throw new Error('duplicate quantity source')
   names.add(b.quantity)
   const quantity=quantities.find(q=>q.name===b.quantity)
   let value:unknown=read.data
   for(const key of b.path) {
    if(!value||typeof value!=='object'||!Object.hasOwn(value,key))throw new Error('quantity source path is unavailable')
    value=(value as Record<string,unknown>)[key]
   }
   if(!quantity||decimal(value)===undefined||decimal(quantity.value)!==decimal(value))throw new Error('quantity does not match its authorized source value')
   // This registered capability currently exposes three Host-validated summary fields. Units are facts,
   // not model labels; arbitrary FX/coverage interpretations are not granted by a successful cache read.
   const field=b.path.length===1?b.path[0]:undefined
   const unit=field==='tradingEquityUsd'?'USD':field==='assetCount'||field==='positionCount'?'count':read.data.unit
   if(typeof unit!=='string'||(quantity.unit??'1')!==unit)throw new Error('quantity unit is not the authorized source field unit')
  }
  if(quantities.some(q=>!names.has(q.name)&&!((q.unit??'1')==='1'&&['0','1','100'].includes(decimal(q.value)??''))))
   throw new Error('each private calculation quantity requires an actual source path; only dimensionless 0, 1 and 100 are constants')
  return bindings
 }
 record(receiptId:string,requestId:string,bindings:Bindings):void {
  this.db.prepare('INSERT INTO task_calculation_source(receipt_id,request_id,bindings) VALUES(?,?,?) ON CONFLICT(receipt_id) DO UPDATE SET request_id=excluded.request_id,bindings=excluded.bindings')
   .run(receiptId,requestId,JSON.stringify(bindings))
 }
 assertCurrent(scope:SourceReadScope,receiptId:string,quantities:CalculationInput['quantities']):void {
  const row=this.db.prepare('SELECT * FROM task_calculation_source WHERE receipt_id=?').get(receiptId)
  if(!row)throw new Error('source-dependent calculation has no actual input evidence')
  this.verify(scope,String(row.request_id),JSON.parse(String(row.bindings)),quantities)
 }
}
