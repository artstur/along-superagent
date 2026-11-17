/** Publish deterministic computed outputs, never raw inputs or a model-written arithmetic claim. */
import type { CalculationResult,CalculationValue } from './calculation.ts'
const display=(value:CalculationValue)=>`${value.value}${value.unit==='1'?'':` ${value.unit}`}`
export function calculationResultText(calculation:CalculationResult,privateInputs=false):string {
  const final=display(calculation.result),seen=new Set([final])
  const other=privateInputs?[]:calculation.trace.flatMap(step=>{
    const text=display(step.result)
    if(seen.has(text))return []
    seen.add(text);return [text]
  })
  return `计算结果：${final}${other.length?'\n其他核算结果：'+other.join('；'):''}`
}
