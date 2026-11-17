/** Model repair instructions contain schema structure only, never supplied personal values or fabricated receipts. */
import type { z } from 'zod'
const recommendation={kind:'hiking',title:'Candidate comparison',summary:'Conditions remain unverified.',constraints:[],options:[{id:'candidate_a',title:'Candidate',reason:'Compare existing evidence.',conditions:[],unknowns:['Access and weather need verification.'],facts:[],checks:[{kind:'access',status:'unknown',summary:'Unverified.',evidence:[]},{kind:'weather',status:'unknown',summary:'Unverified.',evidence:[],alertStatus:'unknown',alertEvidence:[]}]}],nextStep:'Verify official conditions before departure.'}
export function alongArgumentRecovery(name:string,error:z.ZodError) {
 const flatten=(issues:readonly z.core.$ZodIssue[],base:PropertyKey[]=[]):{path:string;message:string}[]=>issues.flatMap(issue=>{
  const path=[...base,...issue.path]
  // Unknown fields, especially host-bound identities, keep their established hard rejection.
  if(issue.code==='unrecognized_keys')throw error
  return issue.code==='invalid_union'?issue.errors.flatMap(branch=>flatten(branch,path)):[{path:path.join('.'),message:issue.message}]
 })

 const issues=flatten(error.issues).slice(0,8)
 const common='No operation or message was written. Repair only the listed invalid fields in the complete authorized envelope. Read actual host state for ids and revisions; never repeat the same invalid object or coerce version strings.'
 const specific=name==='along_changes_commit'
  ? 'Both base_revision and ops[i].base_revision are JSON integers, not quoted strings or labels. Read along_goal_read for root current_revision/input_version and along_task_list for each task revision. Do not edit an automatic task to done: after its trigger is persisted/read back, finish planning and report ready; the Host dispatches execution separately.'+
    (issues.some(i=>i.path.includes('reminder_plan'))?' reminder_plan.source is agent or user; scheduled plans require explanation. Clock/repeat belong in task.update.fields; preserve existing cadence.':'')
  :name==='along_chat_reply'||name==='along_health_followup'||name==='along_task_finish'
  ? 'recommendation is ONE object. recommendation.title and every option.title are strings, never arrays. Keep kind,title,summary,constraints,options,nextStep; each option needs id,title,reason,conditions,unknowns,facts,checks. Unknown arrays may be empty. Use only actual Along source IDs and exact supported quotes. If budget is exhausted, stop browsing and deliver partial/unknown from existing evidence; never fabricate facts or sources. Host computes statuses and dates.'
  : 'Read the tool parameter schema and repair only the listed fields.'
 const structure=name==='along_chat_reply'?{text:'Conditions remain unverified.',recommendation}
  :name==='along_health_followup'?{outcome:'keep',types:[],reason:'This review finished with unknown conditions.',text:'Conditions remain unverified.',recommendation}:undefined
 return {status:'invalid',reason:'invalid_arguments',issues,guidance:common+' '+specific,
  ...(name==='along_changes_commit'?{required_types:{base_revision:'JSON integer from goal current_revision',input_version:'JSON integer from goal input_version',task_base_revision:'JSON integer from task revision'}}:{}),...(structure?{structure_example:structure}:{})}
}
