import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AlongStore } from '../src/along/store.ts'
import { AlongService } from '../src/along/service.ts'
import { createInbox } from '../src/along/inbox.ts'
import { alongTools } from '../src/along/tools.ts'
import { recommendation } from '../src/along/recommendation.ts'

const user = 'u_execution', device = 'd_execution'
const dirs: string[] = [], stores: AlongStore[] = []
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function fixture(content = '研究周末广深徒步目的地') {
  const dir = mkdtempSync(join(tmpdir(), 'along-task-execution-')); dirs.push(dir)
  const path = join(dir, 'along.sqlite'), store = new AlongStore(path); stores.push(store)
  store.assertUser(user, device)
  const goal = store.insertGoal({ userId: user, domain: 'custom' })
  store.appendGoalRevision({ userId: user, goalId: goal.id, title: '原目标', status: 'active' })
  const task = store.insertTask({ userId: user, goalId: goal.id, content })
  store.appendTaskRevision({ userId: user, taskId: task.id, content })
  const inbox = createInbox(store), service = new AlongService(store, { inbox })
  const say = (eventId: string, text = '请研究这个周末的徒步目的地', extra = {}) => {
    expect(inbox.acceptEvent({ event_id: eventId, schema_version: '1', event_type: 'along.user_message', goal_id: goal.id,
      occurred_at: new Date().toISOString(), timezone: 'Asia/Shanghai', payload: { event_type: 'along.user_message', text }, ...extra }, { userId: user, deviceId: device }).status).toBe('accepted')
  }
  const evidence = (ticketId: string) => {
    const scope = { userId: user, goalId: goal.id, ticketId }
    const source = store.research.save(scope, { title: '路线资料', url: 'https://www.gz.gov.cn/route', content: '现有路线为公园环线。', purpose: 'route', fetched: true })
    const request = store.research.claimRequest(scope, 'fetch')!
    store.research.finishRequest(scope, request, 'ok')
    const input = { kind: 'general' as const, title: '周末路线', summary: '可比较现有路线', constraints: [],
      options: [{ id: 'park', title: '公园环线', reason: '适合轻量活动', conditions: [], unknowns: ['出发前复查天气'],
        facts: [{ label: '路线', value: '公园环线', evidence: [{ sourceId: source.id, quote: '现有路线为公园环线。' }] }], checks: [] }], nextStep: '出发前检查开放情况' }
    return { scope, input, output: recommendation(store.research, scope, input) }
  }
  const reply = async (eventId: string, ticketId = 'ticket', reused?: ReturnType<typeof evidence>) => {
    store.recordWorkLink({ ticketId, workId: 'w_' + eventId, goalId: goal.id, taskId: task.id, eventId, threadKey: 'along:goal/' + goal.id + '/work/' + eventId, kind: 'resume' })
    store.recordRunRecord({ ticketId, assignmentId: 'as_' + eventId, userId: user, goalId: goal.id, taskId: task.id, triggerEventId: eventId })
    const proof = reused ?? evidence(ticketId)
    const tool = alongTools({ service, scopeFor: () => ({ userId: user, allowedGoalId: goal.id, triggerEventId: eventId }) }, ticketId).find(t => t.name === 'along_chat_reply')!
    const args = tool.schema.parse({ text: '研究结果', task_id: task.id, recommendation: proof.input })
    await tool.execute(args, new AbortController().signal)
    return { tool, args, proof }
  }
  return { path, store, goal, task, say, inbox, evidence, reply }
}

it('projects a real task-scoped research result once, including legal evidence reuse after another user input', async () => {
  const { store, goal, task, say, reply } = fixture()
  say('first')
  const first = await reply('first')
  expect(store.taskExecution(user, task.id)).toMatchObject({ version: 1, count: 1, records: [{ kind: 'research', outcome: 'researched', summary: '已生成研究方案' }] })
  const id = store.taskExecution(user, task.id).records[0]!.id
  await first.tool.execute(first.args, new AbortController().signal)
  expect(store.taskExecution(user, task.id).count).toBe(1)
  say('second', '按现有资料再比较一下')
  await reply('second', 'ticket', first.proof)
  expect(store.taskExecution(user, task.id).count).toBe(2)
  expect(store.taskExecution(user, task.id).records.some(r => r.id === id)).toBe(true)
  expect(store.goalDetail(user, goal.id).tasks[0]!.execution?.count).toBe(2)
  expect((store.workspaceSync(user, 0, 200).items.at(-1)!.payload as any).snapshot.tasks[0].execution.count).toBe(2)
})

it('excludes audited development results without hiding a later real input sharing its conversation root', async () => {
  const { store, task, say, reply } = fixture()
  say('development')
  const old = await reply('development')
  say('human', '请按这些资料继续比较', { causation_id: 'development' })
  await reply('human', 'ticket', old.proof)
  expect(store.taskExecution(user, task.id).count).toBe(2)
  store.isolateDevelopmentEvents(user, ['development'], 'verified-private-development-manifest')
  expect(store.taskExecution(user, task.id)).toMatchObject({ count: 1 })
  expect(store.research.reply(`msg:${user}:reply_missing`)).toBeUndefined()
  expect(store.counts(user).messages).toBe(4) // Audit bodies and recommendation carriers remain.
})

it('does not count keep, assignment retries, scheduling edits, message lookalikes or an untethered recommendation', () => {
  const { store, goal, task, evidence } = fixture()
  const proof = evidence('unrelated_ticket')
  store.recordRunRecord({ ticketId: 'audit_only', assignmentId: 'retry1', userId: user, goalId: goal.id, taskId: task.id, reportState: 'ready' })
  store.recordRunRecord({ ticketId: 'audit_only', assignmentId: 'retry2', userId: user, goalId: goal.id, taskId: task.id, reportState: 'ready' })
  store.appendTaskRevision({ userId: user, taskId: task.id, scheduledAt: '2026-11-20T11:00:00Z' })
  const message = store.appendMessage({ userId: user, eventId: 'fake_result', role: 'assistant', direction: 'outbound', audience: 'background', text: '研究结果' })
  store.appendSync({ userId: user, goalId: goal.id, taskId: task.id, kind: 'message', messageId: message.id, payload: { recommendation: proof.output } })
  expect(store.taskExecution(user, task.id)).toEqual({ version: 1, count: 0, records: [] })
})

it('deduplicates repeated due dispatches at one civil occurrence and remains stable after restart', () => {
  const { store, path, goal, task, evidence } = fixture()
  for (const inputVersion of [1, 2]) {
    const ticket = 'due_ticket_' + inputVersion, proof = evidence(ticket)
    const d = store.health.dispatchDue(user, goal.id, inputVersion, { taskId: task.id, revision: 1, dueAt: '2026-11-20T11:00:00Z' }, [])
    store.recordWorkLink({ ticketId: ticket, workId: 'w_' + inputVersion, goalId: goal.id, taskId: task.id, eventId: d.eventId, threadKey: 'due/' + inputVersion, kind: 'ticket' })
    const result = { outcome: 'keep', types: [], reason: '本次研究已交付', recommendation: proof.input }
    store.health.finish(d, result)
    const message = store.appendMessage({ userId: user, eventId: 'followup_' + d.eventId, role: 'assistant', direction: 'outbound', audience: 'background', text: '正式方案' })
    store.appendSync({ userId: user, goalId: goal.id, taskId: task.id, messageId: message.id, kind: 'message', payload: { recommendation: proof.output } })
    store.appendSync({ userId: user, goalId: goal.id, taskId: task.id, messageId: message.id, kind: 'message', payload: { recommendation: proof.output, classification_only: true } })
  }
  const before = store.taskExecution(user, task.id)
  expect(before.count).toBe(1)
  store.close(); stores.splice(stores.indexOf(store), 1)
  const restarted = new AlongStore(path); stores.push(restarted)
  expect(restarted.taskExecution(user, task.id)).toEqual(before)
})

it('counts a real completed transition once, not an extra completed feedback, scheduled reminder, or Agent done edit', () => {
  const { store, goal, task, inbox } = fixture('周二完成瑜伽预约')
  const receivedTime = new Date().toISOString()
  const feedback = (eventId: string) => inbox.acceptEvent({ event_id: eventId, schema_version: '1', event_type: 'along.message', kind: 'task.completed',
    goal_id: goal.id, task_id: task.id, occurred_at: receivedTime, timezone: 'Asia/Shanghai', payload: { event_type: 'along.message', kind: 'task.completed', task_id: task.id } }, { userId: user, deviceId: device })
  expect(store.taskExecution(user, task.id).count).toBe(0)
  store.appendSync({ userId: user, goalId: goal.id, taskId: task.id, kind: 'task_updated', payload: { notification: { kind: 'reminder_due', revision: 1 } } })
  expect(store.taskExecution(user, task.id).count).toBe(0)
  expect(feedback('done1').status).toBe('accepted')
  expect(feedback('done1').status).toBe('duplicate')
  expect(feedback('done2').status).toBe('accepted')
  expect(store.taskExecution(user, task.id)).toMatchObject({ count: 1, records: [{ kind: 'completed', outcome: 'completed' }] })
  const other = store.insertTask({ userId: user, goalId: goal.id, content: '实际徒步' })
  store.appendTaskRevision({ userId: user, taskId: other.id, status: 'done' })
  expect(store.taskExecution(user, other.id).count).toBe(0)
})

it('keeps physical action completion distinct from a recommendation and enforces user ownership', async () => {
  const { store, task, say, reply } = fixture('周末进行广深徒步')
  say('human')
  await reply('human')
  expect(store.taskExecution(user, task.id).count).toBe(0)
  expect(() => store.taskExecution('u_another', task.id)).toThrow('not found')
})

it('returns the latest twenty records while keeping the total count and isolating other goals', async () => {
  const { store, goal, task, say, reply } = fixture()
  let proof: Awaited<ReturnType<typeof reply>>['proof'] | undefined
  for (let n = 0; n < 23; n++) { say('human_' + n); proof = (await reply('human_' + n, 'ticket', proof)).proof }
  expect(store.taskExecution(user, task.id).count).toBe(23)
  expect(store.taskExecution(user, task.id).records).toHaveLength(20)
  const otherGoal = store.insertGoal({ userId: user, domain: 'custom' })
  store.appendGoalRevision({ userId: user, goalId: otherGoal.id, title: '别的目标', status: 'active' })
  const other = store.insertTask({ userId: user, goalId: otherGoal.id, content: task.content })
  expect(store.goalDetail(user, goal.id).tasks[0]!.execution?.count).toBe(23)
  expect(store.taskExecution(user, other.id).count).toBe(0)
})
