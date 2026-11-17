/**
 * The Runtime-assembled facade of the Along business service (design §2.1/§4.3): the single entry point the
 * loopback API calls. Storage primitives live on `AlongStore`; `acceptEvent` and `commitChangeSet` are provided
 * by the inbox / changeset factories, which are injected here so the modules never import each other (one-way
 * dependency on `AlongStore` only). The interfaces below are structural contracts — the canonical types live in
 * their owner modules (`EventEnvelope`/`EventReceipt` → `src/along/envelope.ts`, `ChangeSetInput`/`ChangeSetResult`/
 * `CommitScope` → `src/along/changeset.ts`) and are assignable to them.
 */
import type { AlongStore } from './store.ts'
import { ensureSourceGoalReview,sourceReviewChangeRefusal,assertSourceReviewWrite } from './source-goal-review.ts'
import { SourceEventSchema } from './source-state.ts'
import { taskReviewChangeRefusal,assertTaskReviewWrite } from './task-repair.ts'

/** Server-bound identity from the Host's pairing session; never taken from a request body. */
export interface AlongIdentity { userId: string; deviceId: string }
/** Structural shape of the event envelope (design §4.1); the zod-validated original arrives from the inbox module. */
export interface AlongEventEnvelope {
  event_id: string; schema_version: string; event_type: string; kind?: string
  goal_id?: string; task_id?: string; occurred_at: string; timezone: string
  message_id?: string; causation_id?: string; base_revision?: number; payload: Record<string, unknown>
}
/** Persistent receive receipt (design §2.2); `received_seq` is the message seq when the event carried one. */
export interface AlongEventReceipt {
  status: 'accepted' | 'duplicate' | 'conflict' | 'rejected'; event_id: string; received_seq?: number; reason?: string
}
/** The inbox module's receive state machine, injected by the Runtime. */
export interface AlongInboxModule { acceptEvent(envelope: AlongEventEnvelope, identity: AlongIdentity): AlongEventReceipt }

/** Host-bound commit scope; the model cannot specify any of these fields (design §4.4, BC-07-04). */
export interface AlongCommitScope {
  userId: string; allowedGoalId?: string
  ticketId?: string; assignmentId?: string; workId?: string; triggerEventId?: string; requireReminderPlan?: boolean; requireTaskTrigger?:boolean
}
/** Structural shape of a ChangeSet submission (design §4.4); the validated original arrives from the changeset module. */
export interface AlongChangeSetInput {
  idempotency_key: string; goal_id?: string; base_revision: number; input_version: number
  reason: string; derived_from_changeset?: string; ops: readonly unknown[]
}
/** Only applied / conflicted / invalid exist — there is no pending adoption step (D3). */
export interface AlongChangeSetResult {
  status: 'applied' | 'conflicted' | 'invalid'; changeset_id?: string; goal_revision?: number; reused?: boolean; reason?: string
}
/** The changeset module's commit pipeline, injected by the Runtime. */
export interface AlongChangesetModule { commitChangeSet(input: AlongChangeSetInput, scope: AlongCommitScope): AlongChangeSetResult }

/**
 * The Runtime-assembled business service: the loopback API's single entry point. Reads and storage primitives go
 * through the owned `AlongStore`; the two write pipelines are the injected inbox and changeset factories, which
 * depend on the store one-way and never on each other (design §2.1/§4.3).
 */
export class AlongService {
  constructor(private readonly store: AlongStore,
    private readonly modules: { inbox?: AlongInboxModule; changeset?: AlongChangesetModule; taskReviews?:{requestTaskReview(identity:AlongIdentity,body:unknown):unknown} } = {}) {}
  /** Storage primitives for the loopback API reads and for the injected modules. */
  get alongStore(): AlongStore { return this.store }
  /** Receive an event reliably (transactional Inbox + business rows + delivery queue); implemented by the inbox module. */
  acceptEvent(envelope: AlongEventEnvelope, identity: AlongIdentity): AlongEventReceipt {
    if (!this.modules.inbox) throw new Error('the Along inbox module is not installed')
    return this.modules.inbox.acceptEvent(envelope, identity)
  }
  /** Commit the real capability fact and its bounded legacy-goal continuation before acknowledging either. */
  acceptSourceEvent(identity:AlongIdentity,body:unknown) {
    return this.store.atomic(()=>{
      const input=SourceEventSchema.parse(body),receipt=this.store.sources.acceptEvent(identity,input)
      if(receipt.status==='accepted')ensureSourceGoalReview(this.store,identity,input.goal_id)
      return receipt
    })
  }
  requestTaskTriggerReview(identity:AlongIdentity,body:unknown):unknown {
    if(!this.modules.taskReviews)throw new Error('task trigger review not installed')
    return this.modules.taskReviews.requestTaskReview(identity,body)
  }
  /** Validate and auto-commit a ChangeSet (applied / conflicted / invalid); implemented by the changeset module. */
  commitChangeSet(input: AlongChangeSetInput, scope: AlongCommitScope): AlongChangeSetResult {
    if (!this.modules.changeset) throw new Error('the Along changeset module is not installed')
    return this.store.atomic(()=>{
      const refused=taskReviewChangeRefusal(this.store,input,scope)??sourceReviewChangeRefusal(this.store,input,scope)
      if(refused)return {status:'invalid',reason:refused}
      const result=this.modules.changeset!.commitChangeSet(input, scope)
      if(result.status==='applied'){assertTaskReviewWrite(this.store,scope);assertSourceReviewWrite(this.store,scope)}
      return result
    })
  }
}
