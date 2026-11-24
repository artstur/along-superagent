/** Built administrative entry. All writes remain owned by AlongStore; CLI runs only under cold Runtime locks. */
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AlongStore } from './along/store.ts'
import { abortHandoff, activateHandoffTarget, assertHandoffOrchestratorDrained, assertHandoffSchema, freezeHandoffSource, HandoffError,
  expectedHandoffTarget, handoffSHA256, readHandoffActivationPermit, readHandoffStatus, readPersonalHandoff, retireHandoffSource, sourceHandoffPreparation, sourceHandoffStatus,
  stageHandoffTarget, withColdHandoffLocks, writeHandoffActivationPermit, writePersonalHandoff, type HandoffExportInput,
  type HandoffManifest, type PersonalHandoff } from './along/handoff.ts'
export * from './along/handoff.ts'

function argumentsOf(argv: string[]): { command: string; values: Map<string, string> } {
  const [command, ...rest] = argv, commands = ['inspect', 'freeze-source', 'stage-target', 'retire-source', 'activate-target', 'abort', 'status']
  if (!command || !commands.includes(command)) throw new HandoffError('handoff_invalid_command')
  const values = new Map<string, string>()
  const allowed = new Set(['data-dir', 'state-dir', 'user', 'device', 'goals', 'target-origin', 'migration-id', 'host-companion-sha256', 'package', 'permit-file'])
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, ''), value = rest[i + 1]
    if (!rest[i]?.startsWith('--') || !key || !allowed.has(key) || values.has(key) || !value || value.startsWith('--')) throw new HandoffError('handoff_invalid_argument')
    values.set(key, value)
  }
  return { command, values }
}
const required = (values: Map<string, string>, key: string): string => {
  const value = values.get(key)
  if (!value) throw new HandoffError('handoff_missing_' + key.replaceAll('-', '_'))
  return value
}
const summary = (manifest: HandoffManifest) => ({ format: manifest.format, migrationId: manifest.migrationId, schemaVersion: manifest.schemaVersion,
  snapshotSHA256: manifest.snapshotSHA256, syncPrefixSHA256: manifest.syncPrefixSHA256, syncHighWaterMark: manifest.syncHighWaterMark,
  hostCompanionSHA256: manifest.hostCompanionSHA256,
  tables: manifest.tables })
function coldOrchestrator(stateDir: string): void {
  const database = new DatabaseSync(join(stateDir, 'orchestrator.sqlite'), { readOnly: true })
  try { assertHandoffOrchestratorDrained(database) } finally { database.close() }
}
function sourceInput(values: Map<string, string>, preparation: { createdAt: string; activationPermit: string }): HandoffExportInput {
  const migrationId = required(values, 'migration-id')
  return { migrationId, sourceUserId: required(values, 'user'), sourceDeviceId: required(values, 'device'),
    goalIds: required(values, 'goals').split(','), targetOrigin: required(values, 'target-origin'), createdAt: preparation.createdAt,
    hostCompanionSHA256: required(values, 'host-companion-sha256'),
    // The commitment hashes the literal lower-case 64-hex permit string, not the decoded bytes.
    activationPermitSHA256: permitHash(preparation.activationPermit) }
}
const permitHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
function existingSchema(dataDir: string, allowMissing = false): void {
  const file = join(dataDir, 'along.sqlite')
  if (!existsSync(file) && allowMissing) return
  const db = new DatabaseSync(file, { readOnly: true })
  try { assertHandoffSchema(db) } finally { db.close() }
}

/** Returns sanitized metadata only. Package/permit contents are written to owner-only files, never stdout. */
export function runHandoffCLI(argv: string[]): unknown {
  const { command, values } = argumentsOf(argv), dataDir = resolve(required(values, 'data-dir'))
  if (command === 'status') return readHandoffStatus(dataDir) ?? { phase: 'none' }
  if (command === 'activate-target' && readHandoffStatus(dataDir)?.phase === 'target_active') {
    // Lost activation ACK: legitimate new cloud writes may already exist. Never compare them to the old snapshot or restart either writer.
    const status = readHandoffStatus(dataDir)!, packet = readPersonalHandoff(resolve(required(values, 'package')))
    const permit = readHandoffActivationPermit(resolve(required(values, 'permit-file')))
    if (status.manifest.migrationId !== required(values, 'migration-id') || handoffSHA256(status.manifest) !== handoffSHA256(packet.manifest) ||
      permitHash(permit) !== status.manifest.activationPermitSHA256) throw new HandoffError('handoff_conflicting_migration')
    const db = new DatabaseSync(join(dataDir, 'along.sqlite'), { readOnly: true })
    try {
      if (!sourceHandoffStatus(db, dataDir, { userId: packet.manifest.sourceUserId, deviceId: packet.manifest.sourceDeviceId }))
        throw new HandoffError('handoff_invalid_checkpoint')
    } finally { db.close() }
    return { ...status, reused: true }
  }
  const stateDir = resolve(required(values, 'state-dir'))
  return withColdHandoffLocks(dataDir, stateDir, () => {
    coldOrchestrator(stateDir)
    if (command === 'retire-source') {
      const file = resolve(required(values, 'permit-file')), permit = retireHandoffSource(dataDir, required(values, 'migration-id'))
      if (existsSync(file)) {
        if (readHandoffActivationPermit(file) !== permit) throw new HandoffError('handoff_output_conflict')
      } else writeHandoffActivationPermit(file, permit)
      return { phase: 'source_retired', permitFileWritten: true }
    }
    if (command === 'abort') return abortHandoff(dataDir, required(values, 'migration-id'))
    if (command === 'activate-target') {
      const packet = readPersonalHandoff(resolve(required(values, 'package'))), stored = readHandoffStatus(dataDir)
      const permit = readHandoffActivationPermit(resolve(required(values, 'permit-file')))
      if (!stored || handoffSHA256(stored.manifest) !== handoffSHA256(packet.manifest) || packet.manifest.migrationId !== required(values, 'migration-id'))
        throw new HandoffError('handoff_conflicting_migration')
      existingSchema(dataDir)
      const store = new AlongStore(join(dataDir, 'along.sqlite'))
      try {
        const actual = store.exportPersonalHandoff(packet.manifest), expected = expectedHandoffTarget(packet)
        if (actual.manifest.snapshotSHA256 !== expected.snapshotSHA256 || actual.manifest.syncHighWaterMark !== expected.syncHighWaterMark ||
          handoffSHA256(stored.targetReceipt) !== handoffSHA256(expected)) throw new HandoffError('handoff_target_changed')
        store.activatePersonalHandoffCheckpoint(packet.manifest, permit)
      } finally { store.close() }
      return activateHandoffTarget(dataDir, packet.manifest.migrationId, permit)
    }
    existingSchema(dataDir, command === 'stage-target')
    const store = new AlongStore(join(dataDir, 'along.sqlite'))
    try {
      if (command === 'stage-target') {
        const packet = readPersonalHandoff(resolve(required(values, 'package'))), previous = readHandoffStatus(dataDir), expected = expectedHandoffTarget(packet)
        let identical = false
        if (previous) {
          try {
            const actual = store.exportPersonalHandoff(packet.manifest).manifest
            identical = actual.snapshotSHA256 === packet.manifest.snapshotSHA256 && actual.syncHighWaterMark === packet.manifest.syncHighWaterMark ||
              actual.snapshotSHA256 === expected.snapshotSHA256 && actual.syncHighWaterMark === expected.syncHighWaterMark
          }
          catch { /* Empty target after an interrupted stage is safely importable; other data is refused below. */ }
        }
        // Refuse unrelated data before writing its fence. Fence before commit so a crash cannot run imported schedules.
        if (!identical) store.assertPersonalHandoffImportable(packet)
        stageHandoffTarget(dataDir, packet.manifest)
        if (!identical) store.importPersonalHandoff(packet)
        const targetReceipt = store.applyPersonalHandoffSourceHolds(packet.manifest)
        if (handoffSHA256(targetReceipt) !== handoffSHA256(expected)) throw new HandoffError('handoff_source_hold_failed')
        stageHandoffTarget(dataDir, packet.manifest, targetReceipt)
        return { phase: 'target_staged', reused: identical, targetReceipt, ...summary(packet.manifest) }
      }
      const preparation = sourceHandoffPreparation(dataDir, required(values, 'migration-id'))
      const input = sourceInput(values, preparation), packet: PersonalHandoff = store.exportPersonalHandoff(input)
      if (command === 'inspect') return { phase: 'inspected', ...summary(packet.manifest) }
      freezeHandoffSource(dataDir, packet, preparation.activationPermit)
      const file = resolve(required(values, 'package'))
      if (existsSync(file)) {
        if (handoffSHA256(readPersonalHandoff(file)) !== handoffSHA256(packet)) throw new HandoffError('handoff_output_conflict')
      } else writePersonalHandoff(file, packet)
      return { phase: 'source_frozen', ...summary(packet.manifest) }
    } finally { store.close() }
  })
}
