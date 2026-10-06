import readline from 'node:readline';
import {VERSION} from './version.mjs';
import {runMcp} from './mcp.js';
import {runCodex,runStructuredCli} from './native.js';
import {runWorker} from './remote.js';
import {probeEntryVersion} from './version-probe.js';
import {systemClock} from './time.js';

// A connection check never submits a prompt, selects a model, or approves permissions.
export async function probeHarness(host,request){
 const clock=host.clock||systemClock,started=clock.now(),deadlineAt=Math.min(request.deadlineAt||Infinity,started+15000),checked={...request,deadlineAt,probeOnly:true,prompt:'',task:{timeoutMs:Math.max(1,deadlineAt-started)}};let versionProbeMs,stage='version_probe';
 try{
  checked.signal.throwIfAborted();const entryVersion=await probeEntryVersion(host,checked);versionProbeMs=clock.now()-started;stage='connection_budget';
  checked.signal.throwIfAborted();if(clock.now()>=deadlineAt)throw Object.assign(Error('连接检查预算已耗尽'),{protocolStage:stage,code:'COORDINATOR_CONNECTION_DEADLINE'});checked.task.timeoutMs=deadlineAt-clock.now();
  const receipt=await runHarness(host,checked);if(receipt.diagnostics)Object.assign(receipt.diagnostics,{connectionBudgetMs:deadlineAt-started,versionProbeMs});return {...receipt,entryVersion};
 }catch(error){
  if(checked.endpoint.protocol==='mcp'){
   error.protocolStage=error.protocolStage||stage;
   error.connectionReceipt={...(error.connectionReceipt||{protocol:'mcp',transport:checked.endpoint.mcp.transport,handshakeVerified:false,negotiationAttempts:[]}),diagnostics:{...(error.connectionReceipt?.diagnostics||{requestedEra:checked.endpoint.mcp.era||'legacy',signalAborted:checked.signal.aborted,abortSource:checked.signal.aborted?(request.abortContext?.source==='connection_deadline'?'connection_deadline':'caller'):clock.now()>=deadlineAt?'connection_deadline':'none',fallbackDecision:{attempted:false,reason:'preflight_failed'},failedPhase:stage,elapsedMs:clock.now()-started}),connectionBudgetMs:deadlineAt-started,versionProbeMs:versionProbeMs??clock.now()-started}};
  }throw error;
 }
}

// The host supplies sandboxed, managed processes. No shell source is constructed.
export async function runHarness({launch,clock},request){
 const {endpoint:e,task,prompt,signal,cwd,probeOnly=false}=request;
 if(e.protocol==='mcp')return runMcp({launch,clock},request);
 if(e.protocol==='a2a'||e.protocol==='opencode'||e.protocol==='claude-sdk'||(e.protocol==='codex'&&e.server))return runWorker({launch},request);
 if(e.protocol==='codex')return runCodex({launch,clock},request);
 if(e.protocol==='cli')return runStructuredCli({launch},request);
 if(probeOnly&&e.protocol!=='acp')throw Error('这个执行端使用text协议，不能标记ACP握手成功');
 if(probeOnly&&e.args.some(a=>/\{(?:prompt|model|reasoning)\}/.test(a)))throw Error('ACP握手入口不能依赖任务、模型或思考参数');
 const argv=[e.command,...e.args.map(a=>a.replaceAll('{prompt}',prompt).replaceAll('{model}',task.model||'').replaceAll('{reasoning}',task.reasoning||'').replaceAll('{workdir}',cwd))];
 if(e.protocol==='text'&&e.prompt_mode==='arg'&&!e.args.some(a=>a.includes('{prompt}')))argv.push(prompt);
 const h=await launch({...request,argv,env:e.launch_env||{}});let out='',err='',usage=null,timedOut=false;
 h.stderr.on('data',b=>{err=(err+b.toString()).slice(-256000);});
 let timer,lines,phase='launch',seq=0;const pending=new Map();const rejectPending=message=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error(message));}pending.clear();};
 const aborted=()=>{rejectPending('ACP连接检查已取消');void h.stop().catch(()=>{});};
 signal.addEventListener('abort',aborted,{once:true});
 const stdinError=error=>rejectPending(error.message);h.stdin.on('error',stdinError);
 h.done.then(()=>rejectPending('执行端已退出'),e=>rejectPending(e.message));
 const req=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(Error('ACP连接或调用超时：'+method));},method==='session/prompt'?task.timeoutMs:Math.min(task.timeoutMs,15000));pending.set(id,{resolve,reject,timer});h.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n',error=>{if(error){pending.delete(id);clearTimeout(timer);reject(error);}});});
 try{
  signal.throwIfAborted();
  timer=setTimeout(()=>{timedOut=true;void h.stop().catch(()=>{});},task.timeoutMs);timer.unref?.();
  if(e.protocol==='text'){h.stdout.on('data',b=>{out=(out+b.toString()).slice(-256000);});h.stdin.on('error',()=>{});h.stdin.end(e.prompt_mode==='stdin'?prompt:undefined);const result=await h.done;return {ok:result.exitCode===0,exitCode:result.exitCode,output:out,stderr:err,usage:null,error:result.exitCode===0?'':'退出码 '+result.exitCode+' '+err.slice(-1000)};}
  lines=readline.createInterface({input:h.stdout});lines.on('line',line=>{let m;try{m=JSON.parse(line);}catch{return;}if(!m||m.jsonrpc!=='2.0')return;if(m.id!=null&&!m.method){const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}}else if(m.method==='session/update'){const u=m.params?.update;if(u?.sessionUpdate==='agent_message_chunk')out=(out+(u.content?.text||'')).slice(-256000);if(u?.sessionUpdate==='usage_update')usage=u.usage||u;}else if(m.method==='session/request_permission'){err+='执行端请求额外权限，未自动批准。';h.stdin.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{outcome:{outcome:'cancelled'}}})+'\n');}else if(m.method&&m.id!=null)h.stdin.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'此入口不提供客户端文件或终端服务，请使用Harness已有工具'}})+'\n');});
  phase='initialize';const init=await req('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'dsh-cross-harness-coordinator',version:VERSION}});if(init?.protocolVersion!==1)throw Error('ACP版本不兼容：仅支持协议1，执行端返回 '+String(init?.protocolVersion));
  if(JSON.stringify(init).length>64000)throw Error('ACP握手资料过大');
  phase='session/new';const session=await req('session/new',{cwd,mcpServers:[]});if(typeof session?.sessionId!=='string'||!session.sessionId.trim())throw Error('ACP没有返回有效sessionId');
  if(probeOnly){
   const methods=['initialize','session/new'];
   if(init.agentCapabilities?.sessionCapabilities?.close!=null){phase='session/close';await req('session/close',{sessionId:session.sessionId});methods.push('session/close');}
   return {protocolVersion:1,agentInfo:init.agentInfo||{},agentCapabilities:init.agentCapabilities||{},sessionCreated:true,methods,checkedAt:new Date().toISOString()};
  }
  if(task.model){if(!e.capabilities.modelSelection)throw Error('模型选择未经确认');phase='session/set_model';await req('session/set_model',{sessionId:session.sessionId,modelId:task.model});}phase='session/prompt';const result=await req('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:prompt}]});return {ok:result.stopReason==='end_turn',output:out,stderr:err,usage,stopReason:result.stopReason,error:result.stopReason==='end_turn'?'':'ACP未正常完成：'+result.stopReason};
 }catch(error){error.acpStage=phase;throw error;}
 finally{clearTimeout(timer);rejectPending('检查结束');signal.removeEventListener('abort',aborted);lines?.close();try{await h.stop();}catch(error){error.acpStage='cleanup';throw error;}finally{h.stdin.removeListener('error',stdinError);}if(signal.aborted){const error=signal.reason instanceof Error?signal.reason:Error('ACP连接检查已取消');error.acpStage=phase;throw error;}if(timedOut)throw Object.assign(Error(probeOnly?'ACP连接检查超时':'执行超时，工作已停止，需要核对产物'),{acpStage:phase});}
}
