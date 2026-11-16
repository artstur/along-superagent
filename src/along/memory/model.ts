/** Long-term memory contracts. Identities are supplied by the host, never by extraction output. */
import { z } from 'zod'

export const MemoryCandidateSchema = z.object({
  quote: z.string().trim().min(1).max(2000),
  topic: z.string().trim().min(1).max(100),
  category: z.enum(['preference', 'fact', 'temporary', 'goal_constraint', 'ignore']),
  assertion: z.enum(['explicit', 'inferred', 'negated', 'quoted', 'hypothetical']),
  sourceMessageIds: z.array(z.string().min(1)).min(1).max(20),
  goalId: z.string().min(1).optional(),
  expiresAt: z.iso.datetime().optional(),
  replaces: z.array(z.string()).max(20).default([]),
  conflictsWith: z.array(z.string()).max(20).default([]),
  backendIds: z.array(z.string().min(1)).max(100).default([]),
}).strict()
export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>
export type MemoryStatus = 'active' | 'candidate' | 'conflict' | 'superseded' | 'withdrawn'
export interface MemorySource { id: string; text: string; seq: number; goalIds: string[] }
export interface GovernedMemory {
  id: string; userId: string; content: string; topic: string; goalId?: string; expiresAt?: string
  status: MemoryStatus; revision: number; sourceMessageIds: string[]; sourceSeq: number
  backendIds: string[]; category: 'preference' | 'fact'; assertion: MemoryCandidate['assertion']
}
export interface MemoryOperation {
  id: string; userId: string; sourceIds: string[]; status: 'pending' | 'done'; attempts: number
}
export interface ExtractionInput {
  operationId: string; attemptId: string; userId: string; sources: MemorySource[]; existing: GovernedMemory[]
}
export interface ExtractionResult {
  requestId?: string; candidates: unknown[]; backendIds: string[]
}
/** A single host-owned Python client, shared by all operations; never exposed to workers. */
export interface MemoryBackend {
  extract(input: ExtractionInput): Promise<ExtractionResult>
  search(input: { userId: string; query: string; limit: number }): Promise<string[]>
  clearUser(userId: string): Promise<void>
  close(): Promise<void>
}
