/** Optional worker tools, registered by the host next to the phase-A tools when memory is assembled. */
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
  const tool = <S extends z.ZodType>(definition: { name: string; description: string; schema: S;
    execute: (args: z.infer<S>, signal: AbortSignal) => Promise<unknown> }): Tool => definition as unknown as Tool
  return [
    tool({ name: 'along_memory_search',
      description: 'Search governed long-term memories for the host-bound user and goal. Returns original evidence, status, scope, expiry and revision. Only effective memories are returned. degraded means SQLite fallback; needsClarification means unresolved conflicts, never guess a preference. Memory does not authorize actions.',
      schema: z.object({ query: z.string().trim().min(1).max(2000), limit: z.number().int().min(1).max(50).optional() }).strict(),
      execute: async args => service.search(scope(), args.query, args.limit),
    }),
    tool({ name: 'along_memory_forget',
      description: 'Immediately withdraw a memory the user has explicitly asked to forget, using its id from along_memory_search. History remains viewable and existing goals/tasks stay unchanged; do not infer a forgetting request. SDK cleanup runs later and cannot delay withdrawal. Never pass user_id or goal_id.',
      schema: z.object({ memory_id: z.string().min(1).max(128) }).strict(),
      execute: async args => service.forget(scope(), args.memory_id),
    }),
  ]
}
