/** Along Source registration and scope. Authenticated event translation and phone APIs are added in phase A. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { SourceKind } from './kind.ts'

const messageKinds = new Set(['task.completed', 'task.feedback', 'authorization.changed'])
export const alongKind: SourceKind = {
  kind: 'along', title: { zh: 'Along', en: 'Along' },
  description: { zh: '接收服务端已校验的用户对话、授权健康摘要与任务反馈。', en: 'Receives server-validated user messages, authorized health summaries and task feedback.' },
  schema: z.object({}).strict(), fields: [], health: [],
  scope: ({ meta }) => {
    const type = meta.event_type
    if (type === 'along.user_message') return { listened: true, observed: false, row: 'chat' }
    if (type === 'along.health_summary_updated') return { listened: true, observed: true, row: 'health' }
    if (type === 'along.message' && typeof meta.kind === 'string' && messageKinds.has(meta.kind)) return { listened: true, observed: true, row: 'message' }
    return { listened: false, reason: 'unsupported_along_event' }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().trim().min(1).max(128), name: z.string().trim().max(100).optional() }).strict())
      .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate Along user IDs').default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的用户', en: 'Users who may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '用户 ID', en: 'User ID' } },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '已绑定且在名单内的用户对话是明确请求；健康更新按主动规则处理。', en: 'Bound, allowed user messages are explicit requests; health updates follow proactive rules.' },
  },
}

export const name = 'dsh-superagent-along'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(alongKind), 'along: source kind')
}
