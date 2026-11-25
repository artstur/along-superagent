/** Async coordination helpers for tests. */
import { vi } from 'vitest'

/** Create an externally resolvable promise. */
export function deferred<T = void>() {
  return Promise.withResolvers<T>()
}
/** Observe whether a promise has settled without awaiting it. */
export function track<T>(promise: Promise<T>) {
  const state = { settled: false, error: undefined as unknown, promise }
  promise.then(() => { state.settled = true }, (error: unknown) => { state.settled = true; state.error = error })
  return state
}
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
export const waitUntil = (check: () => boolean, timeout = 3000) => vi.waitFor(() => { if (!check()) throw new Error('not yet') }, { timeout, interval: 2 })
