import {workerFile} from './bridges.js';
export async function runWorker({launch},r){
 const e=r.endpoint,python=e.protocol==='claude-sdk'&&e.sdk.language==='python';
 const argv=e.protocol==='claude-sdk'?[e.command,...e.args,workerFile(python?'claude-worker.py':'claude-worker.mjs')]:[process.execPath,workerFile('worker.mjs')];
 r.signal.throwIfAborted();const processController=new AbortController();
 const openingAbort=()=>processController.abort(r.signal.reason);r.signal.addEventListener('abort',openingAbort,{once:true});
 let h;try{h=await launch({...r,signal:processController.signal,argv,env:e.launch_env||{}});}finally{r.signal.removeEventListener('abort',openingAbort);}
 let buffer='',response,malformed=false,stderr='',stopTimer;const approvals=new Map();
 h.stdout.setEncoding('utf8');h.stdout.on('data',chunk=>{buffer+=chunk;if(Buffer.byteLength(buffer)>1024*1024){malformed=true;void h.stop().catch(()=>{});}let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const m=JSON.parse(line);
  if(m.runTrace){if(e.protocol!=='codex'||typeof m.runTrace.event!=='string'||!m.runTrace.details||JSON.stringify(m.runTrace).length>32000)throw Error('日志通道消息无效');r.trace?.(m.runTrace.event,m.runTrace.details);}
  else if(m.approvalRequest){
   if(e.protocol!=='codex'||r.probeOnly||response||typeof m.approvalRequest.id!=='string'||approvals.has(m.approvalRequest.id)||approvals.size>=8)throw Error('审批通道消息无效');
   const {id,...proposal}=m.approvalRequest,controller=new AbortController();approvals.set(id,controller);
    void Promise.resolve().then(()=>{if(typeof r.requestApproval!=='function')throw Error('未接入原会话审批渠道');return r.requestApproval({...proposal,signal:AbortSignal.any([r.signal,controller.signal])});}).catch(error=>({decision:'cancel',reason:String(error.message),...(error.code?{code:error.code}:{})})).then(answer=>{if(approvals.get(id)!==controller)return;approvals.delete(id);if(!r.signal.aborted&&!response&&!h.stdin.destroyed)h.stdin.write(JSON.stringify({approvalDecision:{id,answer}})+'\n');});
  }else if(m.approvalWithdrawal){const id=m.approvalWithdrawal.id;approvals.get(id)?.abort(Error('远端回合结束，撤回审批'));approvals.delete(id);}
  else{if(response)malformed=true;else response=m;}
 }catch{malformed=true;}}});
 // SDK stderr may contain credential-bearing third-party logs; never persist it.
 h.stderr.on('data',()=>{stderr='桥接进程产生诊断日志；未保存第三方原文';});h.stdin.on('error',()=>{});
 const abort=()=>{if(!h.stdin.destroyed)h.stdin.write(JSON.stringify({cancel:true})+'\n');stopTimer=setTimeout(()=>{processController.abort();void h.stop().catch(()=>{});},1200);};r.signal.addEventListener('abort',abort,{once:true});if(r.signal.aborted)abort();
 const timer=setTimeout(()=>void h.stop().catch(()=>{}),r.task.timeoutMs+1500);
 try{
  h.stdin.write(JSON.stringify({endpoint:e,cwd:r.cwd,task:r.task,prompt:r.prompt,probeOnly:!!r.probeOnly})+'\n');
  const exit=await h.done;r.signal.throwIfAborted();if(malformed||!response||buffer.trim())throw Error('桥接进程没有返回有效结果');
  if(response.error)throw Object.assign(Error(response.error),{protocolStage:response.protocolStage,reconnectRequired:response.reconnectRequired});
  if(exit.exitCode!==0)throw Error('桥接进程异常退出');return {...response.result,...(!r.probeOnly?{stderr}:{} )};
 }finally{clearTimeout(timer);clearTimeout(stopTimer);r.signal.removeEventListener('abort',abort);for(const c of approvals.values())c.abort(Error('工作进程结束，审批撤回'));approvals.clear();await h.stop();}
}
