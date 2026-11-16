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

 const common='No operation or message was written by this rejected call. Correct the listed fields and resubmit the COMPLETE envelope, preserving other required fields. Never repeat the same invalid object. Do not coerce version strings: read the current host revision/input_version and send JSON integers. Examples are structure only; replace ALL sample IDs, revisions, dates and text with actual host reads and authorized evidence; never submit the example timestamp.'
 const specific=name==='along_changes_commit'
  ? 'Both base_revision and ops[i].base_revision are JSON integers, not quoted strings. Use the goal current_revision for the root, task revision for the op. reminder_plan.source is only agent or user; scheduled plans require explanation. scheduled_at and repeat belong in task.update.fields, never inside reminder_plan. For an explicit 补上每周 instruction, retain 补上 in the exact evidence quote. An action clock without a reminder verb is not source:user reminder evidence; use source:agent with a truthful explanation while preserving the existing authorized time. Read the exact user mandate before weekly: repeat must be weekly in fields, not merely mentioned in explanation. Existing time/reminders need no rewrite for an ordinary recommendation. On a business refusal follow its guidance; never claim weekly succeeded when only once applied.'
  :name==='along_chat_reply'||name==='along_health_followup'
  ? 'recommendation is ONE object. recommendation.title and every option.title are strings, never arrays. Keep kind,title,summary,constraints,options,nextStep; each option needs id,title,reason,conditions,unknowns,facts,checks. Unknown arrays may be empty. Use only actual Along source IDs and exact supported quotes. If budget is exhausted, stop browsing and deliver partial/unknown from existing evidence; never fabricate facts or sources. Host computes statuses and dates.'
  : 'Read the tool parameter schema and repair only the listed fields.'
 const structure=name==='along_changes_commit'?{idempotency_key:'new_key_for_corrected_submission',base_revision:1,input_version:1,reason:'Explain the authorized change.',ops:[{op:'task.update',task_id:'existing_task_id',base_revision:1,fields:{repeat:'weekly',scheduled_at:'2030-01-04T19:00:00+08:00',reminder_plan:{state:'scheduled',source:'agent',explanation:'Preserve the existing authorized civil time.',evidence:'EXACT explicit add-weekly command including its imperative',action:'distinctive action shared with existing task'}}}]}
  :name==='along_chat_reply'?{text:'Conditions remain unverified.',recommendation}
  :name==='along_health_followup'?{outcome:'keep',types:[],reason:'This review finished with unknown conditions.',text:'Conditions remain unverified.',recommendation}:undefined
 return {status:'invalid',reason:'invalid_arguments',issues:flatten(error.issues).slice(0,8),guidance:common+' '+specific,...(structure?{structure_example:structure}:{})}
}
