import { z } from 'zod'
import { hasDailyMandate } from './task-schedule.ts'
import type { MessageRow } from './store.ts'

const explanation = z.string().trim().min(2).max(240)
export const PLAN = z.discriminatedUnion('state', [
  z.object({ state:z.literal('scheduled'), source:z.enum(['agent','user']).describe('Only agent or user. Never manual, explicit or system.'), explanation:explanation.describe('Required plain-language reason. Mentioning weekly here does not set recurrence; set fields.repeat separately.'),
    evidence:z.string().trim().min(2).max(300).optional().describe('Exact text from this user message for a user-specified clock.'),
    action:z.string().trim().min(2).max(100).optional().describe('User-specified clock or recurring: identifying task action appearing in both the quoted clause and task content.'),
    evidence_event_id:z.string().min(1).max(96).optional().describe('Optional original accepted user instruction already linked to this goal. Background repair may cite it; it grants no new user message or permission.'),
  }).strict(),
  z.object({ state:z.literal('needs_time'), question:explanation }).strict(),
  z.object({ state:z.literal('off'), reason:z.enum(['opt_out','untimed']) }).strict(),
])
export type PlanInput = z.infer<typeof PLAN>
export type Repeat = 'once'|'daily'|'weekly'
export type ReminderPlan = Exclude<PlanInput,{state:'scheduled'}> |
  {state:'scheduled'; source:'agent'|'user'; explanation:string; repeat:Repeat; weekday?:number; timezone?:string; wallTime?:string}

export function localWeekday(date: string, zone:string):number {
  const day=new Intl.DateTimeFormat('en-US',{timeZone:zone,weekday:'short'}).format(new Date(date))
  return ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(day)+1
}
const weekDay = /(?:星期|礼拜|周)([一二三四五六日天])/g
const denial = /不要|不必|禁止|不用|勿|别|无需|取消|停止|不想|如果|假设|是否|要不要|只(?:需|要)?(?:这|今|本)周|仅(?:这|本)周|一次性|只提醒一次|do not|don't|never|if |once/i
const weekLabel = (s:string) => '一二三四五六日'.indexOf(s==='天'?'日':s)+1

const clauses = (text: string) => text.split(/[，,。；;!?！？\n]/).map(value => value.trim()).filter(Boolean)
const weekdays = (text: string) => [...text.matchAll(weekDay)].map(match => weekLabel(match[1]!))
const genericAction = /^(?:提醒|安排|预约|预订|通知|推荐|完成|进行|执行|打卡)$/

// An explicit delegation of the plan's reminders can follow the list of activities. The original
// action, its own recurrence and its own weekday still have to match separately for each task.
function delegatesPlan(message: string): boolean {
  return clauses(message).some(clause => !denial.test(clause) &&
    /^(?:(?:请|麻烦|希望|需要|可以)?(?:你|帮我|你帮我|给我|你来|为我)*)?(?:安排|编排|规划|设置)(?:(?:上面|以上|上述|这些|这几项|所有|我的|的)*)(?:(?:任务|事项|行动)(?:和|及|与|的))?提醒(?:时间|时刻)?[吧啊呀]?$/u.test(clause))
}
function mentionsAction(content: string, quote: string, action: string): boolean {
  const normalize=(text:string)=>text.replace(/(收拾|整理|检查|准备|清点|归还|收集)完(?=[\p{Script=Han}])/gu,'$1')
  return !genericAction.test(action) && normalize(quote).includes(normalize(action)) && normalize(content).includes(normalize(action))
}
function precedingBookingDay(message: string, quote: string, action: string, content: string, weekday: number): boolean {
  // Restrict this offset to the explicit course sentence and its adjacent booking clause.
  for (const sentence of message.split(/[。；;!?！？\n]/)) {
    if (!sentence.includes(quote) || denial.test(sentence)) continue
    const match=/(每(?:个)?(?:周|星期|礼拜).{0,45}?)(?:上|参加)([^，,。；;]{1,30}?(?:课|训练|练习))\s*[，,]\s*(?:课程?|上课)?(?:的)?前一天(?:需要|要|得|提前|必须|先|记得|帮我|提醒我|去)*(?:预约|预订)/u.exec(sentence)
    if (!match || ![match[2]!, '预约'+match[2], '预订'+match[2]].includes(action) || !quote.includes(match[2]!) || !/(?:预约|预订)/u.test(quote) || !content.includes(match[2]!)) continue
    const activityDay=weekday % 7 + 1
    const dayText=content.split(/预约|预订/u)[1]
    if (dayText && weekdays(dayText).length===1 && weekdays(dayText)[0]===activityDay && weekdays(match[1]!).includes(activityDay)) return true
  }
  return false
}
export function singleOccurrence(message: string, content: string, action: string):boolean {
  const once = /(?:仅|只)(?:需要|要|需)?(?:这次|此次|本次|提醒这次|提醒一次|一次)|一次性|just once|only once|one.off/i
  return clauses(message).some(clause => {
    const limit = once.exec(clause)
    if (!limit) return false
    const subject = clause.slice(0,limit.index).replace(/^(?:但|但是|不过|这次|本次|此次|这项|这个任务|这些|我|都|请)+/,'').trim()
    return !subject || content.includes(subject) || clause.includes(action)
  })
}
export function supportsRecurrence(message:string,quote:string,action:string,content:string,repeat:Repeat,weekday:number):boolean {
  if (!message.includes(quote) || declinesReminder(message,content) || singleOccurrence(message,content,action)) return false
  const delegated=delegatesPlan(message)
  // An ongoing goal may delegate a habitual activity without spelling “every” before every weekday.
  // Validate the cited activity/offset relationship, rather than assuming any weekday is recurring.
  const activity=action.replace(/^(?:预约|预订|预定)\s*/u,'')
  if(repeat==='weekly'&&!denial.test(quote)&&!!activity&&!genericAction.test(activity)&&quote.includes(activity)&&content.includes(activity)
    && /保持|长期|持续|生活方式|每(?:个)?周|养成/.test(message)
    && new Set(weekdays(quote)).size>=2&&/前一天(?:需要|要|得|提前|必须|先|记得|帮我|提醒我|去)*(?:预约|预订)/.test(quote)) {
    const booking=/(?:预约|预订)/.exec(content),activityDay=weekday%7+1
    const beforeDays=booking?weekdays(content.slice(0,booking.index)):[]
    if(booking&&(!beforeDays.length||beforeDays.includes(weekday))
      &&weekdays(content.slice(booking.index+booking[0].length)).includes(activityDay)&&weekdays(quote).includes(activityDay))return true
  }
  if (repeat==='weekly' && delegated && precedingBookingDay(message,quote,action,content,weekday)) return true
  if (!mentionsAction(content,quote,action)) return false
  const clause=clauses(message).find(value=>value.includes(quote)) ?? (repeat==='daily'&&clauses(quote).some(value=>
    value.includes(action)&&/每日|每天|每晚|每早|每晨|\bevery day\b|\bdaily\b/i.test(value)&&!denial.test(value))?quote:undefined)
  if (!clause || denial.test(clause.split(/提醒|安排|通知|想要|需要/)[0]!)) return false
  if (repeat==='daily') return hasDailyMandate(clause) ||
    /每日|每天|每晚|每早|每晨|\bevery day\b|\bdaily\b/i.test(quote) && !denial.test(clause)
  const actionStart=clause.indexOf(action)
  // A short activity name can occur after the activity's own weekday. Bound the mandate
  // at the booking verb so that date never becomes a reminder-day authorization.
  const booking=/(?:预约|预订|预定|\b(?:book|reserve)(?:ing)?\b)/i.exec(clause)
  const prefix=clause.slice(0,booking && booking.index<actionStart ? booking.index : actionStart)
  if (!/每(?:个)?(?:星期|礼拜|周)|每逢(?:周|星期)|\b(?:weekly|every)\b/i.test(prefix)) return false
  // The day after “book” is the activity day. An explicit weekly appointment or delegated
  // reminder on the weekday before that action can establish the continuing schedule.
  // An explicit imperative to add a weekly action is a continuing mandate, even without a reminder verb.
  // Require the quoted instruction itself and a command boundary; reported examples and narratives grant nothing.
  const addition = /^(?:请)?补上每(?:个)?(?:周|星期|礼拜)/u.test(quote)
    && /(?:^|[:：])(?:请)?补上每(?:个)?(?:周|星期|礼拜)/u.test(clause)
    && !/比如|例如|示例|举例|他说|她说|提到|引用|听说/u.test(clause)
  if (!delegated && !addition && !/提醒|通知|安排|预约|预订|叫我|帮我.*(?:搜索|研究|核查|计算|分析|推荐)|remind|schedule|book/i.test(clause)) return false
  // A cadence directly qualified by weekdays (every Monday / 每周一和周四) takes
  // precedence over later dates qualifying the activity, including postposed bookings.
  const cadence=/(?:每(?:个)?(?:周|星期|礼拜)|每逢(?:周|星期))([一二三四五六日天](?:\s*(?:和|及|与|、|&|\/)\s*(?:(?:周|星期|礼拜))?[一二三四五六日天])*)/u.exec(prefix)
  const en=['monday','tuesday','wednesday','thursday','friday','saturday','sunday']
  const enCadence=new RegExp('\\bevery\\s+((?:'+en.join('|')+')(?:\\s*(?:and|&|,)\\s*(?:'+en.join('|')+'))*)','i').exec(prefix)
  const days=cadence ? [...cadence[1]!].filter(c=>'一二三四五六日天'.includes(c)).map(weekLabel) : enCadence ? [] : weekdays(prefix)
  for (const [i,word] of en.entries()) if (new RegExp('\\b'+word+'\\b','i').test(enCadence?.[1]??(cadence?'':prefix))) days.push(i+1)
  return days.includes(weekday)
}

function number(text:string):number {
  if (/^\d+$/.test(text)) return Number(text)
  const n=(s:string)=>'零一二三四五六七八九'.indexOf(s.replace('两','二'))
  const [a,b]=text.split('十')
  return b===undefined ? n(text) : (a?n(a):1)*10+(b?n(b):0)
}
function clockInQuote(quote:string,time:string,zone:string,action:string,agentExecution=false):boolean {
  const directlyReminds = (matched: RegExpMatchArray) => {
    const after = quote.slice(matched.index!+matched[0].length)
    if(agentExecution&&after.trimStart().replace(/^(?:(?:请|麻烦|你|帮我|为我|替我)\s*)+/u,'').startsWith(action))return true
    const instruction = /^\s*(?:整|钟|的时候)?\s*(?:请|要|记得)?(?:提醒|叫|通知)(?:一下)?(?:我|本人)?(?:去|要|把|先)?/u.exec(after)
    if (instruction) return after.slice(instruction[0].length).startsWith(action)
    return /\bremind me (?:at|on)\s*$/i.test(quote.slice(0,matched.index!+1)) &&
      after.trimStart().replace(/^to /i,'').startsWith(action)
  }
  const fields=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(time))
  const [h,m]=fields.split(':').map(Number)
  const clocks=quote.match(/\d{1,2}[:：]\d{2}|[零一二两三四五六七八九十\d]+[点时]/g)??[]
  if (clocks.length!==1 || !agentExecution&&(quote.match(/提醒|叫我|通知|闹钟|remind|alert|notif/gi)??[]).length!==1) return false
  for (const r of quote.matchAll(/(?:^|[^\d])(\d{1,2})[:：](\d{2})(?!\d)/g)) if (Number(r[1])===h && Number(r[2])===m && directlyReminds(r)) return true
  for (const r of quote.matchAll(/(凌晨|早上|上午|中午|下午|傍晚|晚上|晚间|晚)?\s*([零一二两三四五六七八九十\d]+)[点时](?:([零一二两三四五六七八九十\d]+)分|(半))?/g)) {
    let hour=number(r[2]!)
    if (/下午|傍晚|晚|中午/.test(r[1]??'') && hour<12) hour+=12
    if (r[1]==='凌晨' && hour===12) hour=0
    if (hour===h && (r[4]?30:r[3]?number(r[3]):0)===m && directlyReminds(r)) return true
  }
  return false
}
function sameSpecifiedDay(quote:string,action:string,time:string,message:MessageRow):boolean {
  const zone=message.timezone!
  const civil=(instant:string)=>new Intl.DateTimeFormat('sv-SE',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(instant))
  const qualifier=quote.slice(0,quote.indexOf(action))
  const appointed=civil(time)
  const date=/\b(\d{4}-\d\d-\d\d)\b/.exec(qualifier)
  if (date && date[1]!==appointed) return false
  const relative=/今天|今日|明天|明日|后天|today|tomorrow/i.exec(qualifier)?.[0]
  if (relative) {
    const offset=/后天/.test(relative)?2:/明天|明日|tomorrow/i.test(relative)?1:0
    const day=Date.parse(civil(message.occurredAt??message.receivedAt)+'T00:00:00Z')+offset*86400000
    if (new Date(day).toISOString().slice(0,10)!==appointed) return false
  }
  const selectedDays=weekdays(qualifier)
  return !selectedDays.length || selectedDays.includes(localWeekday(time,zone))
}
export function planError(plan:PlanInput,time:string|null|undefined,repeat:Repeat,content:string,message:MessageRow|undefined,agentExecution=false):string|undefined {
  if (plan.state!=='scheduled') return time || repeat!=='once' ? 'inactive_plan_has_schedule' : undefined
  if (!message?.timezone || !time || !z.iso.datetime({offset:true}).safeParse(time).success ||
    !Number.isFinite(Date.parse(time)) || Date.parse(time)<=Date.now()) return 'future_reminder_and_user_timezone_required'
  try {localWeekday(time,message.timezone)} catch {return 'invalid_timezone'}
  const quote=plan.evidence
  if (plan.source==='user' && (!quote || !message.text.includes(quote) || /[，,。；;!?！？\n]/.test(quote) ||
    !plan.action || !quote.includes(plan.action) || !content.includes(plan.action) || /^(?:提醒|安排|预约|通知|完成|进行)$/.test(plan.action) || !agentExecution&&!/提醒|叫我|通知|闹钟|remind|alert|notif/i.test(quote) ||
    /[点时](?:前|之前|以前)|\d[:：]\d\d\s*(?:前|之前|以前)|deadline|due by/i.test(quote) || !clockInQuote(quote,time,message.timezone,plan.action,agentExecution) || !sameSpecifiedDay(quote,plan.action,time,message))) return 'user_clock_evidence_required'
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
  const parts = clauses(text)
  return parts.some(clause => {
    const notify = /提醒|闹钟|通知|remind|notif|alert/i.exec(clause)
    if (!notify) return false
    const before = clause.slice(0,notify.index)
    const after = clause.slice(notify.index+notify[0].length)
    const negative = /不要|不用|不必|禁止|勿|别|无需|取消|停止|关闭|撤销|不想|不再|不需要|do not|don't|stop|disable|never|no /i
    const trailing = /(?:的?(?:安排|通知|提醒|闹钟|计划))?(?:已)?(?:取消|停止|关闭|撤销|不需要|不用|不要)了?$/i.exec(after)
    const prefix = negative.exec(before)
    if (!prefix && !trailing) return false
    if (!trailing && /(?:别|勿|不要)(?:太|过)(?:早|晚)(?:地)?$/.test(before)) return false
    const target = (trailing ? after.slice(0,trailing.index) : after)
      .replace(/^(?:我|本人|有关|关于|去|做|的|这条|这项|这个任务|这件事|了|\s)+/,'').trim()
    const subject = before.replace(/.*(?:取消|关闭|撤销|禁止|停止|不要|不用|别)/,'')
      .replace(/^(?:将|把|给|对|为)|的$/g,'').trim()
    if (target && content.includes(target) || subject && content.includes(subject)) return true
    // Bare opt-outs apply globally. A named subject in another clause applies to that subject.
    if (!target && (!subject || /^(?:再|给我|任何|全部|所有|任务|所有任务|一切|为我|系统|发|发送|推送|设置|安排|其它|其他)*$/.test(subject))) return true
    return parts.length === 1
  })
}
