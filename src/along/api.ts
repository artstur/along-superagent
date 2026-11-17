/**
 * The Host↔Along Agent loopback API (design §2.4/§4.2, SD-2): routes under `/along-source/api/*`, registered next to
 * `/orchestrator` on the same loopback-only web server. This module owns the contract's enforcement side;
 * `host/along-bridge.mjs` in the `along` repository is the calling side.
 *
 * Access boundary (AGENTS.md §5, 001 §4.2):
 * - Auth covers **every** route with `x-along-bridge: 1` + `x-along-bridge-token` (timing-safe compare). The
 *   token lives in a 0600 file on this Mac, exists only in the two Mac-local process memories, and never
 *   reaches the iPhone, a Worker environment, or a response body. No token configured → 401 (fail closed).
 * - Identity is the Host's server-bound pairing session, passed as `x-along-user`/`x-along-device` headers —
 *   never taken from a request body. An event/query body that claims `user_id`/`device_id` is refused
 *   (`identity_in_body`, BC-07-04). A query `user_id` that disagrees with the bound identity is 403.
 * - Ownership: reads go through `AlongStore` methods that check ownership themselves; missing and not-owned
 *   answer the same 404 `{error:'not_found'}` body so existence never leaks (BC-07-05).
 * - The `/orchestrator` management plane stays loopback + same-origin and is not registered as a phone path;
 *   `/along-source` serves only bridge calls from the local Host.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { z } from 'zod'
import { SettingsConflict, type Settings } from '../app/settings.ts'
import { UserError } from '../core/index.ts'
import type { AlongEventEnvelope, AlongEventReceipt, AlongIdentity, AlongService } from './service.ts'
import { OwnershipError } from './store.ts'
import { TaskReviewError } from './task-repair.ts'
import { SourceStateError } from './source-state.ts'

/** What the Runtime assembly hands this API: the business service (503 until assembled), the bridge token read
 * from `alongBridgeTokenFile`, and the Settings facade used to add the paired user to `sources.along.allowed`. */
export interface AlongApiHost {
  /** The assembled Along business service; `undefined` until the local-deployment assembly finishes → 503. */
  readonly along?: AlongService
  /** Expected bridge token (the hex content of the 0600 token file); unset → every call is 401. */
  readonly bridgeToken?: string
  /** Settings facade; the paired user lands in `policy.sources.along.allowed` through `save('policy', …)`. */
  readonly settings: Pick<Settings, 'block' | 'save'>
}

/** One already-parsed loopback call; `path` is relative to the `/along-source/api/` prefix. */
export interface AlongSourceRequest {
  method: string
  path: string
  query: URLSearchParams
  headers: Record<string, string | string[] | undefined>
  /** Reads the JSON body; only invoked for the POST routes that need one. */
  body: () => Promise<unknown>
}
export interface AlongSourceResponse { status: number; body: unknown }

/** Loopback-layer rejection with a fixed code; bodies never carry tokens or internal details. */
class AlongApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}

// Server-generated identity shapes (design §2.4.1: `u_`/`d_` + 8 hex from the Host's pairing session).
const USER_ID_SHAPE = /^u_[0-9a-f]{8}$/
const DEVICE_ID_SHAPE = /^d_[0-9a-f]{8}$/
/** Client stable event id — the envelope schema's `ID` shape (design §4.1). */
const EVENT_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/
const MAX_BODY_BYTES = 128 * 1024
const MAX_PAGE_LIMIT = 200
/** Full-conversation pages cap at 50 (design §4.2), stricter than the store's 200. */
const MAX_MESSAGE_LIMIT = 50
const ACK_MAX_SEQS = 500

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const header = (headers: AlongSourceRequest['headers'], name: string): string | undefined => {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

// ---- auth & identity (BC-07-04/05 at the interface layer) ------------------------------------------------------------

/**
 * Bridge auth for every `/along-source/api/*` route: marker header plus the shared token, compared as sha256
 * digests so `timingSafeEqual` is length-safe and constant-time over the secret.
 */
function bridgeAuthorized(host: AlongApiHost, headers: AlongSourceRequest['headers']): boolean {
  if (header(headers, 'x-along-bridge') !== '1') return false
  const expected = host.bridgeToken
  const provided = header(headers, 'x-along-bridge-token')
  if (!expected || !provided) return false
  return timingSafeEqual(createHash('sha256').update(expected).digest(), createHash('sha256').update(provided).digest())
}

/** The Host's server-bound identity from the pairing session; a missing or malformed header is 403 (design §4.2). */
function boundIdentity(headers: AlongSourceRequest['headers']): AlongIdentity {
  const userId = header(headers, 'x-along-user') ?? ''
  const deviceId = header(headers, 'x-along-device') ?? ''
  if (!USER_ID_SHAPE.test(userId) || !DEVICE_ID_SHAPE.test(deviceId)) throw new AlongApiError(403, 'invalid_identity')
  return { userId, deviceId }
}

/** a0 (design §2.2.1a0) at the interface layer: a body claiming `user_id`/`device_id` is refused outright. */
const claimsIdentity = (body: unknown): boolean => isRecord(body) && ('user_id' in body || 'device_id' in body)

// ---- parameters ------------------------------------------------------------------------------------------------------

function intParam(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name)
  if (raw === null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value)) throw new AlongApiError(400, 'invalid_param')
  return value
}
const pageLimit = (query: URLSearchParams, cap: number): number => Math.max(1, Math.min(cap, intParam(query, 'limit', 50)))
/** Keyset-paged reads: the opaque `nextCursor` round-trips through `cursor` (store `PageCursor`). */
function keysetCursor(query: URLSearchParams, cap = MAX_PAGE_LIMIT): { cursor?: string; limit: number } {
  const cursor = query.get('cursor')
  return { cursor: cursor === null || cursor === '' ? undefined : cursor, limit: pageLimit(query, cap) }
}
/** Seq-paged reads (`messages`): `before_seq`/`cursor` continue into older pages (BC-08-07 ordering). */
function seqCursor(query: URLSearchParams, cap = MAX_MESSAGE_LIMIT): { beforeSeq?: number; cursor?: string; limit: number } {
  const raw = query.get('before_seq')
  const beforeSeq = raw === null || raw === '' ? undefined : intParam(query, 'before_seq', 0)
  if (beforeSeq !== undefined && beforeSeq < 0) throw new AlongApiError(400, 'invalid_param')
  return { beforeSeq, cursor: query.get('cursor') ?? undefined, limit: pageLimit(query, cap) }
}
/** Query identity must equal the bound identity — a caller cannot read another user's slice (BC-07-05). */
function requireQueryUser(query: URLSearchParams, identity: AlongIdentity): void {
  if (query.get('user_id') !== identity.userId) throw new AlongApiError(403, 'identity_mismatch')
}

// ---- routes ----------------------------------------------------------------------------------------------------------

const PairingSchema = z.object({ user_id: z.string().regex(USER_ID_SHAPE), device_id: z.string().regex(DEVICE_ID_SHAPE) }).strict()
const SyncAckSchema = z.object({ seqs: z.array(z.number().int().min(1)).min(1).max(ACK_MAX_SEQS) }).strict()

/** Receipt-shaped rejection body; echoes a legal `event_id` so the phone can match its queued item (§2.2.7). */
function rejectedReceipt(body: unknown, reason: string): AlongSourceResponse {
  const eventId = isRecord(body) && typeof body.event_id === 'string' && EVENT_ID_SHAPE.test(body.event_id) ? body.event_id : undefined
  return { status: 400, body: { status: 'rejected', ...(eventId ? { event_id: eventId } : {}), reason } }
}

function receiptResponse(receipt: AlongEventReceipt): AlongSourceResponse {
  if (receipt.status === 'accepted' || receipt.status === 'duplicate') return { status: 200, body: receipt }
  if (receipt.status === 'conflict') return { status: 409, body: receipt }
  return { status: 400, body: receipt }
}

/** POST /events → the inbox receive state machine; the raw body is passed through unvalidated-on-this-layer
 * (the inbox owns the envelope schema), with two explicit interface-layer refusals ahead of it (a0 + event id). */
function acceptEvent(service: AlongService | undefined, identity: AlongIdentity, body: unknown): AlongSourceResponse {
  if (claimsIdentity(body)) return rejectedReceipt(body, 'identity_in_body')
  if (!isRecord(body) || typeof body.event_id !== 'string' || !EVENT_ID_SHAPE.test(body.event_id)) {
    return rejectedReceipt(body, 'invalid_envelope')
  }
  if (service === undefined) throw new AlongApiError(503, 'along_source_not_ready')
  return receiptResponse(service.acceptEvent(body as unknown as AlongEventEnvelope, identity))
}

type PolicyPart = { allowed?: { id: string; name?: string }[] } & Record<string, unknown>
type PolicyValue = { sources?: Record<string, PolicyPart> } & Record<string, unknown>

/** Idempotently adds the paired user to `policy.sources.along.allowed` (design §2.4.1) via the Settings facade;
 * an unchanged list saves nothing. `SettingsConflict` surfaces as 409 so the Host simply retries. */
async function addAllowedUser(host: AlongApiHost, userId: string): Promise<void> {
  const { revision, value } = host.settings.block('policy')
  const policy = (isRecord(value) ? value : {}) as PolicyValue
  const allowed = policy.sources?.along?.allowed ?? []
  if (allowed.some(entry => entry.id === userId)) return
  const merged = { ...policy, sources: { ...policy.sources, along: { ...policy.sources?.along, allowed: [...allowed, { id: userId }] } } }
  await host.settings.save('policy', merged, revision, 'sync')
}

/** POST /pairing → upsert the user row (re-pairing re-binds the device) and allow the user to originate work. */
async function registerPairing(host: AlongApiHost, identity: AlongIdentity, body: unknown): Promise<AlongSourceResponse> {
  const input = PairingSchema.parse(body)
  if (input.user_id !== identity.userId || input.device_id !== identity.deviceId) throw new AlongApiError(403, 'identity_mismatch')
  const service = host.along
  if (service === undefined) throw new AlongApiError(503, 'along_source_not_ready')
  service.alongStore.assertUser(input.user_id, input.device_id)
  await addAllowedUser(host, input.user_id)
  return { status: 200, body: { registered: true, user_id: input.user_id, device_id: input.device_id } }
}

async function route(host: AlongApiHost, identity: AlongIdentity, method: string, path: string,
  query: URLSearchParams, body: () => Promise<unknown>): Promise<AlongSourceResponse> {
  const ok = (value: unknown): AlongSourceResponse => ({ status: 200, body: value })
  // The status probe must win over `goals/:goal_id` — the Host's readiness check tolerates only 404/2xx.
  if (method === 'GET' && path === 'goals/along-status-probe') return ok({ service: 'along-source', ready: true })
  if (method === 'POST' && path === 'pairing') return registerPairing(host, identity, await body())
  if (method === 'POST' && path === 'events') return acceptEvent(host.along, identity, await body())
  const service = host.along
  if (service === undefined) throw new AlongApiError(503, 'along_source_not_ready')
  const store = service.alongStore
  if(method==='POST'&&path==='maintenance/task-trigger-reviews') {
    const input=await body()
    if(claimsIdentity(input))throw new AlongApiError(400,'identity_in_body')
    return ok(service.requestTaskTriggerReview(identity,input))
  }
  if(method==='POST'&&(path==='source-events'||path==='source-read-results')) {
    const input=await body()
    if(claimsIdentity(input))throw new AlongApiError(400,'identity_in_body')
    const receipt=path==='source-events'?store.sources.acceptEvent(identity,input):store.sources.acceptReadResult(identity,input)
    return {status:receipt.status==='conflict'?409:receipt.status==='rejected'?400:200,body:receipt}
  }
  if(method==='GET'&&path==='source-reads') {
    requireQueryUser(query,identity)
    return ok({requests:store.sources.pendingReads(identity.userId)})
  }
  if (method === 'GET' && path === 'goals') { requireQueryUser(query, identity); return ok(store.listGoals(identity.userId, keysetCursor(query))) }
  const detail = /^goals\/([^/]+)$/.exec(path)
  if (method === 'GET' && detail) return ok(store.goalDetail(identity.userId, detail[1]!))
  const messages = /^goals\/([^/]+)\/messages$/.exec(path)
  if (method === 'GET' && messages) return ok(store.messagesByGoal(identity.userId, messages[1]!, seqCursor(query)))
  const changesets = /^goals\/([^/]+)\/changesets$/.exec(path)
  if (method === 'GET' && changesets) return ok(store.changeSetsByGoal(identity.userId, changesets[1]!, keysetCursor(query)))
  if (method === 'GET' && path === 'tasks') {
    requireQueryUser(query, identity)
    const status = query.get('status')
    if (status !== null && !['open', 'done', 'cancelled'].includes(status)) throw new AlongApiError(400, 'invalid_param')
    return ok(store.listTasks(identity.userId, status === null ? {} : { status: status as 'open' | 'done' | 'cancelled' }, keysetCursor(query)))
  }
  if (method === 'GET' && path === 'sync') {
    requireQueryUser(query, identity)
    const afterSeq = intParam(query, 'after_seq', 0)
    if (afterSeq < 0) throw new AlongApiError(400, 'invalid_param')
    const conversationVersion = query.get('conversation_version')
    if (conversationVersion !== null && conversationVersion !== '1') throw new AlongApiError(400, 'invalid_param')
    return ok(store.workspaceSync(identity.userId, afterSeq, pageLimit(query, MAX_PAGE_LIMIT), conversationVersion === '1' ? 1 : 0))
  }
  if (method === 'POST' && path === 'sync/ack') {
    const input = SyncAckSchema.parse(await body())
    store.markSynced(identity.userId, input.seqs)
    return ok({ acked: input.seqs.length })
  }
  throw new AlongApiError(404, 'not_found')
}

/** Maps any route error to the contract's status codes; missing and not-owned share one 404 body (BC-07-05),
 * internals never leak into the body the Host may relay to the phone. */
function failure(error: unknown): AlongSourceResponse {
  if (error instanceof OwnershipError) return { status: 404, body: { error: 'not_found' } }
  if (error instanceof TaskReviewError) return {status:400,body:{error:error.code}}
  if (error instanceof SourceStateError) return { status: 400, body: { error: error.code } }
  if (error instanceof AlongApiError) return { status: error.status, body: { error: error.code } }
  if (error instanceof SettingsConflict) return { status: 409, body: { error: 'conflict' } }
  if (error instanceof UserError) return { status: 400, body: { error: 'invalid_request' } }
  if (error instanceof z.ZodError) return { status: 400, body: { error: 'invalid_request' } }
  // `AlongStore`'s documented cursor error and the facade's not-installed errors are the only plain-Error contracts.
  if (error instanceof Error && error.message === 'invalid page cursor') return { status: 400, body: { error: 'invalid_cursor' } }
  if (error instanceof Error && error.message.endsWith('not installed')) return { status: 503, body: { error: 'along_source_not_ready' } }
  return { status: 500, body: { error: 'internal_error' } }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY_BYTES) throw new AlongApiError(400, 'request_too_large')
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new AlongApiError(400, 'invalid_json') }
}

/**
 * Runs one loopback call without HTTP plumbing — `registerAlongSource` adapts `req`/`res` onto this, and the
 * tests call it directly. Bridge auth and bound identity gate every route.
 */
export async function alongSourceRequest(host: AlongApiHost, request: AlongSourceRequest): Promise<AlongSourceResponse> {
  try {
    if (!bridgeAuthorized(host, request.headers)) return { status: 401, body: { error: 'unauthorized' } }
    const identity = boundIdentity(request.headers)
    return await route(host, identity, request.method, request.path, request.query, request.body)
  } catch (error) { return failure(error) }
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}

/** Registers the loopback routes next to `/orchestrator` (design §2.7.1); the web server is loopback-only, and
 * `/along-source` is never a phone-reachable path — the iPhone talks to the Host, which talks to this API. */
export function registerAlongSource(ctx: Context, host: AlongApiHost): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('The Along source API requires a loopback web server')
  return ctx.webServer.register({ kind: 'prefix', path: '/along-source', handler: async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/along-source/api/')) { res.writeHead(404); res.end(); return }
    const response = await alongSourceRequest(host, {
      method: req.method ?? 'GET',
      path: url.pathname.slice('/along-source/api/'.length),
      query: url.searchParams,
      headers: req.headers,
      body: () => readJsonBody(req),
    })
    writeJson(res, response.status, response.body)
  } })
}
