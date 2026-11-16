/** Private process protocol and credential isolation, with no providers or optional Python packages. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HyMemoryBackend } from '../src/along/memory/hy-client.ts'

let dir: string, backend: HyMemoryBackend | undefined
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'along-memory-transport-')) })
afterEach(async () => { await backend?.close(); backend = undefined; rmSync(dir, { recursive: true, force: true }) })
function start(body: string, timeoutMs = 4000) {
  const script = join(dir, 'backend.py')
  writeFileSync(script, body)
  return backend = new HyMemoryBackend({ python: '/usr/bin/python3', script, dataDir: join(dir, 'memory'), envFile: join(dir, 'secret.env'),
    workerRoot: join(dir, 'work'), timeoutMs })
}
const loop = (body: string) => `import sys,json,os,time\nprint(json.dumps({'ready':True}),flush=True)\nfor line in sys.stdin:\n r=json.loads(line)\n ${body}\n`

describe('Hy-Memory private stdio owner', () => {
  it('checks actual Python cleanup against a lying SDK and user-scoped profiles, without SDK dependencies', () => {
    expect(() => execFileSync('/usr/bin/python3', [fileURLToPath(new URL('./fixtures/memory_owner_checks.py', import.meta.url))],
      { env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe' })).not.toThrow()
  })
  it('reuses one process, serializes requests and passes no parent credentials', async () => {
    process.env.ALONG_MEMORY_SYNTHETIC_TOKEN = 'must-never-inherit'
    try {
      const client = start(loop("assert 'ALONG_MEMORY_SYNTHETIC_TOKEN' not in os.environ\n print(json.dumps({'id':r['id'],'ok':True,'result':[str(os.getpid())]}),flush=True)"))
      const [a, b] = await Promise.all([client.search({ userId: 'u', query: 'a', limit: 1 }), client.search({ userId: 'u', query: 'b', limit: 1 })])
      expect(a).toEqual(b)
      expect(a).toHaveLength(1)
    } finally { delete process.env.ALONG_MEMORY_SYNTHETIC_TOKEN }
  })
  it('kills timed-out owners and starts the next request in a fresh process', async () => {
    const client = start(loop("if r['params']['query']=='hang': time.sleep(30)\n print(json.dumps({'id':r['id'],'ok':True,'result':['fresh']}),flush=True)"), 2000)
    await expect(client.search({ userId: 'u', query: 'hang', limit: 1 })).rejects.toThrow('unavailable')
    await expect(client.search({ userId: 'u', query: 'now', limit: 1 })).resolves.toEqual(['fresh'])
  }, 15_000)
  it('rejects protocol corruption and sanitizes failures rather than returning SDK errors', async () => {
    const client = start(loop("print(json.dumps({'id':r['id'],'ok':False,'error':'secret=do-not-leak'}),flush=True)"))
    await expect(client.search({ userId: 'u', query: 'a', limit: 1 })).rejects.toThrow(/^memory backend unavailable$/)
    const corrupt = start(loop("print('a-secret-that-is-not-json',flush=True)"))
    await client.close()
    await expect(corrupt.search({ userId: 'u', query: 'a', limit: 1 })).rejects.toThrow(/^memory backend unavailable$/)
  })
  it('does not accept data or credential paths inside the worker root', () => {
    expect(() => new HyMemoryBackend({ python: '/usr/bin/python3', script: '/tmp/owner.py', dataDir: '/tmp/work/memory',
      envFile: '/tmp/secret.env', workerRoot: '/tmp/work' })).toThrow('must not overlap')
    expect(() => new HyMemoryBackend({ python: '/usr/bin/python3', script: '/tmp/owner.py', dataDir: '/tmp/memory',
      envFile: '/tmp/work/token.env', workerRoot: '/tmp/work' })).toThrow('must not overlap')
  })
  it('stops a queued request on close instead of launching another process', async () => {
    const client = start(loop("print(json.dumps({'id':r['id'],'ok':True,'result':[]}),flush=True)"))
    await client.search({ userId: 'u', query: 'a', limit: 1 })
    await client.close()
    await expect(client.search({ userId: 'u', query: 'a', limit: 1 })).rejects.toThrow('closed')
  })
})
