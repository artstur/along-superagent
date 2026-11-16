/**
 * Idempotent import of the pre-bridge phone export into `along.sqlite` (BC-09-02, 003 §4).
 *
 * Source shapes are the App's localStorage keys `along.goal-custom.v1` (goals) and `along.goal-conversations.v1`
 * (per-domain conversations), exported from the old client. Stable IDs: domain keys `health|finance|custom` map to
 * the fixed goals `g_health|g_finance|g_custom`; messages are renumbered in export order as
 * `msg:<user_id>:import:<n>`. Every write lands through `AlongStore` idempotent primitives (deterministic ids,
 * `ON CONFLICT DO NOTHING`), so importing the same export twice produces no duplicate rows; the report carries
 * counts and content hashes for the post-import audit. Deleted old messages are never reconstructed (001 §5.3):
 * only what the export still contains is imported, and `localOnly` entries (never actually exchanged) are skipped.
 */
import { createHash } from 'node:crypto'
import type { PageCursor, GoalRevisionRow, GoalRow } from './store.ts'
import type { AlongStore } from './store.ts'

export interface LegacyGoal { title?: unknown; target?: unknown; intent?: unknown }
export interface LegacyConversationEntry { role?: unknown; text?: unknown; localOnly?: unknown; at?: unknown }
export interface LegacyExport {
  goals?: Record<string, LegacyGoal | null | undefined>
  conversations?: Record<string, readonly LegacyConversationEntry[] | undefined>
}
export interface LegacyImportReport {
  goals: { seen: number; imported: number; existing: number; unmappedKeys: string[] }
  messages: { seen: number; imported: number; existing: number; skipped: number }
  tasks: { imported: number }
  counts: { goals: number; tasks: number; messages: number }
  contentHash: { goals: string; messages: string }
}

/** Fixed stable-ID mapping of the legacy domain keys (design §2.1.6). */
export const LEGACY_GOAL_IDS = { health: 'g_health', finance: 'g_finance', custom: 'g_custom' } as const
const LEGACY_DOMAINS = ['health', 'finance', 'custom'] as const

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const isLegacyGoal = (value: unknown): value is LegacyGoal & { title: string } =>
  isObject(value) && typeof value.title === 'string' && value.title.trim() !== ''
const isEntry = (value: unknown): value is LegacyConversationEntry => isObject(value)

/** The user's goal content snapshot for one imported goal, as stored right now. */
function goalSnapshot(store: AlongStore, userId: string, goalId: string): Record<string, unknown> | undefined {
  const goal: GoalRow | undefined = store.getGoal(userId, goalId)
  if (!goal) return undefined
  const revision: GoalRevisionRow | undefined = store.currentGoalRevision(goalId)
  return { id: goal.id, domain: goal.domain, status: goal.status, currentRevision: goal.currentRevision,
    title: revision?.title, metric: revision?.metric, context: revision?.context }
}

export function importLegacy(store: AlongStore, userId: string, exported: LegacyExport): LegacyImportReport {
  const goals = isObject(exported?.goals) ? exported.goals : {}
  const conversations = isObject(exported?.conversations) ? exported.conversations : {}
  const report: LegacyImportReport = {
    goals: { seen: 0, imported: 0, existing: 0, unmappedKeys: [] },
    messages: { seen: 0, imported: 0, existing: 0, skipped: 0 },
    tasks: { imported: 0 },
    counts: { goals: 0, tasks: 0, messages: 0 },
    contentHash: { goals: '', messages: '' },
  }
  store.atomic(() => {
    store.assertUser(userId)
    // Goals first: the fixed stable-ID map only covers the three legacy domain keys; other custom:* keys are
    // reported as unmapped instead of receiving invented ids.
    const goalIds: string[] = []
    for (const domain of LEGACY_DOMAINS) {
      const legacy = goals[domain]
      if (legacy !== null && legacy !== undefined) report.goals.seen++
      if (!isLegacyGoal(legacy)) continue
      const goalId = LEGACY_GOAL_IDS[domain]
      if (store.getGoal(userId, goalId) !== undefined) {
        report.goals.existing++
      } else {
        const metric = typeof legacy.target === 'number' && Number.isFinite(legacy.target) ? { target: legacy.target } : undefined
        const context = typeof legacy.intent === 'string' && legacy.intent.trim() !== '' ? [legacy.intent.trim()] : undefined
        store.insertGoal({ userId, domain, goalId })
        store.appendGoalRevision({ goalId, userId, title: legacy.title.trim(), metric, context, status: 'active' })
        store.ensureInputVersion(userId, goalId)
        report.goals.imported++
      }
      goalIds.push(goalId)
    }
    for (const key of Object.keys(goals)) {
      if (!(LEGACY_DOMAINS as readonly string[]).includes(key) && isLegacyGoal(goals[key])) report.goals.unmappedKeys.push(key)
    }
    // Conversations: renumbered in export order (fixed domain order); every entry consumes one number so the ids
    // are a pure function of the export, which keeps re-imports idempotent even around skipped entries.
    let n = 0
    for (const domain of LEGACY_DOMAINS) {
      const entries = conversations[domain]
      if (!Array.isArray(entries)) continue
      const goalId = store.getGoal(userId, LEGACY_GOAL_IDS[domain]) !== undefined ? LEGACY_GOAL_IDS[domain] : undefined
      for (const entry of entries) {
        n++
        report.messages.seen++
        const role = isEntry(entry) && entry.role === 'assistant' ? 'assistant' : isEntry(entry) && entry.role === 'user' ? 'user' : undefined
        const text = isEntry(entry) && typeof entry.text === 'string' ? entry.text : undefined
        if (role === undefined || text === undefined || text.trim() === '' || entry.localOnly === true) { report.messages.skipped++; continue }
        const messageId = `msg:${userId}:import:${n}`
        if (store.getMessage(userId, messageId) !== undefined) { report.messages.existing++; continue }
        const occurredAt = typeof entry.at === 'string' && Number.isFinite(Date.parse(entry.at)) ? entry.at : undefined
        store.appendMessage({ userId, eventId: `import:${n}`, role,
          direction: role === 'user' ? 'inbound' : 'outbound', text, occurredAt })
        if (goalId !== undefined) store.linkMessageToGoals(messageId, [goalId], 'direct')
        report.messages.imported++
      }
    }
    // The two legacy keys carry no task records; the field stays so the audit checklist has no gap (003 §4).
    report.tasks.imported = 0
    report.counts = store.counts(userId)
    // Content hashes over what is actually stored for the imported scope, so the audit compares database truth
    // against the report rather than re-deriving from the export.
    const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    report.contentHash.goals = hash(LEGACY_DOMAINS.map(domain => goalSnapshot(store, userId, LEGACY_GOAL_IDS[domain])))
    const messages: Record<string, unknown>[] = []
    for (const goalId of goalIds) {
      let cursor: PageCursor = { limit: 200 }
      for (;;) {
        const page = store.messagesByGoal(userId, goalId, cursor)
        for (const message of page.items) {
          messages.push({ id: message.id, seq: message.seq, role: message.role, direction: message.direction, text: message.text })
        }
        if (page.nextCursor === undefined) break
        cursor = { limit: 200, cursor: page.nextCursor }
      }
    }
    messages.sort((first, second) => Number(first.seq) - Number(second.seq))
    report.contentHash.messages = hash(messages)
  })
  return report
}
