/**
 * Independent verification of the loopback API's access boundary (design §2.4/§4.2; BC-07-04/BC-07-05),
 * complementing tests/along-bridge.spec.ts with the cases that spec does not pin down:
 * - fail-closed bridge auth on **every** route family (the original spec samples two), including
 *   POST /pairing — which is exactly the call the Host's startup registration must pass;
 * - secrets (bridge token, identity headers) never echo into any response body;
 * - BC-07-05 extended to per-goal message/changeset reads and to sync/ack crossing users;
 * - BC-07-04: an identity claim nested inside the payload still reaches the inbox tagged with the
 *   **bound** identity (the interface layer never adopts a claimed identity);
 * - pairing registration stays idempotent under concurrent calls.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { alongSourceRequest, type AlongApiHost } from '../src/along/api.ts'
import { AlongService } from '../src/along/service.ts'
import { AlongStore } from '../src/along/store.ts'

const BRIDGE_TOKEN = 'b'.repeat(64)
const USER_A = 'u_aaaa1111'
const DEVICE_A = 'd_aaaa1111'
const USER_B = 'u_bbbb2222'
const GOAL_A = 'g_aaa000000001'
const GOAL_B = 'g_bbb000000002'
const TASK_A = 't_aaa000000001'
const MISSING_GOAL = 'g_missing000001'

let directory: string
let store: AlongStore
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'along-bridge-verify-'))
  store = new AlongStore(join(directory, 'along.sqlite'))
  store.assertUser(USER_A, DEVICE_A)
  store.insertGoal({ userId: USER_A, domain: 'health', goalId: GOAL_A })
  store.appendGoalRevision({ goalId: GOAL_A, userId: USER_A, title: '每周运动 120 分钟', metric: { type: 'workout', target: 120, unit: '分钟', period: 'week' }, status: 'active' })
  store.ensureInputVersion(USER_A, GOAL_A)
  store.insertTask({ goalId: GOAL_A, userId: USER_A, content: '今天散步 30 分钟', taskId: TASK_A })
  store.appendMessage({ userId: USER_A, eventId: 'e1', role: 'user', direction: 'inbound', text: '帮我把目标调到每周 150 分钟' })
  store.linkMessageToGoals(`msg:${USER_A}:e1`, [GOAL_A], 'direct')
  // The other user's slice lives in the same database — the boundary must keep it invisible.
  store.insertGoal({ userId: USER_B, domain: 'finance', goalId: GOAL_B })
  store.appendMessage({ userId: USER_B, eventId: 'b1', role: 'user', direction: 'inbound', text: '这是 B 的私聊原文' })
  store.appendSync({ userId: USER_B, kind: 'message', payload: { text: 'B 的同步项' } })
})
afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

/** Settings stand-in; records policy saves so idempotency is observable. */
function fakeSettings() {
  const state = { revision: 1, policy: { sources: {} } as Record<string, unknown>, saves: 0 }
  return {
    state,
    block: (block: string) => {
      expect(block).toBe('policy')
      return { block, revision: state.revision, value: state.policy }
    },
    save: async (block: string, value: unknown, revision: number, origin: string) => {
      expect(block).toBe('policy')
      state.saves += 1
      state.policy = value as Record<string, unknown>
      state.revision = revision + 1
      return { saved: true, revision: state.revision, policy_changed: true, restarting: false, context_delivery: 'injected' as const }
    },
  }
}

function seededHost(options: { bridgeToken?: string; inbox?: { calls: { envelope: unknown; identity: unknown }[] } } = {}) {
  const inbox = options.inbox ?? { calls: [] as { envelope: unknown; identity: unknown }[] }
  const host: AlongApiHost = {
    along: new AlongService(store, { inbox: { acceptEvent: (envelope, identity) => {
      inbox.calls.push({ envelope, identity })
      return { status: 'accepted', event_id: (envelope as { event_id: string }).event_id }
    } } }),
    // 显式传 undefined 也要生效（fail-closed 探针）：不能被 ?? 兜底吞掉。
    bridgeToken: 'bridgeToken' in options ? options.bridgeToken : BRIDGE_TOKEN,
    settings: fakeSettings() as unknown as AlongApiHost['settings'],
  }
  return { host, inbox, settings: host.settings as unknown as { state: { policy: Record<string, unknown>; saves: number } } }
}

const envelope = (extra: Record<string, unknown> = {}) => ({
  event_id: 'evt-1', schema_version: '1', event_type: 'along.user_message',
  occurred_at: '2026-11-15T08:00:00Z', timezone: 'Asia/Shanghai',
  payload: { event_type: 'along.user_message', text: '把运动目标调高一点' }, ...extra,
})

function call(host: AlongApiHost, method: string, path: string, init: {
  token?: string | null; bridge?: boolean; user?: string | string[]; device?: string | string[]; query?: Record<string, string>; body?: unknown
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
const asA = (host: AlongApiHost, method: string, path: string, init: { query?: Record<string, string>; body?: unknown } = {}) =>
  call(host, method, path, { ...init, user: USER_A, device: DEVICE_A })

describe('fail-closed bridge auth covers every route family', () => {
  const routes = [
    ['GET', 'goals/along-status-probe'],
    ['GET', 'goals'],
    ['GET', `goals/${GOAL_A}`],
    ['GET', `goals/${GOAL_A}/messages`],
    ['GET', `goals/${GOAL_A}/changesets`],
    ['GET', 'tasks'],
    ['GET', 'sync'],
    ['POST', 'sync/ack'],
    ['POST', 'events'],
    ['POST', 'pairing'],
  ] as const
  for (const [method, path] of routes) {
    it(`401 without marker / without token / with wrong token: ${method} ${path}`, async () => {
      const { host } = seededHost()
      expect((await call(host, method, path, { bridge: false })).status).toBe(401)
      expect((await call(host, method, path, { token: null })).status).toBe(401)
      expect((await call(host, method, path, { token: 'wrong' })).status).toBe(401)
    })
  }

  it('401 fail-closed when the Along Agent itself has no bridge token configured', async () => {
    const { host } = seededHost({ bridgeToken: undefined })
    for (const path of ['goals/along-status-probe', 'events', 'pairing', 'sync']) {
      const status = (await asA(host, path === 'events' || path === 'pairing' ? 'POST' : 'GET', path,
        path === 'events' ? { body: envelope() } : path === 'pairing' ? { body: { user_id: USER_A, device_id: DEVICE_A } } : {})).status
      expect(status).toBe(401)
    }
  })
})

describe('bound identity headers gate every entry point', () => {
  it('403 invalid_identity on probe, list reads and POST routes', async () => {
    const { host } = seededHost()
    for (const [method, path, init = {}] of [
      ['GET', 'goals/along-status-probe', {}],
      ['GET', 'goals', { query: { user_id: USER_A } }],
      ['POST', 'events', { body: envelope() }],
      ['POST', 'pairing', { body: { user_id: USER_A, device_id: DEVICE_A } }],
      ['POST', 'sync/ack', { body: { seqs: [1] } }],
    ] as [string, string, Record<string, unknown>][]) {
      // 桥接凭证齐全但身份头缺失/坏形——含 Host 启动注册调用若不带身份头会被拒的契约形状。
      expect((await call(host, method, path, init as never)).status).toBe(403)
      expect((await call(host, method, path, { ...init, user: 'someone', device: DEVICE_A } as never)).status).toBe(403)
      expect((await call(host, method, path, { ...init, user: USER_A, device: 'd_bad' } as never)).status).toBe(403)
    }
  })

  it('identity headers arriving as header-arrays still resolve to the first value', async () => {
    const { host } = seededHost()
    expect((await call(host, 'GET', 'goals/along-status-probe', { user: [USER_A], device: [DEVICE_A] })).status).toBe(200)
  })
})

describe('secrets and identity headers never echo into response bodies', () => {
  it('across 401/403/404/400/unknown-route responses', async () => {
    const { host } = seededHost()
    const responses = [
      await call(host, 'GET', 'goals', { token: 'wrong-token-value', user: USER_A, device: DEVICE_A }),
      await call(host, 'GET', 'goals', { user: undefined, device: undefined }),
      await asA(host, 'GET', `goals/${GOAL_B}`),
      await asA(host, 'GET', `goals/${MISSING_GOAL}`),
      await asA(host, 'GET', 'goals', { query: { user_id: USER_B } }),
      await asA(host, 'GET', 'goals', { query: { user_id: USER_A, cursor: 'garbage' } }),
      await asA(host, 'GET', 'nothing/here'),
    ]
    for (const response of responses) {
      const text = JSON.stringify(response.body)
      expect(text).not.toContain(BRIDGE_TOKEN)
      expect(text).not.toContain('wrong-token-value')
      expect(text).not.toContain(USER_A)
      expect(text).not.toContain(USER_B)
      expect(text).not.toContain(DEVICE_A)
      expect(text.toLowerCase()).not.toContain('token')
    }
  })
})

describe('BC-07-05 extended: every per-goal read of another user answers the same blind 404', () => {
  it('messages and changesets of B\'s goal match the missing-goal body exactly', async () => {
    const { host } = seededHost()
    for (const suffix of ['messages', 'changesets']) {
      const foreign = await asA(host, 'GET', `goals/${GOAL_B}/${suffix}`)
      const missing = await asA(host, 'GET', `goals/${MISSING_GOAL}/${suffix}`)
      expect(foreign.status).toBe(404)
      expect(foreign.body).toEqual(missing.body)
      const text = JSON.stringify(foreign.body)
      expect(text).not.toContain(USER_B)
      expect(text).not.toContain(GOAL_B)
      expect(text).not.toContain('B 的私聊原文')
    }
  })

  it('A acking B\'s sync seqs is a user-scoped no-op (B stays undelivered)', async () => {
    const { host } = seededHost()
    const bSeq = store.syncPage(USER_B, 0, 10).items[0]!.seq
    expect((await asA(host, 'POST', 'sync/ack', { body: { seqs: [bSeq] } })).status).toBe(200)
    expect(store.syncPage(USER_B, 0, 10).items[0]!.deliveredAt).toBeUndefined()
    // A 自己的 ack 正常回填（同一调用形状、不同身份）。
    const aSeq = store.appendSync({ userId: USER_A, kind: 'message', payload: { text: 'A 的同步项' } })
    await asA(host, 'POST', 'sync/ack', { body: { seqs: [aSeq] } })
    expect(store.syncPage(USER_A, 0, 10).items[0]!.deliveredAt).toBeDefined()
  })

  it('B\'s rows never appear in A\'s paged answers, including messages text', async () => {
    const { host } = seededHost()
    for (const [path, query] of [
      ['goals', { user_id: USER_A }],
      ['tasks', { user_id: USER_A }],
      ['sync', { user_id: USER_A, after_seq: '0' }],
      [`goals/${GOAL_A}/messages`, {}],
      [`goals/${GOAL_A}/changesets`, {}],
    ] as const) {
      const response = await asA(host, 'GET', path, { query: { ...query } })
      expect(response.status).toBe(200)
      const text = JSON.stringify(response.body)
      expect(text).not.toContain(USER_B)
      expect(text).not.toContain(GOAL_B)
      expect(text).not.toContain('B 的私聊原文')
    }
  })
})

describe('BC-07-04 at the interface layer: a claimed identity is never adopted', () => {
  it('top-level claims are refused before the inbox sees them', async () => {
    const { host, inbox } = seededHost()
    expect((await asA(host, 'POST', 'events', { body: envelope({ user_id: USER_B }) })).body).toMatchObject({ reason: 'identity_in_body' })
    expect(inbox.calls).toEqual([])
  })

  it('a claim nested inside the payload reaches the inbox tagged with the bound identity only', async () => {
    const { host, inbox } = seededHost()
    const response = await asA(host, 'POST', 'events', {
      body: envelope({ payload: { event_type: 'along.user_message', text: 'nested', user_id: USER_B } }),
    })
    expect(response.status).toBe(200) // 信封 strict 校验是 inbox 的职责，接口层放行但身份仍取绑定值
    expect(inbox.calls).toHaveLength(1)
    expect(inbox.calls[0]!.identity).toEqual({ userId: USER_A, deviceId: DEVICE_A })
    expect(JSON.stringify(inbox.calls[0]!.envelope)).toContain(USER_B) // 原样移交，由 inbox 的 strict Schema 拒绝
  })
})

describe('pairing registration is idempotent under concurrency', () => {
  it('parallel double-registration saves the allowed list once and never duplicates', async () => {
    const { host, settings } = seededHost()
    const responses = await Promise.all([
      asA(host, 'POST', 'pairing', { body: { user_id: USER_A, device_id: DEVICE_A } }),
      asA(host, 'POST', 'pairing', { body: { user_id: USER_A, device_id: DEVICE_A } }),
    ])
    for (const response of responses) expect([200, 409]).toContain(response.status)
    const allowed = (settings.state.policy as { sources?: { along?: { allowed?: { id: string }[] } } }).sources?.along?.allowed ?? []
    expect(allowed.filter(entry => entry.id === USER_A)).toHaveLength(1)
    const row = new DatabaseSync(join(directory, 'along.sqlite')).prepare('SELECT device_id FROM user WHERE id = ?').get(USER_A)
    expect(row).toMatchObject({ device_id: DEVICE_A })
  })
})
