/** Strict lossless JSON output shared by all Along worker tools. */
import { alongArgumentRecovery } from './argument-recovery.ts'
import type { z } from 'zod'
import type { Tool } from '../app/tools/tool.ts'

/**
 * Same contract as the shared `tool()` helper, defined locally: this module must not load app runtime code
 * (`app/tools/tool.ts` sits on the pre-existing tool.ts → resources.ts → executor/dsh.ts → assessment.ts
 * cycle, and entering it from the Along side would leave `assessment.ts` reading a half-initialized module).
 */
function jsonOutput(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(jsonOutput)
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([name, item]) => [name, jsonOutput(item)]))
  }
  throw new Error('Along tool returned a non-JSON value')
}
// Harness 0.2.2 checks lossless JSON before rendering. Optional object fields are absent on the wire;
// invalid array items, non-finite numbers and non-JSON objects still fail rather than becoming null.
export const alongTool = <S extends z.ZodType>(definition: { name: string; description: string; schema: S
  invalidArguments?:(error:z.ZodError)=>unknown
  execute: (args: z.infer<S>, signal: AbortSignal) => Promise<unknown> }): Tool => ({ ...definition,
    execute: async (args: z.infer<S>, signal: AbortSignal) => jsonOutput(await definition.execute(args, signal)),
    ...(['along_changes_commit','along_chat_reply','along_health_followup'].includes(definition.name)
      ? {invalidArguments:definition.invalidArguments??((error:z.ZodError)=>alongArgumentRecovery(definition.name,error))} : {}),
  }) as unknown as Tool
