/**
 * Stage A end-to-end over the assembled Runtime (design §2.7.3, along/docs/stage-a-tech-design.md §2.7/§6):
 * business store + facade + loopback API + delivery pump + domain-event dispatch + worker tools, assembled
 * by `src/app/runtime.ts` — not a hand-wired module composition. The main scenario carries one event from the
 * Host bridge through intake, Ticket, ChangeSet and the execution record, then restarts the Runtime on the
 * same persisted state (BC-08-11), drives sync pull/ack (BC-00-05) and pins the tracking chain (003 §3).
 * Also here: BC-08-03 (duplicate events create no duplicate work), BC-07-01 (credentials never reach a worker
 * environment, extended with the bridge-token name), BC-07-02 (the fail-fast placement guard), BC-07-03/04
 * (the Along tools are the only business write channel, bound by the host) and BC-07-08 (inherited work tools
 * coexist with the Along tools).
 *
 * The restart reuses the SAME state directory with no seed: everything asserted after the restart comes from
 * the persisted orchestrator/along databases (seeding it would fake the acceptance).
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { Store } from '../src/app/store.ts'
import { alongKind } from '../src/sources/along.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const USER = 'u_ab12ef34'
const DEVICE = 'd_cd5690ab'
const EVENT_1 = 'evt-1'
const EVENT_2 = 'evt-2'
const TRIGGER_1 = `along:${USER}:${EVENT_1}`
const TRIGGER_2 = `along:${USER}:${EVENT_2}`
const GOAL_TITLE_1 = '每周运动 120 分钟'
const TEXT_1 = '我想每周运动 120 分钟'
const TEXT_2 = '我想每周运动 150 分钟'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined })

/** The bridge headers a real Host sends (design §4.2): marker + token, identity from the server-bound pairing. */
const bridgeHeaders = (token: string) => ({
  'x-along-bridge': '1', 'x-along-bridge-token': token, 'x-along-user': USER, 'x-along-device': DEVICE,
})

/** A user-message envelope as the phone would send it (§4.1); a retry must serialize identically (payload_hash). */
const messageEnvelope = (eventId: string, text: string, extra: Record<string, unknown> = {}) => ({
  event_id: eventId, schema_version: '1', event_type: 'along.user_message',
  occurred_at: '2026-11-15T09:00:00+08:00', timezone: 'Asia/Shanghai', ...extra,
  payload: { event_type: 'along.user_message', text },
})

/** Stage A settings: the Along local deployment with the paired user allowed to originate work (§2.4.1). The
 * Along Source kind itself is registered by the fixture (pre-`ready`, so queued deliveries are not filtered). */
function configureAlong(h: Host) {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, eval: { ...settings.eval, mode: 'auto' },
    sources: { github: { enabled: false, config: {} }, feishu: { enabled: false, config: {} }, along: { enabled: true, config: {} } },
    policy: { ...settings.policy,
      rules: [{ id: 'along-phase-a', name: 'Along stage A', enabled: true, instruction: 'Keep the exercise goal and its tasks accurate.' }],
      sources: { ...settings.policy.sources, along: { allowed: [{ id: USER }] } } },
  })
}

describe('Along stage A: the assembled runtime carries an event end to end and survives a restart', () => {
  it('bridges one event into an applied ChangeSet and a RunRecord, keeps duplicates idle, and answers full queries after a real restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'along-phase-a-'))
    try {
      // The test owns this directory for both starts: it provisions the fresh state so the Along local
      // deployment holds at construction time, and the restart (below) reopens the same files with no seed —
      // every post-restart assertion then comes from the persisted state only.
      const seeded = new Store(join(directory, 'orchestrator.sqlite'))
      seeded.saveSettings({ ...seeded.settings(),
        sources: { along: { enabled: true, config: {} }, github: { enabled: false, config: {} }, feishu: { enabled: false, config: {} } } })
      seeded.close()
      const h = host = await startRuntime(undefined, { dir: directory })
      configureAlong(h)
      const along = h.runtime.along!
      expect(along.stateDir).toBe(join(h.directory, 'along-data'))
      expect(along.bridgeToken).toMatch(/^[a-f0-9]{64}$/)
      const headers = bridgeHeaders(along.bridgeToken)
      const store = along.service.alongStore
      const bodies: unknown[] = []
      const call = async (method: string, path: string, json?: unknown) => {
        const response = await h.alongApi(method, path, json, headers)
        bodies.push(response.body)
        return response
      }

      // The loopback plane answers the Host's probe, registers the pairing and receives the event (§4.2).
      await expect(call('GET', 'goals/along-status-probe')).resolves.toMatchObject({ status: 200, body: { service: 'along-source', ready: true } })
      await expect(call('POST', 'pairing', { user_id: USER, device_id: DEVICE })).resolves.toMatchObject({ status: 200, body: { registered: true } })

      // ① the event is received transactionally (Inbox + message + delivery in one commit, BC-08-01) …
      await expect(call('POST', 'events', messageEnvelope(EVENT_1, TEXT_1)))
        .resolves.toMatchObject({ status: 200, body: { status: 'accepted', event_id: EVENT_1, received_seq: 1 } })
      expect(store.findInboxEvent(USER, EVENT_1)).toMatchObject({ status: 'accepted', triggerId: TRIGGER_1, eventType: 'along.user_message' })
      expect(store.getMessage(USER, `msg:${USER}:${EVENT_1}`)).toMatchObject({ role: 'user', direction: 'inbound', text: TEXT_1, seq: 1 })
      expect(store.getDelivery(TRIGGER_1)).toMatchObject({ status: 'pending', eventId: EVENT_1 })
      // … and the assembled pump delivers it through the real intake (at-least-once, §2.2.2).
      await vi.waitFor(() => expect(store.getDelivery(TRIGGER_1)?.status).toBe('delivered'), { timeout: 10_000, interval: 100 })

      // ② the explicit request becomes a candidate, the Host routes it, the worklink maps the work (§2.5).
      await h.runtime.idle()
      expect(h.candidates()).toContain(TRIGGER_1)
      const accepted = await h.route({ kind: 'accept', trigger_id: TRIGGER_1, title: GOAL_TITLE_1,
        worktree_name: 'along-phase-a', acknowledgement: '收到，先建立目标。' })
      await h.runtime.idle()
      const ticket = h.runtime.store.tickets.get((accepted.ticket as { ticket_id: string }).ticket_id)!
      expect(ticket.mandate.strength).toBe('explicit')
      const sessionId = `worker-${ticket.id}`
      expect(h.agents.has(sessionId)).toBe(true)
      const link = store.getWorkLink(ticket.id)!
      expect(link).toMatchObject({ eventId: EVENT_1, triggerId: TRIGGER_1, kind: 'ticket' })
      expect(link.goalId).toBeUndefined()

      // ③ the worker's Along tools are registered (BC-07-04) — inherited work tools live in the real DSH tool
      // registry, whose coexistence with Along tools the phase-0 probe pins with `along-phaseA`'s assets.
      for (const name of ['along_goal_read', 'along_conversation_read', 'along_task_list', 'along_health_read', 'along_changes_commit']) {
        expect(h.tools.get(sessionId)?.has(name)).toBe(true)
      }
      await expect(h.runTool(sessionId, 'along_goal_read', {})).rejects.toThrow(/no goal is bound/)

      // ④ the commit applies atomically: goal + first task, revision and input version advanced, the originating
      // message linked (its acceptance had no goal yet) — the target agrees with the user's own words (§2.3.1).
      const commit = await h.runTool(sessionId, 'along_changes_commit', {
        idempotency_key: 'phasea-create-1', base_revision: 0, input_version: 1, reason: '从聊天建立每周运动目标',
        ops: [
          { op: 'goal.create', domain: 'health', title: GOAL_TITLE_1,
            metric: { type: 'workout', target: 120, unit: '分钟', period: 'week' }, context: null },
          { op: 'task.create', trigger:{kind:'waiting',actor:'user',capability:'reminder',resume:'user_input',reason:'等待用户安排本周晨跑'}, content: '本周完成一次 40 分钟晨跑', reminder_plan:{state:'off',reason:'untimed'} },
        ],
      }) as { status: string; changeset_id: string; goal_revision: number; reused: boolean }
      expect(commit).toMatchObject({ status: 'applied', goal_revision: 1, reused: false })
      const goalId = store.listGoals(USER).items[0]!.id
      expect(store.currentRevision('goal', goalId)).toBe(1)
      expect(store.inputVersion(goalId)).toBe(1)
      const linked = store.messagesByGoal(USER, goalId).items.find(item => item.id === `msg:${USER}:${EVENT_1}`)!
      expect(linked.goals).toContainEqual({ goalId, relation: 'direct' })

      // ⑤ the host ends the work without a model call (D7 Stage-A proxy) and the record module lands the
      // RunRecord plus the outbound execution note — the Stage A outbound half of the conversation (§2.6).
      const createsBefore = h.controller.create.mock.calls.length
      await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '目标已建立，已安排本周首次晨跑。' })
      await h.runtime.idle()
      expect(h.controller.create.mock.calls.length).toBe(createsBefore)
      const assignment = ticket.assignments[0]!
      expect(store.getRunRecord(ticket.id, assignment.id)).toMatchObject({ ticketId: ticket.id, workId: link.workId,
        goalId, triggerEventId: EVENT_1, reportState: 'ready', changesetId: commit.changeset_id,
        toolTraceRef: `worker-${ticket.id}:${assignment.id}` })
      expect(store.getMessage(USER, `msg:${USER}:out:${ticket.id}:${assignment.id}`)).toMatchObject({ role: 'assistant', direction: 'outbound' })
      expect(store.getWorkLink(ticket.id)?.endedAt).toBeDefined()

      // ⑥ a duplicate event answers duplicate and creates no duplicate work (BC-08-03).
      const ticketsBefore = h.runtime.store.tickets.list().length
      await expect(call('POST', 'events', messageEnvelope(EVENT_1, TEXT_1))).resolves.toMatchObject({ status: 200, body: { status: 'duplicate' } })
      expect(h.runtime.store.tickets.list()).toHaveLength(ticketsBefore)

      // ⑦ BC-07-03/04 through the real tool surface: the strict schema has no goal_id parameter, so a
      // model-supplied one is refused before any code runs, and a bound-scope violation (a second commit on a
      // goal-less ticket that is not a goal.create) is refused by the host binding. Either way nothing writes.
      await expect(h.runTool(sessionId, 'along_changes_commit', {
        idempotency_key: 'phasea-foreign-1', goal_id: 'g_does_not_exist', base_revision: 1, input_version: 1,
        reason: '越权提交', ops: [{ op: 'goal.update', fields: { title: '不该生效' } }],
      })).rejects.toThrow(/Unrecognized key.*goal_id/s)
      await expect(h.runTool(sessionId, 'along_goal_read', {})).resolves.toMatchObject({ goal: { goal_id: goalId } })
      await expect(h.runTool(sessionId, 'along_changes_commit', {
        idempotency_key: 'phasea-foreign-2', base_revision: 0, input_version: 1,
        reason: '建目标后的旧版本提交', ops: [{ op: 'goal.update', fields: { title: '不该生效' } }],
      })).resolves.toMatchObject({ status: 'conflicted', reason: 'conflicted_revision' })
      expect(store.currentRevision('goal', goalId)).toBe(1)
      expect(store.changeSetsByGoal(USER, goalId).items.filter(change => change.status === 'applied')).toHaveLength(1)

      // The state the restart must reproduce (BC-08-11): unchanged slices compare equal after reopening.
      const before = { revision: store.goalRevisions(goalId)[0], tasks: store.listTasks(USER, { goalId }),
        message: store.getMessage(USER, `msg:${USER}:${EVENT_1}`), inbox: store.findInboxEvent(USER, EVENT_1) }

      // ⑧ queue one more event with the pump stopped, then stop: the row stays pending, nothing is cleared.
      along.stopDeliveryPump()
      const noteSeq = store.getMessage(USER, `msg:${USER}:out:${ticket.id}:${assignment.id}`)!.seq
      await expect(call('POST', 'events', messageEnvelope(EVENT_2, TEXT_2, { goal_id: goalId })))
        .resolves.toMatchObject({ status: 200, body: { status: 'accepted', received_seq: noteSeq + 1 } })
      expect(store.inputVersion(goalId)).toBe(2)
      expect(store.getDelivery(TRIGGER_2)?.status).toBe('pending')
      await h.stop(); host = undefined

      // ⑨ the restart reopens the SAME persisted state with no seed; the token file is reused, not regenerated.
      const h2 = host = await startRuntime(undefined, { dir: directory })
      expect(h2.runtime.along).toBeDefined()
      const store2 = h2.runtime.along!.service.alongStore
      expect(h2.runtime.along!.bridgeToken).toBe(along.bridgeToken)
      expect(store2.findInboxEvent(USER, EVENT_1)).toEqual(before.inbox)
      expect(store2.goalRevisions(goalId)[0]).toEqual(before.revision)
      expect(store2.listTasks(USER, { goalId })).toEqual(before.tasks)
      expect(store2.getMessage(USER, `msg:${USER}:${EVENT_1}`)).toEqual(before.message)

      // ⑩ the fresh pump continues the pending delivery; the follow-up work applies its ChangeSet on the
      // persisted versions (BC-09-04: a rollback of the link switch keeps the database and resumes).
      await vi.waitFor(() => expect(store2.getDelivery(TRIGGER_2)?.status).toBe('delivered'), { timeout: 10_000, interval: 100 })
      await h2.runtime.idle()
      const accepted2 = await h2.route({ kind: 'accept', trigger_id: TRIGGER_2, title: '每周运动 150 分钟',
        worktree_name: 'along-phase-a-2', acknowledgement: '收到，调整目标。' })
      await h2.runtime.idle()
      const ticket2 = h2.runtime.store.tickets.get((accepted2.ticket as { ticket_id: string }).ticket_id)!
      expect(store2.getWorkLink(ticket2.id)).toMatchObject({ goalId, eventId: EVENT_2 })
      const commit2 = await h2.runTool(`worker-${ticket2.id}`, 'along_changes_commit', {
        idempotency_key: 'phasea-update-1', base_revision: 1, input_version: 2, reason: '用户把每周运动目标调整到 150 分钟',
        ops: [{ op: 'goal.update', fields: { title: '每周运动 150 分钟',
          metric: { type: 'workout', target: 150, unit: '分钟', period: 'week' } } }],
      }) as { status: string; changeset_id: string; goal_revision: number }
      expect(commit2).toMatchObject({ status: 'applied', goal_revision: 2 })
      await h2.runTool(`worker-${ticket2.id}`, 'orchestrator_report', { state: 'ready', summary: '目标已调整到每周 150 分钟。' })
      await h2.runtime.idle()

      // ⑪ the loopback plane answers the full queries over the restarted state (BC-08-11): goal, tasks and the
      // complete Stage A conversation — inbound user messages plus the outbound execution notes.
      const headers2 = bridgeHeaders(h2.runtime.along!.bridgeToken)
      const call2 = async (method: string, path: string, json?: unknown) => {
        const response = await h2.alongApi(method, path, json, headers2)
        bodies.push(response.body)
        return response
      }
      await expect(call2('GET', `goals?user_id=${USER}`)).resolves.toMatchObject({ status: 200,
        body: { items: [expect.objectContaining({ id: goalId, currentRevision: 2 })] } })
      await expect(call2('GET', `goals/${goalId}`)).resolves.toMatchObject({ status: 200, body: { goal: { id: goalId, currentRevision: 2 } } })
      const tasks = await call2('GET', `tasks?user_id=${USER}&status=open`)
      expect((tasks.body.items as { content: string }[]).map(task => task.content)).toEqual(['本周完成一次 40 分钟晨跑'])
      const conversation = await call2('GET', `goals/${goalId}/messages`)
      const messages = conversation.body.items as { seq: number; direction: string; text: string }[]
      expect(messages.map(message => `${message.direction}:${message.text}`)).toEqual([
        `inbound:${TEXT_1}`, expect.stringContaining('outbound:执行说明'),
        `inbound:${TEXT_2}`, expect.stringContaining('outbound:执行说明'),
      ])
      expect(messages.every((message, index) => index === 0 || message.seq > messages[index - 1]!.seq)).toBe(true)
      expect(JSON.stringify(messages)).not.toContain('隐藏推理')

      // ⑫ BC-00-05: the changes took effect without any pull; the reconnect pulls them and the ack settles them.
      const sync = await call2('GET', `sync?user_id=${USER}&after_seq=0`)
      const items = sync.body.items as { seq: number; kind: string }[]
      expect(items.map(item => item.kind)).toEqual(expect.arrayContaining(['goal_updated', 'task_updated', 'changeset_note', 'message']))
      const seqs = items.map(item => item.seq)
      await expect(call2('POST', 'sync/ack', { seqs })).resolves.toMatchObject({ status: 200, body: { acked: seqs.length } })
      expect(store2.syncPage(USER, 0, 200).items.every(item => item.deliveredAt !== undefined)).toBe(true)

      // ⑬ the tracking chain (003 §3): inbox → disposition → changeset → sync, and no body ever carries the token.
      expect(h2.runtime.store.triggers.disposition(TRIGGER_1)).toBeDefined()
      const changeset = store2.getChangeSet(USER, commit.changeset_id)
      expect(changeset).toMatchObject({ triggerEventId: EVENT_1, workId: link.workId, ticketId: ticket.id })
      expect(JSON.stringify(bodies)).not.toContain(along.bridgeToken)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }, 60_000)

  it('refuses to start when the business data directory sits inside the worker execution root (BC-07-02)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'along-phase-a-isolation-'))
    try {
      const seeded = new Store(join(directory, 'orchestrator.sqlite'))
      seeded.saveSettings({ ...seeded.settings(), sources: { along: { enabled: true, config: {} }, github: { enabled: false, config: {} } } })
      seeded.close()
      await expect(startRuntime(undefined, { dir: directory, alongStateDir: join(directory, 'work', 'along-data') }))
        .rejects.toThrow(/must not overlap the worker execution root/)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('keeps every credential family, including the bridge-token name, out of a worker environment (BC-07-01)', async () => {
    const secretNames = ['KIMI_CODE_TOKEN', 'ALONG_PAIRING_TOKEN', 'DSH_ADMIN_TOKEN', 'ALONG_BRIDGE_TOKEN_FILE']
    for (const name of secretNames) vi.stubEnv(name, 'along-phase-a-synthetic-value')
    // Layer ① — the scrubbed parent env hits every TOKEN-shaped name by convention (no registration point).
    const clean = scrubbedParentEnv()
    for (const name of secretNames) expect(clean[name]).toBeUndefined()
    const h = host = await startRuntime(store => store.saveSettings({ ...store.settings(),
      sources: { along: { enabled: true, config: {} }, github: { enabled: false, config: {} } } }))
    configureAlong(h)
    const token = h.runtime.along!.bridgeToken
    // The business data never sits below the worker execution root (`<stateDir>/work`) — the fail-fast the
    // runtime enforces at startup (the fixture's tmp layout nests along-data under the state dir for cleanup
    // convenience; the production path is `~/.along/along-data` outside the DSH state dir).
    expect(h.runtime.along!.stateDir.startsWith(join(h.runtime.machine.stateDir, 'work'))).toBe(false)
    // Layer ② — a child worker process sees neither the synthetic names nor the host's real bridge token.
    const worker = join(h.directory, 'worker'); mkdirSync(worker)
    const child = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], { cwd: worker, env: clean, encoding: 'utf8' })
    expect(child.status).toBe(0)
    const env = JSON.parse(child.stdout) as Record<string, string>
    for (const name of secretNames) expect(env[name]).toBeUndefined()
    expect(JSON.stringify(env)).not.toContain(token)
    // Layer ③ — the loopback plane never echoes the token into a response body.
    const denied = await h.alongApi('GET', 'goals', undefined, { 'x-along-bridge': '1', 'x-along-bridge-token': 'wrong-token', 'x-along-user': USER, 'x-along-device': DEVICE })
    expect(denied).toMatchObject({ status: 401, body: { error: 'unauthorized' } })
    expect(JSON.stringify(denied.body)).not.toContain(token)
  })
})
