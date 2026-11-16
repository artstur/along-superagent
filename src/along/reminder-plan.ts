import { z } from 'zod'
import { hasDailyMandate } from './task-schedule.ts'
import type { MessageRow } from './store.ts'

const explanation = z.string().trim().min(2).max(240)
export const PLAN = z.discriminatedUnion('state', [
  z.object({ state:z.literal('scheduled'), source:z.enum(['agent','user']), explanation,
    evidence:z.string().trim().min(2).max(300).optional().describe('Exact text from this user message for a user-specified clock.'),
    action:z.string().trim().min(2).max(100).optional().describe('User-specified clock or recurring: identifying task action appearing in both the quoted clause and task content.'),
  }).strict(),
  z.object({ state:z.literal('needs_time'), question:explanation }).strict(),
  z.object({ state:z.literal('off'), reason:z.enum(['opt_out','untimed']) }).strict(),
])
export type PlanInput = z.infer<typeof PLAN>
export type Repeat = 'once'|'daily'|'weekly'
export type ReminderPlan = Exclude<PlanInput,{state:'scheduled'}> |
  {state:'scheduled'; source:'agent'|'user'; explanation:string; repeat:Repeat; weekday?:number}

export function localWeekday(date: string, zone:string):number {
  const day=new Intl.DateTimeFormat('en-US',{timeZone:zone,weekday:'short'}).format(new Date(date))
  return ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(day)+1
}
const weekDay = /(?:星期|礼拜|周)([一二三四五六日天])/g
const denial = /不要|不必|禁止|不用|勿|别|无需|取消|停止|不想|如果|假设|是否|要不要|只(?:需|要)?(?:这|今|本)周|仅(?:这|本)周|一次性|只提醒一次|do not|don't|never|if |once/i
const weekLabel = (s:string) => '一二三四五六日'.indexOf(s==='天'?'日':s)+1

export function supportsRecurrence(message:string,quote:string,action:string,content:string,repeat:Repeat,weekday:number):boolean {
  if (!message.includes(quote) || !content.includes(action) || !quote.includes(action) ||
    /[，,。；;!?！？\n]/.test(quote) || /^(?:提醒|安排|预约|预订|通知|推荐|完成|进行|执行|打卡)$/.test(action)) return false
  // Validate the full source clause, even if the Worker truncated a leading negation from its quote.
  const clause=message.split(/[，,。；;!?！？\n]/).find(c=>c.includes(quote))
  if (!clause || denial.test(clause.split(action)[0]!)) return false
  if (repeat==='daily') return hasDailyMandate(clause)
  const prefix=clause.slice(0,clause.indexOf(action))
  if (!/每(?:个)?(?:星期|礼拜|周)|每逢(?:周|星期)|\b(?:weekly|every)\b/i.test(prefix)) return false
  // The day after “book” is the activity day. Only a weekday preceding the actual booking action can authorize a reminder.
  const days=[...prefix.matchAll(weekDay)].map(m=>weekLabel(m[1]!))
  const en=['monday','tuesday','wednesday','thursday','friday','saturday','sunday']
  for (const [i,word] of en.entries()) if (new RegExp('\\b'+word+'\\b','i').test(prefix)) days.push(i+1)
  return days.includes(weekday)
}

function number(text:string):number {
  if (/^\d+$/.test(text)) return Number(text)
  const n=(s:string)=>'零一二三四五六七八九'.indexOf(s.replace('两','二'))
  const [a,b]=text.split('十')
  return b===undefined ? n(text) : (a?n(a):1)*10+(b?n(b):0)
}
function clockInQuote(quote:string,time:string,zone:string):boolean {
  const fields=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(time))
  const [h,m]=fields.split(':').map(Number)
  const clocks=quote.match(/\d{1,2}[:：]\d{2}|[零一二两三四五六七八九十\d]+[点时]/g)??[]
  if (clocks.length!==1 || (quote.match(/提醒|叫我|通知|闹钟|remind|alert|notif/gi)??[]).length!==1) return false
  for (const r of quote.matchAll(/(?:^|[^\d])(\d{1,2})[:：](\d{2})(?!\d)/g)) if (Number(r[1])===h && Number(r[2])===m) return true
  for (const r of quote.matchAll(/(凌晨|早上|上午|中午|下午|傍晚|晚上|晚间|晚)?\s*([零一二两三四五六七八九十\d]+)[点时](?:([零一二两三四五六七八九十\d]+)分|(半))?/g)) {
    let hour=number(r[2]!)
    if (/下午|傍晚|晚|中午/.test(r[1]??'') && hour<12) hour+=12
    if (r[1]==='凌晨' && hour===12) hour=0
    if (hour===h && (r[4]?30:r[3]?number(r[3]):0)===m) return true
  }
  return false
}
export function planError(plan:PlanInput,time:string|null|undefined,repeat:Repeat,content:string,message:MessageRow|undefined):string|undefined {
  if (plan.state!=='scheduled') return time || repeat!=='once' ? 'inactive_plan_has_schedule' : undefined
  if (!message?.timezone || !time || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/i.test(time) ||
    !Number.isFinite(Date.parse(time)) || Date.parse(time)<=Date.now()) return 'future_reminder_and_user_timezone_required'
  try {localWeekday(time,message.timezone)} catch {return 'invalid_timezone'}
  const quote=plan.evidence
  if (plan.source==='user' && (!quote || !message.text.includes(quote) || /[，,。；;!?！？\n]/.test(quote) ||
    !plan.action || !quote.includes(plan.action) || !content.includes(plan.action) || /^(?:提醒|安排|预约|通知|完成|进行)$/.test(plan.action) || !/提醒|叫我|通知|闹钟|remind|alert|notif/i.test(quote) ||
    /[点时](?:前|之前|以前)|\d[:：]\d\d\s*(?:前|之前|以前)|deadline|due by/i.test(quote) || !clockInQuote(quote,time,message.timezone))) return 'user_clock_evidence_required'
  if (repeat!=='once' && (!quote || !plan.action || !supportsRecurrence(message.text,quote,plan.action,content,repeat,localWeekday(time,message.timezone)))) return 'task_scoped_repeat_evidence_required'
  return undefined
}
export function publicPlan(plan:PlanInput,repeat:Repeat,weekday?:number):ReminderPlan {
  if (plan.state!=='scheduled') return plan
  return {state:plan.state,source:plan.source,explanation:plan.explanation,repeat,...(repeat==='weekly'?{weekday}:{})}
}

/** A declined notification is never turned back on by an unrelated edit. A task-specific opt-out
 * coexisting with an affirmative instruction for another task is checked against the quoted action. */
export function declinesReminder(text:string,content:string):boolean {
  const clauses=text.split(/[，,。；;!?！？\n]/).map(c=>c.trim()).filter(Boolean)
  return clauses.some(clause=>{
    const m=/(?:不要|不用|不必|禁止|勿|别|无需|取消|停止|关闭|不想|不要再|不再|不需要)(?:再|给我|向我|任何|所有|这项|该任务|这条|的|发|推送|一切|系统|为我|设|设置|安排|任何的|任务)*\s*(?:提醒|通知|闹钟)|(?:do not|don't|stop|disable|no)\s+(?:any\s+)?(?:remind|notif|alert)/i.exec(clause)
    if (!m) return false
    const subject=clause.slice(0,m.index).replace(/^[将把给对为]|的$/g,'').trim()
    const target=clause.slice(m.index+m[0].length).replace(/^(?:我|有关|关于|去|做|的|这条|这项|这个任务|这件事|了)+/,'').trim()
    if (subject && content.includes(subject) || target && content.includes(target)) return true
    if (subject.length<=2 && target.length<=1) return true
    return clauses.length===1
  })
}
