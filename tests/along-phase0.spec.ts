/** Characterization probes for Along phase 0. Passing a blocker probe does not mean phase 0 is ready. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { setupChanged } from '../src/app/setup.ts'
import { alongKind } from '../src/sources/along.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined; vi.unstubAllEnvs() })

function trigger(id: string, human: boolean): Trigger {
  return { id, source: 'along', threads: [{ source: 'along', id: `goal/exercise/work/${id}` }],
    actor: { source: 'along', id: human ? 'phase0-user' : '' }, human,
    ...(human ? { addressed: 'direct' as const } : {}), at: new Date().toISOString(),
    text: human ? '我想每周运动 120 分钟' : '授权运动摘要更新，按已有目标调整剩余安排',
    meta: { event_type: human ? 'along.user_message' : 'along.health_summary_updated', goal_id: 'exercise' } }
}
async function configuredProbe() {
  const h = host = await startRuntime(store => store.saveSettings({ ...store.settings(),
    sources: { along: { enabled: true, config: {} }, github: { enabled: false, config: {} } } }))
  h.runtime.sources.register(alongKind)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings,
    sources: { github: { enabled: false, config: {} }, feishu: { enabled: false, config: {} }, along: { enabled: true, config: {} } },
    policy: { ...settings.policy,
      rules: [{ id: 'along-health', name: 'Along health', enabled: true, instruction: 'Maintain the existing exercise plan within its authorized goal.' }],
      sources: { ...settings.policy.sources, along: { allowed: [{ id: 'phase0-user' }], admission: { health: { unlistedUnaddressed: 'inferred' } } } } },
  })
  return h
}

describe('Along phase 0: current startup and extension boundaries', () => {
  it('keeps the original setup prompt when no source is configured', async () => {
    host = await startRuntime(store => store.saveSettings({ ...store.settings(), sources: {} }))
    expect(host.runtime.configured()).toBe(false)
    expect(host.runtime.setupProblem?.code).toBe('repositoryUnset')
    expect(host.controller.create).not.toHaveBeenCalled()
  })

  it('starts a local Along Runtime without probing a GitHub account or inheriting a gh command', async () => {
    const h = await configuredProbe()
    expect(h.runtime.configured()).toBe(true)
    expect(h.runtime.deployment).not.toHaveProperty('github')
    expect(h.runtime.deployment).not.toHaveProperty('repository')
    // Stage A skeleton (design §2.7): the same probe now runs the assembled Along deployment — business store
    // under the fixture state dir, loopback API answering the Host's probe over the generated bridge token.
    expect(h.runtime.along).toBeDefined()
    expect(h.runtime.along!.stateDir).toBe(join(h.directory, 'along-data'))
    expect(h.runtime.along!.bridgeToken).toMatch(/^[a-f0-9]{64}$/)
    const sourceProbe = await h.alongApi('GET', 'goals/along-status-probe', undefined,
      { 'x-along-bridge': '1', 'x-along-bridge-token': h.runtime.along!.bridgeToken,
        'x-along-user': 'u_00000001', 'x-along-device': 'd_00000001' })
    expect(sourceProbe).toMatchObject({ status: 200, body: { service: 'along-source', ready: true } })
    expect(h.agents.has(h.runtime.masterId)).toBe(true)
    expect(h.subprocess.spawn.mock.calls).toEqual([])
    const shim = spawnSync(join(h.directory, 'worker-bin', 'gh'), ['api', 'user'], { encoding: 'utf8' })
    expect(shim.status).toBe(1)
    expect(shim.stderr).toContain('no GitHub agent account')
    expect(readFileSync(join(h.directory, 'worker-gitconfig'), 'utf8')).not.toContain('auth git-credential')
    vi.mocked(Commands.prototype.gh).mockRestore()
    const commands = new Commands(() => h.runtime.deployment, {}, new AbortController().signal)
    await expect(commands.gh(['api', 'user'])).rejects.toThrow('no configured repository or agent account')
    const state = await h.api('GET', 'state')
    expect(state).toMatchObject({ status: 200, body: { setup: { accounts: { repository: null, agent: null } } } })
    const local = h.runtime.store.settings()
    expect(setupChanged(local, { ...local, sources: { ...local.sources, github: { enabled: true, config: {} } } })).toBe(true)
    expect(setupChanged(local, { ...local, sources: { ...local.sources, along: { enabled: false, config: {} } } })).toBe(true)
  })

  it('requires GitHub to be explicitly disabled because an installed Source defaults to enabled', async () => {
    host = await startRuntime(store => store.saveSettings({ ...store.settings(), sources: { along: { enabled: true, config: {} } } }))
    expect(host.runtime.configured()).toBe(false)
    expect(host.runtime.setupProblem?.code).toBe('repositoryUnset')
  })

  it('keeps Along optional and refuses unknown event types and message kinds when installed', async () => {
    host = await startRuntime()
    expect(host.runtime.sources.kind('along')).toBeUndefined()
    host.runtime.sources.register(alongKind)
    expect(host.runtime.sources.scope({ source: 'along', meta: { event_type: 'along.goal.updated' } }).listened).toBe(false)
    expect(host.runtime.sources.scope({ source: 'along', meta: { event_type: 'along.message', kind: 'shell.execute' } }).listened).toBe(false)
    expect(host.runtime.sources.scope({ source: 'along', meta: { event_type: 'along.message', kind: 'task.completed' } }).listened).toBe(true)
  })

  it('routes an explicit Along message into a Ticket and Assignment with a registered probe Source', async () => {
    const h = await configuredProbe()
    expect(h.runtime.deployment.github).toBeUndefined()
    const event = trigger('along-message-1', true)
    const { ticket, sessionId } = await h.acceptedTicket(event)
    expect(ticket.origin.triggerId).toBe(event.id)
    expect(ticket.mandate.strength).toBe('explicit')
    expect(ticket.assignments).toHaveLength(1)
    expect(h.agents.has(sessionId)).toBe(true)
    h.runtime.receive(event)
    await h.runtime.idle()
    expect(h.runtime.store.tickets.list()).toHaveLength(1)
    expect(h.runtime.store.tickets.get(ticket.id)?.assignments).toHaveLength(1)
  })

  it('accepts a non-human health event under auto rules without marking it as a human request', async () => {
    const h = await configuredProbe()
    const event = trigger('along-health-1', false)
    h.runtime.receive(event)
    await h.runtime.idle()
    expect(h.candidates()).toContain(event.id)
    await h.runTool(h.runtime.masterId, 'orchestrator_eval', { trigger_id: event.id })
    // The model verdict is supplied by the probe; this verifies Policy and domain routing, not semantic judgement.
    const result = await h.runTool(h.runtime.masterId, 'orchestrator_eval_decide', {
      trigger_id: event.id, decision: 'accept', title: '调整运动安排', worktree_name: 'along-exercise',
      scope: '按已有目标调整任务', reason: 'authorized goal has changed progress', intent_evidence: 'existing authorized exercise goal',
      acknowledgement: '按授权更新运动安排。', rule_assessments: [{ rule_id: 'along-health', matched: true, reason: 'existing exercise goal' }],
      direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'existing authorized exercise goal' },
    })
    expect(result).toMatchObject({ decision: 'accept', ticket: { ticket_id: expect.any(String) } })
    await h.runtime.idle()
    expect(h.runtime.store.tickets.list()[0]?.mandate).toMatchObject({ strength: 'inferred', basis: { rules: ['along-health'] } })
    expect(h.runtime.store.triggers.get(event.id)?.human).toBe(false)
  })

  it('scrubs synthetic credential variables but demonstrates that a sibling data directory is still readable', async () => {
    host = await startRuntime()
    const secretNames = ['KIMI_CODE_TOKEN', 'ALONG_PAIRING_TOKEN', 'DSH_ADMIN_TOKEN']
    for (const name of secretNames) vi.stubEnv(name, 'along-phase0-synthetic-value')
    const clean = scrubbedParentEnv()
    for (const name of secretNames) expect(clean[name]).toBeUndefined()
    const worker = join(host.directory, 'worker'), data = join(host.directory, 'business-data')
    mkdirSync(worker); mkdirSync(data)
    const sentinel = join(data, 'sentinel.txt')
    writeFileSync(sentinel, 'synthetic-business-data')
    const child = spawnSync(process.execPath, ['-e',
      'const fs=require("node:fs"); console.log(JSON.stringify({credentials:process.argv.slice(2).filter(k=>process.env[k]),data:fs.readFileSync(process.argv[1],"utf8")}))',
      sentinel, ...secretNames], { cwd: worker, env: clean, encoding: 'utf8' })
    expect(child.status).toBe(0)
    expect(JSON.parse(child.stdout)).toEqual({ credentials: [], data: 'synthetic-business-data' })
  })

  it('keeps inherited work tools and a local Along tool together in the real DSH tool registry', async () => {
    const ctx = new Context()
    ctx.reflect.provide('systemPrompt', { tools: () => () => {} })
    const tools = new ToolRuntime(ctx)
    const definition = (name: string) => ({ name, description: name, parameters: { type: 'object' as const, properties: {} },
      output: { schema: { type: 'object' as const, properties: { ok: { type: 'boolean' as const } }, required: ['ok'] },
        render: () => [{ type: 'text' as const, text: 'ok' }] }, execute: async () => ({ ok: true }) })
    for (const name of ['read', 'bash', 'skill', 'forbidden']) tools.register(definition(name))
    const agent = { id: 'along-phase0-worker' } as Agent
    const scope = createScope(ctx, agent)
    Object.assign(agent, { ctx: scope.ctx })
    try {
      scope.ctx.tools.register(definition('along_probe'))
      scope.ctx.tools.restrict({ allow: ['read', 'bash', 'skill'] })
      let ended = false
      scope.ctx.tools.guard(() => ended ? 'Ticket ended' : undefined)
      const call = (name: string) => tools.execute({ callId: name as never, name, arguments: {}, agent, signal: new AbortController().signal })
      for (const name of ['read', 'bash', 'skill', 'along_probe']) expect(await call(name)).toMatchObject({ isError: false })
      expect(await call('forbidden')).toMatchObject({ isError: true })
      ended = true
      expect(await call('along_probe')).toMatchObject({ isError: true })
    } finally { await scope.dispose() }
  })
})
