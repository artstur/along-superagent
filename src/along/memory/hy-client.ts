/** Private stdio transport. Timeouts kill the owner process, so late SDK writes cannot cross attempts. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'
import { assertAlongDataIsolation } from '../store.ts'
import type { ExtractionInput, ExtractionResult, MemoryBackend } from './model.ts'
import { MemoryBackendError } from './model.ts'

export interface HyMemoryOptions {
  python: string; script: string; dataDir: string; envFile: string; workerRoot: string; timeoutMs?: number
}

/** The owner's own reason codes; anything else stays "unknown", so provider text never crosses the boundary. */
const REASONS = new Set(['classification_empty_content', 'classification_invalid_json', 'classification_invalid_shape',
  'classification_http_error', 'classification_invalid_reply'])

/** Constructed by the host, not from tool arguments. No credential values enter this process's protocol. */
export class HyMemoryBackend implements MemoryBackend {
  private child: ChildProcessWithoutNullStreams | undefined
  private sequence = 0
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  private pending: { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined
  constructor(private readonly options: HyMemoryOptions) {
    for (const path of [options.python, options.script, options.dataDir, options.envFile, options.workerRoot]) {
      if (!isAbsolute(path)) throw new Error('memory paths must be absolute')
    }
    assertAlongDataIsolation(options.dataDir, options.workerRoot)
    assertAlongDataIsolation(options.envFile, options.workerRoot)
    // Resolve existing ancestors as well: a symlink must not turn a sibling data dir into a worker directory.
    const realOrParent = (path: string): string => {
      try { return realpathSync(path) } catch {
        const split = path.lastIndexOf('/')
        if (split <= 0) return path
        return `${realOrParent(path.slice(0, split))}/${path.slice(split + 1)}`
      }
    }
    assertAlongDataIsolation(realOrParent(options.dataDir), realOrParent(options.workerRoot))
    assertAlongDataIsolation(realOrParent(options.envFile), realOrParent(options.workerRoot))
  }
  extract(input: ExtractionInput): Promise<ExtractionResult> { return this.call('extract', input) as Promise<ExtractionResult> }
  search(input: { userId: string; query: string; limit: number }): Promise<string[]> { return this.call('search', input) as Promise<string[]> }
  async clearUser(userId: string): Promise<void> { await this.call('clear', { userId }) }
  async stats(userId: string): Promise<{ llm: number; embeddings: number }> {
    return this.call('stats', { userId }) as Promise<{ llm: number; embeddings: number }>
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child
    const env: NodeJS.ProcessEnv = { PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' }
    // An explicit allow-list: Kimi, pairing, management, provider and bridge credentials cannot be inherited.
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE']) if (process.env[key]) env[key] = process.env[key]
    const child = spawn(this.options.python, [this.options.script, '--data-dir', this.options.dataDir, '--env-file', this.options.envFile],
      { env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    child.stderr.resume() // Never copy SDK/provider errors into logs or tool responses.
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      if (this.child !== child) return
      try {
        if (line.length > 4_000_000) throw new Error('memory protocol limit')
        const response = JSON.parse(line) as { ready?: boolean; id?: number; ok?: boolean; result?: unknown; reason?: string }
        if (response.ready === true) return
        if (!this.pending || response.id !== this.pending.id) throw new Error('memory protocol sequence')
        if (response.ok !== true) this.pending.reject(new MemoryBackendError(
          typeof response.reason === 'string' && REASONS.has(response.reason) ? response.reason : 'unknown'))
        else this.pending.resolve(response.result)
      } catch { this.abort(child) }
    })
    child.stdin.on('error', () => { this.abort(child) })
    child.on('error', () => { this.abort(child) })
    child.on('exit', () => { this.abort(child) })
    return child
  }
  private abort(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return
    this.child = undefined
    child.kill('SIGKILL')
    this.pending?.reject(new Error('memory backend unavailable'))
    this.pending = undefined
  }
  private call(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('memory backend closed'))
    const request = this.queue.then(() => {
      if (this.closed) throw new Error('memory backend closed')
      return new Promise<unknown>((resolve, reject) => {
        const child = this.start(), id = ++this.sequence
        const timer = setTimeout(() => { this.abort(child) }, this.options.timeoutMs ?? 120_000)
        this.pending = { id,
          resolve: value => { clearTimeout(timer); this.pending = undefined; resolve(value) },
          reject: error => { clearTimeout(timer); this.pending = undefined; reject(error) } }
        const line = JSON.stringify({ id, method, params })
        if (line.length > 4_000_000) { this.pending.reject(new Error('memory request too large')); return }
        child.stdin.write(`${line}\n`)
      })
    })
    this.queue = request.catch(() => {})
    return request
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.child) {
      const child = this.child
      // EOF invokes the pinned SDK's drain + close; do not leave a Chroma writer running after shutdown.
      const exited = new Promise<void>(resolve => { child.once('close', () => { resolve() }) })
      child.stdin.end()
      const timer = setTimeout(() => { this.abort(child) }, 10_000)
      await exited
      clearTimeout(timer)
    }
    await this.queue
  }
}
