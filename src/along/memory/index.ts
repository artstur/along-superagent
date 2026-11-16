/** Standalone phase-D entry. Stage B binds tools/context; stage E calls runBatch. */
import type { AlongStore } from '../store.ts'
import { HyMemoryBackend, type HyMemoryOptions } from './hy-client.ts'
import { MemoryService } from './service.ts'

export function createAlongMemory(store: AlongStore, options: HyMemoryOptions): MemoryService {
  return new MemoryService(store, new HyMemoryBackend(options))
}
export { MemoryService } from './service.ts'
export { AlongStore } from '../store.ts'
export { HyMemoryBackend, type HyMemoryOptions } from './hy-client.ts'
export { memoryTools, type MemoryScope } from './tools.ts'
export type { MemoryBackend, GovernedMemory, MemorySource, ExtractionInput, ExtractionResult } from './model.ts'
