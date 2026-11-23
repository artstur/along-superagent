/** Product text only. Display structure never grants task, source or execution authority. */
import { z } from 'zod'
import type { Recommendation } from './recommendation.ts'
import { productTextPrefix,wellFormedProductText } from './product-text.ts'

export const MAX_TASK_RESULT_TEXT = 16000
const line = (max: number) => z.string().trim().min(1).max(max).refine(wellFormedProductText,'Product text contains an incomplete Unicode surrogate')
export const ResultPresentationSchema = z.object({
  version: z.literal(1),
  title: line(120),
  summary: line(360),
  actions: z.array(z.object({ text: line(240), when: line(120).optional() }).strict()).max(5),
  sections: z.array(z.object({ heading: line(80), body: line(8000) }).strict()).max(6),
}).strict().refine(value => value.title.length + value.summary.length +
  value.actions.reduce((n, action) => n + action.text.length + (action.when?.length ?? 0), 0) +
  value.sections.reduce((n, section) => n + section.heading.length + section.body.length, 0) <= MAX_TASK_RESULT_TEXT,
  'Complete presentation must remain within 16000 characters')
export type ResultPresentation = z.infer<typeof ResultPresentationSchema>
/** Old clients parse message.text at <=2000. Preserve their tighter historical 1200 preview boundary. */
export function legacyTaskResultPreview(text:string):string {
  if(!wellFormedProductText(text))throw new Error('Product text contains an incomplete Unicode surrogate')
  if(text.length<=1200)return text
  const label='结果预览（完整内容见新版任务详情）\n'
  return label+productTextPrefix(text,1200-label.length-1)+'…'
}

/** Deterministic segmentation preserves the full body instead of summarizing or silently truncating it. */
export function textPresentation(text: string, title = '执行结果'): ResultPresentation {
  const body = text.trim()
  if (!body || body.length > MAX_TASK_RESULT_TEXT || !wellFormedProductText(body)) throw new Error('task result text is outside the bounded complete-body limit or has incomplete Unicode')
  const first = body.split(/\n\s*\n|\n/, 1)[0]!
  // A labelled preview is not a claim to have semantically summarized the complete body.
  const summary = first.length <= 360 ? first : productTextPrefix(first,359) + '…'
  const sections = []
  for (let offset = 0; offset < body.length;) {
    const chunk=productTextPrefix(body.slice(offset),7800)
    sections.push({ heading: offset ? '完整内容（续）' : '完整内容', body: chunk });offset+=chunk.length
  }
  // Text itself is the separately persisted complete body; duplicating it in sections is optional when
  // the extra labels exceed the display budget. The client must retain its existing full-body fallback.
  const result = { version: 1 as const, title, summary, actions: [], sections }
  return ResultPresentationSchema.safeParse(result).success ? result : { version: 1, title, summary, actions: [], sections: [] }
}

/** Verified recommendation remains the authority; model presentation cannot upgrade risks or facts. */
export function recommendationPresentation(value: Recommendation): ResultPresentation {
  const title=productTextPrefix(value.title,120)
  const summary = value.summary.length <= 360 ? productTextPrefix(value.summary,360) : productTextPrefix(value.summary,359) + '…'
  const sections = value.options.map(option => ({
    heading: productTextPrefix(option.title,80),
    body: [option.status === 'excluded' ? '暂不安排' : option.status === 'conditional' ? '条件待核实' : '已核对当前依据',
      option.reason, ...option.facts.map(fact => `${fact.label}：${fact.value}`),
      ...option.conditions.map(text => `条件：${text}`), ...option.unknowns.map(text => `待核实：${text}`)].join('\n')
  }))
  const result = { version: 1 as const, title, summary,
    actions: value.nextStep.length <= 240 ? [{ text: value.nextStep }] : [], sections }
  // Canonical recommendation is also synced in full; never substitute an unverified projection.
  return ResultPresentationSchema.safeParse(result).success ? result : { version: 1, title, summary, actions: [], sections: [] }
}
