// Bounded JSON lines RPC, including Codex's envelope without a jsonrpc member.
export const CODEX_RPC_MAX_BYTES=16*1024*1024;
export async function openRpc(host,request,{argv,onNotification=()=>{},onRequest=()=>({error:{code:-32601,message:'客户端不提供此服务'}}),maxMessageBytes=1024*1024,onTrace=()=>{}}={}){
 if(!Number.isInteger(maxMessageBytes)||maxMessageBytes<1024||maxMessageBytes>CODEX_RPC_MAX_BYTES)throw Error('RPC消息上限无效');
 const h=await host.launch({...request,argv,env:request.endpoint.launch_env||{}}),pending=new Map(),serverPending=new Set();
 let seq=0,buffer='',stderr='',fatal,closed=false,closing=false,rejectFailure,firstFailure;
 const stats={messages:0,serverRequests:0,receivedBytes:0,largestMessageBytes:0,maxBufferBytes:0,maxMessageBytes};
 const failure=new Promise((_,reject)=>rejectFailure=reject);failure.catch(()=>{});
 const trace=(event,details)=>{try{onTrace(event,details);}catch{}};
 const send=m=>new Promise((resolve,reject)=>h.stdin.write(JSON.stringify(m)+'\n',error=>error?reject(error):resolve()));
 const rejectPending=error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();};
 const fail=(error,kind='transport_error',details={})=>{
  if(closing)return;const e=error instanceof Error?error:Error(String(error));
  if(!fatal){fatal=e;firstFailure={kind,code:e.code||null,message:String(e.message).slice(0,2000),...details};trace('rpc_failure',{kind,code:e.code||'',reason:e.message,...details});rejectFailure(e);}
  rejectPending(fatal);
 };
 const abort=()=>fail(request.signal.reason||Error('调用已取消'),'aborted');request.signal.addEventListener('abort',abort,{once:true});
 const stdinError=e=>fail(e,'stdin_error'),stdoutError=e=>fail(e,'stdout_error');h.stdin.on('error',stdinError);h.stdout.on('error',stdoutError);
 h.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-256000);});h.stdout.setEncoding('utf8');
 h.stdout.on('data',chunk=>{
  if(fatal||closing)return;stats.receivedBytes+=Buffer.byteLength(chunk);buffer+=chunk;
  try{let end;while((end=buffer.indexOf('\n'))>=0){
   const line=buffer.slice(0,end);buffer=buffer.slice(end+1);const bytes=Buffer.byteLength(line);stats.largestMessageBytes=Math.max(stats.largestMessageBytes,bytes);
   if(bytes>maxMessageBytes)throw Object.assign(Error('Codex RPC消息超过上限（'+bytes+'字节 / '+maxMessageBytes+'字节）'),{code:'RPC_MESSAGE_LIMIT',bytes,maxBytes:maxMessageBytes});
   if(!line.trim())continue;let m;try{m=JSON.parse(line);}catch{throw Object.assign(Error('Codex RPC消息不是有效JSON'),{code:'RPC_INVALID_JSON',bytes});}
   if(!m||typeof m!=='object'||Array.isArray(m))throw Object.assign(Error('Codex RPC消息无效'),{code:'RPC_INVALID_ENVELOPE'});
   stats.messages++;const p=m.params||{},metadata={method:typeof m.method==='string'?m.method:'response',bytes,threadId:p.threadId,turnId:p.turnId||p.turn?.id,itemId:p.itemId||p.item?.id};trace('rpc_message',metadata);
   if(m.id!==undefined&&!m.method){const pendingRequest=pending.get(m.id);if(pendingRequest){pending.delete(m.id);clearTimeout(pendingRequest.timer);m.error?pendingRequest.reject(Object.assign(Error(String(m.error.message||'远端RPC错误')),{code:'RPC_REMOTE_ERROR'})):pendingRequest.resolve(m.result);}}
   else if(m.id!==undefined){
    if(serverPending.has(m.id))throw Object.assign(Error('Codex服务端请求编号重复'),{code:'RPC_DUPLICATE_REQUEST'});serverPending.add(m.id);stats.serverRequests++;trace('rpc_server_request',{...metadata,requestId:m.id});
    void Promise.resolve().then(()=>{if(fatal||closing||request.signal.aborted)return;return onRequest(m);}).then(response=>{if(response&&!fatal&&!closed&&!closing&&!request.signal.aborted)return send({id:m.id,...response});}).catch(e=>fail(e,'request_handler_error')).finally(()=>serverPending.delete(m.id));
   }else onNotification(m);
   if(fatal||closing)break;
  }
  const bytes=Buffer.byteLength(buffer);stats.maxBufferBytes=Math.max(stats.maxBufferBytes,bytes);
  if(bytes>maxMessageBytes)throw Object.assign(Error('Codex RPC消息缓冲超过上限（'+bytes+'字节 / '+maxMessageBytes+'字节）'),{code:'RPC_BUFFER_LIMIT',bytes,maxBytes:maxMessageBytes});
 }catch(error){fail(error,error.code==='RPC_MESSAGE_LIMIT'||error.code==='RPC_BUFFER_LIMIT'?'message_limit':'decode_or_handler_error',{...(error.bytes!==undefined?{bytes:error.bytes}:{}),...(error.maxBytes?{maxBytes:error.maxBytes}:{})});void h.stop().catch(()=>{});}
 });
 if(h.transportFailure)h.transportFailure.catch(error=>fail(error,'transport_error',{...(error.bytes?{bytes:error.bytes}:{}),...(error.maxBytes?{maxBytes:error.maxBytes}:{})}));
 h.done.then(value=>{closed=true;trace('rpc_exit',{exitCode:value?.exitCode,signal:value?.signal});if(!closing)fail(Object.assign(Error('Codex在完成事件前退出（退出码 '+String(value?.exitCode??'未知')+'）'),{code:'RPC_PROCESS_EXIT'}),'process_exit',{exitCode:value?.exitCode??null,signal:value?.signal??null});},error=>fail(error,'process_error'));
 return {h,send,failure,beginClose:()=>{closing=true;},get stderr(){return stderr;},get diagnostics(){return {stats:{...stats},failure:firstFailure||null,closed};},request:(method,params,timeout=15000)=>new Promise((resolve,reject)=>{
  if(fatal||closed||request.signal.aborted){reject(fatal||request.signal.reason||Error('连接已关闭'));return;}
  const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Object.assign(Error('协议调用超时：'+method),{code:'RPC_REQUEST_TIMEOUT'}));},timeout);
  pending.set(id,{resolve,reject,timer});void send({id,method,params}).catch(e=>{clearTimeout(timer);pending.delete(id);reject(e);fail(e,'send_error');});
 }),close:async()=>{closing=true;closed=true;request.signal.removeEventListener('abort',abort);rejectPending(Error('调用结束'));if(!h.stdin.destroyed)h.stdin.end();try{await h.stop();}finally{h.stdin.removeListener('error',stdinError);h.stdin.on('error',()=>{});h.stdout.removeListener('error',stdoutError);h.stdout.on('error',()=>{});}}};
}
