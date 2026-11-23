/**
 * Loopback API tests (design §2.4/§4.2 — the interface side of BC-07-04/BC-07-05).
 * The Host (`along` repository, `host/along-bridge.mjs`) is the only legitimate caller; these tests drive
 * `alongSourceRequest` directly with the headers the Host sends:
 * - BC-07-04: a body claiming `user_id`/`device_id` is refused before any parsing — identity comes only from
 *   the Host's server-bound pairing session (headers), never from the phone.
 * - BC-07-05: another user's goal answers the same 404 body as a missing goal, and the body carries nothing
 *   of the other user; a query `user_id` that disagrees with the bound identity is 403.
 * Plus the contract mechanics: bridge auth on every route (401 fail-closed), receipt→status mapping,
 * pairing registration (user upsert + `sources.along.allowed`), paged reads, sync pull/ack, and 503 before assembly.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { alongSourceRequest, type AlongApiHost } from '../src/along/api.ts'
import { AlongService, type AlongEventReceipt } from '../src/along/service.ts'
import { AlongStore } from '../src/along/store.ts'

const BRIDGE_TOKEN = 'a'.repeat(64)
const USER_A = 'u_aaaa1111'
const DEVICE_A = 'd_aaaa1111'
const USER_B = 'u_bbbb2222'
const DEVICE_B = 'd_bbbb2222'
const GOAL_A = 'g_aaa000000001'
const GOAL_B = 'g_bbb000000002'
const TASK_A = 't_aaa000000001'
const MISSING_GOAL = 'g_missing000001'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'along-bridge-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

/** Records the calls the API forwards and replays scripted receipts (the inbox module owns the real machine). */
function stubInbox(receipts: AlongEventReceipt[] = []) {
  const calls: { envelope: unknown; identity: unknown }[] = []
  return {
    calls,
    acceptEvent(envelope: unknown, identity: unknown) {
      calls.push({ envelope, identity })
      return receipts.shift() ?? { status: 'accepted' as const, event_id: (envelope as { event_id: string }).event_id }
    },
  }
}

/** Settings stand-in satisfying `Pick<Settings,'block'|'save'>`; records every policy save. */
function fakeSettings() {
  const state = { revision: 1, policy: { rules: [], sources: {} } as Record<string, unknown>, saves: [] as { value: unknown; origin: string }[] }
  return {
    state,
    block(block: string) {
      if (block !== 'policy') throw new Error(`unexpected block ${block}`)
      return { block, revision: state.revision, value: state.policy }
    },
    async save(block: string, value: unknown, revision: number, origin: string) {
      expect(block).toBe('policy')
      state.saves.push({ value, origin })
      state.policy = value as Record<string, unknown>
      state.revision = revision + 1
      return { saved: true, revision: state.revision, policy_changed: true, restarting: false, context_delivery: 'injected' as const }
    },
  }
}

function seededHost(options: { receipts?: AlongEventReceipt[]; withService?: boolean; file?: string; hostOverrides?: Partial<AlongApiHost> } = {}) {
  const store = new AlongStore(join(directory, options.file ?? 'along.sqlite'))
  store.assertUser(USER_A, DEVICE_A)
  store.insertGoal({ userId: USER_A, domain: 'health', goalId: GOAL_A })
  store.appendGoalRevision({ goalId: GOAL_A, userId: USER_A, title: '每周运动 120 分钟', metric: { type: 'workout', target: 120, unit: '分钟', period: 'week' }, status: 'active' })
  store.ensureInputVersion(USER_A, GOAL_A)
  store.insertTask({ goalId: GOAL_A, userId: USER_A, content: '今天散步 30 分钟', taskId: TASK_A })
  store.appendMessage({ userId: USER_A, eventId: 'e1', role: 'user', direction: 'inbound', text: '帮我把目标调到每周 150 分钟' })
  store.linkMessageToGoals(`msg:${USER_A}:e1`, [GOAL_A], 'direct')
  store.appendSync({ userId: USER_A, kind: 'message', messageId: `msg:${USER_A}:e1`, payload: { text: '帮我把目标调到每周 150 分钟' } })
  // The other user's slice: same database, different pairing identity.
  store.insertGoal({ userId: USER_B, domain: 'finance', goalId: GOAL_B })
  const inbox = stubInbox(options.receipts)
  const settings = fakeSettings()
  const host: AlongApiHost = {
    ...(options.withService === false ? {} : { along: new AlongService(store, { inbox }) }),
    ready: () => true,
    bridgeToken: BRIDGE_TOKEN,
    settings,
    ...options.hostOverrides,
  }
  return { store, inbox, settings, host }
}

const envelope = (extra: Record<string, unknown> = {}) => ({
  event_id: 'evt-1', schema_version: '1', event_type: 'along.user_message',
  occurred_at: '2026-11-15T08:00:00Z', timezone: 'Asia/Shanghai',
  payload: { event_type: 'along.user_message', text: '把运动目标调高一点' }, ...extra,
})

function call(host: AlongApiHost, method: string, path: string, init: {
  /** `undefined` → the shared BRIDGE_TOKEN; `null` → header absent. */
  token?: string | null; bridge?: boolean; user?: string; device?: string; query?: Record<string, string>; body?: unknown
} = {}) {
  const token = init.token === undefined ? BRIDGE_TOKEN : init.token
  return alongSourceRequest(host, {
    method, path, query: new URLSearchParams(init.query ?? {}),
    headers: {
      ...(init.bridge === false ? {} : { 'x-along-bridge': '1' }),
      ...(token === null ? {} : { 'x-along-bridge-token': token }),
      'x-along-user': init.user,
      'x-along-device': init.device,
    },
    body: async () => init.body,
  })
}
/** A correctly authenticated call as user A (the Host's bound pairing session). */
const asA = (host: AlongApiHost, method: string, path: string, init: { query?: Record<string, string>; body?: unknown } = {}) =>
  call(host, method, path, { ...init, user: USER_A, device: DEVICE_A })

describe('bridge auth (every /along-source/api route, fail closed)', () => {
  it('answers 401 without the marker header, without a token, or with a wrong token', async () => {
    const { host } = seededHost()
    expect((await call(host, 'GET', 'goals/along-status-probe', { bridge: false })).status).toBe(401)
    expect((await call(host, 'GET', 'goals/along-status-probe', { token: null })).status).toBe(401)
    expect((await call(host, 'GET', 'goals/along-status-probe', { token: 'b'.repeat(64) })).status).toBe(401)
    expect((await call(host, 'GET', 'goals', { token: null, query: { user_id: USER_A } })).status).toBe(401)
    // Fail closed when the Along Agent itself has no token configured.
    const unconfigured = seededHost({ hostOverrides: { bridgeToken: undefined }, file: 'unconfigured.sqlite' })
    expect((await asA(unconfigured.host, 'GET', 'goals/along-status-probe')).status).toBe(401)
  })

  it('answers 403 when the bound identity headers are missing or malformed', async () => {
    const { host } = seededHost()
    expect((await call(host, 'GET', 'goals/along-status-probe')).status).toBe(403)
    expect((await call(host, 'GET', 'goals/along-status-probe', { user: 'someone', device: DEVICE_A })).status).toBe(403)
    expect((await call(host, 'GET', 'goals/along-status-probe', { user: USER_A, device: 'd_wrong' })).status).toBe(403)
  })
})

describe('BC-07-04: a body that claims identity is refused before any parsing', () => {
  it('rejects an event envelope carrying user_id/device_id and never reaches the inbox', async () => {
    const { host, inbox } = seededHost()
    const claimed = await asA(host, 'POST', 'events', { body: envelope({ user_id: USER_B }) })
    expect(claimed).toEqual({ status: 400, body: { status: 'rejected', event_id: 'evt-1', reason: 'identity_in_body' } })
    expect((await asA(host, 'POST', 'events', { body: envelope({ device_id: DEVICE_B }) })).body).toMatchObject({ reason: 'identity_in_body' })
    expect(inbox.calls).toEqual([])
  })

  it('rejects a body without a legal event id as invalid_envelope, also without an inbox call', async () => {
    const { host, inbox } = seededHost()
    expect((await asA(host, 'POST', 'events', { body: { schema_version: '1' } })).status).toBe(400)
    expect((await asA(host, 'POST', 'events', { body: envelope({ event_id: 'bad id!' }) })).body).toMatchObject({ reason: 'invalid_envelope' })
    expect(inbox.calls).toEqual([])
  })
})

describe('BC-07-05: another user\'s goal is a plain 404 that leaks nothing', () => {
  it('answers missing and not-owned with one identical 404 body', async () => {
    const { host } = seededHost()
    const foreign = await asA(host, 'GET', `goals/${GOAL_B}`)
    const missing = await asA(host, 'GET', `goals/${MISSING_GOAL}`)
    expect(foreign.status).toBe(404)
    expect(foreign.body).toEqual(missing.body)
    expect(JSON.stringify(foreign.body)).not.toContain(USER_B)
    expect(JSON.stringify(foreign.body)).not.toContain(GOAL_B)
  })

  it('refuses a query user_id that disagrees with the bound identity (403)', async () => {
    const { host } = seededHost()
    expect((await asA(host, 'GET', 'goals', { query: { user_id: USER_B } })).status).toBe(403)
    expect((await asA(host, 'GET', 'tasks', { query: { user_id: USER_B } })).status).toBe(403)
    expect((await asA(host, 'GET', 'sync', { query: { user_id: USER_B } })).status).toBe(403)
  })

  it('keeps the other user\'s rows out of every paged answer of user A', async () => {
    const { host } = seededHost()
    for (const [path, query] of [['goals', { user_id: USER_A }], ['tasks', { user_id: USER_A }], ['sync', { user_id: USER_A, after_seq: '0' }]] as const) {
      const response = await asA(host, 'GET', path, { query })
      expect(response.status).toBe(200)
      expect(JSON.stringify(response.body)).not.toContain(USER_B)
      expect(JSON.stringify(response.body)).not.toContain(GOAL_B)
    }
  })
})

describe('pairing registration (POST /pairing)', () => {
  it('upserts the user row, adds the user to sources.along.allowed, and stays idempotent', async () => {
    const { store, settings, host } = seededHost()
    const first = await asA(host, 'POST', 'pairing', { body: { user_id: USER_A, device_id: DEVICE_A } })
    expect(first).toEqual({ status: 200, body: { registered: true, user_id: USER_A, device_id: DEVICE_A } })
    expect(settings.state.saves).toHaveLength(1)
    expect(settings.state.saves[0]?.origin).toBe('sync')
    expect(settings.state.policy).toMatchObject({ sources: { along: { allowed: [{ id: USER_A }] } } })
    // Re-pairing (device replacement): the Host re-binds wholesale — same user, new device in headers and body.
    const rebind = await call(host, 'POST', 'pairing', { user: USER_A, device: 'd_cccc3333', body: { user_id: USER_A, device_id: 'd_cccc3333' } })
    expect(rebind.status).toBe(200)
    expect(settings.state.saves).toHaveLength(1)
    const row = new DatabaseSync(join(directory, 'along.sqlite')).prepare('SELECT device_id FROM user WHERE id = ?').get(USER_A)
    expect(row).toMatchObject({ device_id: 'd_cccc3333' })
    store.close()
  })

  it('refuses a registration body that disagrees with the bound identity or the id shapes', async () => {
    const { host } = seededHost()
    expect((await asA(host, 'POST', 'pairing', { body: { user_id: USER_B, device_id: DEVICE_B } })).status).toBe(403)
    expect((await asA(host, 'POST', 'pairing', { body: { user_id: 'someone', device_id: DEVICE_A } })).status).toBe(400)
    expect((await asA(host, 'POST', 'pairing', { body: { user_id: USER_A, device_id: DEVICE_A, name: 'x' } })).status).toBe(400)
  })
})

describe('event receipts map to the contract status codes', () => {
  const cases: { receipt: AlongEventReceipt; status: number }[] = [
    { receipt: { status: 'accepted', event_id: 'evt-1', received_seq: 7 }, status: 200 },
    { receipt: { status: 'duplicate', event_id: 'evt-1' }, status: 200 },
    { receipt: { status: 'conflict', event_id: 'evt-1' }, status: 409 },
    { receipt: { status: 'rejected', event_id: 'evt-1', reason: 'unsupported_kind' }, status: 400 },
  ]
  for (const { receipt, status } of cases) {
    it(`maps ${receipt.status} → ${status}`, async () => {
      const { host, inbox } = seededHost({ receipts: [receipt] })
      const response = await asA(host, 'POST', 'events', { body: envelope({ goal_id: GOAL_A }) })
      expect(response.status).toBe(status)
      expect(response.body).toEqual(receipt)
      expect(inbox.calls[0]?.identity).toEqual({ userId: USER_A, deviceId: DEVICE_A })
    })
  }

  it('answers 503 while the inbox module is not installed', async () => {
    const store = new AlongStore(join(directory, 'along.sqlite'))
    const host: AlongApiHost = { along: new AlongService(store), ready: () => false, bridgeToken: BRIDGE_TOKEN, settings: fakeSettings() }
    expect((await asA(host, 'POST', 'events', { body: envelope() }))).toEqual({ status: 503, body: { error: 'along_source_not_ready' } })
    store.close()
  })
})

describe('reads, sync pull and ack', () => {
  it('serves the status probe, paged reads and goal detail', async () => {
    const { host } = seededHost()
    expect(await asA(host, 'GET', 'goals/along-status-probe')).toEqual({ status: 200, body: { service: 'along-source', ready: true } })
    const goals = await asA(host, 'GET', 'goals', { query: { user_id: USER_A } })
    expect(goals.status).toBe(200)
    expect(goals.body).toMatchObject({ items: [{ id: GOAL_A, userId: USER_A, domain: 'health' }] })
    const detail = await asA(host, 'GET', `goals/${GOAL_A}`)
    expect(detail.status).toBe(200)
    expect(detail.body).toMatchObject({ goal: { id: GOAL_A }, tasks: [{ id: TASK_A }], recentChangesets: [] })
    const messages = await asA(host, 'GET', `goals/${GOAL_A}/messages`, { query: { limit: '50' } })
    expect(messages.status).toBe(200)
    expect(messages.body).toMatchObject({ items: [{ id: `msg:${USER_A}:e1`, text: '帮我把目标调到每周 150 分钟', goals: [{ goalId: GOAL_A, relation: 'direct' }] }] })
    expect((await asA(host, 'GET', `goals/${GOAL_A}/messages`, { query: { limit: '51' } })).status).toBe(200)
    expect((await asA(host, 'GET', `goals/${GOAL_A}/changesets`)).status).toBe(200)
  })

  it('answers 400 on a garbage page cursor or an unknown task status', async () => {
    const { host } = seededHost()
    expect((await asA(host, 'GET', 'goals', { query: { user_id: USER_A, cursor: 'garbage' } })).status).toBe(400)
    expect((await asA(host, 'GET', 'tasks', { query: { user_id: USER_A, status: 'finished' } })).status).toBe(400)
    expect((await asA(host, 'GET', `goals/${GOAL_A}/messages`, { query: { before_seq: '-1' } })).status).toBe(400)
  })

  it('pulls the sync page and backfills delivered_at on ack', async () => {
    const { store, host } = seededHost()
    const page = await asA(host, 'GET', 'sync', { query: { user_id: USER_A, after_seq: '0' } })
    expect(page.status).toBe(200)
    const seq = (page.body as { items: { seq: number }[] }).items[0]!.seq
    expect(await asA(host, 'POST', 'sync/ack', { body: { seqs: [seq] } })).toEqual({ status: 200, body: { acked: 1 } })
    expect(store.syncPage(USER_A, 0, 10).items[0]?.deliveredAt).toBeDefined()
    expect((await asA(host, 'POST', 'sync/ack', { body: { seqs: [0] } })).status).toBe(400)
    expect((await asA(host, 'POST', 'sync/ack', { body: { seqs: '1' } })).status).toBe(400)
  })
})

describe('readiness', () => {
  it('answers 503 on the probe and data routes until the service is assembled', async () => {
    const { host } = seededHost({ withService: false })
    expect(await asA(host, 'GET', 'goals/along-status-probe')).toEqual({ status: 503, body: { error: 'along_source_not_ready' } })
    expect((await asA(host, 'GET', 'goals', { query: { user_id: USER_A } })).status).toBe(503)
    expect((await asA(host, 'POST', 'pairing', { body: { user_id: USER_A, device_id: DEVICE_A } })).status).toBe(503)
    expect((await asA(host, 'POST', 'events', { body: envelope() })).status).toBe(503)
  })

  it('answers 404 for an unknown route under the prefix', async () => {
    const { host } = seededHost()
    expect((await asA(host, 'GET', 'nothing/here')).status).toBe(404)
  })
})
