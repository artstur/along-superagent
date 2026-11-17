import {expect,it} from 'vitest'
import {calculate} from '../src/along/calculation.ts'
import {calculationResultText} from '../src/along/calculation-result.ts'
it('preserves all computed public outputs instead of losing requested intermediate amounts',()=>{
 const receipt=calculate({quantities:[{name:'income',value:'8200',unit:'CNY/month'},{name:'spending',value:'5700',unit:'CNY/month'},{name:'target',value:'10000',unit:'CNY'},{name:'saved',value:'1600',unit:'CNY'}],steps:[{id:'monthly',op:'subtract',inputs:['income','spending']},{id:'gap',op:'subtract',inputs:['target','saved']},{id:'raw_months',op:'divide',inputs:['gap','monthly']},{id:'months',op:'ceil',inputs:['raw_months']}],result_step:'months'})
 const text=calculationResultText(receipt)
 expect(text).toBe('计算结果：4 month\n其他核算结果：2500 CNY/month；8400 CNY；3.36 month')
 for(const raw of ['8200','5700','10000','1600','raw_months'])expect(text).not.toContain(raw)
 expect(calculationResultText(receipt,true)).toBe('计算结果：4 month')
})
it('keeps single-result compatibility and does not publish private intermediate balances',()=>{
 const receipt=calculate({quantities:[{name:'balance',value:'125.2',unit:'USD'},{name:'reserve',value:'25',unit:'USD'},{name:'two',value:'2',unit:'1'}],steps:[{id:'half',op:'divide',inputs:['balance','two']},{id:'remaining',op:'subtract',inputs:['half','reserve']}],result_step:'remaining'})
 expect(calculationResultText(receipt,true)).toBe('计算结果：37.6 USD')
 expect(calculationResultText(receipt,true)).not.toMatch(/125\.2|62\.6|25/)
})
