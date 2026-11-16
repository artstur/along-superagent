/** A worker's background work in DSH: waiting for its shell jobs and subagents, and stopping them. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import { stopBackground, stopSubagents, untilQuiet } from '../src/executor/background.ts'
import { jobRegistry } from './fixtures/host.ts'

/** A context with DSH's job registry and subagents, and an idle worker agent with one live subagent, `child-1`. */
function setup(waitForChildren: (agent: Agent) => Promise<boolean>, drainChildren: () => Promise<void> = async () => {}) {
  const jobs = jobRegistry()
  const agent = { id: 'worker-t1', status: 'idle', whenIdle: async () => {}, inbox: { nextTurn: [], nextStep: [] }, cancel: vi.fn() } as unknown as
    Agent & { status: string; cancel: ReturnType<typeof vi.fn> }
  const subagents = { waitForChildren: vi.fn(waitForChildren), listChildren: async () => [{ id: 'child-1' }], drainChildren: vi.fn(drainChildren) }
  const services: Record<string, unknown> = { jobs: jobs.service, subagents }
  const ctx = { get: (name: string) => services[name], agents: { get: () => agent } } as unknown as Context
  return { ctx, agent, jobs, subagents }
}

it('is not quiet when an end during the subagent check woke the worker, whose own idle looks again', async () => {
  const { ctx, agent, jobs } = setup(async () => {
    // The job settles meanwhile, and its end wakes the worker.
    jobs.end(id); (agent as { status: string }).status = 'running'
    return false
  })
  const id = jobs.run('worker-t1')
  expect(await untilQuiet(ctx, agent, new AbortController().signal)).toBe(false)
})

it('stops waiting for subagents that never settle once the host stops', async () => {
  let joining!: () => void
  const joined = new Promise<void>(resolve => { joining = resolve })
  const { ctx, agent } = setup(() => { joining(); return new Promise(() => {}) })
  const stop = new AbortController()
  const quiet = untilQuiet(ctx, agent, stop.signal)
  // The host stops while the wait for its subagents runs.
  await joined
  stop.abort()
  expect(await quiet).toBe(false)
})

it('looks at the jobs only when one ends, not at each output of a noisy one', async () => {
  const { ctx, agent, jobs } = setup(async () => false)
  const id = jobs.run('worker-t1')
  const stop = new AbortController()
  const quiet = untilQuiet(ctx, agent, stop.signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  const looked = jobs.service.list.mock.calls.length
  for (let line = 0; line < 100; line++) jobs.output(id)
  expect(jobs.service.list.mock.calls.length).toBe(looked)
  jobs.end(id)
  expect(await quiet).toBe(true)
})

it('joins a worker\'s subagents once for the looks that wait on them, as DSH cannot cancel the join', async () => {
  const { ctx, agent, subagents } = setup(() => new Promise(() => {}))
  for (let look = 0; look < 3; look++) {
    const stop = new AbortController()
    const quiet = untilQuiet(ctx, agent, stop.signal)
    stop.abort()
    expect(await quiet).toBe(false)
  }
  expect(subagents.waitForChildren).toHaveBeenCalledTimes(1)
})

it('gives up a release of subagents that does not end within 10 seconds, and cancels the turn their ends woke', async () => {
  const { ctx, agent } = setup(async () => false, () => new Promise(() => {}))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    let stopped = false
    const stopping = stopSubagents(ctx, agent).then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await stopping
  } finally { vi.useRealTimers() }
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
})

/** The actual 0.2.2 service names, deliberately without the removed 0.2.1 methods. */
function treeSetup() {
  const agent = { id: 'worker-new', status: 'idle', whenIdle: async () => {}, cancel: vi.fn() } as unknown as Agent & { cancel: ReturnType<typeof vi.fn> }
  const children = new Map<string, { id: string; cancel: ReturnType<typeof vi.fn>; whenIdle: () => Promise<void> }>()
  const service = {
    listDescendants: vi.fn(async (_id: string): Promise<{kind:'child'|'diagnostic';id:string;activity:string;mode?:string}[]> =>
      [...children.keys()].map(id => ({ kind: 'child', id, activity: 'running' }))),
    interrupt: vi.fn((_id: string, _authority: unknown) => {}),
    waitForTreeWork: vi.fn(async (_root: Agent) => false),
    // This is a terminal teardown API: it must not be used on reusable worker roots.
    drainDescendants: vi.fn(async () => { throw new Error('tree admission permanently closed') }),
  }
  const ctx = { get: (name: string) => name === 'subagents' ? service : undefined,
    agents: { get: (id: string) => id === agent.id ? agent : children.get(id) } } as unknown as Context
  return { ctx, agent, children, service }
}

it('ends a real-shaped 0.2.2 worker with no children without the removed listChildren API', async () => {
  const h=treeSetup()
  await expect(stopBackground(h.ctx,h.agent.id,'completed')).resolves.toBeUndefined()
  expect(h.service.listDescendants).toHaveBeenCalledWith(h.agent.id)
  expect(h.agent.cancel).not.toHaveBeenCalled()
  expect(h.service.drainDescendants).not.toHaveBeenCalled()
})

it('joins background work through the 0.2.2 tree API when a worker becomes idle', async () => {
  const h=treeSetup()
  expect(await untilQuiet(h.ctx,h.agent,new AbortController().signal)).toBe(true)
  expect(h.service.waitForTreeWork).toHaveBeenCalledWith(h.agent)
})

it('stops scoped 0.2.2 descendants including parked local input without closing future tree admission', async () => {
  const h=treeSetup(),child={id:'child-new',cancel:vi.fn(),whenIdle:vi.fn(async()=>{})}
  h.children.set(child.id,child)
  h.service.listDescendants.mockResolvedValueOnce([
    {kind:'child',id:child.id,activity:'running'},
    {kind:'child',id:'cold-history',activity:'inactive'},
    {kind:'child',id:'external-child',activity:'running'},
  ])
  await stopSubagents(h.ctx,h.agent,true)
  expect(h.service.interrupt).toHaveBeenCalledWith(child.id,{kind:'ancestor',agent:h.agent})
  expect(h.service.interrupt).toHaveBeenCalledWith('external-child',{kind:'ancestor',agent:h.agent})
  expect(h.service.interrupt).not.toHaveBeenCalledWith('cold-history',expect.anything())
  expect(child.cancel).toHaveBeenCalledWith({kind:'parent'},{keepInbox:false})
  expect(child.whenIdle).toHaveBeenCalled()
  expect(h.agent.cancel).toHaveBeenCalledWith({kind:'user'},{keepInbox:true})
  expect(h.service.waitForTreeWork).toHaveBeenCalledWith(h.agent)
  expect(h.service.drainDescendants).not.toHaveBeenCalled()
  // A later assignment can still use this exact worker root.
  await stopSubagents(h.ctx,h.agent)
  expect(h.service.drainDescendants).not.toHaveBeenCalled()
})

it('keeps genuine 0.2.2 interruption failures visible and still stops the other descendants', async () => {
  const h=treeSetup()
  for(const id of ['bad','good'])h.children.set(id,{id,cancel:vi.fn(),whenIdle:async()=>{}})
  h.service.interrupt.mockImplementationOnce(()=>{throw new Error('real cleanup failure')})
  await expect(stopBackground(h.ctx,h.agent.id,'completed')).rejects.toBeInstanceOf(AggregateError)
  expect(h.service.interrupt).toHaveBeenCalledWith('good',{kind:'ancestor',agent:h.agent})
  expect(h.agent.cancel).toHaveBeenCalled()
})

it('interrupts external activations whose catalog is inactive without cancelling a parent for finished history', async () => {
  const h=treeSetup()
  h.service.listDescendants.mockResolvedValue([{kind:'child',id:'external',activity:'inactive',mode:'external'}])
  h.service.waitForTreeWork.mockResolvedValueOnce(true)
  await stopSubagents(h.ctx,h.agent)
  expect(h.service.interrupt).toHaveBeenCalledWith('external',{kind:'ancestor',agent:h.agent})
  expect(h.agent.cancel).toHaveBeenCalledOnce()
  // Historical external rows remain in the catalog, but interrupt is an accepted no-op after settlement.
  h.agent.cancel.mockClear()
  await stopSubagents(h.ctx,h.agent)
  expect(h.agent.cancel).not.toHaveBeenCalled()
})
