import { expect, it } from 'vitest'
import { ResultPresentationSchema, textPresentation, recommendationPresentation, MAX_TASK_RESULT_TEXT, legacyTaskResultPreview } from '../src/along/result-presentation.ts'
import type { Recommendation } from '../src/along/recommendation.ts'
const display={version:1,title:'今天的安排',summary:'先看结论',actions:[{text:'午后散步',when:'合适的空闲时间'}],sections:[{heading:'为什么',body:'依据已知情况安排。'}]}
it('accepts bounded product structure and refuses hidden authority and unbounded payloads',()=>{
 expect(ResultPresentationSchema.safeParse(display).success).toBe(true)
 for(const value of [{...display,version:2},{...display,user_id:'foreign'},{...display,sources:['invented']},
   {...display,summary:'x'.repeat(361)},{...display,actions:Array(6).fill({text:'重复'})},
   {...display,sections:[{heading:'详情',body:'x'.repeat(8001)}]},
   {...display,sections:Array(3).fill({heading:'过量',body:'x'.repeat(6000)})},
   {...display,actions:[{text:'行动',trigger:'immediate'}]}])expect(ResultPresentationSchema.safeParse(value).success).toBe(false)
})
it('keeps Unicode scalars intact at native preview/summary/section and recommendation heading boundaries',()=>{
 const label='结果预览（完整内容见新版任务详情）\n',cut=1200-label.length-1
 const preview=legacyTaskResultPreview('a'.repeat(cut-1)+'😀'+'b'.repeat(60))
 expect(preview.isWellFormed()).toBe(true);expect(preview.length).toBeLessThanOrEqual(1200)
 const body='a'.repeat(7799)+'😀'+'b'.repeat(60),result=textPresentation(body)
 expect(result.sections.every(section=>section.body.isWellFormed())).toBe(true)
 expect(result.sections.map(section=>section.body).join('')).toBe(body)
 expect(textPresentation('a'.repeat(358)+'😀'+'b'.repeat(60)).summary.isWellFormed()).toBe(true)
 const rec={title:'推荐',summary:'a'.repeat(358)+'😀'+'b'.repeat(60),nextStep:'下一步',
   options:[{title:'a'.repeat(79)+'😀',status:'conditional',reason:'待核实',facts:[],conditions:[],unknowns:[]}]} as unknown as Recommendation
 const shown=recommendationPresentation(rec)
 expect(shown.summary.isWellFormed()).toBe(true);expect(shown.sections[0]!.heading.isWellFormed()).toBe(true)
 expect(ResultPresentationSchema.safeParse({...display,summary:'\ud800'}).success).toBe(false)
 expect(ResultPresentationSchema.safeParse({...display,sections:[{heading:'详情',body:'\udc00'}]}).success).toBe(false)
 expect(()=>legacyTaskResultPreview('raw\ud800')).toThrow('incomplete Unicode')
 expect(()=>textPresentation('raw\udc00')).toThrow('Unicode')
})
it('segments complete legacy text without inventing a semantic summary or losing the trailing body',()=>{
 const body='简短结论\n\n'+ '连续的完整内容。'.repeat(900)+'末尾标记'
 const result=textPresentation(body)
 expect(result.summary).toBe('简短结论')
 expect(result.sections.map(section=>section.body).join('')).toBe(body)
 expect(ResultPresentationSchema.safeParse(result).success).toBe(true)
 const maximum=textPresentation('x'.repeat(MAX_TASK_RESULT_TEXT))
 expect(maximum.sections).toEqual([]) // original text remains the full-body fallback, no partial section masquerades as complete
 expect(()=>textPresentation('x'.repeat(MAX_TASK_RESULT_TEXT+1))).toThrow('bounded complete-body')
 expect(legacyTaskResultPreview('x'.repeat(MAX_TASK_RESULT_TEXT)).length).toBe(1200)
 expect(legacyTaskResultPreview('旧客户端短结果')).toBe('旧客户端短结果')
})
