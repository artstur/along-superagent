/** Stage-D governance acceptance uses real SQLite/reopens, with a deliberately untrusted memory backend. */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AlongStore } from '../src/along/store.ts'
import { MemoryService } from '../src/along/memory/service.ts'
import { memoryTools } from '../src/along/memory/tools.ts'
import type { ExtractionInput, ExtractionResult, MemoryBackend, MemoryCandidate } from '../src/along/memory/model.ts'

const USER = 'u_memory', OTHER = 'u_other', GOAL = 'g_memory', SECOND = 'g_second'
let dir: string, path: string, store: AlongStore, service: MemoryService, backend: MemoryBackend
let response: (input: ExtractionInput) => ExtractionResult | Promise<ExtractionResult>
let serial: number
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'along-memory-')); path = join(dir, 'along.sqlite'); store = new AlongStore(path); serial = 0
  store.assertUser(USER, 'd_memory'); store.assertUser(OTHER, 'd_other')
  store.insertGoal({ userId: USER, goalId: GOAL, domain: 'health' })
  store.insertGoal({ userId: USER, goalId: SECOND, domain: 'health' })
  response = input => ({ requestId: `request-${input.attemptId}`, backendIds: ['sdk-node'],
    candidates: input.sources.map(source => candidate(source.id, source.text)) })
  backend = { extract: vi.fn(input => Promise.resolve(response(input))), search: vi.fn(async () => ['sdk-node']),
    clearUser: vi.fn(async () => {}), close: vi.fn(async () => {}) }
  service = new MemoryService(store, backend)
})
afterEach(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }) })

function message(text = '以后尽量安排在晚饭前运动', goalId?: string, userId = USER) {
  const row = store.appendMessage({ userId, eventId: `e_${serial++}`, role: 'user', direction: 'inbound', text })
  if (goalId) store.linkMessageToGoals(row.id, [goalId], 'direct')
  return row
}
function candidate(id: string, quote: string, extra: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return { quote, topic: '运动时间偏好', category: 'preference', assertion: 'explicit', sourceMessageIds: [id],
    replaces: [], conflictsWith: [], backendIds: ['sdk-node'], ...extra }
}
const effective = () => store.memory.effective(USER)

describe('long-term memory evidence and scope (BC-04-01..07/13)', () => {
  it('promotes an explicit preference with original evidence and stable revision; retries are idle', async () => {
    const source = message()
    expect(await service.runBatch(USER)).toMatchObject({ processed: 1, saved: 1, status: 'done' })
    expect(effective()).toEqual([expect.objectContaining({ content: source.text, status: 'active', revision: 1, sourceMessageIds: [source.id] })])
    expect(await service.runBatch(USER)).toMatchObject({ status: 'idle' })
    expect(backend.extract).toHaveBeenCalledTimes(1)
    const read = await service.search({ userId: USER, goalId: SECOND }, '什么时候运动')
    expect(read).toMatchObject({ degraded: false, memories: [{ content: source.text }] })
    expect(store.memory.attempts(USER)).toEqual([expect.objectContaining({ status: 'done', requestId: expect.stringContaining('request-') })])
  })
  it.each([
    ['今天改到晚饭前', 'temporary', 'explicit'],
    ['这次训练每周最多三次', 'goal_constraint', 'explicit'],
    ['朋友说他喜欢晨跑', 'preference', 'quoted'],
    ['如果我喜欢晨跑就好了', 'preference', 'hypothetical'],
    ['我不喜欢晨跑', 'preference', 'negated'],
    ['可能我喜欢晨跑', 'preference', 'inferred'],
  ] as const)('withholds %s from effective facts', async (text, category, assertion) => {
    const source = message(text, GOAL)
    response = () => ({ backendIds: ['sdk-node'], candidates: [candidate(source.id, text, { category, assertion })] })
    expect((await service.runBatch(USER)).status).toBe('done')
    expect(effective()).toEqual([])
    if (category === 'preference') expect(store.memory.memories(USER)[0]?.status).toBe('candidate')
    else expect(store.memory.memories(USER)).toHaveLength(0)
  })
  it('never feeds assistant suggestions, task feedback or health summaries into extraction', async () => {
    store.appendMessage({ userId: USER, eventId: 'e_assistant', role: 'assistant', direction: 'outbound', text: '建议晚上跑步' })
    for (const [eventId, eventType] of [['e_health', 'along.health_summary_updated'], ['e_task', 'along.message']]) {
      store.appendMessage({ userId: USER, eventId: eventId!, role: 'user', direction: 'inbound', text: '步数 10000' })
      store.saveInboxEvent({ userId: USER, eventId: eventId!, schemaVersion: '1', eventType: eventType!, deviceId: 'd_memory',
        receivedAt: new Date().toISOString(), payload: {}, payloadHash: 'health', status: 'accepted' })
    }
    expect(await service.runBatch(USER)).toMatchObject({ status: 'idle' })
    expect(backend.extract).not.toHaveBeenCalled()
  })
  it('does not let source ownership, invented quotes or SDK refs be asserted by the model', async () => {
    const source = message(), foreign = message('别人偏好', undefined, OTHER)
    response = () => ({ backendIds: ['sdk-node'], candidates: [candidate(foreign.id, foreign.text), candidate(source.id, '原文不存在的偏好')] })
    expect((await service.runBatch(USER)).status).toBe('done')
    expect(effective()).toHaveLength(0)
    message('另一个偏好')
    response = input => ({ backendIds: [], candidates: [candidate(input.sources[0]!.id, input.sources[0]!.text)] })
    expect((await service.runBatch(USER)).status).toBe('pending')
    expect(effective()).toHaveLength(0)
  })
  it('respects goal scope and refuses unlinked/foreign scopes before contacting the SDK', async () => {
    const source = message('在这个长期目标中我只做低冲击训练', GOAL)
    response = () => ({ backendIds: ['sdk-node'], candidates: [candidate(source.id, source.text, { category: 'fact', goalId: GOAL })] })
    await service.runBatch(USER)
    expect((await service.search({ userId: USER, goalId: GOAL }, '训练')).memories).toHaveLength(1)
    expect((await service.search({ userId: USER, goalId: SECOND }, '训练')).memories).toHaveLength(0)
    expect((await service.search({ userId: USER }, '训练')).memories).toHaveLength(0)
    await expect(service.search({ userId: OTHER, goalId: GOAL }, '训练')).rejects.toThrow('not found')
    expect(() => service.forget({ userId: USER, goalId: SECOND }, store.memory.memories(USER)[0]!.id)).toThrow('not found')
  })
  it('requires explicit correction links; unresolved contradictions withhold both versions', async () => {
    message(); await service.runBatch(USER)
    const older = effective()[0]!
    const newer = message('以后都在早上运动')
    response = () => ({ backendIds: ['sdk-node'], candidates: [candidate(newer.id, newer.text, { replaces: [older.id] })] })
    await service.runBatch(USER)
    expect(effective().map(item => item.content)).toEqual([newer.text])
    expect(store.memory.memories(USER).find(item => item.id === older.id)?.status).toBe('superseded')
    message('以后也安排夜跑')
    response = input => ({ backendIds: ['sdk-node'], candidates: input.sources.map(source => candidate(source.id, source.text)) })
    await service.runBatch(USER)
    expect(effective()).toHaveLength(0)
    expect((await service.search({ userId: USER }, '运动')).needsClarification).toBe(true)
    expect(store.memory.memories(USER).filter(item => item.status === 'conflict')).toHaveLength(2)
  })
  it('keeps a foreign replacement target unchanged and does not accept that candidate', async () => {
    const first = message(); await service.runBatch(USER)
    const other = message('其他用户的偏好', undefined, OTHER)
    await service.runBatch(OTHER)
    const foreign = store.memory.effective(OTHER)[0]!
    const source = message('以后早上运动')
    response = () => ({ backendIds: ['sdk-node'], candidates: [candidate(source.id, source.text, { replaces: [foreign.id] })] })
    await service.runBatch(USER)
    expect(effective().map(item => item.content)).toEqual([first.text])
    expect(store.memory.effective(OTHER).map(item => item.content)).toEqual([other.text])
  })
  it('expires valid facts without waiting for another extraction', async () => {
    const source = message()
    response = () => ({ backendIds: ['sdk-node'], candidates: [candidate(source.id, source.text, { expiresAt: '2027-01-01T00:00:00.000Z' })] })
    await service.runBatch(USER)
    expect(store.memory.effective(USER, undefined, Date.parse('2026-11-15T00:00:00Z'))).toHaveLength(1)
    expect(store.memory.effective(USER, undefined, Date.parse('2027-02-01T00:00:00Z'))).toHaveLength(0)
  })
  it.each([undefined, 'replaces', 'conflictsWith'] as const)('does not let an expired fact block fresh evidence with %s links', async link => {
    const start = Date.parse('2030-01-01T00:00:00.000Z'), expiresAt = new Date(start + 1000).toISOString()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start)
    try {
      const older = message('我今年长期住在上海')
      response = () => ({ backendIds: ['sdk-node'], candidates: [candidate(older.id, older.text, { category: 'fact', expiresAt })] })
      await service.runBatch(USER)
      const expired = effective()[0]!
      clock.mockReturnValue(Date.parse(expiresAt))
      expect(effective()).toHaveLength(0)
      const newer = message('我今后长期住在北京')
      response = () => ({ backendIds: ['sdk-node'], candidates: [candidate(newer.id, newer.text,
        { category: 'fact', ...(link ? { [link]: [expired.id] } : {}) })] })
      expect(await service.runBatch(USER)).toMatchObject({ saved: 1, status: 'done' })
      expect(await service.search({ userId: USER }, '常住城市')).toMatchObject({
        memories: [{ content: newer.text, status: 'active' }], needsClarification: false,
      })
      expect(store.memory.memories(USER).find(item => item.id === expired.id)?.status).toBe(link === 'replaces' ? 'superseded' : 'active')
    } finally { clock.mockRestore() }
  })
  it('stops expired conflicts requesting clarification and accepts a later explicit fact', async () => {
    const start = Date.parse('2030-01-01T00:00:00.000Z'), expiresAt = new Date(start + 1000).toISOString()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start)
    try {
      response = input => ({ backendIds: ['sdk-node'], candidates: input.sources.map(source => candidate(source.id, source.text, { expiresAt })) })
      message('以后安排早上运动'); await service.runBatch(USER)
      message('以后也想晚上运动'); await service.runBatch(USER)
      expect((await service.search({ userId: USER }, '运动时间')).needsClarification).toBe(true)
      let release!: (ids: string[]) => void
      vi.mocked(backend.search).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      const lookup = service.search({ userId: USER }, '运动时间')
      clock.mockReturnValue(Date.parse(expiresAt))
      release(['sdk-node'])
      expect(await lookup).toMatchObject({ memories: [], needsClarification: false })
      const current = message('今后都安排中午运动')
      response = () => ({ backendIds: ['sdk-node'], candidates: [candidate(current.id, current.text)] })
      await service.runBatch(USER)
      expect(await service.search({ userId: USER }, '运动时间')).toMatchObject({
        memories: [{ content: current.text, status: 'active' }], needsClarification: false,
      })
      expect(store.memory.memories(USER).filter(item => item.status === 'conflict')).toHaveLength(2)
    } finally { clock.mockRestore() }
  })
})

describe('withdrawal and context (BC-04-08..11/14)', () => {
  it.each([SECOND, undefined])('rebuilds an independent identical quote in scope %s after goal-specific withdrawal', async keptGoal => {
    const quote = '这个长期项目由李老师指导'
    const withdrawnSource = message(quote, GOAL), keptSource = message(quote, keptGoal)
    response = input => ({ backendIds: ['sdk-node'], candidates: input.sources.map(source => candidate(source.id, source.text,
      { category: 'fact', goalId: source.goalIds[0] })) })
    await service.runBatch(USER)
    const before = store.memory.memories(USER)
    const withdrawn = before.find(item => item.sourceMessageIds.includes(withdrawnSource.id))!
    const retained = before.find(item => item.sourceMessageIds.includes(keptSource.id))!
    expect(service.forget({ userId: USER, goalId: GOAL }, withdrawn.id).withdrawnIds).toEqual([withdrawn.id])
    response = input => ({ backendIds: ['rebuilt-node'], candidates: input.sources.map(source => candidate(source.id, source.text,
      { category: 'fact', goalId: source.goalIds[0], backendIds: ['rebuilt-node'] })) })
    vi.mocked(backend.search).mockResolvedValue(['rebuilt-node'])
    expect(await service.runBatch(USER)).toMatchObject({ processed: 1, saved: 1, status: 'done' })
    expect(await service.search({ userId: USER, goalId: keptGoal }, '指导老师')).toMatchObject({
      degraded: false, memories: [{ id: retained.id, content: quote, revision: 1 }],
    })
    expect(store.memory.memories(USER).find(item => item.id === withdrawn.id)?.status).toBe('withdrawn')
    expect(await service.runBatch(USER)).toMatchObject({ status: 'idle' })
    await service.close(); store.close()
    store = new AlongStore(path); service = new MemoryService(store, backend)
    expect(await service.search({ userId: USER, goalId: keptGoal }, '指导老师')).toMatchObject({ memories: [{ id: retained.id }] })
  })
  it.each([GOAL, undefined])('keeps hash suppression in the withdrawn scope %s despite a renamed topic', async goalId => {
    const quote = '我长期只参加低冲击训练'
    const root = message(quote, goalId), duplicate = message(quote, GOAL)
    response = () => ({ backendIds: ['sdk-node'], candidates: [candidate(root.id, quote, { goalId })] })
    await service.runBatch(USER)
    const memory = store.memory.memories(USER)[0]!
    service.forget({ userId: USER, goalId }, memory.id)
    expect(store.memory.suppressed(USER, candidate(duplicate.id, quote, { topic: '换了名字的主题', goalId: GOAL }), duplicate.seq)).toBe(true)
    expect(store.memory.suppressed(USER, candidate(root.id, quote, { topic: '其他主题', goalId: SECOND }), root.seq)).toBe(true)
    const fresh = message(quote, GOAL)
    expect(store.memory.suppressed(USER, candidate(fresh.id, quote, { topic: '换了名字的主题', goalId: GOAL }), fresh.seq)).toBe(false)
  })
  it('keeps SQLite fallback after deletion and failed rebuild, including reopen, until retry succeeds', async () => {
    const withdrawn = message(), kept = message('我长期居住在上海')
    response = input => ({ backendIds: ['sdk-node'], candidates: input.sources.map(source => candidate(source.id, source.text, { topic: source.id })) })
    await service.runBatch(USER)
    const keptBefore = effective().find(item => item.sourceMessageIds.includes(kept.id))!
    service.forget({ userId: USER }, effective().find(item => item.sourceMessageIds.includes(withdrawn.id))!.id)
    vi.mocked(backend.search).mockResolvedValue([])
    vi.mocked(backend.extract).mockRejectedValueOnce(new Error('synthetic rebuild outage'))
    expect(await service.runBatch(USER)).toMatchObject({ status: 'pending' })
    expect(effective()).toEqual([keptBefore])
    expect(await service.search({ userId: USER }, '常住城市')).toMatchObject({ degraded: true, memories: [{ id: keptBefore.id }] })
    await service.close(); store.close()
    store = new AlongStore(path); service = new MemoryService(store, backend)
    expect(await service.search({ userId: USER }, '常住城市')).toMatchObject({ degraded: true, memories: [{ id: keptBefore.id }] })
    expect(backend.search).not.toHaveBeenCalled()
    response = input => ({ backendIds: ['rebuilt-node'], candidates: input.sources.map(source => candidate(source.id, source.text,
      { topic: source.id, backendIds: ['rebuilt-node'] })) })
    vi.mocked(backend.search).mockResolvedValue(['rebuilt-node'])
    expect(await service.runBatch(USER)).toMatchObject({ status: 'done', processed: 1 })
    expect(backend.clearUser).toHaveBeenCalledTimes(1)
    expect(await service.search({ userId: USER }, '常住城市')).toMatchObject({ degraded: false, memories: [{ id: keptBefore.id, revision: 1 }] })
    expect(backend.search).toHaveBeenCalledTimes(1)
  })
  it('keeps all retained SQLite facts available between projection rebuild pages', async () => {
    for (let index = 0; index < 22; index++) message(`独立长期事实 ${index}`)
    response = input => ({ backendIds: ['sdk-node'], candidates: input.sources.map(source => candidate(source.id, source.text, { topic: source.id })) })
    await service.runBatch(USER); await service.runBatch(USER)
    service.forget({ userId: USER }, effective()[0]!.id)
    const projected: string[] = []
    response = input => {
      const backendIds = input.sources.map(source => `rebuilt-${source.id}`)
      projected.push(...backendIds)
      return { backendIds, candidates: input.sources.map((source, index) => candidate(source.id, source.text,
        { topic: source.id, backendIds: [backendIds[index]!] })) }
    }
    vi.mocked(backend.search).mockImplementation(async () => [...projected])
    expect(await service.runBatch(USER)).toMatchObject({ processed: 20, status: 'done' })
    const during = await service.search({ userId: USER }, '长期事实', 50)
    expect(during.degraded).toBe(true); expect(during.memories).toHaveLength(21)
    expect(await service.runBatch(USER)).toMatchObject({ processed: 1, status: 'done' })
    const after = await service.search({ userId: USER }, '长期事实', 50)
    expect(after.degraded).toBe(false); expect(after.memories).toHaveLength(21)
    expect(backend.clearUser).toHaveBeenCalledTimes(1)
  })
  it('finishes an empty projection rebuild without leaving healthy searches degraded', async () => {
    message(); await service.runBatch(USER)
    service.forget({ userId: USER }, effective()[0]!.id)
    vi.mocked(backend.search).mockResolvedValue([])
    expect(await service.runBatch(USER)).toMatchObject({ status: 'idle' })
    expect(await service.search({ userId: USER }, '运动')).toMatchObject({ degraded: false, memories: [] })
    expect(backend.clearUser).toHaveBeenCalledTimes(1)
  })
  it('rechecks projection state when a withdrawal happens during an SDK search', async () => {
    message(); const kept = message('我长期居住在上海')
    response = input => ({ backendIds: ['sdk-node'], candidates: input.sources.map(source => candidate(source.id, source.text, { topic: source.id })) })
    await service.runBatch(USER)
    let release!: (ids: string[]) => void
    vi.mocked(backend.search).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const lookup = service.search({ userId: USER }, '常住城市')
    service.forget({ userId: USER }, effective().find(item => !item.sourceMessageIds.includes(kept.id))!.id)
    release([])
    expect(await lookup).toMatchObject({ degraded: true, memories: [{ content: kept.text }] })
  })
  it('withdraws immediately, preserves history/tasks, filters summaries, survives reopen and blocks old extraction', async () => {
    const source = message(); await service.runBatch(USER)
    const memory = effective()[0]!
    const summary = store.appendMessage({ userId: USER, eventId: 'e_summary', role: 'assistant', direction: 'outbound', text: '用户喜欢晚饭前运动' })
    store.insertTask({ userId: USER, goalId: GOAL, taskId: 't_unchanged', content: '明晚跑步' })
    const counts = store.counts(USER), tasks = store.listTasks(USER).items
    expect(service.forget({ userId: USER }, memory.id).withdrawnIds).toEqual([memory.id])
    expect((await service.search({ userId: USER }, '运动')).memories).toHaveLength(0)
    expect(service.context({ userId: USER }, [source, summary]).messages).toHaveLength(0)
    expect(store.getMessage(USER, source.id)?.text).toBe(source.text)
    expect(store.counts(USER)).toEqual(counts); expect(store.listTasks(USER).items).toEqual(tasks)
    await service.close(); store.close()
    store = new AlongStore(path); service = new MemoryService(store, backend)
    expect(effective()).toHaveLength(0)
    await service.runBatch(USER) // deletes old SDK user projection before any rebuild
    expect(backend.clearUser).toHaveBeenCalledWith(USER)
    expect(store.memory.sources(USER)).not.toContainEqual(expect.objectContaining({ id: source.id }))
    expect(effective()).toHaveLength(0)
    const fresh = message('今天跑了十分钟')
    expect(service.context({ userId: USER }, [source, fresh]).messages).toEqual([fresh])
    expect(service.context({ userId: USER }, [{ ...fresh, text: source.text }]).messages).toEqual([])
  })
  it('does not return an SDK hit withdrawn while search is in flight', async () => {
    message(); await service.runBatch(USER)
    let release!: (ids: string[]) => void
    vi.mocked(backend.search).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const lookup = service.search({ userId: USER }, '运动')
    service.forget({ userId: USER }, effective()[0]!.id)
    release(['sdk-node', 'sdk-profile-never-governed'])
    expect((await lookup).memories).toHaveLength(0)
  })
  it('does not revive old evidence when withdrawal happens during extraction', async () => {
    const source = message(); await service.runBatch(USER)
    const id = effective()[0]!.id
    message('其他长期信息')
    let finish!: (value: ExtractionResult) => void
    response = () => new Promise(resolve => { finish = resolve })
    const batch = service.runBatch(USER)
    service.forget({ userId: USER }, id)
    finish({ backendIds: ['sdk-node'], candidates: [candidate(source.id, source.text)] })
    await batch
    expect(effective()).toHaveLength(0)
  })
  it('retries failed cleanup, preserves another user and allows a new post-withdrawal explicit statement', async () => {
    message(); await service.runBatch(USER)
    service.forget({ userId: USER }, effective()[0]!.id)
    vi.mocked(backend.clearUser).mockRejectedValueOnce(new Error('synthetic failure'))
    expect((await service.runBatch(USER)).status).toBe('pending')
    expect(store.memory.cleanupGeneration(USER)).toBeDefined()
    const other = message('其他用户偏好', undefined, OTHER)
    await service.runBatch(OTHER)
    message('以后还是安排在晚饭前运动')
    expect((await service.runBatch(USER)).status).toBe('done')
    expect(effective()).toHaveLength(1)
    expect(store.memory.effective(OTHER).map(item => item.content)).toEqual([other.text])
    expect(backend.clearUser).not.toHaveBeenCalledWith(OTHER)
  })
  it('rebuilds unaffected memories once without reactivating withdrawals or duplicating effective versions', async () => {
    const first = message(), second = message('我长期居住在上海')
    response = input => ({ backendIds: ['sdk-node'], candidates: input.sources.map(source => candidate(source.id, source.text,
      { topic: source.id === second.id ? '常住城市' : '运动时间偏好' })) })
    await service.runBatch(USER)
    const before = effective().find(item => item.topic === '常住城市')!
    service.forget({ userId: USER }, effective().find(item => item.topic === '运动时间偏好')!.id)
    expect((await service.runBatch(USER)).status).toBe('done')
    expect(effective()).toEqual([expect.objectContaining({ id: before.id, revision: 1, content: second.text })])
    expect(store.memory.sources(USER).map(item => item.id)).not.toContain(first.id)
    expect((await service.runBatch(USER)).status).toBe('idle')
  })
  it('does not resend ungoverned old paraphrases after forgetting; old retained facts rebuild only their governed quote', async () => {
    const first = message(), other = message('我长期居住在上海。顺便说一下以前的一些安排。')
    response = () => ({ backendIds: ['sdk-node'], candidates: [candidate(first.id, first.text),
      candidate(other.id, '我长期居住在上海。', { topic: '常住城市' })] })
    await service.runBatch(USER)
    message('没有进入首次提取证据的旧偏好转述')
    service.forget({ userId: USER }, effective().find(item => item.topic === '运动时间偏好')!.id)
    const rebuild = store.memory.sources(USER)
    expect(rebuild.map(item => item.id)).toEqual([other.id])
    expect(rebuild[0]!.text).toBe('我长期居住在上海。')
  })
})

describe('failure recovery and migrations (BC-04-12, §2.5.4)', () => {
  it('bounds extraction batches at 20 messages and resumes with the next server-ordered page', async () => {
    for (let index = 0; index < 21; index++) message(`长期事实 ${index}`)
    response = input => ({ backendIds: ['sdk-node'], candidates: input.sources.map(source => candidate(source.id, source.text, { topic: source.id })) })
    expect((await service.runBatch(USER)).processed).toBe(20)
    expect((await service.runBatch(USER)).processed).toBe(1)
    expect((await service.runBatch(USER)).status).toBe('idle')
    expect(effective()).toHaveLength(21)
    expect(backend.extract).toHaveBeenCalledTimes(2)
  })
  it('exposes strict tools bound only by the host and refuses missing work scope', async () => {
    message(); await service.runBatch(USER)
    const tools = memoryTools(service, () => ({ userId: USER, goalId: GOAL }))
    const search = tools.find(tool => tool.name === 'along_memory_search')!
    const forget = tools.find(tool => tool.name === 'along_memory_forget')!
    expect(search.schema.safeParse({ query: '偏好', user_id: OTHER }).success).toBe(false)
    expect(forget.schema.safeParse({ memory_id: effective()[0]!.id, goal_id: SECOND }).success).toBe(false)
    const result = await search.execute(search.schema.parse({ query: '偏好' }), new AbortController().signal)
    expect(result).toMatchObject({ memories: [{ userId: USER }] })
    const unbound = memoryTools(service, () => undefined)[0]!
    await expect(unbound.execute({ query: '偏好' }, new AbortController().signal)).rejects.toThrow('host-bound')
  })
  it('falls back to governed SQLite content during SDK failure; unknown SDK summaries never become facts', async () => {
    message(); await service.runBatch(USER)
    vi.mocked(backend.search).mockResolvedValueOnce(['untracked-sdk-summary'])
    expect((await service.search({ userId: USER }, '运动')).memories).toHaveLength(0)
    vi.mocked(backend.search).mockRejectedValueOnce(new Error('secret=must-not-escape'))
    const result = await service.search({ userId: USER }, '运动')
    expect(result).toMatchObject({ degraded: true, memories: [{ status: 'active' }] })
    expect(JSON.stringify(result)).not.toContain('must-not-escape')
  })
  it('preserves SDK request mapping after a local commit failure, then retries the same logical operation once', async () => {
    message()
    const save = vi.spyOn(store.memory, 'save').mockImplementationOnce(() => { throw new Error('local commit failed') })
    expect((await service.runBatch(USER)).status).toBe('pending')
    expect(effective()).toHaveLength(0)
    expect(store.memory.attempts(USER)[0]).toMatchObject({ status: 'failed', requestId: expect.stringContaining('request-') })
    save.mockRestore()
    await service.runBatch(USER)
    const attempts = store.memory.attempts(USER)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]!.operationId).toBe(attempts[1]!.operationId)
    expect(attempts[0]!.id).not.toBe(attempts[1]!.id)
    expect(effective()).toHaveLength(1)
    expect(effective()[0]!.revision).toBe(1)
    expect((await service.runBatch(USER)).status).toBe('idle')
  })
  it('keeps failed extraction pending across a real reopen', async () => {
    message(); vi.mocked(backend.extract).mockRejectedValueOnce(new Error('offline'))
    expect((await service.runBatch(USER)).status).toBe('pending')
    await service.close(); store.close(); store = new AlongStore(path); service = new MemoryService(store, backend)
    expect((await service.runBatch(USER)).status).toBe('done')
    expect(store.memory.attempts(USER)).toHaveLength(2)
  })
  it('migrates a stage-A schema-1 DB without changing history or task rows', () => {
    const source = message()
    store.close()
    const raw = new DatabaseSync(path)
    raw.prepare("UPDATE meta SET value='1' WHERE key='schema_version'").run()
    for (const table of ['memory_detail', 'memory_operation', 'memory_attempt', 'memory_processed', 'memory_suppression', 'memory_blocked_source', 'memory_cleanup']) {
      raw.exec(`DROP TABLE ${table}`)
    }
    raw.close()
    store = new AlongStore(path)
    expect(store.getMessage(USER, source.id)?.text).toBe(source.text)
    expect(store.memory.memories(USER)).toEqual([])
  })
})
