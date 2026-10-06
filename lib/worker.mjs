import readline from 'node:readline';
import {PassThrough,Writable} from 'node:stream';
import {runA2a,runOpenCode,redact,sanitize} from './network.js';
import {runCodex} from './native.js';
import {randomUUID} from 'node:crypto';
import {CODEX_RPC_MAX_BYTES} from './rpc.js';
// The host launches this worker under the originating session's sandbox.
const lines=readline.createInterface({input:process.stdin});let started=false,controller=new AbortController();const approvals=new Map();
lines.on('line',async line=>{
 if(Buffer.byteLength(line)>1024*1024){controller.abort(Error('工作请求过大'));process.exitCode=1;return;}
 let r;try{r=JSON.parse(line);}catch{return;}
 if(r.approvalDecision){const p=approvals.get(r.approvalDecision.id);if(p){approvals.delete(r.approvalDecision.id);p.cleanup();p.resolve(r.approvalDecision.answer);}return;}
 if(r.cancel){controller.abort(Error('用户取消'));return;}if(started)return;started=true;
 const timer=setTimeout(()=>controller.abort(Error('桥接调用超时')),r.task.timeoutMs);r.signal=controller.signal;
 r.requestApproval=proposal=>new Promise(resolve=>{const id=randomUUID(),{signal,...value}=proposal,abort=()=>{if(!approvals.delete(id))return;signal.removeEventListener('abort',abort);process.stdout.write(JSON.stringify({approvalWithdrawal:{id}})+'\n');resolve({decision:'cancel',reason:'工作进程审批已撤回'});};approvals.set(id,{resolve,cleanup:()=>signal.removeEventListener('abort',abort)});signal.addEventListener('abort',abort,{once:true});process.stdout.write(JSON.stringify({approvalRequest:{id,...value}})+'\n');if(signal.aborted)abort();});
 if(r.endpoint.protocol==='codex')r.trace=(event,details)=>process.stdout.write(JSON.stringify({runTrace:{event,details}})+'\n');
 try{const result=r.endpoint.protocol==='a2a'?await runA2a(r):r.endpoint.protocol==='opencode'?await runOpenCode(r):await runCodex({launch:()=>websocketLaunch(r)},r);process.stdout.write(JSON.stringify(sanitize({result},r.endpoint.server))+'\n');}
 catch(error){process.stdout.write(JSON.stringify({error:redact(error.message,r.endpoint.server),protocolStage:error.protocolStage||'network',reconnectRequired:!!error.reconnectRequired})+'\n');}
 finally{clearTimeout(timer);lines.close();process.stdin.pause();}
});
lines.on('close',()=>{if(!started)controller.abort();});
async function websocketLaunch(r){
 const ws=new WebSocket(r.endpoint.server.url),stdout=new PassThrough(),stderr=new PassThrough();let stopped=false,rejectTransport;const transportFailure=new Promise((_,reject)=>rejectTransport=reject);transportFailure.catch(()=>{});
 await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',()=>reject(Error('WebSocket连接失败')),{once:true});r.signal.addEventListener('abort',()=>{ws.close();reject(r.signal.reason);},{once:true});});
 const done=new Promise(resolve=>ws.addEventListener('close',()=>{stdout.end();stderr.end();resolve({exitCode:stopped?0:1});},{once:true}));
 ws.addEventListener('message',event=>{const value=String(event.data),bytes=Buffer.byteLength(value);if(bytes>CODEX_RPC_MAX_BYTES){rejectTransport(Object.assign(Error('Codex WebSocket消息超过上限（'+bytes+'字节 / '+CODEX_RPC_MAX_BYTES+'字节）'),{code:'RPC_MESSAGE_LIMIT',bytes,maxBytes:CODEX_RPC_MAX_BYTES}));ws.close();return;}stdout.write(value+'\n');});
 const stdin=new Writable({write(chunk,_encoding,callback){try{for(const line of chunk.toString().split('\n').filter(Boolean))ws.send(line);callback();}catch(error){callback(error);}}});
 return {stdin,stdout,stderr,done,transportFailure,stop:async()=>{stopped=true;ws.close();await Promise.race([done,new Promise(resolve=>setTimeout(resolve,1000))]);}};
}
