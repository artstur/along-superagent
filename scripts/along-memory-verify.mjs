#!/usr/bin/env node
/** Real provider smoke/quality run, synthetic data only. Run pnpm build first; credentials stay outside the repo. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AlongStore, MemoryService, HyMemoryBackend } from '../lib/along-memory.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = join(root, '.artifacts', 'along-memory')
mkdirSync(artifacts, { recursive: true })
const directory = mkdtempSync(join(artifacts, 'verify-'))
const envFile = process.argv[2]
assert(envFile && envFile.startsWith('/'), 'pass the absolute path of the Mac-only env file')
const python = process.env.ALONG_MEMORY_PYTHON || join(root, '.artifacts', 'along-phase0', 'venv', 'bin', 'python')
const config = { python, script: join(root, 'scripts', 'along-memory-service.py'),
  dataDir: join(directory, 'sdk'), envFile, workerRoot: join(directory, 'work'), timeoutMs: 120_000 }
const userId = 'u_memory_quality', goalId = 'g_memory_quality', otherGoal = 'g_memory_second'
const path = join(directory, 'along.sqlite')
let store = new AlongStore(path), backend = new HyMemoryBackend(config), service = new MemoryService(store, backend)
const proof = { syntheticOnly: true, timingsMs: {}, assertions: [], peakSampledRssMiB: 0 }
let serial = 0
const add = text => store.appendMessage({ userId, eventId: `quality-${serial++}`, role: 'user', direction: 'inbound', text })
const measured = async (name, work) => {
  const start = performance.now(), result = await work()
  proof.timingsMs[name] = Math.round(performance.now() - start)
  const processes = execFileSync('ps', ['-axo', 'ppid=,rss='], { encoding: 'utf8' }).trim().split('\n')
  for (const line of processes) {
    const [ppid, rss] = line.trim().split(/\s+/).map(Number)
    if (ppid === process.pid) proof.peakSampledRssMiB = Math.max(proof.peakSampledRssMiB, Math.round(rss / 1024))
  }
  return result
}
try {
  store.assertUser(userId, 'd_memory_quality')
  store.insertGoal({ userId, goalId, domain: 'health' }); store.insertGoal({ userId, goalId: otherGoal, domain: 'health' })
  const source = add('以后尽量安排在晚饭前运动。')
  for (const text of ['今天改到晚饭前。', '这次训练每周最多三次。', '我朋友说他喜欢晨跑。', '如果我喜欢夜跑就好了。', '我不喜欢游泳。']) {
    const message = add(text); store.linkMessageToGoals(message.id, [goalId], 'direct')
  }
  store.appendMessage({ userId, eventId: 'quality-assistant', role: 'assistant', direction: 'outbound', text: '建议你早上游泳。' })
  assert.equal((await measured('extractChineseBatch', () => service.runBatch(userId))).status, 'done')
  let active = store.memory.effective(userId)
  assert.equal(active.length, 1, 'only the explicit long-term preference may be active')
  assert.equal(active[0].content, source.text)
  proof.assertions.push('explicit-vs-temporary-goal-quoted-hypothetical-negated-assistant')
  const search = await measured('semanticRecall', () => service.search({ userId, goalId: otherGoal }, '适合安排什么时候运动？'))
  assert.equal(search.degraded, false); assert.equal(search.memories[0]?.id, active[0].id)
  proof.assertions.push('global-preference-cross-goal-recall')
  const correction = add('更正之前的安排偏好，以后都在早上运动。')
  assert.equal((await measured('correctionBatch', () => service.runBatch(userId))).status, 'done')
  active = store.memory.effective(userId)
  assert.equal(active.length, 1, 'the corrected preference must have one effective version')
  assert.equal(active[0].content, correction.text)
  proof.assertions.push('explicit-correction-supersedes-old')
  proof.modelRequestsBeforeReopen = await backend.stats(userId)
  const memoryId = active[0].id
  await service.close(); store.close()
  store = new AlongStore(path); backend = new HyMemoryBackend(config); service = new MemoryService(store, backend)
  const reopened = await measured('reopenRecall', () => service.search({ userId }, '运动时间偏好'))
  assert.equal(reopened.memories[0]?.id, memoryId)
  proof.assertions.push('sdk-and-governance-reopen')
  const before = store.counts(userId)
  service.forget({ userId }, memoryId)
  assert.equal((await service.search({ userId }, '运动时间偏好')).memories.length, 0)
  assert.equal(service.context({ userId }, [source, correction]).messages.length, 0)
  assert.equal(store.getMessage(userId, source.id)?.text, source.text)
  assert.deepEqual(store.counts(userId), before)
  await measured('cleanupRebuild', () => service.runBatch(userId))
  assert.equal(store.memory.effective(userId).length, 0)
  assert.equal((await service.search({ userId }, '运动时间偏好')).memories.length, 0)
  proof.assertions.push('withdraw-immediate-history-kept-context-filtered-cleanup-no-resurrection')
  proof.modelRequestsAfterReopen = await backend.stats(userId)
  proof.ok = true
} catch (error) {
  proof.ok = false
  // Assertion messages are our constants; provider and SDK exceptions must not be printed.
  proof.failure = error?.code === 'ERR_ASSERTION' ? error.message : 'memory verification failed'
  process.exitCode = 1
} finally {
  await service.close(); store.close()
  writeFileSync(join(directory, 'proof.json'), JSON.stringify(proof, null, 2), { mode: 0o600 })
  process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
}
