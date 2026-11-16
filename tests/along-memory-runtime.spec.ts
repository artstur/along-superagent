/** Runtime acceptance: real governance/store/tools, synthetic SDK I/O only. */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'
import { Store } from '../src/app/store.ts'
import { HyMemoryBackend } from '../src/along/memory/hy-client.ts'
import { alongKind } from '../src/sources/along.ts'
import { WORK_TOOLS } from '../src/app/sessions.ts'
import type { ExtractionInput } from '../src/along/memory/model.ts'

const USER = 'u_cccccccc', DEVICE = 'd_cccccccc'
let host: Host | undefined
const directories: string[] = []
afterEach(async () => {
  await host?.stop(); host = undefined
  vi.restoreAllMocks()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const seed: Parameters<typeof startRuntime>[0] = store => store.saveSettings({ ...store.settings(), eval: { ...store.settings().eval, mode: 'auto' },
  sources: { along: { enabled: true, config: {} }, github: { enabled: false, config: {} } } })
async function configured(dir?: string) {
  const root = dir ?? mkdtempSync(join(tmpdir(), 'along-memory-runtime-')); if (!dir) directories.push(root)
  const h = host = await startRuntime(dir ? undefined : seed, { dir, alongMemory: {
    python: '/bin/false', dataDir: join(root, 'memory'), envFile: join(root, 'memory.env'),
  } })
  if (!dir) h.runtime.sources.register(alongKind)
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), sources: { along: { enabled: true, config: {} }, github: { enabled: false, config: {} }, feishu: { enabled: false, config: {} } } })
  const along = h.runtime.along!
  const headers = { 'x-along-bridge': '1', 'x-along-bridge-token': along.bridgeToken, 'x-along-user': USER, 'x-along-device': DEVICE }
  expect((await h.alongApi('POST', 'pairing', { user_id: USER, device_id: DEVICE }, headers)).status).toBe(200)
  return { h, along, store: along.service.alongStore, headers }
}
async function dispatch(h: Host, headers: Record<string, string>, id: string, text: string, goalId?: string) {
  expect((await h.alongApi('POST', 'events', { event_id: id, schema_version: '1', event_type: 'along.user_message',
    occurred_at: new Date().toISOString(), timezone: 'Asia/Shanghai', ...(goalId ? { goal_id: goalId } : {}),
    payload: { event_type: 'along.user_message', text } }, headers)).body).toMatchObject({ status: 'accepted' })
  const trigger = `along:${USER}:${id}`
  await vi.waitFor(() => expect(h.runtime.along!.service.alongStore.getDelivery(trigger)?.status).toBe('delivered'), { timeout: 10_000 })
  await h.runtime.idle()
  const accepted = await h.route({ kind: 'accept', trigger_id: trigger, title: '处理记忆聊天', worktree_name: id.replaceAll('_', '-'), acknowledgement: '收到。' })
  await h.runtime.idle()
  return `worker-${(accepted.ticket as { ticket_id: string }).ticket_id}`
}
function syntheticSdk() {
  vi.spyOn(HyMemoryBackend.prototype, 'extract').mockImplementation(async (input: ExtractionInput) => ({ backendIds: ['sdk-node'],
    candidates: input.sources.map(source => ({ quote: source.text, topic: source.id, category: 'preference', assertion: 'explicit',
      sourceMessageIds: [source.id], backendIds: ['sdk-node'], replaces: [], conflictsWith: [],
      ...(source.goalIds.length ? { goalId: source.goalIds[0] } : {}) })) }))
  return vi.spyOn(HyMemoryBackend.prototype, 'search').mockResolvedValue(['sdk-node'])
}
it('assembles memory in Runtime and exposes scoped, strict, lossless tools with SQLite fallback and ordered shutdown', async () => {
  const search = syntheticSdk()
  const { h, along, store, headers } = await configured()
  const source = store.appendMessage({ userId: USER, eventId: 'preference', role: 'user', direction: 'inbound', text: '以后都安排晚饭前运动' })
  await along.memory.runBatch(USER)
  store.assertUser('u_dddddddd', 'd_dddddddd')
  store.appendMessage({ userId: 'u_dddddddd', eventId: 'foreign_preference', role: 'user', direction: 'inbound', text: '别人的长期偏好' })
  await along.memory.runBatch('u_dddddddd')
  const worker = await dispatch(h, headers, 'memory_read', '安排下一步运动')
  expect(JSON.stringify(h.runtime.ticketEnvironment(h.runtime.store.tickets.get(worker.slice(7))!))).not.toContain('memory.env')
  expect(WORK_TOOLS).toEqual(expect.arrayContaining(['along_memory_search', 'along_memory_forget']))
  const recalled = await h.runTool(worker, 'along_memory_search', { query: '什么时候运动' })
  expect(recalled).toMatchObject({ degraded: false, memories: [{ content: source.text }] })
  expect(recalled).toStrictEqual(JSON.parse(JSON.stringify(recalled)))
  await expect(h.runTool(worker, 'along_memory_search', { query: '运动', user_id: 'forged' })).rejects.toThrow()
  search.mockRejectedValue(new Error('SDK unavailable'))
  expect(await h.runTool(worker, 'along_memory_search', { query: '运动' })).toMatchObject({ degraded: true, memories: [{ content: source.text }] })
  const close = vi.spyOn(HyMemoryBackend.prototype, 'close').mockImplementation(async () => { expect(store.counts(USER).messages).toBeGreaterThan(0) })
  await h.stop(); host = undefined
  expect(close).toHaveBeenCalledOnce()
  expect(() => store.counts(USER)).toThrow()
}, 25_000)

it('forgets a requested memory while retaining unrelated older context, raw history and existing tasks', async () => {
  syntheticSdk()
  const { h, along, store, headers } = await configured()
  const goal = store.insertGoal({ userId: USER, domain: 'custom' })
  store.appendGoalRevision({ userId: USER, goalId: goal.id, title: '规律运动', status: 'active' })
  const task = store.insertTask({ userId: USER, goalId: goal.id, content: '今天散步十分钟' })
  const source = store.appendMessage({ userId: USER, eventId: 'scoped_preference', role: 'user', direction: 'inbound', text: '长期偏好只在晚饭前运动' })
  store.linkMessageToGoals(source.id, [goal.id], 'direct')
  const unrelated = store.appendMessage({ userId: USER, eventId: 'unrelated_history', role: 'assistant', direction: 'outbound', text: '昨天已经完成散步。' })
  store.linkMessageToGoals(unrelated.id, [goal.id], 'direct')
  await along.memory.runBatch(USER)
  const memory = store.memory.effective(USER, goal.id)[0]!
  const otherGoal = store.insertGoal({ userId: USER, domain: 'custom' })
  const other = await dispatch(h, headers, 'memory_other', '另一个目标的安排', otherGoal.id)
  expect(await h.runTool(other, 'along_memory_search', { query: '运动' })).toMatchObject({ memories: [] })
  await expect(h.runTool(other, 'along_memory_forget', { memory_id: memory.id })).rejects.toThrow('not found')
  const worker = await dispatch(h, headers, 'memory_forget', '忘记我的运动时间偏好', goal.id)
  expect(await h.runTool(worker, 'along_conversation_read', {})).toMatchObject({ messages: expect.arrayContaining([expect.objectContaining({ text: source.text })]) })
  expect(await h.runTool(worker, 'along_memory_forget', { memory_id: memory.id })).toMatchObject({ withdrawnIds: [memory.id] })
  const context = await h.runTool(worker, 'along_conversation_read', {})
  expect(context).toMatchObject({ memories: [], memory_history: [expect.objectContaining({ status: 'withdrawn' })], messages: expect.arrayContaining([expect.objectContaining({ text: unrelated.text })]) })
  expect(JSON.stringify(context.messages)).not.toContain(source.text)
  await expect(h.runTool(worker, 'orchestrator_read', { resource: `trigger/along:${USER}:memory_forget`, offset: 0 })).resolves.toBeDefined()
  expect(store.messagesByGoal(USER, goal.id).items.map(message => message.text)).toContain(source.text)
  expect(store.getTask(USER, task.id)?.status).toBe('open')
  expect(await h.runTool(worker, 'along_memory_search', { query: '运动' })).toMatchObject({ degraded: true, memories: [] })
  expect(await h.runTool(worker, 'along_chat_reply', { text: '已忘记你的运动时间偏好。' })).toMatchObject({ status: 'replied' })
}, 30_000)

it('keeps governance and forgetting usable without SDK configuration and leaves GitHub-only Runtime unchanged', async () => {
  const h = host = await startRuntime(seed)
  const along = h.runtime.along!, store = along.service.alongStore
  store.assertUser(USER, DEVICE)
  expect(await along.memory.search({ userId: USER }, '偏好')).toMatchObject({ degraded: true, memories: [] })
  await h.stop(); host = undefined
  const github = host = await startRuntime()
  expect(github.runtime.along).toBeUndefined()
})


it('reopens memory governance without an SDK while preserving unrelated older conversations', async () => {
  syntheticSdk()
  const directory = mkdtempSync(join(tmpdir(), 'along-memory-reopen-')); directories.push(directory)
  const initial = new Store(join(directory, 'orchestrator.sqlite')); seed!(initial); initial.close()
  const first = await configured(directory)
  const message = first.store.appendMessage({ userId: USER, eventId: 'restart_preference', role: 'user', direction: 'inbound', text: '长期偏好晚饭前运动' })
  await first.along.memory.runBatch(USER)
  const unrelated = first.store.appendMessage({ userId: USER, eventId: 'unrelated_old', role: 'assistant', direction: 'outbound', text: '仍有用的旧聊天' })
  first.along.memory.forget({ userId: USER }, first.store.memory.effective(USER)[0]!.id)
  await first.h.stop(); host = undefined
  const h = host = await startRuntime(undefined, { dir: directory })
  const along = h.runtime.along!
  const headers = { 'x-along-bridge': '1', 'x-along-bridge-token': along.bridgeToken, 'x-along-user': USER, 'x-along-device': DEVICE }
  const worker = await dispatch(h, headers, 'memory_after_restart', '安排下一步运动')
  const read = await h.runTool(worker, 'along_conversation_read', {})
  expect(JSON.stringify(read.messages)).not.toContain(message.text)
  expect(await h.runTool(worker, 'along_memory_search', { query: '运动' })).toMatchObject({ degraded: true, memories: [] })
  const current = along.memory.context({ userId: USER }, [message, unrelated])
  expect(current.messages.map(item => item.text)).toEqual([unrelated.text])
  expect(along.service.alongStore.getMessage(USER, message.id)?.text).toBe(message.text)
}, 25_000)


it('makes current and superseded preferences readable with their source order instead of hiding correction history', async () => {
  syntheticSdk()
  const { h, along, store, headers } = await configured()
  const before = store.appendMessage({ userId: USER, eventId: 'old_preference', role: 'user', direction: 'inbound', text: '以后尽量晚饭前运动' })
  await along.memory.runBatch(USER)
  const older = store.memory.effective(USER)[0]!
  const after = store.appendMessage({ userId: USER, eventId: 'new_preference', role: 'user', direction: 'inbound', text: '现在改成早上运动，以后也这样安排' })
  vi.spyOn(HyMemoryBackend.prototype, 'extract').mockResolvedValue({ backendIds: ['sdk-node'], candidates: [{
    quote: after.text, topic: older.topic, category: 'preference', assertion: 'explicit', sourceMessageIds: [after.id],
    backendIds: ['sdk-node'], replaces: [older.id], conflictsWith: [],
  }] })
  await along.memory.runBatch(USER)
  const worker = await dispatch(h, headers, 'memory_updated', '根据现在的偏好安排运动')
  const recalled = await h.runTool(worker, 'along_memory_search', { query: '运动时间' })
  expect(recalled).toMatchObject({ memories: [{ content: after.text, status: 'active' }], history: [{ content: before.text, status: 'superseded', sourceSeq: before.seq }] })
  expect(recalled).toStrictEqual(JSON.parse(JSON.stringify(recalled)))
  const context = along.memory.context({ userId: USER }, [before, after])
  expect(context.messages.map(item => item.text)).toEqual([before.text, after.text])
  expect(context.memories[0]!.sourceSeq).toBeGreaterThan(context.history[0]!.sourceSeq)
}, 25_000)
