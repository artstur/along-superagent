/** One civil-time occurrence each local day. During a DST gap move forward by the gap;
 * in an overlap use the earlier instant. Skip missed days after a host outage. */
export function nextDailyTime(original: string, zone: string, now: number, wallTime = original): string {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const civil = (instant: number) => {
    const p = Object.fromEntries(fmt.formatToParts(instant).map(({ type, value }) => [type, Number(value)]))
    return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!)
  }
  const day = 86_400_000
  const local = civil(Date.parse(original)), time = civil(Date.parse(wallTime)) % day
  let date = Math.max(Math.floor(local / day) + 1, Math.floor(civil(now) / day))
  for (;;) {
    const target = date * day + time
    const offsets = [-day, day].map(delta => civil(target + delta) - (target + delta))
    const candidates = [...new Set(offsets)].map(offset => target - offset)
      .filter(instant => civil(instant) >= target).sort((a, b) => civil(a) - civil(b) || a - b)
    if (candidates[0] !== undefined && candidates[0] > now) return new Date(candidates[0]).toISOString()
    date++
  }
}

/** The Worker identifies the mandate semantically. Require explicit daily language in the cited
 * original user instruction too: a daily goal metric alone never establishes a daily notification. */
export function hasDailyMandate(text: string): boolean {
  const clauses = text.split(/[。！？!?;；\n]/)
  return clauses.some(clause => /每日|每天|每晚|每早|每晨|daily|every (?:day|morning|night|evening)/i.test(clause)
    && /提醒|安排|续排|推荐|通知|叫我|到点|督促|推送|remind|schedul|recommend|notif|alert/i.test(clause)
    && !/别|不要|不用|仅一次|只提醒一次|只[要在限]?[今这]天|one.off|just once|取消|停止|不必|无需|不想|假如|如果|假设|例如|举例|是否|要不要|don't|do not|stop|cancel|what if|for example|if I/i.test(clause))
}
