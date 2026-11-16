/** Preserve strict parsing while letting a tool explain a rejected model argument shape. */
import type { z } from 'zod'
export async function executeToolArguments<S extends z.ZodType>(schema:S,args:unknown,signal:AbortSignal,
 execute:(args:z.infer<S>,signal:AbortSignal)=>Promise<unknown>,invalidArguments?:(error:z.ZodError)=>unknown):Promise<unknown> {
 const parsed=schema.safeParse(args)
 if(!parsed.success) {
  if(invalidArguments)return invalidArguments(parsed.error)
  throw parsed.error
 }
 return execute(parsed.data,signal)
}
