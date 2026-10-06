import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {ClientFactory,JsonRpcTransportFactory,RestTransportFactory,DefaultAgentCardResolver} from '@a2a-js/sdk/client';
import {GrpcTransportFactory} from '@a2a-js/sdk/client/grpc';
import {credentials} from '@grpc/grpc-js';
import {Role,TaskState} from '@a2a-js/sdk';
import {deliver} from './delivery.js';
export function authHeaders(server){
 const auth=server.auth||{},headers={};const value=name=>{const v=process.env[name];if(!v||/[\r\n]/.test(v))throw Error('缺少有效的认证环境变量：'+name);return v;};
 if(auth.bearerEnv)headers.authorization='Bearer '+value(auth.bearerEnv);
 if(auth.basicEnv)headers.authorization='Basic '+Buffer.from(value(auth.basicEnv)).toString('base64');
 for(const [name,env]of Object.entries(auth.headerEnv||{}))headers[name]=value(env);
 return headers;
}
export function redact(value,server){let result=String(value);for(const name of [server?.auth?.bearerEnv,server?.auth?.basicEnv,...Object.values(server?.auth?.headerEnv||{})].filter(Boolean)){const v=process.env[name];if(v){result=result.replaceAll(v,'[已隐藏凭据]').replaceAll(Buffer.from(v).toString('base64'),'[已隐藏凭据]');}}return result;}
export function sanitize(value,server){return typeof value==='string'?redact(value,server):Array.isArray(value)?value.map(v=>sanitize(v,server)):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sanitize(v,server)])):value;}
export function confinedFetch(server,signal){
 const origin=new URL(server.url).origin,auth=authHeaders(server);
 return async(input,init={})=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.origin!==origin||url.username||url.password)throw Error('网络请求超出登记入口来源');
  const headers=new Headers(init.headers||{});for(const [k,v]of Object.entries(auth))headers.set(k,v);
  const response=await fetch(input,{...init,headers,redirect:'error',signal:AbortSignal.any([signal,...(init.signal?[init.signal]:[])])});
  const size=Number(response.headers.get('content-length'));if(size>16*1024*1024){await response.body?.cancel();throw Error('网络响应超过16MiB');}
  if(!response.body)return response;
  let count=0;const bounded=response.body.pipeThrough(new TransformStream({transform(chunk,controller){count+=chunk.byteLength;if(count>16*1024*1024)throw Error('网络响应超过16MiB');controller.enqueue(chunk);}}));
  return new Response(bounded,{status:response.status,statusText:response.statusText,headers:response.headers});
 };
}
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export async function runA2a(r){
 const s=r.endpoint.server,fetchImpl=confinedFetch(s,new AbortController().signal),resolver=new DefaultAgentCardResolver({fetchImpl:(input,init)=>fetchImpl(input,{...init,signal:r.signal}),legacyCompat:{enabled:s.legacyCompat===true}});
 const card=await resolver.resolve(s.url,s.cardPath||'/.well-known/agent-card.json');
 if(!card.name||!Array.isArray(card.supportedInterfaces)||!card.supportedInterfaces.length)throw Error('A2A AgentCard没有可调用接口');
 // Filter before selection. A card cannot redirect an invitation to another host.
 const origin=new URL(s.url).origin;card.supportedInterfaces=card.supportedInterfaces.filter(i=>{try{return (s.interfaceUrl?new URL(i.url).href===new URL(s.interfaceUrl).href:new URL(i.url).origin===origin)&&(!s.transport||i.protocolBinding===s.transport);}catch{return false;}});
 if(!card.supportedInterfaces.length)throw Error('A2A接口超出登记来源或未提供所选传输');
 const compat={legacyCompat:{enabled:s.legacyCompat===true}},grpcFactory=new GrpcTransportFactory({grpcChannelCredentials:new URL(s.interfaceUrl||s.url).protocol==='http:'?credentials.createInsecure():credentials.createSsl(),...compat});
 // The SDK's gRPC constructor takes an authority rather than an HTTP URL.
 const factories=[new JsonRpcTransportFactory({fetchImpl,...compat}),new RestTransportFactory({fetchImpl,...compat}),{protocolName:'GRPC',create:(url,card)=>grpcFactory.create(new URL(url).host,card)}];
 const client=await new ClientFactory({transports:factories,cardResolver:resolver,clientConfig:{polling:true},...(s.transport?{preferredTransports:[s.transport]}:{})}).createFromAgentCard(card);
 const fingerprint=digest(card.supportedInterfaces);
 if(r.probeOnly)return {protocol:'a2a',handshakeVerified:true,methods:['agent-card'],agentInfo:{name:card.name,version:card.version},interfaces:card.supportedInterfaces,interfaceFingerprint:fingerprint,checkKind:'discovery-only',executionVerified:false,checkedAt:new Date().toISOString()};
 if(r.endpoint.connection?.interfaceFingerprint!==fingerprint)throw Object.assign(Error('A2A接口发生变化，请重新检查连接'),{reconnectRequired:true});
 const options={signal:r.signal,serviceParameters:authHeaders(s)};let taskId,terminal=false;
 try{
  const result=await client.sendMessage({tenant:'',message:{messageId:randomUUID(),role:Role.ROLE_USER,parts:[{content:{$case:'text',value:r.prompt},filename:'',mediaType:'text/plain'}],taskId:'',contextId:'',extensions:[],referenceTaskIds:[]},configuration:{acceptedOutputModes:['text/plain','application/octet-stream','application/json'],returnImmediately:true},metadata:{}},options);
  let task=result;if(!task.id||!task.status)throw Error('A2A仅返回消息，没有可审查的任务与文件交付');taskId=task.id;
  while([TaskState.TASK_STATE_SUBMITTED,TaskState.TASK_STATE_WORKING].includes(task.status.state)){await delay(500,undefined,{signal:r.signal});task=await client.getTask({tenant:'',id:taskId,historyLength:0},options);if(task.id!==taskId)throw Error('A2A返回了其他任务');}
  terminal=true;if(task.status.state!==TaskState.TASK_STATE_COMPLETED)return {ok:false,output:'',stderr:'',error:'A2A任务未完成或等待额外输入：'+task.status.state,remote:{taskId,state:task.status.state}};
  const files=[];for(const artifact of task.artifacts||[]){const parts=artifact.parts||[];if(!parts.length)continue;const filename=artifact.name||parts[0]?.filename;
   if(!r.task.outputs.includes(filename))continue;
   if(parts.every(p=>p.content?.$case==='text'))files.push({path:filename,text:parts.map(p=>p.content.value).join('')});
   else if(parts.length===1&&parts[0].content?.$case==='raw')files.push({path:filename,base64:Buffer.from(parts[0].content.value).toString('base64')});
   else throw Error('A2A文件须以内联文字或字节交付，不自动下载远端URL');
  }
  const delivered=deliver(r.cwd,r.task.outputs,files);return {ok:true,output:'A2A产物已交付：'+delivered.join('、'),stderr:'',usage:null,remote:{taskId,state:task.status.state,delivered}};
 }finally{if(taskId&&!terminal)await client.cancelTask({tenant:'',id:taskId},{signal:AbortSignal.timeout(1000),serviceParameters:authHeaders(s)}).catch(()=>{});}
}
export async function runOpenCode(r){
 const s=r.endpoint.server,fetchImpl=confinedFetch(s,r.signal);let sessionId,terminal=false;
 const call=async(method,route,body)=>{const u=new URL(s.url.replace(/\/$/,'')+route);if(s.directory)u.searchParams.set('directory',s.directory);const res=await fetchImpl(u,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(!res.ok)throw Error('OpenCode HTTP '+res.status);return res.status===204?null:res.json();};
 const health=await call('GET','/global/health'),providers=await call('GET','/config/providers');if(health?.healthy!==true||typeof health.version!=='string'||!Array.isArray(providers?.providers))throw Error('OpenCode元数据无效');
 if(r.probeOnly)return {protocol:'opencode',handshakeVerified:true,methods:['global/health','config/providers'],serverInfo:{version:health.version},providers:providers.providers.map(p=>({id:p.id,name:p.name,models:Object.keys(p.models||{})})),checkKind:'metadata-only',executionVerified:false,checkedAt:new Date().toISOString()};
 try{
  const session=await call('POST','/session',{});sessionId=session?.id;if(!sessionId)throw Error('OpenCode没有返回sessionId');
  const body={parts:[{type:'text',text:r.prompt}]};if(r.task.model){const [providerID,...rest]=r.task.model.split('/');if(!rest.length)throw Error('OpenCode模型应使用provider/model');body.model={providerID,modelID:rest.join('/')};}
  const result=await call('POST','/session/'+encodeURIComponent(sessionId)+'/message',body);terminal=true;
  if(result?.info?.error||!result?.info?.time?.completed||result.info.role!=='assistant'||!['stop','end_turn'].includes(result.info.finish))return {ok:false,output:'',stderr:'',error:'OpenCode未返回成功完成的助手消息',remote:{sessionId}};
  const files=[];for(const relative of r.task.outputs){const u='/file/content?path='+encodeURIComponent(relative),content=await call('GET',u);if(typeof content?.content!=='string'||!['text','raw'].includes(content.type))throw Error('OpenCode未交付声明文件');files.push(content.encoding==='base64'?{path:relative,base64:content.content}:{path:relative,text:content.content});}
  const delivered=deliver(r.cwd,r.task.outputs,files);return {ok:true,output:(result.parts||[]).filter(p=>p.type==='text').map(p=>p.text).join('\n').slice(-256000),stderr:'',usage:result.info.tokens||null,remote:{sessionId,delivered}};
 }finally{if(sessionId&&!terminal){const cancelFetch=confinedFetch(s,AbortSignal.timeout(1000)),u=new URL(s.url);u.pathname=u.pathname.replace(/\/$/,'')+'/session/'+encodeURIComponent(sessionId)+'/abort';if(s.directory)u.searchParams.set('directory',s.directory);await cancelFetch(u,{method:'POST'}).catch(()=>{});}}
}
