/** Isolated, read-only Harness verification plugin. Not installed in the product bundle. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {createScope} from '@deepseek-ai/dsh-scope';
export const name='along-phase0-worker-probe';
export const inject=['orchestrator','tools','subprocess','agents','skills','systemPrompt','sessionController'];
export function apply(ctx){
 const rt=ctx.orchestrator;
 const allowedRoot=resolve(import.meta.dirname,'../.artifacts/along-phase0');
 if(!resolve(rt.machine.stateDir).startsWith(allowedRoot+sep))throw new Error('Worker probe requires an isolated .artifacts/along-phase0 state directory');
 const file=join(rt.machine.stateDir,'..','worker-proof.json');
 const previous=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
 const proof={...previous,status:'starting',skillRead:previous.skillRead??false};
 const save=()=>{let out=JSON.stringify(proof,null,2);for(const name of ['ALONG_PHASE0_API_KEY','KIMI_CODE_TOKEN','ALONG_PAIRING_TOKEN','DSH_ADMIN_TOKEN'])if(process.env[name])out=out.replaceAll(process.env[name],'[REDACTED]');writeFileSync(file,out)};
 const verifyEndedGuard=async agent=>{
  // Harness 0.2.2 accepts raw call batches rather than the 0.2.1 single-call API.
  const batch=await ctx.tools.execute({calls:[{id:'phase0-after-ended',name:'along_phase0_verify',arguments:'{}'}],agent,signal:new AbortController().signal});
  const result=batch.results[0]?.result;
  proof.endedGuardReason=result?.error?.message;
  proof.endedGuardDenied=result?.isError===true&&proof.endedGuardReason==='Ticket ended; new work needs a new authorized ticket';
  proof.ticketEnded=true;
  if(!proof.endedGuardDenied)throw new Error('Expected the specific ended Ticket guard denial');
  if(!proof.skillRead||!proof.workerCreated||!proof.childEnvClean||proof.childExit!==0||proof.secretInPrompt!==false||proof.secretInEvents!==false||proof.workTools?.length!==3)throw new Error('Worker verification evidence is incomplete');
  delete proof.errorType;
  proof.status='complete';save();
 };
 let worker;
 ctx.on('tools/result',(exec,result)=>{
  if(exec.agent?.id.startsWith('worker-') && exec.name==='skill' && !result.isError)proof.skillRead=true;
 });
 ctx.on('agent/created',async({agent})=>{
  if(!agent.id.startsWith('worker-'))return;
  worker=agent;
  const scoped=createScope(ctx,agent);
  ctx.effect(()=>()=>scoped.dispose());
  scoped.ctx.skills.register({name:'along-phase0-check',description:'Read this skill for the Along phase zero verification task.',source:'runtime',content:'For this synthetic verification only: call along_phase0_verify, then report state=dropped with summary=Along phase zero verified. Do not perform any other work.'});
  scoped.ctx.tools.register({name:'along_phase0_verify',description:'Run the read-only synthetic Along feasibility checks. Call after reading along-phase0-check.',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok']},render:(_,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:async(_,exec)=>{
   const assembly=await scoped.ctx.systemPrompt.assemble({scope:agent,signal:exec.signal});
   const text=JSON.stringify(assembly);
   const secrets=['ALONG_PHASE0_API_KEY','KIMI_CODE_TOKEN','ALONG_PAIRING_TOKEN','DSH_ADMIN_TOKEN'].map(k=>process.env[k]).filter(Boolean);
   proof.secretInPrompt=secrets.some(value=>text.includes(value));
   proof.secretInEvents=secrets.some(value=>JSON.stringify(agent.session.snapshotEvents()).includes(value));
   proof.workTools=['read','bash','skill'].filter(name=>scoped.ctx.tools.get(name,agent));
   const handle=ctx.subprocess.spawn({argv:['node','-e','console.log(JSON.stringify(["ALONG_PHASE0_API_KEY","KIMI_CODE_TOKEN","ALONG_PAIRING_TOKEN","DSH_ADMIN_TOKEN"].filter(k=>process.env[k])))'],cwd:rt.store.tickets.get(agent.id.slice(7)).execution.directory,stdio:{stdin:'ignore',stdout:{maxBytes:4096},stderr:{maxBytes:4096}},graceMs:100,signal:exec.signal});
   const done=await handle.done;
   proof.childExit=done.exitCode;
   proof.childEnvClean=JSON.parse(handle.collected.stdout.readFrom(0).text).length===0;
   proof.workerCreated=true;
   proof.status='verified';save();
   return{ok:proof.skillRead&&!proof.secretInPrompt&&!proof.secretInEvents&&proof.childEnvClean&&proof.workTools.length===3};
  }});
  scoped.ctx.tools.guard(exec=>['skill','along_phase0_verify','orchestrator_report'].includes(exec.name)?undefined:'Phase zero: only the verification skill, verification tool and report are permitted.');
 });
 ctx.effect(()=>{
  let timer;
  const start=async()=>{
   await rt.ready;
   const ended=rt.store.tickets.list().find(t=>t.origin.triggerId==='along-actual-worker-phase0'&&t.ended);
   if(ended){
    const loaded=await ctx.sessionController.resolveAgent(`worker-${ended.id}`);
    if('error' in loaded)throw new Error('Cannot restore probe worker');
    await verifyEndedGuard(loaded.agent);return;
   }
   const settings=rt.store.settings();
   rt.store.saveSettings({...settings,eval:{...settings.eval,mode:'auto'},policy:{...settings.policy,sources:{along:{allowed:[{id:'phase0-user'}],admission:{}}}}});
   rt.receive({id:'along-actual-worker-phase0',source:'along',threads:[{source:'along',id:'phase0/work/actual-worker'}],actor:{source:'along',id:'phase0-user'},human:true,addressed:'direct',at:new Date().toISOString(),text:'这是一次只读的合成验证任务。请创建工单并派给 Worker。Worker 先用 skill 读取 along-phase0-check，再调用 along_phase0_verify，最后调用 orchestrator_report，state=dropped，summary=Along phase zero verified。不要修改文件，不要访问用户资料，不要进行其他工作。',meta:{event_type:'along.user_message'}});
   const deadline=Date.now()+90000;
   timer=setInterval(async()=>{
    const master=ctx.agents.get(rt.masterId); proof.masterStatus=master?.status; proof.masterEvents=master?.session.snapshotEvents().slice(-8).map(e=>({type:e.type,keys:Object.keys(e), ...(String(e.type).includes('error')?{data:e.data}: {})})); const ticket=rt.store.tickets.list().find(t=>t.origin.triggerId==='along-actual-worker-phase0'); save();
    if(ticket?.ended&&worker&&proof.status==='verified'){
     clearInterval(timer);
     await verifyEndedGuard(worker).catch(error=>{proof.status='failed';proof.errorType=error.name;save();});
    }else if(Date.now()>deadline){clearInterval(timer);proof.status='timeout';proof.ticketEnded=Boolean(ticket?.ended);save();}
   },500);
   save();
  };
  start().catch(error=>{proof.status='failed';proof.errorType=error.name;save();});
  return()=>{clearInterval(timer)};
 });
}
