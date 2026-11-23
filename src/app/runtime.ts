/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { lockSync } from 'proper-lockfile'
import { Engine, key, reasonText, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import type { DomainEvent } from '../core/ports.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, executionRoot, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, triggerMessage, workerSessionId } from '../executor/dsh.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'
import { registerAlongSource, type AlongApiHost } from '../along/api.ts'
import { startDeliveryPump } from '../along/delivery.ts'
import { createChangeSetModule } from '../along/changeset.ts'
import { createInbox } from '../along/inbox.ts'
import { createRunRecord, type RunRecordModule } from '../along/runrecord.ts'
import { AlongService } from '../along/service.ts'
import { createAlongMemory, MemoryService } from '../along/memory/index.ts'
import { packagePath } from '../infra/paths.ts'
import { AlongStore, assertAlongDataIsolation } from '../along/store.ts'
import { createWorkLink, type WorkLinkModule } from '../along/worklink.ts'
import { HealthFollowup } from '../along/health.ts'
import { researchWeb, researchCapability } from '../along/web-research.ts'
import { AlongMaintenance } from '../along/maintenance.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()

/**
 * The Along local-deployment assembly (design §2.7.1, stage-a-tech-design.md): one per Runtime, present only
 * when the settings configure the Along local deployment (Along Source enabled and GitHub explicitly
 * disabled, `setup.ts` `localDeployment`). Owns the business database handle and its directory lock, the
 * business facade, the mapping/record modules, the bridge token of the loopback API and the delivery pump.
 */
export interface AlongRuntime {
  /** The business facade the loopback API and the Along worker tools call. */
  readonly service: AlongService
  /** Host-owned governance, backend lifecycle and batch entry for stage E. */
  readonly memory: MemoryService
  readonly maintenance: AlongMaintenance
  readonly healthFollowup: HealthFollowup
  /** The worklink module: domain events → WorkLink rows, and the host-bound commit scope lookup. */
  readonly worklink: WorkLinkModule
  /** The record module: Worker ends → RunRecord rows and the outbound execution note (never a model call). */
  readonly runrecord: RunRecordModule
  /** The bridge token the loopback API expects (generated on first start); exists only in this process. */
  readonly bridgeToken: string
  /** The business data directory this assembly locked and opened (`alongStateDir`). */
  readonly stateDir: string
  /** Committed domain events → the mapping/record modules through the orchestrator store's `afterCommit`
   * (§2.7.2): a rolled-back Engine transaction leaves no row, a committed one always lands. */
  dispatch(event: DomainEvent): void
  /** Stops the delivery pump; `stop()` runs it before closing the business database (§2.7.1 停机逆序). */
  stopDeliveryPump(): void
}

/** Reads the bridge token file, generating a 0600 32-byte hex file on first start (design §4.7). A file with
 * other content fails startup: a wrong token would 401 every Host→Along Agent call. The token never leaves this Mac. */
function bridgeTokenOf(file: string): string {
  try {
    const token = readFileSync(file, 'utf8').trim()
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error(`The Along bridge token file (${file}) does not hold a 32-byte hex token; restore it or delete the file to regenerate`)
    return token
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error
    const token = randomBytes(32).toString('hex')
    writeFileSync(file, `${token}\n`, { mode: 0o600 })
    return token
  }
}

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** The Along local-deployment assembly; `undefined` unless the settings configure one (design §2.7.1). */
  readonly along?: AlongRuntime
  private alongStore?: AlongStore
  private alongRelease?: () => void
  private alongPumpStop?: () => void
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void) {
    super(ctx, 'orchestrator')
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      // Along local deployment (design §2.7.1): assembled from the seeded settings before the Engine exists, so
      // domain-event dispatch, the loopback API and the worker tools all see it. A failure closes the business
      // store and releases its directory lock in the catch below, next to the orchestrator ones.
      const along = this.along = this.assembleAlong()
      const policyFor: typeof settingsPolicy = (settings, scope) => {
        const base = settingsPolicy(settings, scope)
        return along ? along.healthFollowup.policy(along.maintenance.policy(base, settings), settings) : base
      }
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        lifetime: this.lifetime,
        closing: () => this.closing(), environment,
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, policyFor, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      const { assessor, executor } = this
      const policy = () => policyFor(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy,
        assessor: { request: candidate => { if (!along?.maintenance.assess(candidate) && !along?.healthFollowup.assess(candidate)) assessor.request(candidate) },
          release: id => assessor.release(id) }, executor,
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
          // Along domain-event dispatch first (design §2.7.2): through the orchestrator store's afterCommit so a
          // rolled-back Engine transaction leaves no business row; the notice logic below ignores the ordering.
          along?.dispatch(event)
          // Notify the main Session only about domain events it did not initiate itself.
          const basis = 'ticketId' in event.data ? store.tickets.get(event.data.ticketId)?.mandate.basis.via : undefined
          const maintenanceEvent = basis === 'scheduled' || basis === 'health' || basis === 'task_due'
          const notice = this.quiet || maintenanceEvent ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured() && setup.deployment.repository) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
          }
        } })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { along?.maintenance.tick(); along?.healthFollowup.tick(); engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } },
        // The Along worker tools (design §2.3.6): registered by `executorTools` for the assembled deployment;
        // the scope lookup is the worklink module's host-bound reverse mapping (BC-07-04) — the model cannot
        // specify user, ticket or goal.
        ...(along ? { healthFollowup: along.healthFollowup, maintenance: along.maintenance, along: { web: () => researchWeb(ctx), service: along.service, memory: along.memory, healthFollowup: along.healthFollowup, scopeFor: ticketId => along.worklink.workScopeForTicket(ticketId) } } : {}) }
      this.ready = this.initialize()
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      // The Along assembly may have failed partway (or a later step failed after it): close the business store
      // and release its directory lock the same way (design §2.7.1).
      const alongRelease = this.alongRelease
      this.alongRelease = undefined
      try { this.alongStore?.close() } finally { try { alongRelease?.() } catch { /* already released */ } }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  private alongSourceAvailable(): boolean {
    return !this.lifetime.aborted && this.sources.instance('along')?.enabled === true
  }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    // The loopback Along routes (design §2.7.1): registered next to `/orchestrator` before setup completes so a
    // not-yet-configured local deployment still answers the Host's probe and pairing (the API 503s until assembled).
    if (this.along) this.disposers.push(registerAlongSource(this.ctx, this.alongApiHost()))
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    this.sessions.install()
    this.executor.install()
    await this.sessions.ensure(this.masterId, this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    // Cordis registers the Along Source in a separate plugin. Its activation can follow this initialization,
    // so check the Source before claiming deliveries and continue checking across unloads and reloads.
    if (this.along) {
      this.alongPumpStop = startDeliveryPump(this.along.service.alongStore, {
        canDeliver: () => this.alongSourceAvailable(),
        receive: trigger => this.passes.receive(trigger),
        filteredReason: triggerId => {
          const reason = this.store.triggers.disposition(triggerId)?.filtered
          return reason === undefined ? undefined : reasonText(reason)
        },
        report: error => this.ctx.logger.warn('along delivery pump: %s', String(error)),
      }, this.lifetime)
    }
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  /** The loopback API's host view: the assembled facade (503 before it exists), the bridge token and the Settings
   * facade that adds a paired user to `sources.along.allowed` (design §2.4.1). */
  private alongApiHost(): AlongApiHost {
    const runtime = this
    return { get along() { return runtime.along?.service },
      ready: () => runtime.alongPumpStop !== undefined && runtime.alongSourceAvailable(),
      bridgeToken: runtime.along?.bridgeToken, settings: runtime.settings }
  }
  /**
   * Assembles the Along local deployment (design §2.7.1): settings configure it when the Along Source is enabled
   * and GitHub is explicitly disabled (`setup.ts` `localDeployment`). Order: optional config keys → execution-root
   * containment (BC-07-02) → directory lock → business store → facade over the inbox/changeset factories → the
   * mapping/record modules → the bridge token. Throws with configuration guidance when the local deployment is
   * configured without its keys; a GitHub profile never reads them.
   */
  private assembleAlong(): AlongRuntime | undefined {
    const settings = this.store.settings()
    if (!(settings.sources.along?.enabled === true && settings.sources.github?.enabled === false)) return undefined
    const { alongStateDir, alongBridgeTokenFile } = this.machine
    if (!alongStateDir || !alongBridgeTokenFile) {
      throw new Error('The Along local deployment needs the alongStateDir and alongBridgeTokenFile configuration keys (absolute paths in the dsh-superagent profile configuration); without them the Along business database cannot be opened')
    }
    // BC-07-02 fail-fast (the storage module's canonical guard): neither directory may contain the other —
    // workers run under the same account, so the placement is the business data boundary, not a sandbox.
    assertAlongDataIsolation(alongStateDir, executionRoot(settings, this.machine.stateDir))
    mkdirSync(alongStateDir, { recursive: true, mode: 0o700 })
    const alongCompromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    this.alongRelease = lockSync(alongStateDir, { stale: 30_000, onCompromised: alongCompromised })
    const alongStore = this.alongStore = new AlongStore(join(alongStateDir, 'along.sqlite'))
    const memory = this.machine.alongMemory ? createAlongMemory(alongStore, { ...this.machine.alongMemory,
      script: packagePath('scripts', 'along-memory-service.py'), workerRoot: executionRoot(settings, this.machine.stateDir) })
      : new MemoryService(alongStore, {
        extract: async () => { throw new Error('memory backend unavailable') },
        search: async () => { throw new Error('memory backend unavailable') },
        clearUser: async () => { throw new Error('memory backend unavailable') }, close: async () => {},
      })
    const report = (error: unknown) => { this.ctx.logger.warn('along: %s', String(error)) }
    const worklink = createWorkLink({ store: alongStore, repo: this.store, report })
    const runrecord = createRunRecord({ store: alongStore, repo: this.store,
      prompts: sessionId => this.store.get(KV.sessions.prompts(sessionId)), report })
    const maintenance = new AlongMaintenance({ store: alongStore, memory, repo: this.store,
      engine: () => this.engine, settings: () => this.store.settings(), available: () => !!this.machine.alongMemory,
      time: () => this.machine.alongMaintenanceTime?.get() ?? '03:00',
      paused: () => this.paused(), closing: () => this.closing() })
    const healthFollowup = new HealthFollowup({ store: alongStore, repo: this.store, engine: () => this.engine,
      settings: () => this.store.settings(), paused: () => this.paused(), closing: () => this.closing(),
      available: capability => capability!=='research'||researchCapability(researchWeb(this.ctx)).configured,
      source: (userId,goalId,provider) => {
        if(!alongStore.goalDataSources(userId,goalId).some(s=>s.provider===provider))return undefined
        const fact=alongStore.sources.queryCurrent(userId,goalId,provider)
        return fact?{state:fact.state,generation:fact.generation,revision:fact.revision,reference:fact.reference,capabilities:fact.capabilities}:undefined
      } })
    return {
      service: new AlongService(alongStore, { inbox: createInbox(alongStore), changeset: createChangeSetModule(alongStore,{available:capability=>capability!=='research'||researchCapability(researchWeb(this.ctx)).configured}), taskReviews:healthFollowup }),
      worklink, runrecord, memory, maintenance, healthFollowup,
      bridgeToken: bridgeTokenOf(alongBridgeTokenFile),
      stateDir: alongStateDir,
      dispatch: event => {
        // Committed events only (§2.7.2): the orchestrator store's afterCommit drops them on a rollback.
        this.store.afterCommit(() => {
          worklink.onDomainEvent(event); runrecord.onDomainEvent(event)
          if ('ticketId' in event.data) maintenance.record(event.data.ticketId,
            'assignmentId' in event.data ? event.data.assignmentId : undefined)
        })
      },
      stopDeliveryPump: () => { this.alongPumpStop?.(); this.alongPumpStop = undefined },
    }
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks,
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog() }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
    try {
      this.assessor.stop()
      const ids = [this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await this.executor.shutdown()
      this.executor.dispose()
      this.sessions.dispose()
      for (const dispose of this.disposers.reverse()) dispose()
      await this.ctx.sessionPersistence.flush()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      try {
        // Along stop order (design §2.7.1 停机逆序): pump → business database → orchestrator store → both locks.
        this.along?.stopDeliveryPump()
        try { await this.along?.memory.close() }
        finally {
          try { await this.along?.maintenance.idle() }
          finally { this.alongStore?.close(); this.alongStore = undefined }
        }
      } finally {
        try { this.store.close() } finally {
          const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
            String(error)) }
          await this.releaseLock?.().catch(unreleased)
          const alongRelease = this.alongRelease
          this.alongRelease = undefined
          try { alongRelease?.() } catch (error) { this.ctx.logger.warn('dsh-superagent could not release the Along directory lock: %s',
            String(error)) }
        }
      }
    }
  }
}
