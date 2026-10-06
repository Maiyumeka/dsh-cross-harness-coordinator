import {VERSION} from './version.mjs';
import {openRpc,CODEX_RPC_MAX_BYTES} from './rpc.js';
import {codexApproval,recheckCodexApproval,diagnosticText} from './codex-approval.js';
import {systemClock} from './time.js';
import path from 'node:path';
import {createHash} from 'node:crypto';
const expand=(a,r)=>a.replace(/\{(prompt|workdir|model|reasoning)\}/g,(_,key)=>({prompt:r.prompt,workdir:r.cwd,model:r.task.model||'',reasoning:r.task.reasoning||''})[key]);
export async function runCodex(host,r){
 const e=r.endpoint,clock=host.clock||systemClock,deadlineAt=Math.min(r.deadlineAt||Infinity,clock.now()+r.task.timeoutMs),remaining=()=>Math.max(0,deadlineAt-clock.now());let threadId,turnId,provisionalTurnId,output='',commandOutput='',phase='initialize',lastNotification='',waiter,exit,primaryError,result,probeReceipt,closing=false,resolveTurn;
 const completed=new Map(),items=new Map(),approvals=[],generatedImages=[],pendingApprovals=new Set(),lifetime=new AbortController();
 const trace=(event,details={})=>{try{r.trace?.(event,{phase,...details});}catch{}};
 const signal=AbortSignal.any([r.signal,lifetime.signal]),turnReady=new Promise(resolve=>resolveTurn=resolve),deadlineTimer=clock.setTimeout(()=>{trace('codex_deadline',{remainingMs:remaining(),abortSource:'codex_deadline'});lifetime.abort(Object.assign(Error(r.probeOnly?'Codex连接检查超时':'Codex任务超时'),{code:'CODEX_DEADLINE'}));},remaining());
 const summary=()=>({threadId:threadId||null,turnId:turnId||provisionalTurnId||null,phase,lastNotification,exit:exit||null,approvals,generatedImages:generatedImages.filter(i=>i.threadId===threadId&&i.turnId===turnId).map(i=>({...i,scopeVerified:true})),termination:{signalAborted:r.signal.aborted,deadlineExceeded:remaining()===0,abortSource:r.signal.aborted?(r.abortContext?.source||'caller'):lifetime.signal.reason?.code==='CODEX_DEADLINE'?'codex_deadline':'none'}});
 const requestApproval=async m=>{
  const p=m.params||{},audit={requestId:m.id,method:m.method,itemId:p.itemId||null,decision:'cancel',reason:''};approvals.push(audit);if(approvals.length>64)approvals.shift();
  const expectedTurn=turnId||provisionalTurnId,scoped=!r.probeOnly&&!closing&&threadId&&p.threadId===threadId&&typeof p.turnId==='string'&&!!p.turnId&&(!expectedTurn||p.turnId===expectedTurn)&&!completed.has(p.turnId);
  if(!scoped){audit.reason='审批不属于当前任务线程或登记检查不允许审批';trace('approval_rejected',{...audit,stage:'scope'});return {result:{decision:'cancel'}};}
  provisionalTurnId=provisionalTurnId||p.turnId;
  const controller=new AbortController(),approvalSignal=AbortSignal.any([signal,controller.signal]);pendingApprovals.add(controller);let abortTurnWait;
  let stage='turn_scope';try{
   if(!turnId){await Promise.race([turnReady,new Promise((_,reject)=>{abortTurnWait=()=>reject(approvalSignal.reason);approvalSignal.addEventListener('abort',abortTurnWait,{once:true});if(approvalSignal.aborted)abortTurnWait();})]);}
   approvalSignal.throwIfAborted();if(p.turnId!==turnId||completed.has(p.turnId))throw Error('审批对应的回合已结束或变化');
   stage='proposal_validation';const proposal=codexApproval(m.method,p,items.get(p.itemId),r.cwd);
   const original=JSON.stringify(proposal);
   if(!remaining())throw Error('Codex任务期限已到，审批失效');
   if(typeof r.requestApproval!=='function')throw Error('未接入原会话审批渠道');
   stage='origin_session';trace('approval_forwarded',{method:m.method,itemId:p.itemId,threadId:p.threadId,turnId:p.turnId,requestId:m.id});const answer=await r.requestApproval({...proposal,requestId:m.id,signal:approvalSignal}),decision=typeof answer==='string'?answer:answer?.decision;
   approvalSignal.throwIfAborted();if(!remaining()||p.turnId!==turnId||completed.has(p.turnId))throw Error('审批对应的回合已超期、结束或变化');
   stage='reply_validation';if(JSON.stringify(proposal)!==original)throw Error('待批准操作已经变化，原批准失效');if(decision==='accept')recheckCodexApproval(proposal,r.cwd);
   audit.decision=decision==='accept'?'accept':'cancel';audit.reason=diagnosticText(answer?.reason|| (audit.decision==='accept'?'原任务会话批准本次操作':'原任务会话拒绝或撤回本次操作'),2000);if(answer?.code)audit.code=answer.code;
  }catch(error){audit.reason=diagnosticText(error?.message||error,2000);audit.stage=stage;if(error?.code)audit.code=error.code;}finally{if(abortTurnWait)approvalSignal.removeEventListener('abort',abortTurnWait);pendingApprovals.delete(controller);trace(audit.decision==='accept'?'approval_reply':'approval_rejected',{...audit,stage});}
  return {result:{decision:audit.decision}};
 };
 let rpc;try{rpc=await openRpc(host,{...r,signal},{argv:[e.command,...e.args.map(a=>expand(a,r))],maxMessageBytes:CODEX_RPC_MAX_BYTES,onTrace:trace,onRequest:m=>{
  const p=m.params||{};trace('codex_request_enter',{method:m.method,requestId:m.id,itemId:p.itemId,threadId:p.threadId,turnId:p.turnId});
  if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(m.method))return requestApproval(m);
  const audit={requestId:m.id,method:m.method,decision:'not_granted',reason:'额外权限、交互输入或外部工具授权未接入'};approvals.push(audit);if(approvals.length>64)approvals.shift();
  trace('approval_rejected',{...audit,stage:'unsupported_interaction'});
  if(m.method==='item/permissions/requestApproval')return {result:{permissions:{},scope:'turn'}};
  if(m.method==='mcpServer/elicitation/request')return {result:{action:'cancel',content:null}};
  return {error:{code:-32601,message:'该交互未接入原会话审批，不自动授予权限'}};
 },onNotification:m=>{
  const p=m.params||{};if(p.threadId&&p.threadId!==threadId)return;
  if(p.turnId&&(turnId||provisionalTurnId)&&p.turnId!==(turnId||provisionalTurnId))return;
  lastNotification=String(m.method||'').slice(0,160);
  if(m.method==='item/agentMessage/delta'&&(!turnId||p.turnId===turnId))output=(output+String(p.delta||'')).slice(-256000);
  if(m.method==='item/commandExecution/outputDelta')commandOutput=(commandOutput+String(p.delta||'')).slice(-64000);
  if(['item/started','item/completed'].includes(m.method)&&p.item?.id){
   const item=p.item,image=item.type==='imageGeneration'?item:item.type==='extension'&&item.kind==='image_gen.generation'?item.payload:null;
   if(image&&m.method==='item/completed'){
    if(p.threadId!==threadId||typeof p.turnId!=='string'||!p.turnId)return;
    const savedPath=typeof image.savedPath==='string'&&path.isAbsolute(image.savedPath)&&image.savedPath.length<=1000?diagnosticText(image.savedPath,1000):null,entry={itemId:String(item.id).slice(0,200),status:String(image.status||item.status||'unknown').slice(0,100),savedPath,resultChars:typeof image.result==='string'?image.result.length:0,failure:image.failure?String(image.failure.type||'image_failure').slice(0,200):null};
    entry.threadId=p.threadId;entry.turnId=p.turnId;
    if(typeof image.result==='string'&&image.result.length&&image.result.length%4===0&&!/[^A-Za-z0-9+/=]/.test(image.result)){
     const padding=image.result.endsWith('==')?2:image.result.endsWith('=')?1:0;
     if(!image.result.slice(0,image.result.length-padding).includes('='))entry.sha256=createHash('sha256').update(Buffer.from(image.result,'base64')).digest('hex');
    }
    const index=generatedImages.findIndex(g=>g.itemId===entry.itemId);if(index>=0)generatedImages[index]=entry;else{generatedImages.push(entry);if(generatedImages.length>16)generatedImages.shift();}
    trace('codex_image_completed',{itemId:entry.itemId,threadId:p.threadId,turnId:p.turnId,artifactPath:savedPath,imageStatus:entry.status,encodedChars:entry.resultChars});
   }
   if(['commandExecution','fileChange'].includes(item.type)&&JSON.stringify(item).length<=32000){items.set(item.id,item);if(items.size>128)items.delete(items.keys().next().value);}
  }
  if(m.method==='turn/started'&&p.turn?.id)provisionalTurnId=provisionalTurnId||p.turn.id;
  if(m.method==='turn/completed'&&p.turn?.id){completed.set(p.turn.id,p.turn);if(completed.size>32)completed.delete(completed.keys().next().value);if(p.turn.id===(turnId||provisionalTurnId)){for(const c of pendingApprovals)c.abort(Error('回合结束，撤回未完成审批'));waiter?.(p.turn);}}
 }});}catch(error){clock.clearTimeout(deadlineTimer);error.protocolStage='launch';throw error;}
 const call=(method,params)=>{signal.throwIfAborted();if(!remaining())throw Error('Codex总预算已耗尽');return rpc.request(method,params,Math.max(1,Math.min(15000,remaining())));};
 rpc.h.done.then(value=>exit=value,()=>{});
 try{
  const initialized=await call('initialize',{clientInfo:{name:'dsh-cross-harness-coordinator',version:VERSION},capabilities:{experimentalApi:false}});if(typeof initialized?.userAgent!=='string'||!initialized.userAgent)throw Error('Codex初始化响应无效');await rpc.send({method:'initialized',params:{}});
  phase='model/list';const models=await call('model/list',{});if(!Array.isArray(models?.data))throw Error('Codex没有返回模型目录');
  if(r.probeOnly)probeReceipt={protocol:'codex',handshakeVerified:true,methods:['initialize','initialized','model/list'],models:models.data.slice(0,200),accessVerified:false,approvalPolicy:'origin-session-one-shot',checkedAt:new Date().toISOString()};
  else{
   phase='thread/start';const started=await call('thread/start',{cwd:r.cwd,...(r.task.model?{model:r.task.model}:{})});threadId=started?.thread?.id;if(!threadId)throw Error('Codex没有创建线程');
   phase='turn/start';const turn=await call('turn/start',{threadId,input:[{type:'text',text:r.prompt}],...(r.task.model?{model:r.task.model}:{}),...(r.task.reasoning?{effort:r.task.reasoning}:{})});turnId=turn?.turn?.id;if(!turnId)throw Error('Codex没有返回turnId');if(provisionalTurnId&&provisionalTurnId!==turnId)throw Error('Codex审批或通知回合与启动结果不一致');resolveTurn();
   phase='turn/completed';const terminal=completed.get(turnId)||await Promise.race([rpc.failure,new Promise((resolve,reject)=>{
    waiter=resolve;const abort=()=>reject(signal.reason||Error('任务取消'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();r.signalCleanup=()=>signal.removeEventListener('abort',abort);
   })]);
   const cancelled=approvals.find(a=>a.decision==='cancel');result={ok:terminal.status==='completed'&&!cancelled,error:cancelled?'Codex操作审批未通过：'+cancelled.reason:terminal.status==='completed'?'':'Codex未完成：'+diagnosticText(terminal.error?.message||terminal.status,2000),status:terminal.status};
  }
 }catch(error){primaryError=error instanceof Error?error:Error(String(error));}
 finally{
  clock.clearTimeout(deadlineTimer);r.signalCleanup?.();closing=true;rpc.beginClose();lifetime.abort(Error('Codex调用结束，撤回未完成审批'));
  if(threadId&&turnId&&!completed.has(turnId))await rpc.send({id:2147483647,method:'turn/interrupt',params:{threadId,turnId}}).catch(()=>{});
  try{await rpc.close();}catch(error){if(!primaryError)primaryError=Object.assign(error,{protocolStage:'cleanup'});}
 }
 if(!primaryError&&r.signal.aborted)primaryError=r.signal.reason instanceof Error?r.signal.reason:Error('Codex调用已取消');
 if(primaryError){primaryError.protocolStage=primaryError.protocolStage||phase;trace('codex_failed',{stage:primaryError.protocolStage,code:primaryError.code||'',reason:primaryError.message});if(r.probeOnly)throw primaryError;const denial=approvals.find(a=>a.decision!=='accept');result={ok:false,status:'failed',error:diagnosticText(primaryError.message,2000)+(denial?'；审批记录：'+denial.reason:'')};}
 if(probeReceipt&&!primaryError)return probeReceipt;
 const transport=rpc.diagnostics;if(transport.failure)transport.failure.message=diagnosticText(transport.failure.message,2000);
 return {...result,output:diagnosticText(output,256000),stderr:diagnosticText(rpc.stderr),usage:null,native:{...summary(),transport,failedPhase:primaryError?.protocolStage||(!result.ok?phase:null),status:result.status,commandOutput:diagnosticText(commandOutput)}};
}
export async function runStructuredCli({launch},r){
 const e=r.endpoint,argv=[e.command,...(r.probeOnly?e.probe_args:e.args).map(a=>expand(a,r))];
 if(!r.probeOnly&&e.prompt_mode==='arg'&&!e.args.some(a=>a.includes('{prompt}')))argv.push(r.prompt);
 const h=await launch({...r,argv,env:e.launch_env||{}});let stdout='',stderr='',overflow=false;
 h.stdout.setEncoding('utf8');h.stdout.on('data',b=>{stdout+=b;if(Buffer.byteLength(stdout)>2*1024*1024){overflow=true;void h.stop().catch(()=>{});}});h.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-256000);});h.stdin.on('error',()=>{});
 const timer=setTimeout(()=>void h.stop().catch(()=>{}),r.task.timeoutMs);
 try{
  h.stdin.end(!r.probeOnly&&e.prompt_mode==='stdin'?r.prompt:undefined);const exit=await h.done;r.signal.throwIfAborted();if(overflow)throw Error('CLI结构化输出超过2MiB');
  if(r.probeOnly){if(exit.exitCode!==0||!stdout.trim())throw Error('CLI帮助或版本检查失败');return {protocol:'cli',handshakeVerified:true,methods:['help/version'],checkKind:'launch-only',structuredExecutionVerified:false,checkedAt:new Date().toISOString()};}
  const parsed=e.cli.format==='json'?JSON.parse(stdout):null,messages=e.cli.format==='json'?(Array.isArray(parsed)?parsed:[parsed]):stdout.split(/\r?\n/).filter(s=>s.trim()).map(s=>JSON.parse(s));
  let terminal,output='',usage=null,failed=false;
  for(const m of messages){
   if(e.cli.preset==='codex'){if(m.type==='item.completed'&&m.item?.type==='agent_message')output+=m.item.text||'';if(['turn.completed','turn.failed','error'].includes(m.type)){failed||=m.type!=='turn.completed';terminal={ok:m.type==='turn.completed',error:m.error?.message||m.message||m.type};}usage=m.usage||usage;}
   else if(e.cli.preset==='claude'){if(m.type==='result'){terminal={ok:m.subtype==='success'&&m.is_error!==true,error:m.errors?.join('; ')||m.subtype};output=m.result||'';usage=m.usage||null;}}
   else{const value=e.cli.successField.split('.').reduce((v,k)=>v&&typeof v==='object'&&Object.hasOwn(v,k)?v[k]:undefined,m);if(value!==undefined){terminal={ok:value===e.cli.successValue,error:'CLI返回失败终态'};output=typeof m.output==='string'?m.output:JSON.stringify(m);}}
  }
  const ok=exit.exitCode===0&&terminal?.ok===true&&!failed;return {ok,output:output.slice(-256000),stderr,usage,error:ok?'':exit.exitCode!==0?'CLI退出码 '+exit.exitCode:failed?'CLI返回失败事件':terminal?.error||'CLI缺少结构化完成事件'};
 }finally{clearTimeout(timer);await h.stop();}
}
