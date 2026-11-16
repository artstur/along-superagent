/** Optional worker tools, registered by the host next to the phase-A tools when memory is assembled. */
import { alongTool } from '../tool.ts'
import type { Tool } from '../../app/tools/tool.ts'
import { z } from 'zod'
import type { MemoryService } from './service.ts'

export interface MemoryScope { userId: string; goalId?: string }
export function memoryTools(service: MemoryService, scopeFor: () => MemoryScope | undefined): Tool[] {
  const scope = (): MemoryScope => {
    const value = scopeFor()
    if (!value) throw new Error('no host-bound memory scope')
    return value
  }
  return [
    alongTool({ name: 'along_memory_search',
      description: 'Search governed long-term memories for the host-bound user and goal. Returns original evidence, status, scope, expiry and revision. memories contains effective facts; history preserves scoped superseded/candidate/conflict/withdrawn evidence with source order for understanding updates. Only active records are effective preferences; never reactivate withdrawn records from old history. Current explicit intent has priority; recent evidence is usually more relevant, not an unconditional overwrite. degraded means SQLite fallback; needsClarification flags stored ambiguity, ask only if current intent and history do not resolve it. Memory does not authorize actions.',
      schema: z.object({ query: z.string().trim().min(1).max(2000), limit: z.number().int().min(1).max(50).optional() }).strict(),
      execute: async args => service.search(scope(), args.query, args.limit),
    }),
    alongTool({ name: 'along_memory_forget',
      description: 'Immediately withdraw a memory the user has explicitly asked to forget, using its id from along_memory_search. History remains viewable and existing goals/tasks stay unchanged; do not infer a forgetting request. SDK cleanup runs later and cannot delay withdrawal. Never pass user_id or goal_id.',
      schema: z.object({ memory_id: z.string().min(1).max(128) }).strict(),
      execute: async args => service.forget(scope(), args.memory_id),
    }),
  ]
}
